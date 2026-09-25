// 运行环境随插件分发（0.6.12）的用例。
//
// 背景（2026-09-23 生产取证）：Windows 上「装插件 → 后台 npx 装运行环境」是最大的流失源 ——
// 近 14 天 427 台 win32 里 138 台 install_failed（32%）；v0.6.6 的 95 台里 73 台装机失败，
// 其中 48 台点过「一键更新」却一台都没救回来（Node ≥20.12 上 spawn npx.cmd 不带 shell 抛 EINVAL）。
// 现在插件包自带 runtime/（scripts/bundle-runtime.mjs 打进 npm 包与 GitHub Release 资产），
// 补装退化为**本地拷贝**：零网络、零 npx、零控制台代码页，且运行环境版本恒等于插件版本。
//
// 本文件锁死三条不变量：
//   ① 打包产物完整（入口 + 入口点名的 clients 文件 + ws），且**不含** test/ 这类垃圾；
//   ② 半装运行环境（入口在、依赖不在）→ 用自带运行环境**整份补齐**，全程不碰 npx；
//   ③ 自带运行环境本身不完整/不存在 → 老实回落到 npx（绝不假装成功）。
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { apply } from "../lib/index.js";

// ⚠️ 必须用 fileURLToPath：Windows 上 `new URL(...).pathname` 得到的是 "/D:/a/..."（带前导斜杠），
// path.join 之后会拼成 "D:\\D:\\a\\..." → ENOENT。CI 的 Windows 专项就死在这条上。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "..");
const BUNDLER = path.join(ROOT, "scripts", "bundle-runtime.mjs");
const PKG_JSON = path.join(ROOT, "packages", "dsh-remote-web", "package.json");

const readOrEmpty = async (p) => { try { return await readFile(p, "utf8"); } catch { return ""; } };
async function waitFor(fn, { timeout = 5000, step = 25 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}

/** 假 npx：只记参数（用例必须证明「该走本地拷贝时一次 npx 都不调」）。 */
const FAKE_NPX = `#!/bin/sh
printf '%s\\n' "$*" >> "$DSH_TEST_NPX_LOG"
exit 0
`;

async function makeEnv() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-rtbundle-"));
  const fakeBin = path.join(root, "bin");
  const relayDir = path.join(root, "relay");
  const fakeHome = path.join(root, "home");           // 必须伪造 HOME（见 setup-output.test.mjs 的静态护栏）
  await mkdir(fakeBin, { recursive: true });
  await mkdir(relayDir, { recursive: true });
  await mkdir(fakeHome, { recursive: true });
  const npxLog = path.join(root, "npx.log");
  await writeFile(npxLog, "");
  for (const name of ["npx", "npx.cmd"]) {
    await writeFile(path.join(fakeBin, name), FAKE_NPX);
    await chmodSync(path.join(fakeBin, name), 0o755);
  }
  const saved = {};
  for (const k of ["HOME", "PATH", "DSH_TEST_NPX_LOG", "DSH_SETUP_NPX_DIR", "DSH_RELAY_SKIP_SERVICE",
    "DSH_RELAY_PLATFORM", "DSH_REMOTE_TELEMETRY", "DSH_RELAY_DEFAULT_API", "DSH_RELAY_BUNDLED_RUNTIME"]) {
    saved[k] = process.env[k];
  }
  process.env.HOME = fakeHome;
  process.env.PATH = `${fakeBin}:${saved.PATH || ""}`;
  process.env.DSH_TEST_NPX_LOG = npxLog;
  process.env.DSH_SETUP_NPX_DIR = fakeBin;
  process.env.DSH_RELAY_PLATFORM = "win32";        // 反馈来自 Windows；win32 分支不碰 launchctl
  process.env.DSH_REMOTE_TELEMETRY = "0";
  process.env.DSH_RELAY_DEFAULT_API = "http://127.0.0.1:1";
  delete process.env.DSH_RELAY_SKIP_SERVICE;       // 走真实分支（npx 是假的）
  // 默认指向不存在的目录：本机跑过 npm pack / npm publish 后 packages/dsh-remote-web/runtime 会存在，
  // 那会让"没有自带运行环境"的用例前提失效（实测：全量套件里这条因此变红）。
  process.env.DSH_RELAY_BUNDLED_RUNTIME = "/nonexistent-dsh-bundled";
  return {
    root, relayDir, npxLog,
    async restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function boot(relayDir) {
  const routes = new Map();
  const disposers = [];
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { const d = register(); if (typeof d === "function") disposers.push(d); return d; },
    logger: { info() {}, warn() {} },
  }, { relayDir });
  routes.dispose = () => { for (const d of disposers) { try { d(); } catch { /* 忽略 */ } } };
  return routes;
}

async function serve(routes) {
  const host = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, "http://x").pathname);
    (handler || ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  return { host, base: `http://127.0.0.1:${host.address().port}` };
}

/** 半装运行环境：入口在，且它**点名**的文件不在（这正是用户卡死的现场）。 */
const HALF_INSTALL_ENTRY = `import { childStopped } from "./clients/dsh-remote/src/lifecycle.mjs";
export const bridge = new URL("./clients/dsh-remote/dsh-bridge.mjs", import.meta.url);
export { childStopped };
`;

