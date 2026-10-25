// 设备超额锁定 —— 桌面插件面板侧回归（契约 docs/device-overquota-lock-contract.md §8）。
//
// 【为什么必须有】锁定不是"普通连接失败"：设备行还在、手机端能看到这台电脑，只是中继按套餐
// 额度拒绝接入；bridge 不退出、30s 轮询等解锁。如果面板把它显示成「连接失败，请重试」，
// 用户只会反复点重试（契约明确提出"不能再出现无限重试暗示"），而真正的两条出路——
// **升级 Pro Max** 或 **手机端解绑**——根本没人告诉他。
//
// 本用例钉住：
//   ① composeConnect：phase=locked / .bind-error.json code=device_locked → error + 固定文案
//      （「本机已被锁定（当前套餐可同时使用 N 台）…本机会自动解锁」）；
//   ② 面板 UI（lib/client.js）：红条带「🚀 升级 Pro Max」按钮，链接由 app_url 派生（不硬编码域名），
//      旧 device_limit_exceeded 文案已是新语义；
//   ③ 插件半的设备绑定退避（bridge 退出码 5）：10s→1min→5min→15min→封顶 30min，
//      `.bind-error.json` 签名变化时复位；ensureConnection 退避期内不再拉起 bridge；
//   ④ watcher（dsh-setup.mjs）识别退出码 5 并做同一套指数退避（bridge 与 watcher 常量必须一致）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  __composeConnect as composeConnect,
  __ensureConnection as ensureConnection,
  __connectBook as connectBook,
  __bindFailGate as bindFailGate,
  __bindFailSignatureOf as bindFailSignatureOf,
  __bindCapBackoffMs as bindCapBackoffMs,
  __noteBindFailAttempt as noteBindFailAttempt,
  __DEVICE_BIND_CAP_EXIT_CODE as DEVICE_BIND_CAP_EXIT_CODE,
  __BIND_CAP_BACKOFF_MAX_MS as BIND_CAP_BACKOFF_MAX_MS,
} from "../lib/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "..");
const CLIENT_SRC = readFileSync(path.join(HERE, "..", "lib", "client.js"), "utf8").replace(/\r\n/g, "\n");
const INDEX_SRC = readFileSync(path.join(HERE, "..", "lib", "index.js"), "utf8").replace(/\r\n/g, "\n");
const SETUP_SRC = readFileSync(path.join(ROOT, "dsh-setup.mjs"), "utf8").replace(/\r\n/g, "\n");
const BRIDGE_SRC = readFileSync(path.join(ROOT, "clients", "dsh-remote", "dsh-bridge.mjs"), "utf8").replace(/\r\n/g, "\n");

const DEVICE_ID = "dev-locked-0001";

/** 提取 `function name(...) { ... }` 的完整源码（按花括号配对，用于把纯函数单独求值）。 */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `源码里找不到 function ${name}`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`function ${name} 花括号不配对`);
}

