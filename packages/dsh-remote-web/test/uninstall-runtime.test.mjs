// 插件 node 半「彻底卸载（运行时/bridge 清理）」回归：/dsh-remote/self/uninstall 的新增行为。
// 背景：用户反馈卸载不干净——bridge 自启动服务（launchd com.dshremote.bridge / Linux dsh-bridge）
//       仍在运行、自启动 plist/unit 仍在、配置目录 ~/.dsh-remote（账号/设备密钥/.dsh-config.json/
//       .harness-cookie.json/固化运行时 dsh-setup.mjs + clients 等）也还在。
// 0.6.7-beta.3 起卸载**分两段**（顺序是刻意的，见 uninstall 路由注释）：
//   ① 同步段：uninstallSelf（纯 fs、快）→ markUninstalled → 立刻回响应；
//   ② 异步段：运行时清理（停自启动/杀残留/清配置目录）交给**独立子进程**执行。
// 为什么必须这样：同步段里任何一次 spawnSync 卡住（Windows 沙箱拦 schtasks，而 spawnSync 的
// timeout 在 Windows 上并不可靠），旧实现会让 uninstallSelf 永远不执行、整个 dsh web 僵死
// （端口在听、无响应）。因此这些用例改为：断言响应契约（runtimeCleanup）+ 轮询等待子进程的物理结果。
// 测试隔离（绝不触碰本机真实 launchd/systemd/进程）：
//   - 大多数用例设 DSH_RELAY_SKIP_SERVICE=1 → 跳过一切系统级操作，只验证配置目录清理与 profile 清理；
//   - 「自然跳过」用例把 PATH 指向假 launchctl/pgrep/ps，完全接管系统命令后走无开关路径。
import assert from "node:assert/strict";
import http from "node:http";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等待条件成立：运行时清理现在是独立子进程，物理结果要等它跑完（而不是同步返回）。 */
async function waitFor(fn, { timeout = 10000, step = 50 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await sleep(step);
  }
}

/** 加载插件（要求调用方已把 process.env.HOME 指向 tempHome；profile 推导才落在 temp 而非真实 ~/.dsh）。 */
function boot(relayDir) {
  const routes = new Map();
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { return register(); },
    logger: { info() {}, warn() {} }
  }, { relayDir });
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

/** 在 tempHome 下造一份「真实安装痕迹」：profile（patch+package.json+插件目录）+ relayDir（配置/密钥/运行时）。 */
async function plantInstallation(tempHome, opts = {}) {
  const relayDir = opts.relayDir || path.join(tempHome, "relay");
  const profile = path.join(tempHome, ".dsh", "profiles", "web");
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, "cordis.patch.yml"), `base: .\ninclude:\n${PLUGIN_BLOCK}  - other-plugin\n`);
  await writeFile(path.join(profile, "package.json"), JSON.stringify({
    dependencies: { "dsh-remote-ui": "github:mrRisega/dsh-remote#path:/packages/dsh-remote-ui", "other": "^1.0.0" },
    dsh: { profile: { bundles: ["dsh-remote-ui", "other-bundle"] } },
  }));
  if (!opts.skipPluginDirs) {
    await mkdir(path.join(profile, "dsh-remote-ui-plugin"), { recursive: true });
    await mkdir(path.join(profile, "node_modules", "dsh-remote-ui"), { recursive: true });
    await writeFile(path.join(profile, "dsh-remote-ui-plugin", "index.js"), "// stub");
    await writeFile(path.join(profile, "node_modules", "dsh-remote-ui", "index.js"), "// stub");
  }
  if (!opts.skipRelay) {
    // 模拟固化运行时 + 账号/密钥/会话 cookie/安装标记等全部残留
    await mkdir(path.join(relayDir, "clients", "dsh-remote"), { recursive: true });
    await writeFile(path.join(relayDir, ".dsh-config.json"), JSON.stringify({
      phone: "13800000000", password: "pw", device_id: "dev", device_private_key: "pk", local_key: "lk",
      // ⚠️ api_url 必须显式指向本地不可达端口 —— 缺了它会回落到 DEFAULT_API(生产中继),
      // 而插件 boot 时会跑 reportInstallOnce → relayToken → bridgeSecretOf → fetch /api/public-config,
      // 于是这个「卸载」用例会去打**生产**。测试期网络护栏会把它拦成 ENETUNREACH(所以不会真污染),
      // 但那意味着用例是在「断网」分支上通过的,而不是它声称的场景。
      api_url: "http://127.0.0.1:1",
    }));
    await writeFile(path.join(relayDir, "dsh-setup.mjs"), "// runtime stub");
    await writeFile(path.join(relayDir, "clients", "dsh-remote", "dsh-bridge.mjs"), "// bridge stub");
    await writeFile(path.join(relayDir, ".harness-cookie.json"), JSON.stringify({ authority: "127.0.0.1:3080", cookie: "dsh-auth-x=1" }));
    await writeFile(path.join(relayDir, ".dsh-setup-installing"), JSON.stringify({ pid: 999999, at: Date.now() }));
    await writeFile(path.join(relayDir, ".dsh-update-running"), JSON.stringify({ pid: 999999, at: Date.now() }));
    await writeFile(path.join(relayDir, "unrelated-marker.txt"), "keep-me");
  }
  return { relayDir, profile };
}