test("打包脚本：产物完整（入口 + 点名文件 + ws）、不含 test/，且自检通过", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "dsh-runtime-out-"));
  try {
    const r = spawnSync(process.execPath, [BUNDLER, "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 0, `打包脚本必须成功：${r.stdout}${r.stderr}`);
    for (const rel of [
      "dsh-setup.mjs",
      "clients/dsh-remote/dsh-bridge.mjs",
      "clients/dsh-remote/src/lifecycle.mjs",
      "node_modules/ws/package.json",
    ]) {
      assert.ok(existsSync(path.join(out, rel)), `产物缺 ${rel} —— 半装运行环境就是用户卡死的直接原因`);
    }
    assert.ok(!existsSync(path.join(out, "clients", "dsh-remote", "test")), "测试目录不该进运行时产物（体积）");
    // 自检模式：发布门禁会用它
    const chk = spawnSync(process.execPath, [BUNDLER, "--check", "--out", out], { encoding: "utf8" });
    assert.equal(chk.status, 0, `自检必须通过：${chk.stdout}${chk.stderr}`);

    // 反例：产物不完整时自检必须**失败**（宁可发布失败，也不发一个半装运行环境出去）
    rmSync(path.join(out, "clients", "dsh-remote", "src", "lifecycle.mjs"));
    const bad = spawnSync(process.execPath, [BUNDLER, "--check", "--out", out], { encoding: "utf8" });
    assert.notEqual(bad.status, 0, "缺文件时自检必须非 0");
    assert.match(String(bad.stderr || bad.stdout), /不完整/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("打包契约：插件 package.json 声明了 runtime 与 prepack，且 runtime/ 不入库", () => {
  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes("runtime"),
    "files 必须含 runtime，否则 npm pack / GitHub Release 资产里没有运行环境");
  assert.match(String(pkg.scripts && pkg.scripts.prepack || ""), /bundle-runtime\.mjs/,
    "prepack 必须在打包前生成 runtime/（发布流程依赖它）");
  const gi = readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  assert.match(gi, /packages\/dsh-remote-web\/runtime\//,
    "runtime/ 是构建产物：必须 gitignore，否则 dsh-setup.mjs/clients 会有两份互相漂移的副本");
});

test("半装运行环境 → 用插件自带的运行环境整份补齐，全程不碰 npx（Windows 装机失败类的根治）", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "dsh-runtime-src-"));
  spawnSync(process.execPath, [BUNDLER, "--out", out], { encoding: "utf8" });
  const env = await makeEnv();
  process.env.DSH_RELAY_BUNDLED_RUNTIME = out;   // 必须早于 boot：apply() 里就会用自带运行环境补装
  const routes = boot(env.relayDir);
  const { host, base } = await serve(routes);
  try {
    // 半装：入口在、依赖不在 —— 旧实现会报「运行环境: 已就绪」，然后插起来的守护秒退
    await writeFile(path.join(env.relayDir, "dsh-setup.mjs"), HALF_INSTALL_ENTRY);
    await writeFile(path.join(env.relayDir, ".dsh-config.json"),
      JSON.stringify({ phone: "13800000000", password: "pw", api_url: "http://127.0.0.1:1" }));
    const r = await (await fetch(`${base}/dsh-remote/bridge-status`)).json();
    assert.equal(r.connect.runtimeReady, true, "自带运行环境补齐后必须报就绪");
    assert.deepEqual(r.connect.runtimeMissing, [], "补齐后不得再缺文件");
    assert.ok(existsSync(path.join(env.relayDir, "clients", "dsh-remote", "src", "lifecycle.mjs")),
      "入口点名的 lifecycle.mjs 必须被补齐（这正是半装运行环境缺的那个文件）");
    assert.ok(existsSync(path.join(env.relayDir, "node_modules", "ws", "package.json")), "依赖 ws 必须一起就位");
    assert.equal((await readOrEmpty(path.join(env.relayDir, ".dsh-setup-version"))).trim(),
      JSON.parse(readFileSync(PKG_JSON, "utf8")).version, "运行时版本标记必须等于插件版本（不再出现版本错配）");
    assert.equal((await readOrEmpty(env.npxLog)).trim(), "",
      "该走本地拷贝时**一次 npx 都不该调**（npx 正是 Windows 上的失败源）");
    assert.match(await readOrEmpty(path.join(env.relayDir, ".dsh-setup-install.log")), /自带的运行环境就地补齐/);
  } finally {
    host.close(); routes.dispose(); await env.restore();
    rmSync(out, { recursive: true, force: true });
  }
});

test("自带运行环境本身不完整 → 老实回落到 npx（绝不假装补齐成功）", async () => {
  const broken = await mkdtemp(path.join(os.tmpdir(), "dsh-runtime-broken-"));
  const env = await makeEnv();
  process.env.DSH_RELAY_BUNDLED_RUNTIME = broken; // 同上：apply() 先试自带、失败再落 npx
  const routes = boot(env.relayDir);
  const { host, base } = await serve(routes);
  try {
    // 「自带」目录只放入口、不放依赖 → 拷贝后自检必然失败
    await writeFile(path.join(broken, "dsh-setup.mjs"), HALF_INSTALL_ENTRY);
    await writeFile(path.join(env.relayDir, "dsh-setup.mjs"), HALF_INSTALL_ENTRY);
    await writeFile(path.join(env.relayDir, ".dsh-config.json"),
      JSON.stringify({ phone: "13800000000", password: "pw", api_url: "http://127.0.0.1:1" }));
    await fetch(`${base}/dsh-remote/bridge-status`);
    assert.ok(await waitFor(async () => (await readOrEmpty(env.npxLog)).includes("@mrrisega/dsh-remote")),
      "自带运行环境不完整时必须回落 npx 补装，实际 npx 日志：" + (await readOrEmpty(env.npxLog)));
    assert.match(await readOrEmpty(path.join(env.relayDir, ".dsh-setup-install.log")), /仍不完整/);
  } finally {
    host.close(); routes.dispose(); await env.restore();
    rmSync(broken, { recursive: true, force: true });
  }
});
