#!/usr/bin/env node
/**
 * watcher 的上游端口发现回归 —— 复现 2026-09-23 两起真实事故的**用户可见形态**。
 *
 * 现场（用户报告，DSH Desktop 2.0.4 + 插件 0.6.10）：
 *   ```
 *   连接阶段: starting（正在启动 Bridge…）
 *   bridge 进程: 未运行   中继注册: 未注册   自动重试: 已尝试 6 次
 *   ```
 *   面板永久停在 starting，设备从未登记。根因：**watcher 把上游写死 3080**，
 *   而 DSH Desktop（Electron 壳 `dsh-plugin-desktop`）把 Web 服务放在 **43120**（占用则 +1）、
 *   独立用户也可能 `dsh web --port 8090` / `--port 0`。探不到 → `checkUpstream()` 恒 false
 *   → **bridge 永远不被派生**，而面板只会说「正在启动 Bridge…」。
 *
 * 本用例锁的是**决策点**（不是实现细节）：只要上游在**非默认端口**且应答像 dsh web，
 * watcher 就必须走进「dsh web 在线，启动 bridge...」并带着**正确的**
 * `DSH_BRIDGE_UPSTREAM` 去派生 bridge。
 *
 * 隔离手法与 runtime-provision / connect-loop 一致：临时 HOME + 假 launchctl/pgrep/ps/npx，
 * 绝不用到本机真实服务；上游是**测试进程内**起的假 dsh web（真 dsh web 只在 3080，
 * 那正是我们要避开的默认值）。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.join(HERE, "..", "..", "..", "dsh-setup.mjs");

/** 假 dsh web 的应答：带官方特征（身份校验靠它），并记录被访问过。 */
const DSH_HTML = "<!doctype html><html><head><title>DeepSeek Harness</title></head>"
  + "<body><script>__ModuleLoader__</script></body></html>";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个假的上游（= 非默认端口上的 dsh web）。 */
async function startFakeDshWeb() {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(DSH_HTML);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { srv, port: srv.address().port, hits, url: `http://127.0.0.1:${srv.address().port}` };
}

/** 临时 relayDir + 一份"已登录"的配置（指向本地死端口，绝不外联）。 */
function makeEnv() {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-upstream-port-"));
  const home = path.join(root, "home");
  const relayDir = path.join(root, "relay");
  const bin = path.join(root, "bin");
  for (const d of [home, relayDir, bin]) mkdirSync(d, { recursive: true });

  // 假命令：让 watcher/插件的系统操作全部落空，绝不碰本机真实服务
  const stub = (name, body) => {
    const p = path.join(bin, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  };
  stub("launchctl", 'case "$1" in list) exit 0 ;; print) echo "could not find service" >&2; exit 113 ;; esac\nexit 0');
  stub("pgrep", "exit 1");
  stub("ps", 'case "$*" in *ppid*) echo 1 ;; *lstart*) echo "Mon Jan  1 00:00:00 2026" ;; esac\nexit 0');
  stub("npx", "exit 127");

  writeFileSync(path.join(relayDir, ".dsh-config.json"), JSON.stringify({
    phone: "13800000000",
    password: "pw",
    device_id: "dev-aaaaaaaaaaaa",
    tunnel_url: "ws://127.0.0.1:1",
    api_url: "http://127.0.0.1:1"
  }, null, 2), { mode: 0o600 });

  return { root, home, relayDir, bin };
}

/** 起 watcher，返回 {proc, out(), stop()}。 */
function startWatcher(env, extraEnv = {}) {
  let out = "";
  const proc = spawn(process.execPath, [SETUP, "run"], {
    cwd: env.root,
    env: {
      ...process.env,
      HOME: env.home,
      DSH_RELAY_DIR: env.relayDir,
      DSH_BRIDGE_CONFIG: path.join(env.relayDir, ".dsh-config.json"),
      PATH: `${env.bin}:${process.env.PATH}`,
      DSH_REMOTE_TELEMETRY: "0",
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc.stdout.on("data", (d) => { out += String(d); });
  proc.stderr.on("data", (d) => { out += String(d); });
  return {
    proc,
    out: () => out,
    async stop() {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      await sleep(120);
    }
  };
}

const waitFor = async (fn, timeoutMs = 12_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await sleep(150);
  }
  return false;
};

test("★ 上游在非默认端口(DSH Desktop 场景):watcher 必须发现它并派生 bridge", async (t) => {
  const env = makeEnv();
  const upstream = await startFakeDshWeb();
  let watcher = null;
  try {
    // 真实的 Desktop 情形：端口文件要么还没写、要么写着上一轮的旧端口
    writeFileSync(path.join(env.relayDir, ".dsh-upstream"), "http://127.0.0.1:1\n", { mode: 0o600 });
    // DSH_WEB_URL 是宿主真实端口的合法来源之一（Desktop 包就是用它把端口暴露给子进程的）
    watcher = startWatcher(env, { DSH_WEB_URL: upstream.url });

    const started = await waitFor(() => /dsh web 在线，启动 bridge/.test(watcher.out()));
    assert.ok(
      started,
      `上游在 ${upstream.port}（非 3080）时 watcher 依然要启动 bridge。实际输出：\n${watcher.out().slice(0, 1200)}`
    );
    assert.ok(upstream.hits.length > 0, "watcher 必须真的探测了那个非默认端口");
    assert.ok(
      !/等待 dsh web（http:\/\/127\.0\.0\.1:3080）/.test(watcher.out()),
      "日志不得再宣称自己在等 3080（用户实测就是被这句误导）"
    );
    // ★ 关键：派生出去的 bridge 必须拿到**被发现的那个端口**（否则它会自己去探 3080 并永久失败）
    const gotBridgeUpstream = await waitFor(() => new RegExp(`上游地址已确定: http://127\\.0\\.0\\.1:${upstream.port}`).test(watcher.out()), 6000);
    assert.ok(
      gotBridgeUpstream,
      `bridge 应被注入发现到的上游 ${upstream.url}。实际输出：\n${watcher.out().slice(0, 1200)}`
    );
  } finally {
    if (watcher) await watcher.stop();
    await new Promise((r) => upstream.srv.close(r));
    rmSync(env.root, { recursive: true, force: true });
  }
});

test("上游确实不在时:watcher 保持等待(不谎报在线,也不派生 bridge)", async (t) => {
  const env = makeEnv();
  // ⚠️ 必须用**显式** DSH_BRIDGE_UPSTREAM 钉死死端口：不加它时动态发现会去探 3080，
  //    而开发机/CI 上真的可能有一个 dsh web 在 3080 —— 那样这条断言就变成看环境了。
  //    显式值优先且不做探测（既有语义），于是"上游不可达"这件事在测试里是确定的。
  let watcher = null;
  try {
    writeFileSync(path.join(env.relayDir, ".dsh-upstream"), "http://127.0.0.1:1\n", { mode: 0o600 });
    watcher = startWatcher(env, { DSH_BRIDGE_UPSTREAM: "http://127.0.0.1:1" });
    await sleep(3500);
    const out = watcher.out();
    assert.ok(!/dsh web 在线，启动 bridge/.test(out), `不得谎报在线：\n${out.slice(0, 600)}`);
    assert.match(out, /等待 dsh web/, "应如实说明在等 dsh web");
  } finally {
    if (watcher) await watcher.stop();
    rmSync(env.root, { recursive: true, force: true });
  }
});
