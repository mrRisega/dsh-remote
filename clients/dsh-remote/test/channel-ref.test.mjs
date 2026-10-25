// 渠道归因码（channel referral）全链路回归。
//
// 契约：dsh-relay-enterprise/docs/channel-referral-contract.md §1 / §5 ——
//   `npx @mrrisega/dsh-remote --ref 368`
//     → 安装器把 `--ref`（3~6 位数字）写进 ~/.dsh-remote/.dsh-config.json 的 `ref_code`
//     → bridge `POST /api/devices` 带 `ref_code`；
//     → 插件 `POST /api/install-report` 带 `ref_code`，面板注册 `POST /api/register` 带 `channel_code`。
//   非法值一律静默忽略（归因是附加信息，绝不能因此让安装失败）。
//
// 三层锁（哪一层单独测都不够）：
//   A. 解析/合并纯函数：非法值忽略、CLI > 环境变量、升级不覆盖已有值；
//   B. 真起 bridge 进程 + 127.0.0.1 假账号 API：逐字断言 `/api/devices` 的 body；
//   C. 真跑安装器子进程（隔离 HOME / DSH_RELAY_DIR）：断言磁盘上的 ref_code 行为。
//
// ⚠️ 所有测试进程只绑 127.0.0.1（仓库测试铁律：不许绑 0.0.0.0）。
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { applyRefCodeToConfig, normalizeRefCode, resolveRefCode } from "../src/channel-ref.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, "..", "dsh-bridge.mjs");
const SETUP = path.join(HERE, "..", "..", "..", "dsh-setup.mjs");

// ───────────────────────── A. 纯函数（安装器/桥共用同一份规则） ─────────────────────────

test("ref 解析：3~12 位字母或数字才合法，其余一律空串（绝不抛错）", () => {
  const valid = [
    ["368", "368"],
    [" 368 ", "368"],        // 前后空白容忍（argv 里偶尔带）
    ["0368", "0368"],        // 保留前导零：码是字符串不是数字
    ["123456789012", "123456789012"], // 12 位上限
    ["bili", "bili"],        // ★字母短词（更隐蔽，业主 2026-10 口径）
    ["BILI", "bili"],        // 大小写不敏感 → 归一化小写
    [" Bili ", "bili"],
    ["xhs8", "xhs8"],
    [368, "368"],            // 配置被手改成数字也能救回来
  ];
  for (const [input, want] of valid) {
    assert.equal(normalizeRefCode(input), want, `合法值 ${JSON.stringify(input)} 应归一化为 ${want}`);
  }
  const invalid = ["12", "a", "ab", "1234567890123", "36 8", "36-8", "-368", "3.68", "", "   ", null, undefined, {}, [], 12, 3.68, -368];
  for (const input of invalid) {
    assert.equal(normalizeRefCode(input), "", `非法值 ${JSON.stringify(input)} 必须是空串（调用方据此省略字段）`);
  }
});

test("ref 解析优先级：命令行 --ref 优先；非法/缺值的命令行不悄悄回落环境变量", () => {
  assert.equal(resolveRefCode(["--ref", "368"]), "368");
  assert.equal(resolveRefCode(["--ref", "368"], { DSH_REF: "999" }), "368", "命令行优先于 DSH_REF");
  assert.equal(resolveRefCode([], { DSH_REF: "456" }), "456", "命令行没给时用 DSH_REF");
  assert.equal(resolveRefCode([], { DSH_REF: "x" }), "", "环境变量非法 → 忽略");
  assert.equal(resolveRefCode(["--ref", "x"], { DSH_REF: "456" }), "", "命令行给了非法值 → 忽略，不回落到环境变量（避免来路不明的归因）");
  assert.equal(resolveRefCode(["--ref"], { DSH_REF: "456" }), "", "--ref 后面没值 → 忽略");
  assert.equal(resolveRefCode([], {}), "");
  assert.equal(resolveRefCode(undefined, undefined), "", "参数异常也不得抛错");
});

