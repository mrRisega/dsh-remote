/**
 * ★★ 回归锁：自愈 watcher **不许**把"探测失败"翻译成"每 12 秒杀掉一次隧道"。
 *
 * 现场（线上反馈 `fb_3c4c5a13bc47`，用户 842，Linux fyf-MS-7D42，npx 安装，插件 0.6.18）：
 *   用户原话「是给用户列出几个选项选择的那种窗口，总是一会出现、一会儿消失，持续不停。」
 *
 * 只读诊断（`dsh-relay-internal/2026-10-13-反馈fb_3c4c5a13bc47-诊断.md`）给出的证据链：
 *   · `audit_log` 里该设备当天 `device.claim` **3567 次**，相邻间隔 p50 **12001ms**、p90 12281ms，
 *     连续 10 小时整点 300 次/小时（300 × 12s = 3600s）。而 `device.claim` 是 **bridge 进程启动**
 *     的必然产物（一个进程只登记一次）→ 3567 次 = 3567 次进程启动；
 *   · `relay_sessions` 该设备 236 条 ws 会话里 235 条挤在 2h20m 内，单条时长均值 5.3s、最大 7.4s，
 *     相邻间隔 p50 7.05s（+ 隧道建立 ≈12.3s 一个完整周期）；
 *   · 每次新 bridge 连接顶掉旧隧道 → 中继 `close(1012 "bridge offline")` 掉该设备**所有**手机镜像
 *     WS → 镜像页每 12 秒断线重连并**全量重放**界面（同一份 bytes 反复出现）→ 交互弹窗的临时
 *     界面状态被反复销毁重建 = 用户看到的"一会儿显示、一会儿消失"；
 *   · 全站性：上百台设备每天 1.1~1.5 万次重登记，多台设备间隔 p50 精确 ≈12.0s
 *     （11996/11998/12000/12001/12002ms）—— 只可能来自客户端同一个 12s 常量；
 *   · 中继侧对这类 churn 只做了日志抑制，所以**运维侧一直没发现**。
 *
 * 代码落点：`lib/index.js` 的 `scheduleRuntime()`（12s 定时器）→ 就绪判据只有
 * `launchdStatus().running` 与 `manualStatus().watcher.length > 0`（后者靠 `pgrep` 名称匹配，
 * 极易拿到空结果）→ 判据为假就 `startBridge()` → `startBridgeLinux()` → **无条件**
 * `systemctl --user restart dsh-bridge`（restart 会杀掉正在健康运行的 bridge）。
 *
 * 本文件锁死的四件事（对应用户给的四条修复要求）：
 *   ① **权威判据**：`systemctl --user is-active` 说 active ⇒ 就是"在跑"，pgrep 说什么都不算；
 *   ② **幂等**：已 active 时自愈**绝不得**调用 `systemctl restart`（假 runner 断言调用次数为 0）；
 *   ③ **成功即止**：一旦判定就绪，同一进程生命周期内定时器真的停摆（后续 systemctl 调用数冻结）；
 *   ④ **熔断 + 退避 + 可观测**：最小重启间隔内不重复重启；同一进程内最多 3 次；触顶后停手
 *      并把原因写进**可见**的安装日志（面板「复制诊断信息」与用户主动上报都会带它的尾部）。
 *
 * ⚠️ 测试隔离（与 `linux-bridge.test.mjs` 同一套手法）：
 *   · 走**真实分支**（删掉 DSH_RELAY_SKIP_SERVICE），所以必须伪造 HOME 与 PATH；
 *   · 所有系统命令都是假 PATH 上的假脚本（`systemctl` 只写调用日志 + 读写状态文件），
 *     **不会**碰开发者本机上真实的 systemd/launchd；
 *   · 预置一份 `.dsh-watcher.pid` 指向**本测试进程**（必然存活）→ `startBridgeDetached`
 *     的"已在跑"分支立刻返回，因此**不会真的派生**任何后台进程。
 */
import assert from "node:assert/strict";
import http from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { apply } from "../lib/index.js";
import { __scheduleRuntime, __startBridge } from "../lib/index.js";
import {
  __linuxSystemdUnitState,
  __selfhealRestartGate,
  __noteSelfhealRestart,
  __noteSelfhealBlocked,
  __resetSelfhealGuard,
  __selfhealGuardOf,
  __SELFHEAL_MAX_RESTARTS,
} from "../lib/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 本轮上游地址（显式给死，免得依赖 boundWebPort / 端口发现 → 用例结果与开发机状态耦合）。 */
const UPSTREAM = "http://127.0.0.1:12345";
/** 模拟"上游地址在抖"时被写回来的旧值。 */
const UPSTREAM_OLD = "http://127.0.0.1:3080";

