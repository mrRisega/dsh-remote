// 插件 node 半「自管理」回归：/dsh-remote/self | update-check | update | update-log | uninstall。
// 覆盖用户三项诉求对应的机制：
//   1) 插件市场没有「更新按钮」→ 面板内 self* 路由提供版本检测与一键在线更新；
//   2) 市场无法卸载（我们的 include 引用挡住）→ uninstall 路由移除 include/依赖/bundle/本地文件；
//   3) 版本可见 + 新版本检测 + 稳健更新（含残留 marker 清理兜底逻辑在 apply 时执行）。
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply } from "../lib/index.js";

const PLUGIN_BLOCK = `# >>> dsh-remote-ui (managed by dsh-remote plugin; do not edit)
- type: plugin
  name: dsh-remote-ui
  apply: dsh-remote-ui
# <<< dsh-remote-ui
`;

/** 加载插件（tempHome 可覆盖 os.homedir()，供 uninstall 的默认 profile 推导用）。 */
function boot(tempHome, relayDir) {
  const routes = new Map();
  const previousHome = process.env.HOME;
  if (tempHome) process.env.HOME = tempHome;
  try {
    apply({
      webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
      effect(register) { return register(); },
      logger: { info() {}, warn() {} }
    }, { relayDir });
  } finally {
    if (tempHome) process.env.HOME = previousHome;
  }
  return routes;
}