test("彻底卸载：配置目录整目录清空（含账号/密钥/固化运行时），不误伤 profile 其它条目与家目录其它数据", { skip: process.platform !== "darwin" }, async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "dsh-ui-rt-"));
  const prevHome = process.env.HOME;
  process.env.HOME = tempHome;
  process.env.DSH_RELAY_SKIP_SERVICE = "1"; // 测试隔离：跳过 launchctl/systemctl/杀进程
  try {
    const { relayDir, profile } = await plantInstallation(tempHome);
    // 家目录里放一份「用户自己的数据」：卸载绝不能误删
    await writeFile(path.join(tempHome, "my-notes.txt"), "user data");
    const routes = boot(relayDir);
    const { host, base } = await serve(routes);
    try {
      const r = await (await fetch(`${base}/dsh-remote/self/uninstall`, { method: "POST" })).json();
      assert.equal(r.ok, true);
      // profile 清理（原 uninstallSelf 行为不变）
      assert.equal(r.removedPatch, true);
      assert.equal(r.removedDep, true);
      assert.equal(r.removedBundle, true);
      assert.equal(r.removedDir, true, "profile 插件目录与 node_modules 链接应删除");
      // 运行时清理交给独立子进程（响应先回，慢活不再钉住事件循环）
      assert.equal(r.runtimeCleanup, "deferred", "运行时清理必须由子进程接管（不得同步阻塞）");
      assert.ok(r.cleanupLog, "应给出清理日志路径");
      // 物理断言：等子进程跑完，relayDir 与其中全部残留都应消失
      assert.ok(await waitFor(() => !existsSync(relayDir)), "relayDir 应被整目录清空（子进程执行）");
      assert.equal(existsSync(path.join(relayDir, ".dsh-config.json")), false);
      assert.equal(existsSync(path.join(relayDir, "dsh-setup.mjs")), false);
      assert.equal(existsSync(path.join(relayDir, "clients")), false);
      // 不误伤：profile 的其它 include/依赖仍在；家目录其它文件仍在
      const patch = await readFile(path.join(profile, "cordis.patch.yml"), "utf8");
      assert.ok(!patch.includes("dsh-remote-ui") && patch.includes("other-plugin"), "patch 只移除插件条目");
      const pkg = JSON.parse(await readFile(path.join(profile, "package.json"), "utf8"));
      assert.equal(pkg.dependencies["other"], "^1.0.0");
      assert.deepEqual(pkg.dsh.profile.bundles, ["other-bundle"]);
      assert.equal(existsSync(path.join(tempHome, "my-notes.txt")), true, "家目录其它用户数据不得被删");
      assert.equal(existsSync(profile), true, "dsh web profile 目录整体不得被删");
      // 人类可读 detail
      assert.match(String(r.detail), /插件引用与本地文件已移除/);
      assert.match(String(r.detail), /正在后台清理/);
      assert.match(String(r.detail), /请重启 dsh web/);
    } finally {
      host.close();
    }
  } finally {
    delete process.env.DSH_RELAY_SKIP_SERVICE;
    process.env.HOME = prevHome;
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("彻底卸载边界：只装了插件、从未跑过 bridge → relayDir 不存在仍返回成功且不虚报「已清空」", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "dsh-ui-rt-nodir-"));
  const prevHome = process.env.HOME;
  process.env.HOME = tempHome;
  process.env.DSH_RELAY_SKIP_SERVICE = "1";
  try {
    // profile 有插件引用，但 relayDir（~/.dsh-remote）从未被创建
    const relayDir = path.join(tempHome, "relay");
    await plantInstallation(tempHome, { skipRelay: true });
    assert.equal(existsSync(relayDir), false);
    const routes = boot(relayDir);
    const { host, base } = await serve(routes);
    try {
      const r = await (await fetch(`${base}/dsh-remote/self/uninstall`, { method: "POST" })).json();
      assert.equal(r.ok, true);
      assert.equal(r.removedPatch, true, "profile 里的插件引用应照常清理");
      assert.equal(r.runtimeCleanup, "deferred");
      const detail = String(r.detail);
      assert.ok(!detail.includes("配置目录已清空"), "目录不存在时不应谎报已清空，实际: " + detail);
      assert.match(detail, /请重启 dsh web/);
      await sleep(800); // 等清理子进程跑完
      assert.equal(existsSync(relayDir), false, "relayDir 本来就不存在 → 不得被凭空创建");
    } finally {
      host.close();
    }
  } finally {
    delete process.env.DSH_RELAY_SKIP_SERVICE;
    process.env.HOME = prevHome;
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("彻底卸载边界：什么都没有安装 → 全链路幂等返回 ok，不抛错不崩溃", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "dsh-ui-rt-empty-"));
  const prevHome = process.env.HOME;
  process.env.HOME = tempHome;
  process.env.DSH_RELAY_SKIP_SERVICE = "1";
  try {
    const relayDir = path.join(tempHome, "relay"); // 不存在
    const routes = boot(relayDir);
    const { host, base } = await serve(routes);
    try {
      const r = await (await fetch(`${base}/dsh-remote/self/uninstall`, { method: "POST" })).json();
      assert.equal(r.ok, true);
      assert.equal(r.runtimeCleanup, "deferred");
      assert.equal(r.removedPatch, false);
      assert.equal(r.removedDep, false);
      assert.equal(r.removedBundle, false);
      assert.match(String(r.detail), /请重启 dsh web/);
      await sleep(800);
      assert.equal(existsSync(relayDir), false, "什么都没有也不该凭空创建目录");
    } finally {
      host.close();
    }
  } finally {
    delete process.env.DSH_RELAY_SKIP_SERVICE;
    process.env.HOME = prevHome;
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("DSH_RELAY_SKIP_SERVICE 开关：置位时即便存在自启动 plist 也不执行系统级清理，仅清空配置目录", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "dsh-ui-rt-gate-"));
  const prevHome = process.env.HOME;
  process.env.HOME = tempHome;
  process.env.DSH_RELAY_SKIP_SERVICE = "1";
  try {
    const { relayDir } = await plantInstallation(tempHome);
    // 在「当前 HOME 的 LaunchAgents」放一个真实存在的 plist：开关必须挡下删除动作
    const fakePlist = path.join(tempHome, "Library", "LaunchAgents", "com.dshremote.bridge.plist");
    await mkdir(path.dirname(fakePlist), { recursive: true });
    await writeFile(fakePlist, "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict/></plist>");
    const routes = boot(relayDir);
    const { host, base } = await serve(routes);
    try {
      const r = await (await fetch(`${base}/dsh-remote/self/uninstall`, { method: "POST" })).json();
      assert.equal(r.ok, true);
      assert.equal(r.runtimeCleanup, "deferred");
      assert.ok(await waitFor(() => !existsSync(relayDir)), "配置目录清理不受开关影响");
      assert.equal(existsSync(fakePlist), true, "开关置位 → plist 不得被删（子进程同样受开关约束）");
    } finally {
      host.close();
    }
  } finally {
    delete process.env.DSH_RELAY_SKIP_SERVICE;
    process.env.HOME = prevHome;
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("无开关（真实分支）：自启动清理由独立子进程执行，且走 PATH 上的假 launchctl（不碰真实服务）", { skip: process.platform !== "darwin" }, async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "dsh-ui-rt-natural-"));
  const prevHome = process.env.HOME;
  const prevPath = process.env.PATH;
  const prevLog = process.env.DSH_TEST_LAUNCH_LOG;
  process.env.HOME = tempHome;
  delete process.env.DSH_RELAY_SKIP_SERVICE; // 明确走无开关的真实分支
  const launchLog = path.join(tempHome, "launchctl.log");
  try {
    // 假系统命令：launchctl 只记录参数、绝不报 running；pgrep/ps 一律空
    const fakeBin = path.join(tempHome, "bin");
    await mkdir(fakeBin, { recursive: true });
    const fakeLaunchctl = `#!/bin/sh
printf '%s\n' "$*" >> "$DSH_TEST_LAUNCH_LOG"
exit 0
`;
    const fakeNoMatch = "#!/bin/sh\nexit 1\n";
    writeFileSync(path.join(fakeBin, "launchctl"), fakeLaunchctl); chmodSync(path.join(fakeBin, "launchctl"), 0o755);
    writeFileSync(path.join(fakeBin, "pgrep"), fakeNoMatch); chmodSync(path.join(fakeBin, "pgrep"), 0o755);
    writeFileSync(path.join(fakeBin, "ps"), fakeNoMatch); chmodSync(path.join(fakeBin, "ps"), 0o755);
    process.env.PATH = `${fakeBin}:${prevPath}`;
    process.env.DSH_TEST_LAUNCH_LOG = launchLog;

    const { relayDir } = await plantInstallation(tempHome);
    // 当前 HOME 的 LaunchAgents 里有 plist（服务此前装过，但现在未运行）
    const plist = path.join(tempHome, "Library", "LaunchAgents", "com.dshremote.bridge.plist");
    await mkdir(path.dirname(plist), { recursive: true });
    await writeFile(plist, "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict/></plist>");

    const routes = boot(relayDir);
    const { host, base } = await serve(routes);
    try {
      const r = await (await fetch(`${base}/dsh-remote/self/uninstall`, { method: "POST" })).json();
      assert.equal(r.ok, true);
      assert.equal(r.runtimeCleanup, "deferred", "无开关时同样走子进程");
      // 等清理子进程跑完（它继承 HOME/PATH → plist 路径与 launchctl 都落在测试环境里）
      assert.ok(await waitFor(() => !existsSync(plist)), "plist 应被清理子进程删除");
      assert.ok(await waitFor(() => !existsSync(relayDir)), "配置目录应被清空");
      // 关键安全性质：清理用的是 PATH 上的**假** launchctl —— 证明没有触碰任何真实服务
      const log = existsSync(launchLog) ? readFileSync(launchLog, "utf8") : "";
      assert.ok(log.includes("com.dshremote.bridge"), "应通过（假）launchctl 清理自启动，实际: " + log);
    } finally {
      host.close();
    }
  } finally {
    if (prevLog === undefined) delete process.env.DSH_TEST_LAUNCH_LOG; else process.env.DSH_TEST_LAUNCH_LOG = prevLog;
    process.env.PATH = prevPath;
    process.env.HOME = prevHome;
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("保护参数：relayDir 误配置成 dsh web profile 目录 → 绝不整目录删除（防误删 dsh 本体）", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "dsh-ui-rt-protect-"));
  const prevHome = process.env.HOME;
  process.env.HOME = tempHome;
  process.env.DSH_RELAY_SKIP_SERVICE = "1";
  try {
    // relayDir 与 profileDir 相同（异常配置）：卸载只清插件引用/文件，绝不能 rm 整个 profile
    const profile = path.join(tempHome, ".dsh", "profiles", "web");
    const { relayDir } = await plantInstallation(tempHome, { relayDir: profile, skipRelay: true });
    assert.equal(relayDir, profile);
    const routes = boot(relayDir);
    const { host, base } = await serve(routes);
    try {
      const r = await (await fetch(`${base}/dsh-remote/self/uninstall`, { method: "POST" })).json();
      assert.equal(r.ok, true);
      assert.equal(r.runtimeCleanup, "deferred");
      await sleep(1000); // 等清理子进程跑完：它必须自己判断出"这是 profile，不许删"
      assert.equal(existsSync(profile), true, "dsh web profile 必须存活（子进程也受同一条护栏约束）");
      assert.equal(existsSync(path.join(profile, "package.json")), true);
      assert.equal(existsSync(path.join(profile, "dsh-remote-ui-plugin")), false, "插件子目录应被 uninstallSelf 单独移除");
      assert.equal(existsSync(path.join(profile, "node_modules", "dsh-remote-ui")), false);
    } finally {
      host.close();
    }
  } finally {
    delete process.env.DSH_RELAY_SKIP_SERVICE;
    process.env.HOME = prevHome;
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("源码约束：浏览器半彻底卸载文案与行为说明 bridge 服务与本地配置一并移除/清空", () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  // 二次确认文案：说明会停 bridge 自启动、清配置目录（不再有旧的「bridge 与数据目录保留」误导）
  assert.match(source, /停止并移除 bridge 自启动服务/);
  assert.match(source, /清空本地配置目录/);
  assert.ok(!source.includes("bridge 与数据目录保留"), "旧文案已移除：卸载不再保留 bridge 与数据目录");
  // 成功提示：优先展示服务端 detail，兜底文案同样声明 bridge/本地配置已移除
  assert.match(source, /b\.detail/);
  assert.match(source, /bridge 自启动服务与本地配置目录/);
  assert.match(source, /请重启 dsh web/);
});