test("配置合并：本次没带/非法 ref 时保留旧值（升级清空 = 归因永久丢失）", () => {
  const old = { ref_code: "111", phone: "13800000000" };
  assert.deepEqual(
    applyRefCodeToConfig(old, []).ref_code,
    "111",
    "★升级（不带 --ref）必须保留配置里已有的 ref_code"
  );
  assert.equal(applyRefCodeToConfig(old, ["--ref", "x"]).ref_code, "111", "非法值不得覆盖旧值");
  assert.equal(applyRefCodeToConfig(old, ["--ref", "368"]).ref_code, "368", "带合法 --ref → 覆盖");
  assert.equal(applyRefCodeToConfig({}, ["--ref", "368"]).ref_code, "368", "首次安装 → 写入");
  assert.ok(!("ref_code" in applyRefCodeToConfig({}, [])), "没有就没有：绝不写空串占位");
  assert.equal(old.ref_code, "111", "不得原地改传入对象（调用方后面还要整份写回）");
});

// ───────────────────────── B. bridge：真的往 /api/devices 发什么 ─────────────────────────

/** 起一个 127.0.0.1 假账号 API + 假 tunnel，拉真 bridge 进程，等它完成设备登记后交给断言。 */
async function withBridge(configFile, fn) {
  const seen = { devices: null };
  const api = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.url === "/api/device-login") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: "token-1" }));
        return;
      }
      if (req.url === "/api/devices") {
        try { seen.devices = JSON.parse(raw); } catch { seen.devices = { parseError: raw }; }
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ device: { id: "dev-000000000009" } }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => wss.once("listening", resolve));

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-channel-ref-"));
  const configPath = path.join(tempDir, "config.json");
  if (configFile) await writeFile(configPath, JSON.stringify(configFile));
  const child = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      DSH_BRIDGE_API: `http://127.0.0.1:${api.address().port}`,
      DSH_BRIDGE_TUNNEL_URL: `ws://127.0.0.1:${wss.address().port}`,
      DSH_BRIDGE_PHONE: "test-account",
      DSH_BRIDGE_PASSWORD: "test-password",
      DSH_BRIDGE_DEVICE_ID: "dev-000000000009",
      DSH_BRIDGE_CONFIG: configPath,
    },
    stdio: "ignore",
  });
  try {
    for (let i = 0; i < 60 && !seen.devices; i += 1) await delay(100, null, { ref: false });
    assert.ok(seen.devices, "bridge 应在 6 秒内完成设备登记（POST /api/devices）");
    return await fn(seen.devices);
  } finally {
    try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    await new Promise((r) => wss.close(r));
    await new Promise((r) => api.close(r));
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("bridge 设备登记：配置里有 ref_code → POST /api/devices 必须带 ref_code", async () => {
  await withBridge({ ref_code: "368" }, (body) => {
    assert.equal(body.ref_code, "368", "★安装器 --ref 写的 ref_code 必须随设备登记上报（否则服务端无法归因）");
    assert.equal(body.device_id, "dev-000000000009", "既有字段照旧");
    assert.ok(body.pub_key && body.machine_fp, "既有登记字段不得丢失");
  });
});

test("bridge 设备登记：没有/非法 ref_code → 字段整个省略（不发空串、不发脏值）", async () => {
  // ① 配置里没有 ref_code
  await withBridge({}, (body) => {
    assert.ok(!("ref_code" in body), "没有归因码时字段必须缺席（服务端字段可选）");
  });
  // ② 配置里是被手改坏的值
  await withBridge({ ref_code: "not-a-code" }, (body) => {
    assert.ok(!("ref_code" in body), "非法值不得原样上报");
  });
});

// ───────────────────────── C. 安装器：磁盘上的 ref_code ─────────────────────────

/** 假 SaaS API：只要 public-config（安装器会读），其余 404。 */
async function startMockApi() {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/public-config") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ app_url: "http://127.0.0.1/app/" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** 隔离 HOME 跑安装器（--no-autostart/--no-plugin/--no-restart：不碰真实服务与 profile）。 */
function runSetup({ relayDir, home, api, args = [], env = {} }) {
  const childEnv = {
    ...process.env,
    HOME: home,
    DSH_RELAY_DIR: relayDir,
    DSH_PROFILE_DIR: path.join(home, "dsh-profile"),
    DSH_RELAY_SKIP_SERVICE: "1",
    DSH_RELAY_DEFAULT_API: api,
    DSH_REMOTE_TELEMETRY: "0",
    ...env,
  };
  // 开发机上的变量不得泄漏进来（否则「环境变量回退」用例结论不可信）
  for (const k of ["DSH_BRIDGE_CONFIG"]) delete childEnv[k];
  if (!("DSH_REF" in env)) delete childEnv.DSH_REF;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SETUP, "--api", api, "--no-autostart", "--no-plugin", "--no-restart", ...args],
      { env: childEnv, timeout: 60_000 },
      (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout: String(stdout || ""), stderr: String(stderr || "") })
    );
  });
}

