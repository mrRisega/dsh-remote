// 插件 node 半「彻底卸载（运行时/bridge 清理）」回归：/dsh-remote/self/uninstall 的新增行为。
// 背景：用户反馈卸载不干净——bridge 自启动服务（launchd com.dshremote.bridge / Linux dsh-bridge）
//       仍在运行、自启动 plist/unit 仍在、配置目录 ~/.dsh-remote（账号/设备密钥/.dsh-config.json/
//       .harness-cookie.json/固化运行时 dsh-setup.mjs + clients 等）也还在。
// 卸载路由现在依次执行：profile 插件清理（uninstallSelf，原逻辑）+ 运行时清理（uninstallRuntime：
// 停自启动服务 → 删自启动文件 → 杀残留进程 → rm -rf 配置目录），全部幂等、单项失败不致命。
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
      // 运行时清理标志位
      assert.equal(r.relayDirRemoved, true, "relayDir 应被整目录清空");
      assert.equal(r.servicePlatform, "launchd", "macOS 下 servicePlatform=launchd");
      assert.equal(r.stoppedService, false, "DSH_RELAY_SKIP_SERVICE=1 → 不触碰真实 launchd 服务");
      assert.equal(r.removedPlist, false);
      assert.deepEqual(r.killedPids, []);
      // 物理断言：relayDir 与其中全部残留都消失
      assert.equal(existsSync(relayDir), false, "relayDir 目录应整体不存在");
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
      assert.match(String(r.detail), /配置目录已清空/);
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
      assert.equal(r.relayDirRemoved, false, "目录本就不存在 → 不声称已清空");
      assert.equal(r.stoppedService, false);
      assert.equal(r.removedPlist, false);
      assert.deepEqual(r.killedPids, []);
      const detail = String(r.detail);
      assert.ok(!detail.includes("配置目录已清空"), "目录不存在时不应谎报已清空，实际: " + detail);
      assert.match(detail, /请重启 dsh web/);
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
      assert.equal(r.relayDirRemoved, false);
      assert.equal(r.removedPatch, false);
      assert.equal(r.removedDep, false);
      assert.equal(r.removedBundle, false);
      assert.deepEqual(r.killedPids, []);
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
      assert.equal(r.removedPlist, false, "开关置位 → plist 不得被删");
      assert.equal(existsSync(fakePlist), true, "plist 应原样保留（开关只放行配置目录清理）");
      assert.equal(r.relayDirRemoved, true, "配置目录清理不受开关影响");
      assert.equal(existsSync(relayDir), false);
    } finally {
      host.close();
    }
  } finally {
    delete process.env.DSH_RELAY_SKIP_SERVICE;
    process.env.HOME = prevHome;
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("自然跳过（无开关）：HOME 有 plist 但服务未运行 → 删除 plist 但不发 launchctl bootout（PATH 假命令接管）", { skip: process.platform !== "darwin" }, async () => {
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
      assert.equal(r.removedPlist, true, "plist 存在于当前 HOME → 应被删除");
      assert.equal(existsSync(plist), false);
      assert.equal(r.stoppedService, false, "服务未运行 → 无需 bootout，不虚报已停止");
      assert.deepEqual(r.killedPids, [], "无残留进程可杀");
      assert.equal(r.relayDirRemoved, true);
      assert.equal(existsSync(relayDir), false);
      // 关键：全程不得发出 bootout（避免任何真实/假服务被停）
      const log = readFileSync(launchLog, "utf8");
      assert.ok(!log.includes("bootout"), "未运行的服务不应触发 bootout，实际调用: " + log);
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
      assert.equal(r.relayDirRemoved, false, "profile 目录受保护 → 不得整目录删除");
      assert.equal(existsSync(profile), true, "dsh web profile 必须存活");
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