const ENV_KEYS = ["DSH_RELAY_SKIP_SERVICE", "DSH_RELAY_PLATFORM", "DSH_REMOTE_TELEMETRY", "DSH_RELAY_DEFAULT_API", "DSH_RELAY_SELFHEAL_MS"];
function withTestEnv() {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.DSH_RELAY_SKIP_SERVICE = "1"; // 隔离：绝不碰真实 launchd/systemd/npx
  process.env.DSH_RELAY_PLATFORM = "win32"; // 让 launchdStatus 直接返回「无此服务」（不 shell 出去问）
  process.env.DSH_REMOTE_TELEMETRY = "0";
  process.env.DSH_RELAY_DEFAULT_API = "http://127.0.0.1:1";
  delete process.env.DSH_RELAY_SELFHEAL_MS;
  return () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

/** 假 relayDir：运行环境入口用「没有任何相对 import」的桩，避免半装判定干扰。 */
async function makeRelayDir(extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-lock-panel-"));
  const relayDir = path.join(root, "relay");
  await mkdir(relayDir, { recursive: true });
  await writeFile(path.join(relayDir, "dsh-setup.mjs"), "// runtime stub\n");
  await writeFile(path.join(relayDir, ".dsh-config.json"), JSON.stringify({
    phone: "13800000000", password: "pw", device_id: DEVICE_ID, api_url: "http://127.0.0.1:1",
  }));
  if (extra.state) await writeFile(path.join(relayDir, ".dsh-bridge-state.json"), JSON.stringify(extra.state));
  if (extra.bindError) await writeFile(path.join(relayDir, ".bind-error.json"), JSON.stringify({ at: Date.now(), ...extra.bindError }));
  return { root, relayDir };
}

const lockedState = {
  device_id: DEVICE_ID,
  phase: "locked",
  account_bound_at: Date.now(),
  locked: { message: "已超出当前套餐设备额度，升级 Pro Max 可多台设备同时使用", plan: "free", limit: 2, upgrade_to: "pro_max" },
  last_error: null,
};
const lockedBindError = {
  code: "device_locked",
  message: "已超出当前套餐设备额度，升级 Pro Max 可多台设备同时使用",
  device_id: DEVICE_ID,
  plan: "free",
  limit: 2,
  upgrade_to: "pro_max",
};
const fakeLaunchd = { running: false, pid: null, state: "", runs: null, lastExitCode: null, crashing: false };
const fakeManual = { watcher: [], bridge: [], allBridge: [] };

// ─────────────────────── ① composeConnect：锁定态 ───────────────────────

test("composeConnect：bridge phase=locked → error + 契约 §8.1 文案 + locked 详情", async () => {
  const restore = withTestEnv();
  const { root, relayDir } = await makeRelayDir({ state: lockedState, bindError: lockedBindError });
  try {
    const conn = await composeConnect(relayDir, {
      launchd: fakeLaunchd, manual: { watcher: [], bridge: [], allBridge: [process.pid] },
    });
    assert.equal(conn.phase, "error", "锁定态对用户是「用不了」，必须是 error 阶段");
    assert.equal(conn.online, false);
    assert.equal(conn.error && conn.error.code, "device_locked", "错误码必须是 device_locked（面板据此出现升级按钮）");
    assert.ok(conn.locked, "必须下发 locked 详情（plan/limit/upgradeTo）供面板渲染");
    assert.equal(conn.locked.limit, 2);
    assert.equal(conn.locked.plan, "free");
    assert.equal(conn.locked.upgradeTo, "pro_max");
    // 契约 §8.1 固定文案：N 台 + 升级 Pro Max + 手机端「管理电脑」解绑 + 自动解锁
    assert.match(conn.detail, /本机已被锁定（当前套餐可同时使用 2 台）/);
    assert.match(conn.detail, /升级 Pro Max 可多台设备同时使用/);
    assert.match(conn.detail, /「管理电脑」解绑其他设备/);
    assert.match(conn.detail, /自动解锁/);
    assert.doesNotMatch(conn.detail, /无限重试|反复重试直到成功/, "不能出现无限重试的暗示");
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("composeConnect：只有 .bind-error.json code=device_locked 也要识别（旧 bridge / 半升级现场）", async () => {
  const restore = withTestEnv();
  const { root, relayDir } = await makeRelayDir({ bindError: lockedBindError });
  try {
    const conn = await composeConnect(relayDir, {
      launchd: fakeLaunchd, manual: { watcher: [], bridge: [], allBridge: [process.pid] },
    });
    assert.equal(conn.phase, "error");
    assert.equal(conn.error.code, "device_locked");
    assert.equal(conn.locked.limit, 2, "limit 从 bind-error.json 取（桥已富化该字段）");
    assert.match(conn.detail, /自动解锁/);
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("composeConnect：device_bind_cap → 硬上限文案，且不暗示无限重试", async () => {
  const restore = withTestEnv();
  const { root, relayDir } = await makeRelayDir({
    bindError: { code: "device_bind_cap", message: "已绑定设备数已达上限(50 台)", device_id: DEVICE_ID },
  });
  try {
    const conn = await composeConnect(relayDir, { launchd: fakeLaunchd, manual: fakeManual });
    assert.equal(conn.phase, "error");
    assert.equal(conn.error.code, "device_bind_cap");
    assert.match(conn.detail, /手机端「管理电脑」解绑/);
    assert.match(conn.detail, /指数退避/, "要说明守护在退避重试（而不是每 10 秒空撞一次）");
    assert.equal(conn.locked, null, "硬上限不是锁定态，不该出现升级按钮的 locked 详情");
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
});

// ─────────────────────── ② 面板 UI 文案 / 按钮 ───────────────────────

test("面板红条：锁定态渲染「🚀 升级 Pro Max」按钮，链接由 app_url 派生（不硬编码域名）", () => {
  assert.ok(CLIENT_SRC.includes("🚀 升级 Pro Max"), "契约 §8.2：红条必须有「🚀 升级 Pro Max」按钮");
  assert.ok(CLIENT_SRC.includes("openLockedUpgrade"), "按钮必须有可点击的实现（不是纯文案）");
  assert.ok(CLIENT_SRC.includes("upgradePromoUrlOf"), "链接必须走派生函数（app_url → /app/promo）");
  assert.ok(CLIENT_SRC.includes("/app/promo"), "升级入口路径是 /app/promo");
  // 派生函数本体：只认 http(s) 前缀 + /app 之前的部分，不写死生产域名
  const fn = extractFunction(CLIENT_SRC, "upgradePromoUrlOf");
  const derive = new Function(`${fn}\nreturn upgradePromoUrlOf;`)();
  assert.equal(derive("https://example.com/app/?auth=abc"), "https://example.com/app/promo");
  assert.equal(derive("https://example.com:13443/app"), "https://example.com:13443/app/promo");
  assert.equal(derive(""), "", "拿不到 app_url 时返回空串，调用方回退到带登录态的升级通道");
  assert.equal(derive("not-a-url"), "");
  assert.doesNotMatch(fn, /risegao|n\.dsh|dsh\.remote|\.cn/, "派生函数里不得硬编码任何生产域名");
});

test("面板文案：lockedPanelDetail 同时讲清「N 台 / 升级 / 解绑 / 自动解锁」", () => {
  const fn = extractFunction(CLIENT_SRC, "lockedPanelDetail");
  const detail = new Function(`${fn}\nreturn lockedPanelDetail;`)();
  const text = detail(2);
  assert.match(text, /本机已被锁定（当前套餐可同时使用 2 台）/);
  assert.match(text, /升级 Pro Max 可多台设备同时使用/);
  assert.match(text, /「管理电脑」解绑其他设备/);
  assert.match(text, /自动解锁/);
  assert.match(detail(null), /可同时使用 N 台/, "服务端没给额度时退回 N 占位（不编造数字）");
  // 旧 device_limit_exceeded 文案已废弃（契约 §8.3）：不能再出现"解绑旧设备才能登录"
  assert.equal(CLIENT_SRC.includes("已达本套餐设备数上限。若是同一台电脑重装"), false,
    "旧的「解绑旧设备才能登录」文案必须删掉（新语义是锁定 → 升级/解绑 → 自动解锁）");
  assert.ok(CLIENT_SRC.includes('be.code === "device_bind_cap"') || CLIENT_SRC.includes('isBindCap'),
    "后台服务卡要识别 device_bind_cap（退出码 5 的那类失败）");
});

// ─────────────────────── ③ 插件半：设备绑定退避（退出码 5） ───────────────────────

test("插件半退避序列：10s→1min→5min→15min，之后封顶 30min；且常量与 bridge 一致", () => {
  assert.equal(DEVICE_BIND_CAP_EXIT_CODE, 5, "退出码 5 是契约 §6.3 的专用码");
  assert.equal(bindCapBackoffMs(1), 10_000);
  assert.equal(bindCapBackoffMs(2), 60_000);
  assert.equal(bindCapBackoffMs(3), 300_000);
  assert.equal(bindCapBackoffMs(4), 900_000);
  assert.equal(bindCapBackoffMs(5), 30 * 60 * 1000);
  assert.equal(bindCapBackoffMs(99), BIND_CAP_BACKOFF_MAX_MS, "封顶 30 分钟，不能无限增长");
  // bridge 与 watcher 的常量必须同源（否则 watcher 认不出退出码 5，又回 10s 空撞）
  assert.match(BRIDGE_SRC, /export const DEVICE_BIND_CAP_EXIT_CODE = 5;/);
  assert.match(SETUP_SRC, /const DEVICE_BIND_CAP_EXIT_CODE = 5;/);
  assert.ok(/code === DEVICE_BIND_CAP_EXIT_CODE/.test(SETUP_SRC), "watcher 必须识别退出码 5");
  assert.ok(/bindCapBackoffUntil = Date\.now\(\) \+ waitMs/.test(SETUP_SRC), "识别后要真的进入退避窗口");
});

test("插件半退避闸门：签名变化复位、窗口内 blocked、窗口过可再试一次", async () => {
  const restore = withTestEnv();
  const { root, relayDir } = await makeRelayDir();
  try {
    const err = { code: "device_bind_cap", message: "已达上限", device_id: DEVICE_ID };
    const sig1 = bindFailSignatureOf(err);
    assert.equal(bindFailSignatureOf({ ...err, at: 111 }), sig1, "签名不含 at（bridge 每次重试都会刷 at）");
    assert.notEqual(bindFailSignatureOf({ ...err, message: "别的原因" }), sig1, "结论变了才算变化");

    const g0 = bindFailGate(relayDir, err);
    assert.equal(g0.permanent, true);
    assert.equal(g0.blocked, false, "首次观察到失败：允许一次重试");
    const st = noteBindFailAttempt(relayDir, err);
    assert.equal(st.step, 1);
    const g1 = bindFailGate(relayDir, err);
    assert.equal(g1.blocked, true, "记账后的第一档退避必须是 10s");
    assert.ok(g1.remainingMs > 0 && g1.remainingMs <= 10_000);

    // 步进序列（同一签名连续失败）：10s→1min→5min→15min→30min
    noteBindFailAttempt(relayDir, err);
    noteBindFailAttempt(relayDir, err);
    noteBindFailAttempt(relayDir, err);
    noteBindFailAttempt(relayDir, err);
    assert.equal(connectBook(relayDir).bindFail.step, 5);
    assert.ok(connectBook(relayDir).bindFail.until - Date.now() <= 30 * 60 * 1000 + 50);

    // 签名变化（用户解绑/换账号/提示被清掉）→ 立即复位
    const gReset = bindFailGate(relayDir, { code: "device_locked", message: "x", device_id: DEVICE_ID });
    assert.equal(gReset.permanent, false);
    assert.equal(gReset.blocked, false);
    assert.equal(gReset.step, 0);
    // 非永久失败（网络抖动等）不参与该退避
    assert.equal(bindFailGate(relayDir, { code: "api_unreachable", message: "x" }).permanent, false);
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureConnection：设备绑定硬上限退避期内不再拉起 bridge（避免把 watcher 退避重启掉）", async () => {
  const restore = withTestEnv();
  const { root, relayDir } = await makeRelayDir({
    bindError: { code: "device_bind_cap", message: "已绑定设备数已达上限", device_id: DEVICE_ID },
  });
  try {
    const first = await ensureConnection(relayDir);
    const book = connectBook(relayDir);
    assert.equal(book.bindFail.step, 1, "第一次观察到永久失败 → 记一步退避后允许这一次动作");
    // 退避窗口内的下一轮：必须直接拦下（action=bind-cap-backoff），不再动服务
    const second = await ensureConnection(relayDir);
    assert.equal(second && second.action, "bind-cap-backoff", `第二次必须是退避拦下，实际：${JSON.stringify(second)}`);
    assert.ok(second.until > Date.now());
    // 人工操作（面板「重试」= force）永远放行：安全阀不能把用户锁在门外
    const forced = await ensureConnection(relayDir, { force: true });
    assert.notEqual(forced && forced.action, "bind-cap-backoff", "force 必须绕过退避");
    void first;
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
});

// ─────────────────────── ④ watcher（dsh-setup.mjs）退避纯函数 ───────────────────────

test("dsh-setup.mjs watcher 的退避序列与签名复位（与插件半同一套语义）", () => {
  const fnSrc = extractFunction(SETUP_SRC, "bindCapBackoffMs");
  const consts = SETUP_SRC.slice(SETUP_SRC.indexOf("const DEVICE_BIND_CAP_EXIT_CODE"), SETUP_SRC.indexOf("function bindErrorSignature"));
  const mod = new Function("path", "CONFIG_DIR", `${consts}\n${fnSrc}\nreturn { bindCapBackoffMs, DEVICE_BIND_CAP_EXIT_CODE, BIND_CAP_BACKOFF_MAX_MS };`)(
    { join: (...parts) => parts.join("/") },
    "/tmp/fake-relay"
  );
  assert.equal(mod.DEVICE_BIND_CAP_EXIT_CODE, 5);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(mod.bindCapBackoffMs), [10_000, 60_000, 300_000, 900_000, 30 * 60 * 1000, 30 * 60 * 1000]);
  assert.equal(mod.bindCapBackoffMs(4), mod.BIND_CAP_BACKOFF_MAX_MS / 2, "15min 是封顶前最后一档");
  // 退避提示里必须告诉用户「解绑后自动恢复」（否则用户以为要等 30 分钟且什么也做不了）
  assert.match(SETUP_SRC, /解绑后自动恢复|解绑后会自动恢复/);
  // 该退避只约束**自动**拉起：换账号时要清掉（新账号额度/硬上限可能完全不同）
  assert.ok(/换账号 = 绑定前提已变/.test(SETUP_SRC), "换账号必须复位设备绑定退避");
  assert.ok(/bridge 因设备绑定达到硬上限退出/.test(SETUP_SRC), "watcher 收到退出码 5 要有明确日志");
  // 插件半必须记住"上次退避提示"的那行日志开关，否则 2.5s 轮询会把安装日志刷爆
  assert.ok(/bindFailLogged/.test(INDEX_SRC));
});