/**
 * 假 systemctl：**每一次调用都记进日志**（用例据此断言 `restart` 被调用了几次），
 * 状态机放在一个文件里，于是"restart 之后 bridge 真的起来了没有"由用例决定：
 *   · DSH_TEST_RESTART_HEALS=1 → restart 把状态置为 active（模拟重启后真的恢复）；
 *   · =0 → restart 不改变状态（模拟"重启了但起不来"）。
 */
const FAKE_SYSTEMCTL = `#!/bin/sh
printf '%s\\n' "$*" >> "$DSH_TEST_SYSTEMCTL_LOG"
case "$*" in
  *show-environment*) exit 0 ;;
  *is-active*)
    s="$(cat "$DSH_TEST_SYSTEMCTL_STATE" 2>/dev/null)"
    [ -z "$s" ] && s=inactive
    echo "$s"
    [ "$s" = "active" ] && exit 0 || exit 3
    ;;
  *daemon-reload*) exit 0 ;;
  *enable*) exit 0 ;;
  *restart*)
    if [ "$DSH_TEST_RESTART_HEALS" = "1" ]; then printf 'active\\n' > "$DSH_TEST_SYSTEMCTL_STATE"; fi
    exit 0
    ;;
esac
exit 0
`;

/**
 * 隔离环境：假 HOME（systemd unit 落这里）+ 假 systemctl/pgrep/ps + 临时 relayDir。
 * @param {{state?:string, heals?:boolean, minRestartMs?:number, selfhealMs?:number}} opts
 *   state = 假 systemd 的初始状态（active/inactive/failed）；heals = restart 之后是否变成 active。
 */