async function readSetupConfig(relayDir) {
  return JSON.parse(await readFile(path.join(relayDir, ".dsh-config.json"), "utf8"));
}

test("安装器：--ref 写入 ref_code；升级不带 --ref 必须保留；非法值忽略且安装照常成功", async () => {
  const mock = await startMockApi();
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-setup-ref-"));
  try {
    const home = path.join(root, "home");
    await mkdir(home, { recursive: true });
    const relayDir = path.join(root, ".dsh-remote");

    // ① 首次安装：`npx @mrrisega/dsh-remote --ref 368`（同时给一个不同的 DSH_REF，锁「命令行优先」）
    const first = await runSetup({ relayDir, home, api: mock.base, args: ["--ref", "368"], env: { DSH_REF: "999" } });
    assert.equal(first.code, 0, `安装器应成功退出：${first.stderr}`);
    const cfg1 = await readSetupConfig(relayDir);
    assert.equal(cfg1.ref_code, "368", "★--ref 必须写进 .dsh-config.json 的 ref_code（命令行优先于 DSH_REF）");
    assert.equal(typeof cfg1.ref_code, "string", "契约要求是字符串（不是数字）");

    // ② 升级（重跑 setup，本次不带 --ref，环境里也没有 DSH_REF）→ 旧值必须原样保留
    const second = await runSetup({ relayDir, home, api: mock.base });
    assert.equal(second.code, 0, `升级也应成功退出：${second.stderr}`);
    const cfg2 = await readSetupConfig(relayDir);
    assert.equal(cfg2.ref_code, "368", "★升级时没带 --ref 不得清空已写入的 ref_code（saveConfig 是整对象覆盖）");

    // ③ 全新目录 + 非法 --ref：静默忽略，但安装必须照常成功（主链路优先）
    const home2 = path.join(root, "home2");
    await mkdir(home2, { recursive: true });
    const relayDir2 = path.join(root, ".dsh-remote-2");
    const third = await runSetup({ relayDir: relayDir2, home: home2, api: mock.base, args: ["--ref", "x"] });
    assert.equal(third.code, 0, `非法 --ref 绝不能导致安装失败：${third.stderr}`);
    assert.match(third.stdout + third.stderr, /安装完成/, "安装器应走完正常流程并打印「安装完成」");
    const cfg3 = await readSetupConfig(relayDir2);
    assert.ok(!("ref_code" in cfg3), "非法值必须被静默丢弃（不写空串、不写脏值）");
  } finally {
    await new Promise((r) => mock.server.close(r));
    await rm(root, { recursive: true, force: true });
  }
});

test("安装器：命令行没给 --ref 时用环境变量 DSH_REF", async () => {
  const mock = await startMockApi();
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-setup-ref-env-"));
  try {
    const home = path.join(root, "home");
    await mkdir(home, { recursive: true });
    const relayDir = path.join(root, ".dsh-remote");
    const r = await runSetup({ relayDir, home, api: mock.base, env: { DSH_REF: "456" } });
    assert.equal(r.code, 0, `安装器应成功退出：${r.stderr}`);
    assert.equal((await readSetupConfig(relayDir)).ref_code, "456", "DSH_REF 应作为 --ref 的回退写入配置");
  } finally {
    await new Promise((r2) => mock.server.close(r2));
    await rm(root, { recursive: true, force: true });
  }
});