/** 起一个指向 routes 的 http server，返回 base url。 */
async function serve(routes) {
  const host = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const handler = routes.get(url.pathname);
    (handler || ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  return { host, base: `http://127.0.0.1:${host.address().port}` };
}

test("self 路由：版本可见 + 运行环境状态（无 npx 环境时不谎报已就绪）", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-ui-self-"));
  try {
    const routes = boot(null, tempDir);
    const { host, base } = await serve(routes);
    try {
      const self = await (await fetch(`${base}/dsh-remote/self`)).json();
      assert.equal(self.ok, true);
      assert.match(self.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, `version 应为 semver(含预发布)，实际 ${self.version}`);
      assert.equal(self.runtimeReady, false, "temp 目录没有 dsh-setup.mjs → runtimeReady=false");
      assert.equal(self.relayDir, tempDir);
    } finally {
      host.close();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("update-check 路由：从 npm 检测新版本（dist-tags.latest 9.9.9 > 当前）", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-ui-upchk-"));
  const origFetch = globalThis.fetch;
  try {
    const routes = boot(null, tempDir);
    const { host, base } = await serve(routes);
    // 假 npm 源：registry 请求回 9.9.9，其余请求（本测试自身的 HTTP 调用）走真实 fetch
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://registry.")) {
        return { ok: true, status: 200, json: async () => ({ "dist-tags": { latest: "9.9.9" } }) };
      }
      return origFetch(url, init);
    };
    try {
      const r = await (await fetch(`${base}/dsh-remote/self/update-check`)).json();
      assert.equal(r.ok, true);
      assert.equal(r.latest, "9.9.9");
      assert.equal(r.outdated, true, "9.9.9 > 当前版本 → outdated 应为 true");
      assert.notEqual(r.current, r.latest);
    } finally {
      host.close();
    }
  } finally {
    globalThis.fetch = origFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("update-log 路由：running 由 marker 决定，日志返回尾部", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-ui-uplog-"));
  try {
    const routes = boot(null, tempDir);
    const { host, base } = await serve(routes);
    try {
      // 无 marker：不 running
      let r = await (await fetch(`${base}/dsh-remote/self/update-log`)).json();
      assert.equal(r.ok, true);
      assert.equal(r.running, false);

      // 写入 marker + 日志 → running=true 且返回日志尾部
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
      await writeFile(path.join(tempDir, ".dsh-update-running"), String(Date.now()));
      await writeFile(path.join(tempDir, ".dsh-update.log"), lines.join("\n"));
      r = await (await fetch(`${base}/dsh-remote/self/update-log`)).json();
      assert.equal(r.running, true);
      assert.ok(r.log.includes("line 29"), "日志应含尾部内容");
      assert.ok(!r.log.includes("line 0"), "日志过长时应只截尾部（tailOf 生效）");
    } finally {
      host.close();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("update 路由：已有更新进行中时拒绝重复触发（防重入）", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-ui-up-"));
  try {
    const routes = boot(null, tempDir);
    const { host, base } = await serve(routes);
    try {
      await writeFile(path.join(tempDir, ".dsh-update-running"), String(Date.now()));
      const r = await (await fetch(`${base}/dsh-remote/self/update`, { method: "POST" })).json();
      assert.equal(r.ok, false);
      assert.match(String(r.detail), /进行中/, `detail 应提示进行中，实际: ${r.detail}`);
    } finally {
      host.close();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("残留 marker 自愈：记录进程已死的 marker 在插件启动时立即清理（不等 30 分钟超时）", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "dsh-ui-sweep-"));
  try {
    // 模拟“宿主在更新途中被重启”：更新子进程已死，但清理回调随旧宿主丢失
    const deadPid = 2147483647; // 不可能存在的 pid
    writeFileSync(path.join(tempDir, ".dsh-setup-installing"), JSON.stringify({ pid: deadPid, at: Date.now() }));
    writeFileSync(path.join(tempDir, ".dsh-update-running"), JSON.stringify({ pid: deadPid, at: Date.now() }));
    writeFileSync(path.join(tempDir, ".dsh-config.json"), "{}");
    boot(null, tempDir); // apply() → sweepStaleMarkers
    assert.equal(existsSync(path.join(tempDir, ".dsh-setup-installing")), false, "死进程的安装 marker 应被立即清理");
    assert.equal(existsSync(path.join(tempDir, ".dsh-update-running")), false, "死进程的更新 marker 应被立即清理");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("uninstall 路由：移除 include 块 + package.json 依赖/bundle + 本地目录（解锁市场卸载）", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "dsh-ui-home-"));
  const relayDir = path.join(tempHome, "relay");
  await mkdir(relayDir, { recursive: true });
  // 模拟真实 profile 布局：cordis.patch.yml + package.json + 本地插件目录/链接
  const profile = path.join(tempHome, ".dsh", "profiles", "web");
  await mkdir(path.join(profile, "dsh-remote-ui-plugin"), { recursive: true });
  await mkdir(path.join(profile, "node_modules", "dsh-remote-ui"), { recursive: true });
  const patchFile = path.join(profile, "cordis.patch.yml");
  const pkgFile = path.join(profile, "package.json");
  await writeFile(patchFile, `base: .\ninclude:\n${PLUGIN_BLOCK}  - other-plugin\n`);
  await writeFile(pkgFile, JSON.stringify({
    dependencies: { "dsh-remote-ui": "github:mrRisega/dsh-remote#path:/packages/dsh-remote-ui", "other": "^1.0.0" },
    dsh: { profile: { bundles: ["dsh-remote-ui", "other-bundle"] } },
  }));
  await writeFile(path.join(profile, "dsh-remote-ui-plugin", "index.js"), "// stub");
  await writeFile(path.join(profile, "node_modules", "dsh-remote-ui", "index.js"), "// stub");
  await writeFile(path.join(relayDir, ".dsh-config.json"), "{}");

  try {
    // 测试隔离开关：卸载路由跳过 launchctl / systemctl / 杀进程等系统级操作（本机真实 bridge 正由 launchd 运行，
    // 不能被测试误停），只验证「插件 profile 清理 + 配置目录清空」逻辑。
    process.env.DSH_RELAY_SKIP_SERVICE = "1";
    // 关键：以 tempHome 为 HOME 启动，profileDir 默认推导才会落在 temp profile 而非真实 ~/.dsh
    const routes = boot(tempHome, relayDir);
    const { host, base } = await serve(routes);
    try {
      const r = await (await fetch(`${base}/dsh-remote/self/uninstall`, { method: "POST" })).json();
      assert.equal(r.ok, true);
      assert.equal(r.removedPatch, true, "应移除 patch 中的 include 块");
      assert.equal(r.removedDep, true, "应移除 package.json 依赖");
      assert.equal(r.removedBundle, true, "应移除 dsh.profile.bundles 条目");
      assert.equal(r.removedDir, true, "应删除本地插件目录与 node_modules 链接");

      // 运行时/bridge 清理（隔离模式下只清空配置目录，绝不触碰真实 launchd 服务）
      assert.equal(r.relayDirRemoved, true, "配置目录 relayDir 应被整目录清空");
      assert.equal(r.stoppedService, false, "DSH_RELAY_SKIP_SERVICE=1 → 不做真实服务操作");
      assert.equal(r.removedPlist, false, "DSH_RELAY_SKIP_SERVICE=1 → 不删自启动 plist");
      assert.deepEqual(r.killedPids, [], "DSH_RELAY_SKIP_SERVICE=1 → 不杀进程");
      assert.equal(existsSync(relayDir), false, "relayDir 物理上应已不存在");
      assert.match(String(r.detail), /配置目录已清空/, "detail 应说明配置目录已清空");
      assert.match(String(r.detail), /请重启 dsh web/, "detail 应提示重启生效");

      const patch = await readFile(patchFile, "utf8");
      assert.ok(!patch.includes("dsh-remote-ui"), "patch 不应再引用 dsh-remote-ui");
      assert.ok(patch.includes("other-plugin"), "其他插件 include 不应被误伤");

      const pkg = JSON.parse(await readFile(pkgFile, "utf8"));
      assert.equal(pkg.dependencies["dsh-remote-ui"], undefined, "依赖应被删除");
      assert.equal(pkg.dependencies["other"], "^1.0.0", "其他依赖应保留");
      assert.deepEqual(pkg.dsh.profile.bundles, ["other-bundle"], "其他 bundle 应保留");
    } finally {
      host.close();
    }
  } finally {
    delete process.env.DSH_RELAY_SKIP_SERVICE;
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("源码约束：浏览器半提供版本与更新卡片（含彻底卸载确认）", () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(source, /🔄 版本与更新/);
  assert.match(source, /dsh-remote\/self\/update-check/);
  assert.match(source, /一键更新/);
  assert.match(source, /彻底卸载/);
  assert.match(source, /dsh-remote\/self\/uninstall/);
  assert.match(source, /再点一次确认彻底卸载/);
});