function makeEnv({ state = "inactive", heals = false, minRestartMs = 60_000, selfhealMs = 25 } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-selfheal-"));
  const fakeBin = path.join(root, "bin");
  const fakeHome = path.join(root, "home");
  const relayDir = path.join(root, "relay");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(relayDir, { recursive: true });

  const sysctlLog = path.join(root, "systemctl.log");
  const sysctlState = path.join(root, "systemctl.state");
  writeFileSync(sysctlLog, "");
  writeFileSync(sysctlState, `${state}\n`);
  writeFileSync(path.join(fakeBin, "systemctl"), FAKE_SYSTEMCTL);
  chmodSync(path.join(fakeBin, "systemctl"), 0o755);
  // 假 pgrep：**一个进程都不匹配**（= 本次故障里那个"极易拿到空结果"的探测）。
  // 用例要证明的正是：即使它一无所获，只要 systemd 说 active，就绝不许 restart。
  for (const n of ["pgrep", "ps"]) {
    writeFileSync(path.join(fakeBin, n), "#!/bin/sh\nexit 1\n");
    chmodSync(path.join(fakeBin, n), 0o755);
  }

  // 运行环境入口：无相对 import → runtimeReady 判定为就绪（不会去跑 npx 补装）。
  writeFileSync(path.join(relayDir, "dsh-setup.mjs"), "// 测试用运行环境入口（无相对 import）\n");
  // 已登录（local_key 即视为有账号）→ 自愈 watcher 才会走到"服务在不在跑"这一步。
  writeFileSync(path.join(relayDir, ".dsh-config.json"), JSON.stringify({
    api_url: "http://127.0.0.1:1", local_key: "test-local-key", device_id: "dev-test-selfheal",
  }));
  // 上游文件预先写成与 DSH_BRIDGE_UPSTREAM 一致 → publishUpstream() 回报 changed=false
  // （否则"上游刚变过"本身就是一个合法的重启理由，会把用例的意图搅浑）。
  writeFileSync(path.join(relayDir, ".dsh-upstream"), `${UPSTREAM}\n`);
  // ⚠️ 关键隔离：pid 文件指向**本测试进程**（必然存活）→ startBridgeDetached 的
  //   "已在跑，别再拉第二个"分支立刻返回 → 用例永远不会真的派生后台 bridge 进程。
  writeFileSync(path.join(relayDir, ".dsh-watcher.pid"), `${process.pid}\n`);

  const saved = {};
  const keys = ["HOME", "PATH", "DSH_RELAY_PLATFORM", "DSH_RELAY_SKIP_SERVICE", "DSH_REMOTE_TELEMETRY",
    "DSH_RELAY_SELFHEAL_MS", "DSH_RELAY_SELFHEAL_MIN_RESTART_MS", "DSH_RELAY_DEFAULT_API",
    "DSH_BRIDGE_UPSTREAM", "DSH_WEB_URL", "XDG_RUNTIME_DIR", "DSH_BRIDGE_INSTALL_SOURCE",
    "DSH_TEST_SYSTEMCTL_LOG", "DSH_TEST_SYSTEMCTL_STATE", "DSH_TEST_RESTART_HEALS"];
  for (const k of keys) saved[k] = process.env[k];

  process.env.HOME = fakeHome;
  process.env.PATH = `${fakeBin}${path.delimiter}${saved.PATH || ""}`;
  process.env.DSH_RELAY_PLATFORM = "linux";
  process.env.DSH_REMOTE_TELEMETRY = "0";
  process.env.DSH_RELAY_DEFAULT_API = "http://127.0.0.1:1";
  process.env.DSH_BRIDGE_UPSTREAM = UPSTREAM;
  process.env.XDG_RUNTIME_DIR = path.join(root, "run");
  mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true });
  process.env.DSH_RELAY_SELFHEAL_MS = String(selfhealMs);
  process.env.DSH_RELAY_SELFHEAL_MIN_RESTART_MS = String(minRestartMs);
  process.env.DSH_TEST_SYSTEMCTL_LOG = sysctlLog;
  process.env.DSH_TEST_SYSTEMCTL_STATE = sysctlState;
  process.env.DSH_TEST_RESTART_HEALS = heals ? "1" : "0";
  delete process.env.DSH_RELAY_SKIP_SERVICE; // 走真实分支，但系统命令全是假脚本
  delete process.env.DSH_WEB_URL;
  delete process.env.DSH_BRIDGE_INSTALL_SOURCE;

  return {
    root, relayDir, fakeHome, sysctlLog, sysctlState,
    /** systemctl 被调用过的**所有**命令行（一行一次）。 */
    calls: () => readFileSync(sysctlLog, "utf8").split("\n").filter(Boolean),
    /** 断言用：某个子命令被调用了几次。 */
    count: (needle) => readFileSync(sysctlLog, "utf8").split("\n").filter((l) => l.includes(needle)).length,
    installLog: () => {
      const p = path.join(relayDir, ".dsh-setup-install.log");
      return existsSync(p) ? readFileSync(p, "utf8") : "";
    },
    /** 上游文件"抖"回旧值（见护栏用例）。 */
    rewindUpstream: () => writeFileSync(path.join(relayDir, ".dsh-upstream"), `${UPSTREAM_OLD}\n`),
    setState: (s) => writeFileSync(sysctlState, `${s}\n`),
    restore() {
      __resetSelfhealGuard(relayDir);
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 起一个只跑插件路由的假宿主（与 `linux-bridge.test.mjs` 同一手法）：只为驱动真实的面板端点。 */
function bootRoutes(relayDir) {
  const routes = new Map();
  const disposers = [];
  apply({
    webServer: { port: 0, register(route) { routes.set(route.path, route.handler); return () => {}; } },
    get() { return null; },
    effect(register) { const d = register(); if (typeof d === "function") disposers.push(d); return d; },
    logger: { info() {}, warn() {} },
  }, { relayDir });
  routes.dispose = () => { for (const d of disposers) { try { d(); } catch { /* ignore */ } } };
  return routes;
}

async function serveRoutes(routes) {
  const host = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, "http://x").pathname);
    (handler || ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${host.address().port}`,
    async close() { await new Promise((r) => host.close(r)); },
  };
}

// ─────────────── ① 权威判据 + ② 幂等：已 active 时自愈绝不得 restart ───────────────
test("★ ①：systemctl 说 active（而 pgrep 一无所获）→ 自愈 watcher 必须判定「就绪」，restart 调用 0 次", async () => {
  const env = makeEnv({ state: "active" });
  let stop = null;
  try {
    // 前置：权威判据本身要能读出 active（三态里的"明确 active"）
    assert.deepEqual(__linuxSystemdUnitState(), { known: true, active: true, raw: "active" });

    stop = __scheduleRuntime(env.relayDir);
    await sleep(400); // 自愈间隔 25ms → 这段窗口内本会跑十几拍

    const calls = env.calls();
    assert.equal(env.count("restart"), 0,
      `★ 已 active 就绝不许 restart（那是这台机器上唯一会造成"手机镜像每 12 秒断一次"的动作）。`
      + `实际调用：\n${calls.join("\n")}`);
    assert.equal(env.count("stop"), 0, "更不许 stop：停掉正在跑的 bridge 会直接断掉用户的远程访问");
    assert.ok(env.calls().some((l) => l.includes("is-active")), "应当用 is-active 做权威判据，而不是猜进程名");

    // 判定就绪 → 循环停摆：调用数必须冻结（不只是"被限流"，是真的不再探了）
    const frozen = env.calls().length;
    await sleep(300);
    assert.equal(env.calls().length, frozen, "★ 判定就绪后定时器必须真的停摆（调用数冻结）");

    // 可观测：留下"判定就绪、已停止自愈循环"的一行（同一条结论只写一次）
    const log = env.installLog();
    assert.match(log, /自愈判定 bridge 已就绪，已停止自愈循环/, `安装日志必须留下判据与依据，实际：\n${log}`);
    assert.match(log, /systemd --user is-active=active/, "日志要写清依据是 systemd 的权威回答");
    assert.doesNotMatch(log, /自愈重启 bridge/, "既然没重启，就不该有重启记录");
  } finally {
    stop?.();
    env.restore();
  }
});

test("★ ②：已 active 时反复调用 startBridge（面板重试/自愈轮次）也必须幂等 —— restart 恒为 0 次", () => {
  const env = makeEnv({ state: "active" });
  try {
    for (let i = 0; i < 6; i += 1) {
      const r = __startBridge(env.relayDir);
      assert.equal(r.ok, true, `已 active 时必须如实回报 ok（第 ${i + 1} 次），实际 ${JSON.stringify(r)}`);
      assert.equal(r.reused, true, `已 active 时必须标记 reused（第 ${i + 1} 次）`);
      assert.equal(r.status, "running");
    }
    assert.equal(env.count("restart"), 0,
      `★ 幂等闸门失效：已 active 却调了 restart。实际调用：\n${env.calls().join("\n")}`);
    assert.equal(env.count("daemon-reload"), 0, "既然没必要重启，就不该连 daemon-reload 一起做（避免无谓的 systemd 抖动）");
    assert.equal(env.count("enable"), 0);
  } finally {
    env.restore();
  }
});

// ─────────────── ② + ③：确实没在跑才重启，且最小间隔内不重复、成功即止 ───────────────

test("★ ②③：真的不 active 时才重启**一次**；成功即止（同一进程生命周期内不再有 restart）", async () => {
  // 模拟"systemd 里它确实没在跑，但 restart 之后真的起来了"
  const env = makeEnv({ state: "inactive", heals: true, minRestartMs: 60_000, selfhealMs: 25 });
  let stop = null;
  try {
    stop = __scheduleRuntime(env.relayDir);
    await sleep(250);
    assert.equal(env.count("restart"), 1,
      `★ 只该重启一次，实际 ${env.count("restart")} 次：\n${env.calls().join("\n")}`);

    // 成功即止：定时器必须停摆，后续调用数冻结（不是"每 25ms 被限流一次"）
    const frozen = env.calls().length;
    await sleep(300);
    assert.equal(env.count("restart"), 1, "★ 判定成功后再也不许有 restart 调用");
    assert.equal(env.calls().length, frozen, "★ 判定成功之后定时器必须停摆（调用数冻结）");

    const log = env.installLog();
    assert.match(log, /自愈重启 bridge（第 1\/3 次/, `重启必须留可见日志，实际：\n${log}`);
    assert.match(log, /→ running/, "日志要带上重启后的结果");
    assert.match(log, /自愈判定 bridge 已就绪，已停止自愈循环/, "就绪后要写「循环已停」的一行");
  } finally {
    stop?.();
    env.restore();
  }
});

test("★ ④：最小重启间隔内**不重复**重启，并且写下可见的「已暂缓」日志", () => {
  // 起不来（heals=false）+ 最小间隔 60 秒：真实重启只许发生 1 次，后面的尝试全被拦下。
  const env = makeEnv({ state: "inactive", heals: false, minRestartMs: 60_000 });
  try {
    for (let i = 0; i < 5; i += 1) __startBridge(env.relayDir);
    assert.equal(env.count("restart"), 1,
      `★ 最小间隔（60s）内不得重复 restart，实际 ${env.count("restart")} 次：\n${env.calls().join("\n")}`);

    const log = env.installLog();
    assert.match(log, /已暂缓自愈重启 bridge：距上次重启不足 60 秒/, `实际：\n${log}`);
    // 去重：同一条结论只说一次（否则每 12 秒一行，用户复制过来的诊断里全是重复行）
    const hits = log.split("\n").filter((l) => l.includes("已暂缓自愈重启 bridge")).length;
    assert.equal(hits, 1, `同一条"已暂缓"结论不得刷屏，实际 ${hits} 行`);
  } finally {
    env.restore();
  }
});

// ─────────────── ④ 熔断触顶：停手 + 明确报错 ───────────────

test("★ ④：破坏性重启触顶（本进程最多 3 次）后**停手**，并写下明确的熔断日志", () => {
  // 场景：上游地址在抖（上游文件被另一个组件写回旧值）→ 每轮都会认为"需要重启才能生效"。
  // 这正是护栏存在的意义：哪怕上游真的在抖，也绝不能退化成"每 12 秒杀一次隧道"。
  const env = makeEnv({ state: "active", minRestartMs: 0 });
  try {
    for (let i = 0; i < 6; i += 1) {
      env.rewindUpstream();     // 上游地址又变了 → 又一个"合法的重启理由"
      __startBridge(env.relayDir);
    }
    assert.equal(env.count("restart"), __SELFHEAL_MAX_RESTARTS,
      `★ 同一进程内最多 ${__SELFHEAL_MAX_RESTARTS} 次破坏性重启，实际 ${env.count("restart")} 次：\n${env.calls().join("\n")}`);
    assert.equal(__selfhealGuardOf(env.relayDir).count, __SELFHEAL_MAX_RESTARTS);

    const log = env.installLog();
    assert.match(log, /已停止自愈重启 bridge：本进程生命周期内已重启 3 次仍未就绪/, `实际：\n${log}`);
    assert.match(log, /已熔断/, "要把「熔断」这个结论明确写给用户/运维");
    assert.match(log, /一键更新/, "要给出下一步动作，而不是只报一个错误");
    const hits = log.split("\n").filter((l) => l.includes("已停止自愈重启 bridge")).length;
    assert.equal(hits, 1, `熔断结论只说一次，实际 ${hits} 行`);

    // 触顶之后再怎么抖，也不许再动 bridge
    for (let i = 0; i < 3; i += 1) { env.rewindUpstream(); __startBridge(env.relayDir); }
    assert.equal(env.count("restart"), __SELFHEAL_MAX_RESTARTS, "★ 触顶后必须彻底停手");
  } finally {
    env.restore();
  }
});

test("★ ④ 护栏本身：纯查询语义（不记账）+ 三态边界", () => {
  const env = makeEnv({ state: "inactive", minRestartMs: 1000 });
  try {
    // 纯查询：反复问不许改变状态（否则"只查不做"的路径会凭空吃掉额度）
    for (let i = 0; i < 5; i += 1) assert.equal(__selfhealRestartGate(env.relayDir).allowed, true);
    assert.equal(__selfhealGuardOf(env.relayDir).count, 0, "查询不得记账");

    __noteSelfhealRestart(env.relayDir, "测试", "running");
    assert.equal(__selfhealGuardOf(env.relayDir).count, 1);
    const tooSoon = __selfhealRestartGate(env.relayDir);
    assert.equal(tooSoon.allowed, false);
    assert.equal(tooSoon.reason, "too-soon");
    assert.ok(tooSoon.waitMs > 0 && tooSoon.waitMs <= 1000, `waitMs 应落在剩余窗口内，实际 ${tooSoon.waitMs}`);

    __noteSelfhealRestart(env.relayDir, "测试", "running");
    __noteSelfhealRestart(env.relayDir, "测试", "running");
    const exhausted = __selfhealRestartGate(env.relayDir);
    assert.equal(exhausted.allowed, false);
    assert.equal(exhausted.reason, "exhausted");
    // 记一次重启会清掉"被拦下"的去重状态（结论变了要重新说）
    assert.equal(__selfhealGuardOf(env.relayDir).blockedLine, "");

    __resetSelfhealGuard(env.relayDir);
    assert.equal(__selfhealGuardOf(env.relayDir).count, 0, "桥恢复后要能重新自愈");
    assert.equal(__selfhealRestartGate(env.relayDir).allowed, true);
  } finally {
    env.restore();
  }
});

test("★ ④ 护栏文案：被拦下时写进**可见**日志（面板诊断/用户上报会带它）", () => {
  const env = makeEnv({ state: "inactive", minRestartMs: 5000, selfhealMs: 12_000 });
  try {
    assert.equal(__noteSelfhealBlocked(env.relayDir, { reason: "too-soon", count: 1, waitMs: 4000 }), true);
    assert.equal(__noteSelfhealBlocked(env.relayDir, { reason: "too-soon", count: 1, waitMs: 1234 }), false,
      "★ 文案里不得带倒计时秒数，否则每拍文本都不同、去重失效 → 又变成刷屏");
    assert.equal(__noteSelfhealBlocked(env.relayDir, { reason: "exhausted", count: 3, waitMs: 0 }), true);
    const log = env.installLog();
    assert.match(log, /已暂缓自愈重启 bridge/);
    assert.match(log, /已停止自愈重启 bridge/);
    // 文案必须点出"那个 12 秒"本身：它就是这个故障的名字，也是用户能对上号的信息
    assert.match(log, /每 12 秒重启一次/);
    assert.match(log, /每 12 秒杀掉一次正在跑的隧道/);
  } finally {
    env.restore();
  }
});

// ─────────────── 契约锁：护栏只约束"自动"，绝不约束"人" ───────────────

test("★ 契约：面板「重试」（ensureConnection force=true）必须无视已熔断的护栏，仍然把 bridge 拉起来", async () => {
  // 自愈间隔设成 10 分钟 → 定时器在本用例里绝不会自己跑，行为只来自面板这一次显式请求。
  const env = makeEnv({ state: "inactive", heals: true, minRestartMs: 60_000, selfhealMs: 600_000 });
  const routes = bootRoutes(env.relayDir);
  const srv = await serveRoutes(routes);
  try {
    // 前置：模拟"自动自愈已经把 3 次额度用完并熔断"
    for (let i = 0; i < __SELFHEAL_MAX_RESTARTS; i += 1) __noteSelfhealRestart(env.relayDir, "前置", "running");
    assert.equal(__selfhealRestartGate(env.relayDir).reason, "exhausted", "前置条件：护栏必须已熔断");
    assert.equal(__startBridge(env.relayDir).status, "selfheal-throttled", "前置条件：自动路径此刻确实被拦下");

    // 用户点面板「重试」→ POST /dsh-remote/connect/retry（内部 force=true）
    const res = await fetch(`${srv.base}/dsh-remote/connect/retry`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(env.count("restart"), 1,
      `★ 人工操作必须永远立即放行（与 resetProvisionRetry 同一原则）——`
      + `否则熔断会变成"用户被自己的插件锁在门外"。实际调用：\n${env.calls().join("\n")}`);
    // 账号切换同理（resetBridgeForAccountChange 里也清了额度），这里只锁住"重试"这一条即可
    assert.equal(__linuxSystemdUnitState().active, true, "重试之后 bridge 应当真的起来了");
  } finally {
    await srv.close();
    routes.dispose();
    env.restore();
  }
});

// ─────────────── 隔离自检：本文件不得碰真实系统 ───────────────

test("★ 隔离自检：本文件走的都是假 systemctl（真实系统命令一个都不碰）", () => {
  const env = makeEnv({ state: "inactive" });
  try {
    __startBridge(env.relayDir);
    const calls = env.calls();
    assert.ok(calls.length > 0, "前置：假 systemctl 必须真的被调用过（否则下面的断言恒真）");
    assert.ok(calls.every((l) => l.startsWith("--user ")), `假 runner 收到的是 systemctl --user 系列命令：${calls.join(" | ")}`);
    // process.execPath 是本机 node，但 pid 文件指向本测试进程 → 绝不会派生真的 watcher
    assert.equal(env.installLog().includes("脱离进程启动 bridge 失败"), false);
  } finally {
    env.restore();
  }
});
