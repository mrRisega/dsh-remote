#!/usr/bin/env node
/**
 * dsh-remote 微信机器人通道(ilink)—— bridge 端协议客户端
 *
 * 依据 docs/wechat-bot-channel.md(设计已定稿)§3 协议 / §5 节点 / §8 安全 /
 * §9 状态 / §10 绑定流程 / §11 待验证清单 实现。**零运行时依赖**(只用 node: 内置模块 +
 * 全局 fetch)—— bridge 要跑在用户自己的电脑上,bundle 里不能多出任何第三方包。
 *
 * ── 本模块负责(且只负责)──
 *   1. ilink 协议客户端:get_bot_qrcode / get_qrcode_status / notifystart / notifystop /
 *      getupdates / sendmessage。baseUrl 可注入(测试打本地 mock,仓库的
 *      scripts/test-net-guard.cjs 会拦掉一切非 loopback 请求)。
 *   2. 扫码绑定状态机(§3 的 8 态,含 need_verifycode 回调式交互、expired×3、
 *      binded_redirect 视为成功、-14 冷却退避)。
 *   3. 凭据落盘 <relayDir>/.wechat-account.json(0600 + Windows icacls 收紧,镜像
 *      dsh-setup.mjs / dsh-bridge.mjs 的 hardenFile)。
 *   4. 面板状态文件 <relayDir>/.wechat-state.json(§9:**只有已绑定/未绑定两态**)。
 *   5. 零依赖 QR 编码器 → SVG data URL(§10 第 3 步:面板与手机端复用同一接口,
 *      所以编码器放 bridge 侧、不引第三方包)。
 *   6. 通知文案格式化(§5 P0/P1 节点)+ 回执编号注册表 + 入站回复解析。
 *
 * ── 本模块**不做** ──
 *   - 不碰 dsh-bridge.mjs 的隧道/WS/事件流(接线是后续步骤,本模块只提供原语);
 *   - 不做自由文本对话(v1 明确不做,§1);
 *   - 不复用 E2EE 通道(§8:微信走 TLS、DSH 走 loopback,新增 E2eeSession.keyFor 的
 *     kind 会牵动浏览器侧字节级对等测试)。
 *
 * ── 安全约定(§8,测试逐条覆盖)──
 *   - token 只落 0600 文件,**绝不进任何日志行**(所有日志过 redact());
 *   - 对外(面板)只暴露 {bound, botId, boundAt},永不回显 token;
 *   - 解绑顺序:停轮询 → notifystop → 删凭据。
 *
 * 用法:node --test clients/dsh-remote/test/wechat-channel.test.mjs
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ===========================================================================
// 0. 协议常量
// ===========================================================================

/** ilink 默认服务地址;可经 options.baseUrl 注入(测试指向 127.0.0.1 mock)。 */
export const DEFAULT_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";

/** get_bot_qrcode / get_qrcode_status 的 bot_type(腾讯插件该渠道构建固定为 "3")。 */
export const DEFAULT_BOT_TYPE = "3";

/** iLink-App-Id:腾讯插件取自身 package.json 的顶层 ilink_appid 字段,值为 "bot"。 */
export const ILINK_APP_ID = "bot";

/**
 * iLink-App-ClientVersion:uint32,编码 0x00MMNNPP(major<<16 | minor<<8 | patch)。
 * 腾讯自己的插件发的是**它自己的**版本(2.4.9 → 0x00020409 = 132105);我们不是它,
 * 所以必须发一个**我们自己的、非零**的版本号 —— 留空会被服务端当成缺字段。
 * 这里用本包版本(0.6.9 → 0x00000609 = 1545),并允许 DSH_WECHAT_CLIENT_VERSION 覆盖。
 */
export const DEFAULT_CLIENT_VERSION = "0.6.9";

/** "1.2.3" → 0x00010203(= major<<16 | minor<<8 | patch,高 8 位固定为 0)。 */
export function buildClientVersion(version) {
  const parts = String(version || "").split(".").map((p) => parseInt(p, 10));
  const major = Number.isFinite(parts[0]) ? parts[0] : 0;
  const minor = Number.isFinite(parts[1]) ? parts[1] : 0;
  const patch = Number.isFinite(parts[2]) ? parts[2] : 0;
  return (((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)) >>> 0;
}

/** 解析实际要发的 client version 数字(环境变量可覆盖,便于跟服务端灰度对齐)。 */
export function resolveClientVersion(raw) {
  const v = raw ?? process.env.DSH_WECHAT_CLIENT_VERSION;
  if (v === undefined || v === null || String(v).trim() === "") {
    return buildClientVersion(DEFAULT_CLIENT_VERSION);
  }
  const s = String(v).trim();
  const n = Number(s);
  if (Number.isFinite(n) && /^\d+$/.test(s)) return n >>> 0;
  return buildClientVersion(s) || buildClientVersion(DEFAULT_CLIENT_VERSION);
}

/**
 * 数值协议常量 —— **逐个抄自归档参考实现**,不是猜的:
 *   /Users/mac/AIWorkSpace/myFreeWork/dsh-relay-internal/reference/openclaw-weixin/plugin-2.4.9/src/api/types.ts
 *     · MessageType      (types.ts:64-68)   NONE:0 / USER:1 / BOT:2
 *     · MessageItemType  (types.ts:70-79)   NONE:0 TEXT:1 IMAGE:2 VOICE:3 FILE:4 VIDEO:5
 *                                           TOOL_CALL_START:11 TOOL_CALL_RESULT:12
 *     · MessageState     (types.ts:81-85)   NEW:0 / GENERATING:1 / FINISH:2
 * 组装位置:同仓库 src/messaging/send.ts:56-80(buildTextMessageReq:
 *   message_type = BOT、message_state = FINISH、item_list = [{type: TEXT, text_item:{text}}])。
 * GetUpdatesResp 的字段名与 ret/errcode/errmsg/longpolling_timeout_ms 见 types.ts:219-232。
 */
export const MessageType = Object.freeze({ NONE: 0, USER: 1, BOT: 2 });

export const MessageItemType = Object.freeze({
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12
});

export const MessageState = Object.freeze({ NEW: 0, GENERATING: 1, FINISH: 2 });

/** 二维码长轮询的客户端超时(§3:`get_qrcode_status` 客户端 35s)。 */
export const QR_LONG_POLL_TIMEOUT_MS = 35_000;

/** getUpdates 长轮询默认客户端超时(参考实现 DEFAULT_LONG_POLL_TIMEOUT_MS)。 */
export const DEFAULT_UPDATES_TIMEOUT_MS = 35_000;

/** 普通请求超时(参考实现 DEFAULT_API_TIMEOUT_MS)。 */
export const DEFAULT_API_TIMEOUT_MS = 15_000;

/** 轻量请求超时(参考实现 DEFAULT_CONFIG_TIMEOUT_MS)。 */
export const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

/**
 * errcode -14 / "session timeout" = token 失效或会话过期(§3、§7)。
 * 腾讯官方插件把该账号**静默冷却 1 小时**(参考实现 src/api/session-guard.ts:
 * SESSION_PAUSE_DURATION_MS = 60*60*1000)。我们必须同样退避,绝不打爆接口。
 */
export const STALE_TOKEN_ERRCODE = -14;
export const SESSION_COOLDOWN_MS = 60 * 60 * 1000;

/** 二维码过期后的自动刷新上限(§3:最多 3 次)。 */
export const MAX_QR_REFRESH_COUNT = 3;

/** need_verifycode / verify_code_blocked 之后的重试上限(对齐参考实现)。 */
export const MAX_VERIFY_ATTEMPTS = 3;

/** 扫码状态的 8 态(§3)—— 未知状态一律走「可重试」分支,不崩。 */
export const QR_STATUSES = Object.freeze([
  "wait",
  "scaned",
  "need_verifycode",
  "confirmed",
  "expired",
  "scaned_but_redirect",
  "verify_code_blocked",
  "binded_redirect"
]);

export const ACCOUNT_FILE = ".wechat-account.json";
export const STATE_FILE = ".wechat-state.json";

// ===========================================================================
// 1. 错误类型 + 脱敏
// ===========================================================================

/**
 * 协议/流程错误。`code` 是稳定的机器可读标识,调用方据此分支:
 *   bad_options | http_error | bad_response_shape | unexpected_status |
 *   bind_missing_bot_id | bind_expired | verify_blocked | verify_timeout |
 *   session_expired | cooldown | network
 */
export class WeChatError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "WeChatError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

const TOKEN_PREFIX_LEN = 6;

/**
 * 日志脱敏(§8「永不回显 token」)。三类输入都要能过:
 *   - 字符串:原样打回,但把**已知密钥字面量**替换掉(精确匹配,不搞正则误伤);
 *   - 对象:递归,敏感 key(见 SENSITIVE_KEYS)值替换为 "***";
 *   - undefined/null → 空串。
 * 说明:准确率比覆盖率重要 —— 只要调用方把 token 交给它,就必须被抹掉;
 * 因此除了字段名判断,还有一次「已知 token 字面量」的兜底替换(见 createRedactor)。
 */
const SENSITIVE_KEYS = /^(token|bot_token|access_token|refresh_token|authorization|context_token|secret|password|qrcode|verify_code|key)$/i;

export function redact(value, known = []) {
  const literals = (Array.isArray(known) ? known : [known]).filter(
    (s) => typeof s === "string" && s.length >= 4
  );
  const maskLiterals = (s) => literals.reduce((acc, t) => acc.split(t).join(`${t.slice(0, TOKEN_PREFIX_LEN)}…<redacted>`), s);

  const walk = (v, depth) => {
    if (v == null) return v === null ? null : undefined;
    if (typeof v === "string") return maskLiterals(v);
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return v;
    if (depth > 4) return "<deep>";
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => walk(x, depth + 1));
    if (v instanceof Error) return maskLiterals(`${v.name}: ${v.message}`);
    if (typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = SENSITIVE_KEYS.test(k) ? "***" : walk(val, depth + 1);
      }
      return out;
    }
    return String(v);
  };
  return walk(value, 0);
}

/** token 的展示形态:只给前 6 字符 + 长度,绝不给全文(参考实现 redactToken)。 */
export function redactToken(token) {
  if (!token) return "(none)";
  const s = String(token);
  if (s.length <= TOKEN_PREFIX_LEN) return `****(len=${s.length})`;
  return `${s.slice(0, TOKEN_PREFIX_LEN)}…(len=${s.length})`;
}

/**
 * 把**文本里**「敏感字段名 = 值」的值打掉。
 *
 * 为什么需要它:`redact()` 只在**对象**上按 key 判断,但真实日志/状态里密钥多半以
 * **字符串**形态出现 —— `JSON.stringify({token:"…"})`、`token=…`、以及拼进错误信息里的 token。
 * 这些字符串进 `redact()` 只会走「已知密钥字面量」那一支,于是**未登记(或登记之前)**的
 * 密钥就原样落进日志与状态文件。
 *
 * 实测踩过两次:① `createLogger` 收到调用方已 stringify 的 JSON,字段名规则完全没生效;
 * ② `markPush(ok, errText)` 把错误原文写进 `.wechat-state.json`,而错误里带着 token。
 */
export function maskFieldsInText(text) {
  const KEYS =
    "token|bot_token|access_token|refresh_token|authorization|context_token|secret|password|verify_code|qrcode";
  let s = String(text ?? "");
  // 引号形态:`"token":"abc"` / `'token': 'abc'`
  s = s.replace(
    new RegExp(`(["']?)(${KEYS})\\1(\\s*[:=]\\s*)(["'])(?:(?!\\4)[\\s\\S])*?\\4`, "gi"),
    (_m, q1, k, sep, q2) => `${q1}${k}${q1}${sep}${q2}***${q2}`
  );
  // 裸 k=v 形态:`token=abc123`(到空白/分隔符为止;已是 *** 的不动,保证幂等)
  s = s.replace(new RegExp(`\\b(${KEYS})=([^\\s,;&"']+)`, "gi"), (_m, k) => `${k}=***`);
  return s;
}

// ===========================================================================
// 2. 文件权限:0600 + Windows ACL 收紧
// ===========================================================================

/**
 * 镜像 dsh-setup.mjs:272-287 / dsh-bridge.mjs:215-230 的 hardenFile
 * (**未修改那两个文件**,此处是等价的最小实现,因为本模块必须零依赖、独立可测)。
 *
 * ⚠️ Windows 上 `{ mode: 0o600 }` 是**空操作**(Windows 用 ACL 不用 POSIX mode 位):
 * 实测默认拿到的是用户目录的**继承 ACL**,任何按文件复制的场景(备份/同步盘/杀软
 * 上报/崩溃转储/发给作者的支持包)都会连明文 bot_token 一起被带走。所以显式断开继承、
 * 只授予当前用户;失败只警告一次,绝不影响主流程。
 */
let hardenWarned = false;
export function hardenFile(file, onWarn) {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* POSIX 上失败不致命 */
  }
  if (process.platform !== "win32") return;
  const who = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join("\\");
  // 两个环境变量都取不到时**绝不能静默返回**：那会让人以为文件已加固，实际仍是继承 ACL。
  // 正常 Windows 会话不会走到这里（USERNAME 必然存在），但受限令牌/服务账户下有可能。
  if (!who) {
    if (!hardenWarned) {
      hardenWarned = true;
      const msg = `无法收紧文件权限(USERDOMAIN/USERNAME 均未设置):${file}`;
      if (typeof onWarn === "function") onWarn(msg);
      else console.warn(`⚠️ ${msg}`);
    }
    return;
  }
  let r;
  try {
    r = spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${who}:F`], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 8000
    });
  } catch (e) {
    r = { status: -1, stderr: e.message };
  }
  if (r.status !== 0 && !hardenWarned) {
    hardenWarned = true;
    const msg = `收紧文件权限失败(${who}):${String(r.stderr || "").trim() || `icacls 退出码 ${r.status}`}`;
    if (typeof onWarn === "function") onWarn(msg);
    else console.warn(`⚠️ ${msg}`);
  }
}

/** 原子写 + 0o600 + hardenFile。写失败不致命(调用方决定是否上报)。 */
export function writePrivateJson(file, data, onWarn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  hardenFile(file, onWarn);
}

/** 读文件的 POSIX 权限位(Windows 上为 null,因为 mode 不可信)。 */
export function fileMode(file) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

// ===========================================================================
// 3. 日志
// ===========================================================================

/**
 * 极简日志器。默认**不写 stdout**(bridge 的 stdout 可能被守护进程捕获/落盘,
 * 不是安全的地方),只把最近 200 行留在内存里给面板/排障用。
 * 每一行都过 redact(..., known) —— known 里的密钥字面量不可能漏出去。
 * 测试正是用 `logger.lines` 断言「token 从未出现在任何日志行」。
 */
export function createLogger(opts = {}) {
  const max = opts.maxLines ?? 200;
  const lines = [];
  const known = Array.isArray(opts.secrets) ? [...opts.secrets] : [];
  const sink = typeof opts.sink === "function" ? opts.sink : null;

  const log = (level, ...parts) => {
    try {
      const text = parts
        .map((p) => (typeof p === "string" ? p : JSON.stringify(redact(p, known))))
        .join(" ");
      // ⚠️ 字符串 part 也必须过一遍**字段名**脱敏:调用方常常已经自己 JSON.stringify 了,
      // 那种情况下 redact() 的对象分支根本不会被走到 —— 实测漏 token 的正是这条路径。
      // 顺序:先按字段名抹值,再按已登记密钥抹字面量(两者互补,谁先谁后都不漏)。
      const line = `[wechat] ${level} ${maskKnown(maskFieldsInText(text), known)}`;
      lines.push(line);
      if (lines.length > max) lines.splice(0, lines.length - max);
      if (sink) sink(line);
    } catch {
      /* 日志失败不能影响业务 */
    }
  };
  const maskKnown = (s, secrets) =>
    secrets.filter((t) => typeof t === "string" && t.length >= 4).reduce(
      (acc, t) => acc.split(t).join(`${t.slice(0, TOKEN_PREFIX_LEN)}…<redacted>`),
      s
    );

  return {
    lines,
    /** 把新的密钥登记进脱敏集合(保存 / 收到 token 时调用)。 */
    addSecret(secret) {
      if (typeof secret === "string" && secret.length >= 4) known.push(secret);
    },
    debug: (...a) => log("debug", ...a),
    info: (...a) => log("info", ...a),
    warn: (...a) => log("warn", ...a),
    error: (...a) => log("error", ...a)
  };
}

// ===========================================================================
// 4. 协议客户端
// ===========================================================================

function ensureTrailingSlash(url) {
  return String(url).endsWith("/") ? String(url) : `${String(url)}/`;
}

/** X-WECHAT-UIN:随机 uint32 → 十进制串 → base64(参考实现 api.ts:222-225)。 */
function randomWechatUin() {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64");
}

/**
 * `scaned_but_redirect` 给的 redirect_host 会直接拼进 URL 并携带 bot_token,
 * 所以这里做一次收紧:只接受 https、只接受主机名(可带端口),任何路径/查询/凭据
 * 一律拒绝 —— 未公开协议里这是「服务端可控输入」,不该无条件信任。
 */
export function normalizeRedirectHost(host) {
  const raw = String(host ?? "").trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.search || url.hash) return null;
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(url.host)) return null;
  return url.host;
}

/** 让"超时"这一控制流与其他网络错误可区分。 */
function timeoutSignal(ms, external) {
  const controller = new AbortController();
  const timer = ms > 0 ? setTimeout(() => controller.abort(), ms) : null;
  const onExternal = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternal, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup() {
      if (timer) clearTimeout(timer);
      if (external) external.removeEventListener("abort", onExternal);
    },
    get timedOut() {
      return controller.signal.aborted && !(external && external.aborted);
    }
  };
}

/**
 * ilink 协议客户端。
 *
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]     注入式基址(测试指向 http://127.0.0.1:<port>)。
 * @param {string} [opts.token]       bot_token;设置后所有请求带 Authorization: Bearer。
 * @param {number} [opts.clientVersion] iLink-App-ClientVersion(uint32)。
 * @param {object} [opts.logger]      createLogger() 产物;默认新建一个。
 * @param {Function} [opts.fetch]     注入 fetch(测试可选;默认全局 fetch)。
 */
export class IlinkClient {
  constructor(opts = {}) {
    this.baseUrl = String(opts.baseUrl || DEFAULT_ILINK_BASE_URL).replace(/\/+$/, "");
    this.token = opts.token ? String(opts.token) : "";
    this.botType = String(opts.botType || DEFAULT_BOT_TYPE);
    this.clientVersion = resolveClientVersion(opts.clientVersion);
    this.logger = opts.logger || createLogger();
    this.fetchImpl = opts.fetch || ((...a) => globalThis.fetch(...a));
    if (this.token) this.logger.addSecret(this.token);
  }

  /** 换基址(scaned_but_redirect 用)。 */
  setBaseUrl(url) {
    this.baseUrl = String(url).replace(/\/+$/, "");
  }

  /** 设置/更新 token(绑定成功后调用)。 */
  setToken(token) {
    this.token = token ? String(token) : "";
    if (this.token) this.logger.addSecret(this.token);
  }

  /** 公共请求头(参考实现 api.ts:228-254)。 */
  commonHeaders() {
    return {
      "iLink-App-Id": ILINK_APP_ID,
      "iLink-App-ClientVersion": String(this.clientVersion)
    };
  }

  headers() {
    const h = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomWechatUin(),
      ...this.commonHeaders()
    };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  /**
   * 底层 JSON 请求。**不抛 HTTP/超时之外的错**:响应体解析失败一律
   * `WeChatError("bad_response_shape")` —— 未公开协议下这是常见路径,不是异常。
   *
   * @returns {Promise<{json:any, raw:string, status:number}>}
   */
  async request({ method, endpoint, body, timeoutMs, label, abortSignal }) {
    const url = new URL(endpoint, ensureTrailingSlash(this.baseUrl)).toString();
    const t = timeoutSignal(timeoutMs ?? 0, abortSignal);
    const init = {
      method,
      headers: method === "GET" ? this.commonHeaders() : this.headers(),
      signal: t.signal
    };
    if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
    let res;
    try {
      res = await this.fetchImpl(url, init);
    } catch (err) {
      t.cleanup();
      if (t.timedOut) throw new WeChatError("timeout", `${label}: 客户端超时(${timeoutMs}ms)`, { url });
      throw new WeChatError("network", `${label}: 网络错误 ${redact(err.message, [this.token])}`, {
        url,
        code: err && err.code
      });
    }
    t.cleanup();
    let raw = "";
    try {
      raw = await res.text();
    } catch (err) {
      throw new WeChatError("network", `${label}: 读取响应失败`, { url });
    }
    if (!res.ok) {
      throw new WeChatError("http_error", `${label}: HTTP ${res.status}`, { url, status: res.status });
    }
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new WeChatError("bad_response_shape", `${label}: 响应不是合法 JSON`, {
        url,
        preview: redact(raw.slice(0, 200), [this.token])
      });
    }
    return { json, raw, status: res.status };
  }

  /** 形状校验:必须是普通对象(数组/字符串/null 都算"形状不认识")。 */
  static expectObject(json, label) {
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      throw new WeChatError(
        "bad_response_shape",
        `${label}: 响应形状不认识(期望对象,收到 ${json === null ? "null" : Array.isArray(json) ? "array" : typeof json})`
      );
    }
    return json;
  }

  /**
   * 取绑定二维码。
   * POST {baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3
   * body {"local_token_list":[...]} —— 我们保留已绑过的 token 列表(空数组也算合法)。
   * @returns {Promise<{qrcode:string, qrcode_img_content:string, raw:object}>}
   */
  async getBotQrcode({ localTokenList = [], botType = this.botType, timeoutMs = DEFAULT_API_TIMEOUT_MS, signal } = {}) {
    const endpoint = `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`;
    this.logger.info(`getBotQrcode: base=${this.baseUrl} bot_type=${botType} local_tokens=${localTokenList.length}`);
    const { json } = await this.request({
      method: "POST",
      endpoint,
      body: { local_token_list: localTokenList },
      timeoutMs,
      label: "getBotQrcode",
      abortSignal: signal
    });
    const obj = IlinkClient.expectObject(json, "getBotQrcode");
    if (typeof obj.qrcode !== "string" || !obj.qrcode) {
      throw new WeChatError("bad_response_shape", "getBotQrcode: 响应缺 qrcode", {
        keys: Object.keys(obj).slice(0, 20)
      });
    }
    return {
      qrcode: obj.qrcode,
      qrcode_img_content: typeof obj.qrcode_img_content === "string" ? obj.qrcode_img_content : "",
      ret: obj.ret,
      raw: obj
    };
  }

  /**
   * 长轮询扫码状态(§3:客户端超时 35s)。
   * GET {baseUrl}/ilink/bot/get_qrcode_status?qrcode=&verify_code=
   *
   * **超时或网络错误一律返回 {status:"wait"}**(可重试),绝不抛 —— 参考实现
   * login-qr.ts:128-158 的语义,长轮询超时是正常控制流。
   * 但**形状不认识**(非对象 / status 非字符串)要抛 WeChatError,好让上层区分
   * 「服务端改协议了」与「这次没消息」。
   */
  async pollQrcodeStatus({ qrcode, verifyCode, timeoutMs = QR_LONG_POLL_TIMEOUT_MS, signal, baseUrl } = {}) {
    if (typeof qrcode !== "string" || !qrcode) {
      throw new WeChatError("bad_options", "pollQrcodeStatus: 缺少 qrcode");
    }
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    const client = baseUrl ? withBase(this, baseUrl) : this;
    try {
      const { json } = await client.request({
        method: "GET",
        endpoint,
        timeoutMs,
        label: "pollQrcodeStatus",
        abortSignal: signal
      });
      const obj = IlinkClient.expectObject(json, "pollQrcodeStatus");
      if (typeof obj.status !== "string" || !obj.status) {
        throw new WeChatError("bad_response_shape", "pollQrcodeStatus: 响应缺 status", {
          keys: Object.keys(obj).slice(0, 20)
        });
      }
      return { ...obj, status: obj.status };
    } catch (err) {
      if (err instanceof WeChatError && (err.code === "timeout" || err.code === "network")) {
        this.logger.debug(`pollQrcodeStatus: ${err.code}, 返回 wait 继续轮询`);
        return { status: "wait", transient: true };
      }
      throw err;
    }
  }

  /** 上报通道客户端上线。POST ilink/bot/msg/notifystart */
  async notifyStart({ timeoutMs = DEFAULT_CONFIG_TIMEOUT_MS, signal } = {}) {
    return this.notify("ilink/bot/msg/notifystart", "notifyStart", timeoutMs, signal);
  }

  /** 上报通道客户端下线。POST ilink/bot/msg/notifystop */
  async notifyStop({ timeoutMs = DEFAULT_CONFIG_TIMEOUT_MS, signal } = {}) {
    return this.notify("ilink/bot/msg/notifystop", "notifyStop", timeoutMs, signal);
  }

  async notify(endpoint, label, timeoutMs, signal) {
    const { json } = await this.request({
      method: "POST",
      endpoint,
      body: { base_info: this.baseInfo() },
      timeoutMs,
      label,
      abortSignal: signal
    });
    const obj = IlinkClient.expectObject(json, label);
    this.logger.debug(`${label}: ret=${obj.ret} errcode=${obj.errcode ?? ""}`);
    return obj;
  }

  baseInfo() {
    return { channel_version: DEFAULT_CLIENT_VERSION };
  }

  /**
   * 长轮询收消息。POST ilink/bot/getupdates,body {get_updates_buf}。
   * 返回 {msgs, get_updates_buf, longpolling_timeout_ms, ret, errcode, errmsg}。
   *
   * - 客户端超时 → 空响应(ret 0、msgs []、游标原样返回),让调用方直接重试;
   * - `errcode -14` → **由调用方处理冷却**(见 ensureSessionCooldown);此处只回传,
   *   除非 opts.throwOnSessionExpired 为 true。
   */
  async getUpdates({ buf = "", timeoutMs = DEFAULT_UPDATES_TIMEOUT_MS, signal, throwOnSessionExpired = false } = {}) {
    let json;
    try {
      ({ json } = await this.request({
        method: "POST",
        endpoint: "ilink/bot/getupdates",
        body: { get_updates_buf: buf ?? "", base_info: this.baseInfo() },
        timeoutMs,
        label: "getUpdates",
        abortSignal: signal
      }));
    } catch (err) {
      if (err instanceof WeChatError && err.code === "timeout") {
        this.logger.debug(`getUpdates: 客户端超时(${timeoutMs}ms),空响应重试`);
        return { msgs: [], get_updates_buf: buf ?? "", ret: 0, errcode: 0, errmsg: "", timedOut: true };
      }
      throw err;
    }
    const obj = IlinkClient.expectObject(json, "getUpdates");
    const out = {
      msgs: Array.isArray(obj.msgs) ? obj.msgs : [],
      get_updates_buf: typeof obj.get_updates_buf === "string" ? obj.get_updates_buf : (buf ?? ""),
      longpolling_timeout_ms:
        Number.isFinite(obj.longpolling_timeout_ms) && obj.longpolling_timeout_ms > 0
          ? obj.longpolling_timeout_ms
          : undefined,
      ret: Number.isFinite(obj.ret) ? obj.ret : 0,
      errcode: Number.isFinite(obj.errcode) ? obj.errcode : 0,
      errmsg: typeof obj.errmsg === "string" ? obj.errmsg : ""
    };
    if (out.errcode === STALE_TOKEN_ERRCODE || /session timeout/i.test(out.errmsg)) {
      this.logger.warn(`getUpdates: errcode=${out.errcode} errmsg="${out.errmsg}" → token 失效/会话过期`);
      if (throwOnSessionExpired) {
        throw new WeChatError("session_expired", "getUpdates: session timeout(errcode -14)", out);
      }
    }
    return out;
  }

  /**
   * 发一条文本消息。POST ilink/bot/sendmessage
   * body {msg:{from_user_id:"", to_user_id, client_id, message_type: BOT,
   *            message_state: FINISH, item_list:[{type: TEXT, text_item:{text}}]}}
   * 字段与常量来源见本文件 MessageType / MessageItemType / MessageState 的注释。
   */
  async sendMessage({ to, text, clientId, timeoutMs = DEFAULT_API_TIMEOUT_MS, signal } = {}) {
    if (!to) throw new WeChatError("bad_options", "sendMessage: 缺少 to(to_user_id)");
    const msg = {
      from_user_id: "",
      to_user_id: String(to),
      client_id: clientId || newClientId(),
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: text ? [{ type: MessageItemType.TEXT, text_item: { text: String(text) } }] : []
    };
    const { json } = await this.request({
      method: "POST",
      endpoint: "ilink/bot/sendmessage",
      body: { msg, base_info: this.baseInfo() },
      timeoutMs,
      label: "sendMessage",
      abortSignal: signal
    });
    const obj = IlinkClient.expectObject(json, "sendMessage");
    if (obj.ret && obj.ret !== 0) {
      // 注意:errmsg 可能带上下文信息,过一遍 redact 再抛(内容里可能回显 token)。
      throw new WeChatError("http_error", `sendMessage: ret=${obj.ret} errmsg=${redact(obj.errmsg || "(none)", [this.token])}`);
    }
    if (obj.errcode === STALE_TOKEN_ERRCODE) {
      throw new WeChatError("session_expired", "sendMessage: session timeout(errcode -14)", obj);
    }
    return obj;
  }
}

/** 用另一个 baseUrl 复用同一个 client 的配置(不改动 this,避免并发串台)。 */
function withBase(client, baseUrl) {
  const c = new IlinkClient({
    baseUrl,
    token: client.token,
    botType: client.botType,
    clientVersion: client.clientVersion,
    logger: client.logger,
    fetch: client.fetchImpl
  });
  return c;
}

/** client_id:腾讯侧用它做去重,随机 uuid 即可。 */
export function newClientId() {
  return crypto.randomUUID();
}

// ===========================================================================
// 5. 冷却退避(-14 / session timeout)
// ===========================================================================

/**
 * 账号级冷却闸门(§3:腾讯官方插件把该账号静默冷却 1 小时)。
 * 内存态即可 —— 冷却窗口跨重启丢失只会导致「多打一次接口」,不会更糟。
 * 测试正是数 mock 的请求次数来证明「不会打爆」。
 */
export class SessionCooldown {
  constructor({ cooldownMs = SESSION_COOLDOWN_MS, clock = Date.now } = {}) {
    this.cooldownMs = cooldownMs;
    this.clock = clock;
    this.until = 0;
    this.reason = "";
  }

  /** 进入冷却;返回本次冷到什么时候。 */
  arm(reason = "session timeout(errcode -14)") {
    this.until = this.clock() + this.cooldownMs;
    this.reason = reason;
    return this.until;
  }

  active() {
    return this.clock() < this.until;
  }

  remainingMs() {
    return Math.max(0, this.until - this.clock());
  }

  /** 剩余分钟数(向上取整,用于文案)。 */
  remainingMinutes() {
    return Math.ceil(this.remainingMs() / 60_000);
  }

  clear() {
    this.until = 0;
    this.reason = "";
  }

  /** 在冷却期内的请求一律拒绝(调用点:notifystart / getupdates / sendmessage)。 */
  assertActive() {
    if (!this.active()) return;
    throw new WeChatError(
      "cooldown",
      `账号冷却中:${this.reason},还剩约 ${this.remainingMinutes()} 分钟再试`
    );
  }
}

/**
 * 判断某次响应是否代表「token 失效 / 会话过期」(errcode -14 或 errmsg session timeout)。
 * 供 bridge 在 getupdates / sendmessage 的返回上统一判断,然后 arm 冷却。
 */
export function isSessionExpired(resp) {
  if (!resp || typeof resp !== "object") return false;
  if (resp.errcode === STALE_TOKEN_ERRCODE || resp.ret === STALE_TOKEN_ERRCODE) return true;
  return typeof resp.errmsg === "string" && /session timeout/i.test(resp.errmsg);
}

// ===========================================================================
// 6. 零依赖 QR 编码器(→ SVG data URL)
// ===========================================================================
/*
 * 为什么自己写(§10 第 3 步 + 交付要求):
 *   面板(桌面插件)和手机端网页都要渲染同一个二维码;把编码器放在 bridge 侧、
 *   以 `data:image/svg+xml;base64,…` 形式下发,两个前端就能复用同一份实现,
 *   浏览器 bundle 里**一个第三方包都不用加**(SVG 只是 <rect>,比 PNG 简单得多)。
 *
 * 实现范围:字节模式 + 纠错等级 M(交付要求的「至少 M」)+ 版本 1..40 自动选择。
 * 结构:功能图形(finder/separator/timing/alignment/dark module/format/version info)
 *   → 数据按「两列一组、自下而上、蛇形」落位 → 8 种掩码算罚分取最优 → 定型。
 * 校验:test/wechat-channel.test.mjs 用**独立参考实现(Nayuki qrcodegen,Python)
 *   在开发期逐模块比对** + 模块内解码器往返(格式位/掩码/交错/RS 全部真解一遍)。
 */

/** 纠错等级:仅 M(交付要求「至少 M」);format bits 的映射见 QR 规范表 25。 */
export const QR_EC_LEVEL_M = 0;

/**
 * 版本 1..40 的「每块纠错码字数」(等级 M)。
 * 数值原样取自 QR 规范中 M 列(经独立参考实现 Nayuki qrcodegen.py
 * `_ECC_CODEWORDS_PER_BLOCK[1]` 交叉核对 —— 不是猜的)。
 */
const QR_ECC_CODEWORDS_PER_BLOCK_M = [
  0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28
];

/** 版本 1..40 的**纠错块数**(等级 M);同样取自 QR 规范 M 列(同上交叉核对)。 */
const QR_NUM_EC_BLOCKS_M = [
  0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25,
  26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49
];

/**
 * 版本 1..40 的**剩余位**数(数据区装不满 8 位码字时的补齐位数,规范表 1)。
 * 直接用几何法算:剩余位 = 数据模块数 mod 8 —— 这样它永远和上面的功能图形定义一致
 * (手抄这张表极易整体错位一个版本,V6 就会因此少算一个码字)。
 */
const qrRemainderBits = (version) => dataModuleCount(version) % 8;

// ---- 矩阵构造(码字总数也要用它算,所以放在 qrBlocks 之前) ----

function makeMatrix(size) {
  return {
    size,
    modules: Array.from({ length: size }, () => new Array(size).fill(false)),
    fn: Array.from({ length: size }, () => new Array(size).fill(false))
  };
}

function setFn(m, x, y, dark) {
  if (x < 0 || y < 0 || x >= m.size || y >= m.size) return;
  m.modules[y][x] = !!dark;
  m.fn[y][x] = true;
}

function drawFinder(m, cx, cy) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      setFn(m, cx + dx, cy + dy, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(m, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setFn(m, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

/** 版本 1..40 的对齐图形中心坐标(规范附录 E)。 */
function qrAlignmentPositions(version) {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const numAlign = Math.floor(version / 7) + 2;
  // 间距:把 [6, size-7] 均分成 numAlign-1 段,向上取最近偶数(版本 32 是规范里的特例)。
  const step = version === 32 ? 26 : Math.ceil((size - 13) / (numAlign - 1) / 2) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

/**
 * 只画功能图形(不含格式位/版本位之外的任何数据),用于**数出数据模块数**。
 * 用途:算每版本码字总数 —— 规范公式在个别版本上容易记错,直接几何计数最稳。
 */
function functionPatternMatrix(version) {
  const m = makeMatrix(version * 4 + 17);
  for (let i = 0; i < m.size; i++) {
    setFn(m, 6, i, i % 2 === 0);
    setFn(m, i, 6, i % 2 === 0);
  }
  drawFinder(m, 3, 3);
  drawFinder(m, m.size - 4, 3);
  drawFinder(m, 3, m.size - 4);
  const pos = qrAlignmentPositions(version);
  const n = pos.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      drawAlignment(m, pos[i], pos[j]);
    }
  }
  // 格式位(两份,含 dark module)+ 版本位
  for (let i = 0; i <= 5; i++) setFn(m, 8, i, false);
  setFn(m, 8, 7, false);
  setFn(m, 8, 8, false);
  setFn(m, 7, 8, false);
  for (let i = 9; i <= 14; i++) setFn(m, 14 - i, 8, false);
  for (let i = 0; i <= 7; i++) setFn(m, m.size - 1 - i, 8, false);
  for (let i = 8; i <= 14; i++) setFn(m, 8, m.size - 15 + i, false);
  setFn(m, 8, m.size - 8, true);
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = m.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(m, a, b, false);
      setFn(m, b, a, false);
    }
  }
  return m;
}

/** 可放数据的模块数 = 总模块数 − 功能图形模块数(含格式/版本位与 dark module)。 */
function dataModuleCount(version) {
  const m = functionPatternMatrix(version);
  let used = 0;
  for (const row of m.fn) for (const c of row) if (c) used++;
  return m.size * m.size - used;
}

const totalCodewordsCache = new Map();
/** 每版本码字总数 = (数据模块数 − 剩余位) ÷ 8。 */
function qrTotalCodewords(version) {
  if (totalCodewordsCache.has(version)) return totalCodewordsCache.get(version);
  const total = (dataModuleCount(version) - qrRemainderBits(version)) / 8;
  totalCodewordsCache.set(version, total);
  return total;
}

/** 把数据码字切成交错用的块(短块在前,与 QR 规范表 9 的排布一致)。 */
export function qrBlocks(version) {
  if (!Number.isInteger(version) || version < 1 || version > 40) {
    throw new WeChatError("bad_options", `QR: 版本越界 ${version}`);
  }
  const total = qrTotalCodewords(version);
  const numBlocks = QR_NUM_EC_BLOCKS_M[version];
  const ecLen = QR_ECC_CODEWORDS_PER_BLOCK_M[version];
  const rawData = total - ecLen * numBlocks;
  // QR 规范的块结构是「先短块、后长块」,短块数量 = 块数 − 余数、长块数量 = 余数
  // (例如 V6-M:2 块 43 codewords + 2 块 42)。反过来写会构造出错误的块划分,
  // 纠错码字随之全错 —— 但**总码字数仍然对得上**,所以容量自检发现不了它。
  const shortLen = Math.floor(rawData / numBlocks);
  const numLong = rawData % numBlocks;
  const numShort = numBlocks - numLong;
  return { total, numBlocks, ecLen, rawData, shortLen, numShort, longLen: shortLen + 1 };
}

/** 字节模式数据码字数(4 bit 模式指示 + 8/16 bit 字符数 + 字节 + 补齐)。 */
export function qrDataCapacityBytes(version) {
  const { rawData } = qrBlocks(version);
  const ccBits = version <= 9 ? 8 : 16;
  return Math.max(0, rawData - Math.ceil((4 + ccBits) / 8));
}

/** 选版本:能装下就用最小的;超出版本 40 上限则报错(不静默截断)。 */
export function pickQrVersion(byteLength, minVersion = 1) {
  for (let v = Math.max(1, minVersion); v <= 40; v++) {
    if (byteLength <= qrDataCapacityBytes(v)) return v;
  }
  throw new WeChatError(
    "bad_options",
    `QR: 内容过长(${byteLength} 字节),超过版本 40-M 的容量上限`
  );
}

// ---- GF(256) XOR 运算(QR 用 0x11D 多项式) ----

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/**
 * 生成多项式 ∏(x − α^i),i = 0..degree-1。
 * 返回**降幂**系数(g[0] = x^degree 的系数 … g[degree] = 1),
 * 与 QR 规范表 A.1 的排布一致 —— 例如 degree=2 → [1, 3, 2]。
 */
function rsGeneratorPoly(degree) {
  let result = [1];
  let root = 1;
  for (let i = 0; i < degree; i++) {
    const next = new Array(result.length + 1).fill(0);
    for (let j = 0; j < result.length; j++) {
      next[j] ^= gfMul(result[j], root);
      next[j + 1] ^= result[j];
    }
    result = next;
    root = gfMul(root, 0x02);
  }
  return result.reverse(); // 升幂 → 降幂
}

/** 带余除法求纠错码字。返回除数多项式去掉最高次后的余式。 */
export function rsRemainder(data, degree) {
  const divisor = rsGeneratorPoly(degree);
  const result = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    for (let i = 0; i < degree; i++) result[i] ^= gfMul(divisor[i + 1], factor);
  }
  return result;
}

/** 字节 → 数据码字(模式指示 0100、字符数、内容、终止符、补齐 0xEC/0x11)。 */
export function qrEncodeBytes(bytes, version) {
  const { rawData } = qrBlocks(version);
  const ccBits = version <= 9 ? 8 : 16;
  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0x4, 4); // 字节模式
  push(bytes.length, ccBits);
  for (const b of bytes) push(b, 8);
  for (let i = 0; i < 4 && bits.length < rawData * 8; i++) bits.push(0); // 终止符
  while (bits.length % 8 !== 0) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    out.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  for (let pad = 0xec; out.length < rawData; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** 数据码字 → 全部码字(按块算 RS,再交错;短块在前)。 */
export function qrAddEcc(dataCodewords, version) {
  const { numBlocks, ecLen, shortLen, numShort, rawData } = qrBlocks(version);
  if (dataCodewords.length !== rawData) {
    throw new WeChatError("bad_options", `QR: 数据码字数不符(期望 ${rawData},收到 ${dataCodewords.length})`);
  }
  const dataBlocks = [];
  const ecBlocks = [];
  let k = 0;
  for (let i = 0; i < numBlocks; i++) {
    const len = shortLen + (i < numShort ? 0 : 1);
    const dat = dataCodewords.slice(k, k + len);
    k += len;
    dataBlocks.push(dat);
    ecBlocks.push(rsRemainder(dat, ecLen));
  }
  const result = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const blk of dataBlocks) if (i < blk.length) result.push(blk[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const blk of ecBlocks) result.push(blk[i]);
  }
  return result;
}

// ---- 矩阵内容(功能图形与矩阵构造在文件上方,因为码字总数也依赖它) ----

/** 15 bit 格式信息:(ecLevel<<3 | mask) 做 BCH(15,5),再异或 0x5412。 */
function qrFormatBits(ecLevel, mask) {
  const data = (ecLevel << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18 bit 版本信息(仅版本 ≥ 7):版本号做 BCH(18,6)。 */
function qrVersionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

function drawFormatBits(m, mask) {
  const bits = qrFormatBits(QR_EC_LEVEL_M, mask);
  const bit = (i) => ((bits >>> i) & 1) !== 0;
  // 第一份:左上 finder 周围
  for (let i = 0; i <= 5; i++) setFn(m, 8, i, bit(i));
  setFn(m, 8, 7, bit(6));
  setFn(m, 8, 8, bit(7));
  setFn(m, 7, 8, bit(8));
  for (let i = 9; i <= 14; i++) setFn(m, 14 - i, 8, bit(i));
  // 第二份:右上(行 8)/ 左下(列 8)
  for (let i = 0; i <= 7; i++) setFn(m, m.size - 1 - i, 8, bit(i));
  for (let i = 8; i <= 14; i++) setFn(m, 8, m.size - 15 + i, bit(i));
  setFn(m, 8, m.size - 8, true); // dark module
}

function drawVersionBits(m, version) {
  if (version < 7) return;
  const bits = qrVersionBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) !== 0;
    const a = m.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFn(m, a, b, dark);
    setFn(m, b, a, dark);
  }
}

/** 在给定矩阵上补齐功能图形(复用 functionPatternMatrix,避免两处定义漂移)。 */
function drawFunctionPatterns(m, version) {
  const fn = functionPatternMatrix(version);
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (fn.fn[y][x]) setFn(m, x, y, fn.modules[y][x]);
    }
  }
  // 版本 ≥ 7 还有两块 18 bit 版本信息(functionPatternMatrix 只把它们标成功能位,
  // 并没有填值 —— 这里必须真正画上,否则那 36 个模块会一直保持浅色)。
  drawVersionBits(m, version);
}

/**
 * 把码字按「两列一组、自下而上、蛇形」落到非功能模块上,并应用掩码。
 * 掩码索引:0 (x+y)%2 · 1 y%2 · 2 x%3 · 3 (x+y)%3 · 4 (x/3+y/2)%2 · 5 x*y%2+x*y%3 · 6 (x*y%2+x*y%3)%2 · 7 ((x+y)%2+x*y%3)%2
 *
 * 数据区末尾可能多出 0..7 个**剩余位**(装不满一个码字)。这些位仍属于符号本体,
 * 掩码对它们同样生效,所以它们的最终取值就是掩码位本身(写 0 再掩码 = 掩码位)。
 * 这里显式按掩码写,与参考实现逐模块一致,避免"剩余位永远浅色"。
 */
function drawCodewords(m, codewords, mask) {
  const size = m.size;
  let i = 0;
  // 竖直 timing pattern 在 x=6,不参与数据区:右列走到它时整体左移一列,
  // 使第 5 列与第 4 列配对(否则第 6 列会被当成数据列)。
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (m.fn[y][x]) continue;
        const masked = maskFn(mask, x, y);
        if (i >= codewords.length * 8) {
          m.modules[y][x] = masked; // 剩余位:0 ^ 掩码
          continue;
        }
        const bit = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
        // 掩码是 XOR:module = bit ^ maskFn(x, y)(规范 §8.8.1)
        m.modules[y][x] = masked ? !bit : bit;
        i++;
      }
    }
  }
}

function maskFn(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new WeChatError("bad_options", `QR: 掩码越界 ${mask}`);
  }
}

/** 掩码罚分(规范 §8.8.2 四条规则,N1=3 N2=3 N3=40 N4=10)。 */
function penaltyScore(m) {
  const size = m.size;
  const mod = (x, y) => m.modules[y][x];
  let result = 0;

  // 规则 1:行/列上连续同色 ≥5
  for (let y = 0; y < size; y++) {
    let runColor = false;
    let runLen = 0;
    for (let x = 0; x < size; x++) {
      if (x === 0 || mod(x, y) !== runColor) {
        runColor = mod(x, y);
        runLen = 1;
      } else {
        runLen++;
        if (runLen === 5) result += 3;
        else if (runLen > 5) result++;
      }
    }
  }
  for (let x = 0; x < size; x++) {
    let runColor = false;
    let runLen = 0;
    for (let y = 0; y < size; y++) {
      if (y === 0 || mod(x, y) !== runColor) {
        runColor = mod(x, y);
        runLen = 1;
      } else {
        runLen++;
        if (runLen === 5) result += 3;
        else if (runLen > 5) result++;
      }
    }
  }

  // 规则 2:2×2 同色块
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = mod(x, y);
      if (c === mod(x + 1, y) && c === mod(x, y + 1) && c === mod(x + 1, y + 1)) result += 3;
    }
  }

  // 规则 3:finder 状 1:1:3:1:1 且一侧有 4 个浅色模块
  const pattern = [true, false, true, true, true, false, true];
  const matches = (get, i, len) => {
    for (let k = 0; k < 7; k++) if (get(i + k) !== pattern[k]) return false;
    let before = true;
    for (let k = 1; k <= 4; k++) before = before && (i - k < 0 || get(i - k) === false);
    let after = true;
    for (let k = 7; k <= 10; k++) after = after && (i + k >= len || get(i + k) === false);
    return before || after;
  };
  for (let y = 0; y < size; y++) {
    const row = (i) => mod(i, y);
    for (let x = 0; x + 7 <= size; x++) if (matches(row, x, size)) result += 40;
  }
  for (let x = 0; x < size; x++) {
    const col = (i) => mod(x, i);
    for (let y = 0; y + 7 <= size; y++) if (matches(col, y, size)) result += 40;
  }

  // 规则 4:深色比例偏离 50% 的步长
  let dark = 0;
  for (const row of m.modules) for (const c of row) if (c) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += Math.max(0, k) * 10;
  return result;
}

/**
 * 编码为 QR 矩阵(布尔二维数组,[y][x] === true 表示深色)。
 * @param {string} text
 * @param {object} [opts] { minVersion, mask } —— mask 指定时跳过自动选优(测试/对比用)
 * @returns {{size:number, modules:boolean[][], version:number, mask:number, ecLevel:number}}
 */
export function qrEncode(text, opts = {}) {
  const bytes = Buffer.from(String(text ?? ""), "utf-8");
  const version = pickQrVersion(bytes.length, opts.minVersion ?? 1);
  const codewords = qrAddEcc(qrEncodeBytes(bytes, version), version);

  let best = null;
  const masks = Number.isInteger(opts.mask) && opts.mask >= 0 && opts.mask <= 7 ? [opts.mask] : [0, 1, 2, 3, 4, 5, 6, 7];
  for (const mask of masks) {
    const m = makeMatrix(version * 4 + 17);
    drawFunctionPatterns(m, version);
    drawCodewords(m, codewords, mask);
    drawFormatBits(m, mask);
    const score = penaltyScore(m);
    if (!best || score < best.score) best = { score, mask, m };
  }
  return { size: best.m.size, modules: best.m.modules, version, mask: best.mask, ecLevel: QR_EC_LEVEL_M };
}

/** QR 矩阵 → SVG 源码(每行 run-length 合并成若干 <rect>,保持文件小且可读)。 */
export function qrToSvg(qr, opts = {}) {
  const size = qr.size;
  const quiet = Math.max(0, Math.min(16, opts.quietZone ?? 4));
  const scale = opts.scale ?? 4;
  const dim = (size + quiet * 2) * scale;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">`,
    `<rect width="${dim}" height="${dim}" fill="#ffffff"/>`,
    `<g fill="#000000">`
  ];
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!qr.modules[y][x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < size && qr.modules[y][x + run]) run++;
      parts.push(
        `<rect x="${(x + quiet) * scale}" y="${(y + quiet) * scale}" width="${run * scale}" height="${scale}"/>`
      );
      x += run;
    }
  }
  parts.push("</g>", "</svg>");
  return parts.join("");
}

/**
 * 文本 → `data:image/svg+xml;base64,…`(面板 <img src> 直接用,无需第三方库)。
 * @returns {string}
 */
export function qrSvgDataUrl(text, opts = {}) {
  const svg = qrToSvg(qrEncode(text, opts), opts);
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf-8").toString("base64")}`;
}

// ===========================================================================
// 7. 绑定状态机(§3 / §10)
// ===========================================================================

/**
 * 扫码绑定会话。
 *
 * 设计要点(全部来自 §3 的 8 态表):
 *   - `need_verifycode` **回调式**表面化(onNeedVerifyCode),不读 stdin ——
 *     面板弹输入框,`submitVerifyCode()` 带回轮询;
 *   - `expired` 自动刷新二维码,**最多 3 次**,超限给出明确文案;
 *   - `binded_redirect` = 成功(该 bot 以前绑过),不是失败;
 *   - `scaned_but_redirect` 切 redirect_host 继续(且做 https 校验);
 *   - `verify_code_blocked` 给明确文案,并按参考实现刷新二维码/封顶放弃;
 *   - `confirmed` **必须带 ilink_bot_id**,没有就失败(绝不当作成功);
 *   - 未知状态 / 形状不认识 → 记日志 + 按可重试处理,**不崩**。
 */
export class BindSession {
  constructor(opts) {
    this.client = opts.client;
    this.logger = opts.logger;
    this.qr = opts.qr;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? QR_LONG_POLL_TIMEOUT_MS;
    this.onEvent = typeof opts.onEvent === "function" ? opts.onEvent : () => {};
    this.onNeedVerifyCode = typeof opts.onNeedVerifyCode === "function" ? opts.onNeedVerifyCode : null;
    this.deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
    this.clock = opts.clock ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

    this.qrcodeUrl = opts.qr.qrcode_img_content;
    this.expiredRefreshes = 0;
    this.verifyAttempts = 0;
    this.pendingVerifyCode = "";
    this.verifyCodeRequested = false;
    this.unknownStatuses = [];
    this.pollBaseUrl = opts.baseUrl ?? null; // null = 用 client 自己的
    this.done = false;
    this.result = null;
  }

  /** 供面板 `submitVerifyCode(code)` 调用:暂存,下次轮询带上。 */
  submitVerifyCode(code) {
    const c = String(code ?? "").trim();
    if (!c) return false;
    this.pendingVerifyCode = c;
    this.verifyCodeRequested = false;
    return true;
  }

  emit(evt, payload = {}) {
    try {
      this.onEvent(evt, payload);
    } catch (e) {
      this.logger.warn(`bind: onEvent 回调抛错(忽略)${redact(e.message)}`);
    }
  }

  /** 刷新二维码(expired / verify_code_blocked 用)。 */
  async refreshQr() {
    this.expiredRefreshes++;
    const qr = await this.client.getBotQrcode({});
    this.qr = qr;
    this.qrcodeUrl = qr.qrcode_img_content;
    this.pendingVerifyCode = "";
    this.verifyCodeRequested = false;
    this.emit("qr", { qrcodeUrl: this.qrcodeUrl, refreshCount: this.expiredRefreshes });
    return qr;
  }

  /** 放弃时的统一出口。 */
  fail(code, message) {
    this.done = true;
    this.result = { ok: false, code, message, qrcodeUrl: this.qrcodeUrl };
    this.emit("fail", this.result);
    return this.result;
  }

  /**
   * 推进一步。返回值:
   *   {ok:false, pending:true, status}   继续轮询
   *   {ok:false, verifyNeeded:true}      等面板给配对码
   *   {ok:true, ...}                     绑定成功(binded_redirect 也算成功)
   *   {ok:false, code, message}          终态失败
   */
  async next() {
    if (this.done) return this.result;
    if (this.clock() > this.deadline) {
      return this.fail("verify_timeout", "绑定超时:二维码已失效,请重新发起绑定。");
    }
    const opts = { qrcode: this.qr.qrcode, timeoutMs: this.pollTimeoutMs };
    if (this.pendingVerifyCode) opts.verifyCode = this.pendingVerifyCode;
    if (this.pollBaseUrl) opts.baseUrl = this.pollBaseUrl;

    let resp;
    try {
      resp = await this.client.pollQrcodeStatus(opts);
    } catch (err) {
      if (err instanceof WeChatError && err.code === "bad_response_shape") {
        // §3 警告:未公开接口,形状不认识是一等错误 —— 记下来并要求重试,不崩。
        this.logger.warn(`bind: 轮询响应形状不认识,按可重试处理(${redact(err.message)})`);
        this.unknownStatuses.push("bad_response_shape");
        this.emit("unknown", { reason: "bad_response_shape" });
        return { ok: false, pending: true, status: "unknown" };
      }
      const code = err instanceof WeChatError ? err.code : "unknown";
      return this.fail(code === "http_error" ? "http_error" : code, `轮询失败:${redact(err.message)}`);
    }

    const status = resp.status;
    this.emit("status", { status });

    switch (status) {
      case "wait":
        return { ok: false, pending: true, status };

      case "scaned":
        if (this.pendingVerifyCode) {
          this.logger.info("bind: 配对码已被接受,继续轮询");
          this.pendingVerifyCode = "";
        }
        this.emit("scaned", {});
        return { ok: false, pending: true, status };

      case "need_verifycode": {
        this.verifyAttempts++;
        if (this.verifyAttempts > MAX_VERIFY_ATTEMPTS) {
          return this.fail("verify_blocked", "配对码多次不正确,连接流程已停止,请稍后再试。");
        }
        this.pendingVerifyCode = "";
        const payload = {
          attempt: this.verifyAttempts,
          maxAttempts: MAX_VERIFY_ATTEMPTS,
          message:
            this.verifyAttempts === 1
              ? "请输入手机微信上显示的数字配对码。"
              : "配对码不正确,请重新输入。"
        };
        this.emit("need_verifycode", payload);
        // 回调式表面化:面板弹输入框。没有回调也**不读 stdin**,直接返回等待态。
        if (this.onNeedVerifyCode) {
          try {
            const code = await this.onNeedVerifyCode(payload);
            if (code) this.submitVerifyCode(code);
          } catch (e) {
            this.logger.warn(`bind: onNeedVerifyCode 回调抛错 ${redact(e.message)}`);
          }
        }
        return { ok: false, verifyNeeded: true, status, attempt: this.verifyAttempts };
      }

      case "expired": {
        if (this.expiredRefreshes >= MAX_QR_REFRESH_COUNT) {
          return this.fail(
            "bind_expired",
            `二维码已失效 ${MAX_QR_REFRESH_COUNT} 次,连接流程已停止,请稍后重新发起绑定。`
          );
        }
        this.emit("expired", { refreshCount: this.expiredRefreshes + 1, max: MAX_QR_REFRESH_COUNT });
        try {
          await this.refreshQr();
        } catch (e) {
          return this.fail("http_error", `刷新二维码失败:${redact(e.message)}`);
        }
        return { ok: false, pending: true, status, refreshed: true };
      }

      case "scaned_but_redirect": {
        const host = normalizeRedirectHost(resp.redirect_host);
        if (host) {
          this.pollBaseUrl = `https://${host}`;
          this.logger.info(`bind: IDC 重定向,轮询主机切换为 ${host}`);
          this.emit("redirect", { host });
        } else {
          this.logger.warn("bind: scaned_but_redirect 缺 redirect_host 或非法,沿用当前主机");
          this.emit("redirect", { host: null });
        }
        return { ok: false, pending: true, status };
      }

      case "verify_code_blocked":
        this.pendingVerifyCode = "";
        this.emit("verify_code_blocked", { message: "多次输入错误,请稍后再试。" });
        if (this.expiredRefreshes >= MAX_QR_REFRESH_COUNT) {
          return this.fail("verify_blocked", "多次输入错误,连接流程已停止。请稍后再试。");
        }
        try {
          await this.refreshQr();
        } catch (e) {
          return this.fail("http_error", `刷新二维码失败:${redact(e.message)}`);
        }
        return { ok: false, pending: true, status };

      case "binded_redirect":
        // 该 bot 之前绑过 —— 按参考实现语义视为**成功**(alreadyBound),不是失败。
        this.logger.info("bind: binded_redirect(该 bot 已绑定过),视为成功");
        this.done = true;
        this.result = {
          ok: true,
          alreadyBound: true,
          qrcodeUrl: this.qrcodeUrl,
          message: "该微信机器人已绑定过,无需重复绑定。"
        };
        this.emit("binded_redirect", this.result);
        return this.result;

      case "confirmed": {
        if (!resp.ilink_bot_id) {
          return this.fail(
            "bind_missing_bot_id",
            "绑定失败:服务器返回 confirmed 但没有 ilink_bot_id,无法确认绑定结果。"
          );
        }
        if (!resp.bot_token) {
          // token 缺失同样是"形状不认识"的一种,不能当成绑定成功(§8:没有 token 什么都做不了)。
          return this.fail("bad_response_shape", "绑定失败:服务器未返回 bot_token。");
        }
        this.done = true;
        this.result = {
          ok: true,
          alreadyBound: false,
          token: resp.bot_token,
          accountId: resp.ilink_bot_id,
          baseUrl: resp.baseurl || this.pollBaseUrl || this.client.baseUrl,
          userId: resp.ilink_user_id || "",
          qrcodeUrl: this.qrcodeUrl,
          message: "已将此电脑连接到微信机器人。"
        };
        this.logger.info(
          `bind: confirmed bot_id=${resp.ilink_bot_id} user=${redactToken(resp.ilink_user_id)} token=${redactToken(resp.bot_token)}`
        );
        this.emit("confirmed", { accountId: resp.ilink_bot_id, baseUrl: this.result.baseUrl });
        return this.result;
      }

      default: {
        // 未知状态 = 未公开协议演进的正常可能。记下来、继续轮询,绝不崩、也不当成成功。
        this.logger.warn(`bind: 未知状态 "${String(status).slice(0, 40)}",按可重试处理`);
        this.unknownStatuses.push(String(status).slice(0, 40));
        this.emit("unknown", { status });
        return { ok: false, pending: true, status: "unknown" };
      }
    }
  }

  /** 走到终态或超时(便捷封装;面板不需要它,测试和 CLI 用)。 */
  async run() {
    for (;;) {
      const step = await this.next();
      if (step.done !== undefined || step.ok || (!step.pending && !step.verifyNeeded)) return step;
      if (step.verifyNeeded) {
        // 没有配对码来源 → 明确失败,而不是死循环(§10 第 5 步:面板必须弹框)。
        if (!this.pendingVerifyCode) {
          return this.fail("verify_blocked", "需要数字配对码,但没有可用的输入来源。");
        }
        continue;
      }
      await this.sleep(this.pollIntervalMs);
    }
  }
}

/**
 * 发起绑定(§10 第 2-3 步):取二维码 → 返回会话句柄 + 二维码 URL。
 * 面板拿到 qrcodeUrl 后本地渲染(可用本模块的 qrSvgDataUrl)。
 */
export async function startBind(init = {}) {
  const client = init.client;
  if (!client) throw new WeChatError("bad_options", "startBind: 缺少 client");
  const logger = init.logger || client.logger;
  const localTokenList = Array.isArray(init.localTokenList) ? init.localTokenList : [];
  const qr = await client.getBotQrcode({ localTokenList });
  logger.info(`startBind: 二维码已就绪(img_len=${qr.qrcode_img_content.length})`);
  const session = new BindSession({
    client,
    logger,
    qr,
    baseUrl: init.baseUrl ?? null,
    pollIntervalMs: init.pollIntervalMs,
    pollTimeoutMs: init.pollTimeoutMs,
    onEvent: init.onEvent,
    onNeedVerifyCode: init.onNeedVerifyCode,
    // ⚠️ 必须用**注入的 clock** 算截止时间,不能写 Date.now():
    //   Session 内部判超时用的是 `this.clock() > this.deadline`。若这里用真实 Date.now()
    //   而测试/调用方注入假时钟,两边时间轴不同源 → 超时**永远不会触发**,next() 一直
    //   返回 pending,面板就卡在"进行中"转圈,用户也不会看到"二维码已过期"。
    deadline:
      init.deadline ??
      (init.timeoutMs ? (init.clock ? init.clock() : Date.now()) + init.timeoutMs : Number.POSITIVE_INFINITY),
    clock: init.clock,
    sleep: init.sleep
  });
  return {
    session,
    qrcode: qr.qrcode,
    qrcodeUrl: qr.qrcode_img_content,
    /** 面板直接可用的 data URL。 */
    qrcodeSvg: qr.qrcode_img_content ? qrSvgDataUrl(qr.qrcode_img_content) : "",
    message: "请用手机微信扫描二维码完成绑定。",
    submitVerifyCode: (code) => session.submitVerifyCode(code),
    next: () => session.next(),
    run: () => session.run()
  };
}

// ===========================================================================
// 8. 凭据 / 状态文件(§8 / §9)
// ===========================================================================

export const accountPath = (relayDir) => path.join(relayDir, ACCOUNT_FILE);
export const statePath = (relayDir) => path.join(relayDir, STATE_FILE);

/**
 * 读凭据。返回 {token, accountId, baseUrl, userId, boundAt} 或 null。
 * ⚠️ **只有 bridge 内部能用它** —— 面板接口一律走 sanitizeAccount()(§8:永不回显 token)。
 */
export function loadAccount(relayDir) {
  try {
    const raw = fs.readFileSync(accountPath(relayDir), "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || typeof data.token !== "string" || !data.token) return null;
    return {
      token: data.token,
      accountId: typeof data.accountId === "string" ? data.accountId : "",
      baseUrl: typeof data.baseUrl === "string" && data.baseUrl ? data.baseUrl : DEFAULT_ILINK_BASE_URL,
      userId: typeof data.userId === "string" ? data.userId : "",
      boundAt: Number.isFinite(data.boundAt) ? data.boundAt : 0
    };
  } catch {
    return null;
  }
}

/** 保存凭据(0600 + Windows ACL 收紧)。 */
export function saveAccount(relayDir, account, onWarn) {
  const data = {
    token: String(account.token),
    accountId: String(account.accountId ?? ""),
    baseUrl: String(account.baseUrl || DEFAULT_ILINK_BASE_URL),
    userId: String(account.userId ?? ""),
    boundAt: Number.isFinite(account.boundAt) ? account.boundAt : Date.now()
  };
  writePrivateJson(accountPath(relayDir), data, onWarn);
  return data;
}

/** 解绑第一步:删凭据文件(§8 解绑顺序:停轮询 → notifystop → 删凭据)。 */
export function clearAccount(relayDir) {
  try {
    fs.rmSync(accountPath(relayDir), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 面板可见的账号形态(§8:面板 API **永不回显 token**)。
 * 只有三个字段,且注释里再强调一次:任何新增字段都要先过一遍「会不会泄 token」。
 */
export function sanitizeAccount(account) {
  if (!account) return { bound: false, botId: "", boundAt: 0 };
  return {
    bound: true,
    botId: String(account.accountId ?? ""),
    boundAt: Number.isFinite(account.boundAt) ? account.boundAt : 0
  };
}

/** 空状态(§9:只有 bound / unbound 两态)。 */
export function emptyState() {
  return {
    bound: false,
    bot_id: "",
    bound_at: 0,
    last_error: "",
    last_push_ok_at: 0,
    connected_at: 0
  };
}

/**
 * 写 <relayDir>/.wechat-state.json(0600)。
 * §9:**只有两态** —— bound / unbound;`connected_at` / `last_error` / `last_push_ok_at`
 * 只是健康提示,**不参与、也不改变绑定状态**(面板只用来显示「连接正常 / 最近一次推送失败」)。
 * 沿用 persistBridgeState / writeE2eeStateFile 的文件约定。
 */
export function saveState(relayDir, patch, onWarn) {
  let base = emptyState();
  try {
    const cur = JSON.parse(fs.readFileSync(statePath(relayDir), "utf8"));
    if (cur && typeof cur === "object") base = { ...base, ...cur };
  } catch {
    /* 首次写 / 文件损坏 → 从空状态开始 */
  }
  const next = { ...base, ...patch };
  next.bound = !!next.bound; // 归一为布尔,杜绝"三态"
  next.bot_id = next.bound ? String(next.bot_id ?? "") : "";
  next.bound_at = next.bound ? Number(next.bound_at) || 0 : 0;
  writePrivateJson(statePath(relayDir), next, onWarn);
  return next;
}

/** 读状态文件;不存在 / 损坏 → 空状态(未绑定)。 */
export function loadState(relayDir) {
  try {
    const cur = JSON.parse(fs.readFileSync(statePath(relayDir), "utf8"));
    if (!cur || typeof cur !== "object") return emptyState();
    return { ...emptyState(), ...cur, bound: !!cur.bound };
  } catch {
    return emptyState();
  }
}

/** 绑定成功后的状态写入。 */
export function markBound(relayDir, account, onWarn) {
  return saveState(
    relayDir,
    {
      bound: true,
      bot_id: account.accountId ?? "",
      bound_at: Number(account.boundAt) || Date.now(),
      last_error: "",
      connected_at: Date.now()
    },
    onWarn
  );
}

/** 解绑:清凭据 + 状态回到未绑定。 */
export function markUnbound(relayDir, reason = "", onWarn) {
  clearAccount(relayDir);
  return saveState(relayDir, { bound: false, bot_id: "", bound_at: 0, last_error: reason, connected_at: 0 }, onWarn);
}

// ===========================================================================
// 9. 通知格式化(§5)+ 回执编号注册表
// ===========================================================================

/** 回执有效期文案里的分钟数(§6 ①:审批有寿命,过期静默丢失,文案必须说出来)。 */
export const DEFAULT_REPLY_TTL_MINUTES = 5;

const NODE_LABELS = Object.freeze({
  approval: "需要你拍板",
  question: "在等你回答",
  plan: "计划待你批准",
  error: "任务报错",
  stopped: "任务已停止",
  daily: "每日简报",
  quota: "额度提醒",
  membership: "会员提醒"
});

/**
 * 文案纪律(§5):邀请/奖励相关**只有邀请人得奖励**,绝无「双方都得」
 * (这是已核实的商品事实:没有接受邀请方的奖励)。
 * 任何从这里长出来的文案都要过 test 的措辞断言。
 */
export const INVITE_COPY = Object.freeze({
  inviteOnlyRewarded: "只有邀请人得奖励(被邀请方没有奖励)",
  quotaBtn: "回复 1 邀请好友(你可得奖励)",
  membershipBtn: "回复 1 邀请好友换时长(只有你可得奖励)"
});

/**
 * 给每个节点留一格「可回执」的选项定义。
 * plan-review(intent.kind === 'plan-review')与普通提问文案必须区分(§5 节点 2)。
 */
function optionsFor(kind, node) {
  if (kind === "approval") {
    return [
      { label: "同意一次", value: "allowed-once" },
      { label: "拒绝", value: "rejected" }
    ];
  }
  if (kind === "question" || kind === "plan") {
    const raw = Array.isArray(node.options) ? node.options : [];
    const opts = raw
      .map((o, i) => ({
        label: typeof o === "string" ? o : String((o && (o.label ?? o.title ?? o.value)) ?? `选项${i + 1}`),
        value: o && typeof o === "object" && o.value !== undefined ? o.value : i
      }))
      .slice(0, 9);
    return opts.length ? opts : null;
  }
  if (kind === "quota" || kind === "membership") {
    return [
      { label: "邀请好友", value: "invite" },
      { label: "知道了", value: "dismiss" }
    ];
  }
  return null;
}

/**
 * 把 P0/P1 节点渲染成**纯文本**微信消息。
 *
 * @param {object} node
 *   kind: 'approval'|'question'|'plan'|'error'|'stopped'|'daily'|'quota'|'membership'
 *   tool / reason / prompt / detail / sessionId / options / lines(简报用)…
 *   ttlMinutes(可回执节点的有效期,默认 5)
 * @returns {{kind,title,text,options,replyable,ttlMinutes,expiresAt}}
 */
export function formatNotification(node = {}, opts = {}) {
  const kind = String(node.kind || "error");
  const title = NODE_LABELS[kind] || "DSH 通知";
  const now = opts.now ?? Date.now();
  const ttlMinutes = Number.isFinite(node.ttlMinutes) ? node.ttlMinutes : DEFAULT_REPLY_TTL_MINUTES;
  const lines = [];

  switch (kind) {
    case "approval": {
      lines.push(`【${title}】`);
      lines.push(`工具: ${node.tool || "(未提供)"}`);
      if (node.reason) lines.push(`原因: ${node.reason}`);
      if (node.detail) lines.push(`详情: ${shorten(node.detail, 200)}`);
      break;
    }
    case "question":
    case "plan": {
      if (kind === "plan") {
        lines.push(`【${title}】`);
        lines.push("DSH 已写好计划,等你批准后开始执行。");
      } else {
        lines.push(`【${title}】`);
        lines.push("DSH 在等你回答:");
      }
      if (node.prompt) lines.push(shorten(node.prompt, 400));
      break;
    }
    case "error": {
      lines.push(`【${title}】`);
      if (node.sessionTitle) lines.push(`任务: ${node.sessionTitle}`);
      lines.push(shorten(node.detail || node.message || "任务执行出错。", 400));
      break;
    }
    case "stopped": {
      lines.push(`【${title}】`);
      if (node.sessionTitle) lines.push(`任务: ${node.sessionTitle}`);
      lines.push(`停止原因: ${stopReasonText(node.reason)}`);
      break;
    }
    case "daily": {
      lines.push(`【${title}】`);
      for (const l of Array.isArray(node.lines) ? node.lines : []) lines.push(String(l));
      if (!Array.isArray(node.lines) || !node.lines.length) lines.push("今天暂时没有要做的事。");
      // ⚠️ 这句是**功能**不是客套:微信 24h 推送窗口靠用户回消息续期,
      // 简报的产品作用正是每天制造一次互动(§7)。必须出现「回复」字样,否则用户不会回。
      lines.push("(回复任意一句话即可保持推送窗口有效)");
      break;
    }
    case "quota": {
      lines.push(`【${title}】`);
      lines.push(shorten(node.message || "你的额度快用完了 / 已被限流。", 300));
      lines.push(INVITE_COPY.inviteOnlyRewarded);
      break;
    }
    case "membership": {
      lines.push(`【${title}】`);
      lines.push(shorten(node.message || "你的会员即将过期 / 已过期。", 300));
      lines.push(INVITE_COPY.inviteOnlyRewarded);
      break;
    }
    default: {
      lines.push(`【${title}】`);
      lines.push(shorten(node.message || node.detail || `未知节点 ${kind}`, 300));
      break;
    }
  }

  const options = optionsFor(kind, node);
  const replyable = Array.isArray(options) && options.length > 0;
  if (replyable) {
    lines.push("");
    options.forEach((o, i) => lines.push(`回复 ${i + 1} ${o.label}`));
    if (kind === "question" || kind === "plan") {
      lines.push(`(本条 ${ttlMinutes} 分钟内有效)`);
    } else {
      lines.push(`(本条 ${ttlMinutes} 分钟内有效)`);
    }
  }

  // 纯文本 + 短:微信不是富客户端(§5 交付要求)。超长整条截断并显式标注。
  let text = lines.join("\n");
  const maxLen = opts.maxLength ?? 900;
  if (text.length > maxLen) text = `${text.slice(0, maxLen - 20)}\n…(内容过长已截断)`;

  return {
    kind,
    title,
    text,
    options: replyable ? options : [],
    replyable,
    ttlMinutes,
    expiresAt: replyable ? now + ttlMinutes * 60_000 : 0
  };
}

/**
 * 单行摘要 + **显式标注截断**。
 * ⚠️ 截断必须写明「已截断」:否则用户以为自己看到的是全文(尤其错误详情被截时,
 * 会照着半句话去排查)。测试锁死了这一点。
 */
function shorten(s, n) {
  const t = String(s ?? "").replace(/\s*\n\s*/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…(已截断)` : t;
}

const STOP_REASONS = Object.freeze({
  completed: "正常完成",
  aborted: "被中止",
  blocked: "被阻塞(等你处理)",
  error: "出错结束",
  "max-tokens": "上下文/输出达上限",
  interrupted: "被中断"
});

export function stopReasonText(reason) {
  const k = String(reason ?? "").trim();
  return STOP_REASONS[k] || (k ? `未知原因(${k})` : "未知原因");
}

/**
 * 只有这几种收尾需要额外说明"它不是正常跑完的"。
 * `completed` 故意不在表里 —— 正常完成就是正常完成,多一句废话反而像出事。
 */
const COMPLETION_REASON_NOTES = Object.freeze({
  "max-tokens": "(到上限就停了,不是正常完成,结论可能不完整)",
  aborted: "(被中止,后面的活没做完,结论可能不完整)",
  interrupted: "(被中断,后面的活没做完,结论可能不完整)",
  blocked: "(它正等你处理,这一轮还没真正结束)",
  error: "(出错结束,结论可能不完整)"
});

/**
 * **任务收尾消息**模板 —— 整个产品里用户看得最多的一条输出。
 *
 * 它要回答三个问题,顺序就是用户看消息的顺序:
 *   ① 怎么结束的(完成 / 中断 / 中止 / 超 token 必须**能分辨**;
 *      以前只推「任务已停止」= 什么都没说);
 *   ② 是哪个任务(会话名);
 *   ③ 干出了什么(结论);最后告诉用户**直接回复就能接着做**
 *      —— 这是本产品的全部卖点:不用回电脑、不用重新交代背景。
 *
 * ⚠️ 措辞诚实:`completed` 的头不许带失败味(用户会以为白干了);
 *    `max-tokens` **不是**"跑完了",必须写明到上限截断。
 * ⚠️ 拿不到结论时(hanging)说的是"没取到",而不是"没有结论"——
 *    后者是替 agent 下结论,用户会据此以为任务什么都没产出。
 *
 * @param {object} args { title(会话名), reason(completed|aborted|blocked|error|max-tokens|interrupted),
 *                        summary(结论), sessionId, hanging(结论取不到时 true) }
 * @param {object} [opts] { summaryMaxLength=400, maxLength=900, ttlMinutes, continuationHint }
 *   `continuationHint` 非空 = 用**调用方给的**收尾话术替换默认的「回复就能接着做」,
 *   且不再在结论缺失时邀请用户回复(免费档做不到,不能对他下这种指令)。
 * @returns {{kind:'completed', title:string, text:string, replyable:false, ttlMinutes:number}}
 *   title 是**展示标题**(和 formatNotification 的 title 同义,【】里那一行);会话名在 text 里。
 */
export function formatCompletion({ title, reason, summary, sessionId, hanging } = {}, opts = {}) {
  const reasonKey = String(reason ?? "").trim();
  const reasonText = stopReasonText(reasonKey);
  const name = String(title ?? "").trim();
  const sid = String(sessionId ?? "").trim();
  const body = String(summary ?? "").trim();
  const summaryMax = Number.isFinite(opts.summaryMaxLength) ? opts.summaryMaxLength : 400;
  const ttlMinutes = Number.isFinite(opts.ttlMinutes) ? opts.ttlMinutes : DEFAULT_REPLY_TTL_MINUTES;
  const lines = [];

  // ① 结果头
  lines.push(`【任务${reasonText}】`);
  const note = COMPLETION_REASON_NOTES[reasonKey];
  if (note) lines.push(note);

  // ② 哪个任务(用户第一眼要找的就是它)
  if (name) {
    lines.push(`会话:${name}`);
  } else if (sid) {
    // 没名字但知道 id → 给短号,用户能在 /ls 里对上号(总比"未命名"强)
    lines.push(`会话:未命名(${sid.replace(/^session-/, "").slice(0, 8)})`);
  } else {
    lines.push("会话:未命名(这次没取到会话名)");
  }

  // ③ 结论
  //   只有「能回话」的档位才邀请用户回复 —— 否则那是对一个做不到的人下指令
  //   (免费用户回复纯文本只会拿到付费引导,见 wechat-runtime 的 #upsellText)。
  const canContinue = opts.continuationHint === undefined;
  if (body) {
    lines.push(`结论:${shorten(body, summaryMax)}`);
  } else if (hanging) {
    lines.push(canContinue
      ? "结论:暂时没取到(任务可能还在收尾)。回复 /summary 可以再要一次。"
      : "结论:暂时没取到(任务可能还在收尾)。");
  } else {
    lines.push(canContinue
      ? "结论:这次没有产出结论。回复一句话就能追问。"
      : "结论:这次没有产出结论。");
  }

  // ④ 收尾:回复即续接同一会话(付费档的产品核心,别删这句)。
  //   免费档由调用方传 `continuationHint` 换成"会员可用 + App 链接"的说法。
  lines.push(opts.continuationHint || "回复这条消息(直接说下一步)就能接着这个会话往下做,不用重新交代背景。");

  // 纯文本 + 长度上限:微信不是富客户端,超长整条截断并显式标注
  let text = lines.join("\n");
  const maxLen = Number.isFinite(opts.maxLength) ? opts.maxLength : 900;
  if (text.length > maxLen) text = `${text.slice(0, maxLen - 20)}\n…(内容过长已截断)`;

  return { kind: "completed", title: `任务${reasonText}`, text, replyable: false, ttlMinutes };
}

/**
 * 回执编号注册表:每条发出去的通知拿一个不透明 eventId,
 * 入站回复用「编号」映射回它(§1 一步回执)。
 */
export class EventRegistry {
  constructor({ max = 200, ttlMs = DEFAULT_REPLY_TTL_MINUTES * 60_000, clock = Date.now } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.entries = new Map(); // eventId -> {eventId, options, kind, createdAt, expiresAt, meta}
  }

  /** 登记一条可回执通知;返回其 eventId(调用方负责把它带进消息文案)。 */
  register({ eventId, options = [], kind = "", ttlMs = this.ttlMs, meta = {} } = {}) {
    const id = eventId || crypto.randomUUID();
    const now = this.clock();
    this.entries.set(id, {
      eventId: id,
      options,
      kind,
      meta,
      createdAt: now,
      expiresAt: now + ttlMs
    });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
    return id;
  }

  /** 取一条;**已过期 / 不存在**都返回 null,调用方据此回「这条已过期」(§6 ①)。 */
  get(eventId) {
    const e = this.entries.get(eventId);
    if (!e) return null;
    if (this.clock() > e.expiresAt) {
      this.entries.delete(eventId);
      return null;
    }
    return e;
  }

  /** 用掉的立刻清掉,避免同一个编号被回复两次。 */
  consume(eventId) {
    const e = this.get(eventId);
    if (e) this.entries.delete(eventId);
    return e;
  }

  expire(eventId) {
    return this.entries.delete(eventId);
  }

  get size() {
    return this.entries.size;
  }

  clear() {
    this.entries.clear();
  }
}

/**
 * 把一条通知格式化成「带编号选项 + eventId」的完整出站规格。
 * 返回值里的 eventId 就是入站解析要映射回去的那个不透明 id。
 * ⚠️ 微信消息里**不出现** eventId(用户只回数字);eventId 只留在调用方/注册表。
 */
export function buildOutboundNotification(node, registry, opts = {}) {
  const formatted = formatNotification(node, opts);
  if (!formatted.replyable || !registry) return { ...formatted, eventId: "" };
  const eventId = registry.register({
    eventId: node.eventId,
    options: formatted.options,
    kind: formatted.kind,
    ttlMs: formatted.ttlMinutes * 60_000,
    meta: node.meta || {}
  });
  return { ...formatted, eventId };
}

// ===========================================================================
// 9b. 破坏性工具识别(v2 安全约束:危险操作**不给一步回执**)
// ===========================================================================

/**
 * 判定哲学:**假阳性便宜,假阴性昂贵**。
 *   假阳性 = 用户多走两步、回到电脑上当面点一次(烦,但没有任何损失);
 *   假阴性 = 手机上一下点掉 `rm -rf`,数据没了(不可逆,且**没有任何补救**)。
 * 所以**拿不准就判破坏性(true)**。
 *
 * 唯一的例外是"把什么都判成破坏性":那等于没有判定 —— 用户会对提示脱敏
 * (反正每次都要去电脑),安全约束反而废掉。所以普通的读/查/测试/构建
 * (`ls`、`cat`、`grep`、`npm test`、`git status`)以及 agent 的日常文件
 * 写入/编辑必须判 **false**。
 *
 * ⚠️ 真实生产者给的信息很薄:`dsh-events.mjs` 的审批节点只有
 * `toolName / callId / reason`(见该文件 1676-1685),**没有命令原文**。
 * 所以本函数按三层判:
 *   ① 工具名本身带破坏语义(delete_file / rmdir / drop_table …);
 *   ② detail / reason 文本里能认出破坏性意图(rm -rf、强推、DROP TABLE…);
 *   ③ 能跑命令的工具**连一点可看的信息都没有**时,一律判破坏性
 *      (看不见要跑什么 = 拿不准;见 SHELL_TOOL_NAME_RE)。
 */

/** 工具名本身就带破坏语义(detail 为空也要拦)。 */
const DESTRUCTIVE_TOOL_NAME_RE =
  /(^|[^a-z0-9])(rm|rmdir|unlink|del|delete|remove|destroy|drop|truncate|purge|wipe|erase|shred|mkfs|revoke|force[_-]?push)([^a-z0-9]|$)/i;

/** 会执行命令的工具(第三层的判据:看不见命令原文就不给一步回执)。 */
const SHELL_TOOL_NAME_RE =
  /(^|[^a-z0-9])(bash|sh|shell|zsh|fish|powershell|pwsh|cmd|terminal|exec|execute|run[_-]?command|subprocess|spawn|command)([^a-z0-9]|$)/i;

/** 搬运类工具:单个改名不算破坏性,但**带通配/强制**就是批量覆盖(见下面"批量搬运")。 */
const MOVE_TOOL_NAME_RE = /(^|[^a-z0-9])(mv|move|rename|cp|copy)([^a-z0-9]|$)/i;

/**
 * detail/reason 文本里的破坏性意图。`why` 只用于排查/报告(函数只返回布尔)。
 * 每条都写得**具体**(要看得见的破坏动作),避免"什么命令都算破坏性"。
 */
const DESTRUCTIVE_INTENT_PATTERNS = Object.freeze([
  // ── 删除(递归/强制/批量) ───────────────────────────────────────────────
  { re: /\brm\s+(-\S+\s+)*\S/i, why: "rm 删除" },
  { re: /\brmdir\b|\brd\s+\/s\b|\bremove-item\b/i, why: "删目录" },
  { re: /\b(del|delete|remove|unlink|erase|purge)\s+\S/i, why: "删除文件/对象" },
  { re: /\bfind\b[^\n]*(-delete\b|-exec\s+rm\b)/i, why: "find 批量删除" },
  { re: /\bgit\s+clean\s+-[a-z]*[fdx]/i, why: "git clean 丢弃未跟踪文件" },
  { re: /\bdocker\s+(system|volume|image|container)\s+prune\b|\bdocker\s+(rm|rmi)\b/i, why: "清理容器/镜像" },
  { re: /\bdocker\s+compose\s+down\b[^\n]*\s-v\b/i, why: "连数据卷一起拆" },
  { re: /\bkubectl\s+delete\b|\bterraform\s+(destroy|apply\s+-destroy)\b|\bhelm\s+uninstall\b/i, why: "删基础设施" },
  { re: /\baws\s+s3\s+(rm|rb)\b|\bgcloud\b[^\n]*\bdelete\b/i, why: "删云端资源" },
  { re: /\bnpm\s+unpublish\b/i, why: "撤回已发布的包" },

  // ── 覆盖磁盘/分区 ─────────────────────────────────────────────────────
  { re: /\bmkfs(\.\w+)?\b|\bwipefs\b|\bshred\b/i, why: "格式化/擦除设备" },
  { re: /\bdiskutil\s+(erase|reformat|zeroDisk|secureErase)\w*/i, why: "抹掉磁盘" },
  { re: /\bdd\b[^\n]*\bof=/i, why: "dd 直接写设备/文件" },
  { re: /\bfdisk\b|\bparted\b|\bformat\s+[a-z]:/i, why: "改分区/格式化" },
  { re: /\bformat-volume\b/i, why: "格式化卷" },

  // ── 重写历史/强推/丢弃改动 ────────────────────────────────────────────
  { re: /\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|--delete\b|--mirror\b|\s-f\b)/i, why: "强推/删远端分支" },
  { re: /\bgit\s+(reset\s+--hard|filter-branch|filter-repo|rebase|update-ref\s+-d)\b/i, why: "重写历史" },
  { re: /\bgit\s+commit\b[^\n]*--amend\b/i, why: "改写已有提交" },
  { re: /\bgit\s+(checkout\s+--\s+\.|restore\s+\.|branch\s+-D|tag\s+-d|stash\s+(drop|clear))\b/i, why: "丢弃本地改动" },

  // ── 数据库 ────────────────────────────────────────────────────────────
  { re: /\bdrop\s+(table|database|schema|collection|index|user|view)\b/i, why: "DROP" },
  { re: /\btruncate\b/i, why: "TRUNCATE" },
  { re: /\bdelete\s+from\b|\bdeleteMany\b|\bdropDatabase\b|\bdb\.\w+\.drop\b/i, why: "删数据" },
  { re: /--drop\b/i, why: "带 --drop 的导入/迁移" },

  // ── 批量搬运/覆盖/递归改权限 ──────────────────────────────────────────
  { re: /\bmv\s+-[a-z]*f|\bmv\s+[^\n]*\*/i, why: "强制/批量移动" },
  { re: /\bmove\s+\/[yY]\b/i, why: "覆盖式移动" },
  { re: /\brsync\b[^\n]*--delete\b/i, why: "rsync --delete" },
  { re: /\bchmod\s+-[a-z]*R\b|\bchown\s+-[a-z]*R\b|\bchmod\s+777\b/i, why: "递归改权限" },

  // ── 凭据/密钥(外泄面:手机上点一下就把密钥读了) ──────────────────────
  {
    re: /\.ssh\b|\bid_(rsa|dsa|ecdsa|ed25519)\b|\.aws\/credentials|\.netrc\b|\.npmrc\b|\.env\b|\.pem\b|\bkeychain\b|find-generic-password|\bsecretsmanager\b|get-secret-value|\bprivate[_-]?key\b|\bapi[_-]?key\b|\bpassword\b|\bpasswd\b|\bcredential/i,
    why: "读凭据/密钥"
  },
  { re: /\bgpg\b[^\n]*--export-secret/i, why: "导出私钥" },

  // ── 停服务/杀进程/关机器 ─────────────────────────────────────────────
  { re: /\bsystemctl\s+(stop|disable|mask)\b|\blaunchctl\s+(unload|bootout|remove|stop)\b/i, why: "停系统服务" },
  { re: /\b(kill|killall|pkill)\s+-9\b|\bkillall\b|\bpkill\b/i, why: "强杀进程" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, why: "关机/重启" },

  // ── 远端脚本直接喂给 shell(供应链) ──────────────────────────────────
  { re: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba|z|k|d)?sh\b/i, why: "远端脚本直接执行" },

  // ── 中文描述里写明的破坏性(事件侧 reason 常是中文) ──────────────────
  { re: /删库|删除所有|全部删除|彻底删除|格式化|强制推送|清空数据|数据丢失|不可恢复|销毁|擦除/, why: "描述里有明确破坏性措辞" }
]);

/** 把 detail(字符串/对象/数组)压成一段可扫的文本;循环引用/函数/超深结构都不抛。 */
function flattenToolDetail(detail, depth = 0, seen = new Set()) {
  if (detail == null) return "";
  const t = typeof detail;
  if (t === "string") return detail;
  if (t === "symbol" || t === "function") return t === "symbol" ? String(detail) : "";
  if (t !== "object") return String(detail);
  if (depth > 4) return "";
  if (seen.has(detail)) return ""; // 循环引用:扫不出结论,但**绝不抛**
  seen.add(detail);
  try {
    if (Array.isArray(detail)) {
      return detail.map((v) => flattenToolDetail(v, depth + 1, seen)).join("\n");
    }
    const parts = [];
    for (const [k, v] of Object.entries(detail)) {
      parts.push(k);
      parts.push(flattenToolDetail(v, depth + 1, seen));
    }
    return parts.join("\n");
  } catch {
    return "";
  }
}

/**
 * 这个工具/这次调用**是不是破坏性**?
 * 编排层据此**收回一步回执按钮**,让用户回电脑上当面确认。
 *
 * @param {string} toolName 工具名(如 Bash / Write / delete_file / mcp__fs__remove)
 * @param {string|object} [detail] 命令原文、参数对象,或事件侧给的 reason 文本
 * @returns {boolean} 拿不准 → true(理由见文件顶部注释)
 */
export function isDestructiveTool(toolName, detail) {
  const name = String(toolName ?? "");
  if (DESTRUCTIVE_TOOL_NAME_RE.test(name)) return true;

  const text = flattenToolDetail(detail);
  // ⚠️ 2026-09-22 按业主决定**删掉**了原来的规则③:「能跑命令的工具 + 完全看不到内容 → 算破坏性」。
  //   原意是防"盲批",但 DSH 的审批节点本来就只下发 toolName、常常没有命令原文,
  //   那条规则会把**绝大多数正常 Bash 审批**都降级成"只能回电脑确认",过严且伤体验。
  //   业主明确:安全边界松一点没问题,**DSH 自身有权限控制**。
  //   所以现在只看**内容**:看得出是 rm -rf / 强推 / DROP TABLE / 批量覆盖这类才拦;
  //   看不到内容时按普通审批处理(保留一步回执)。SHELL_TOOL_NAME_RE 仍保留,
  //   供将来若要恢复"盲批保护"时使用,并由测试固化其语义。
  if (!text.trim()) return false;
  for (const { re } of DESTRUCTIVE_INTENT_PATTERNS) {
    if (re.test(text)) return true;
  }
  // 搬运类工具 + 通配/强制 = 批量覆盖(单个改名不算,见 brief:"mass file moves")
  if (MOVE_TOOL_NAME_RE.test(name) && /[*?]|--force\b|\/force\b|\s-f\b/.test(text)) return true;
  return false;
}

// ===========================================================================
// 10. 入站解析(§11:真实形状未验证 → 防御式)
// ===========================================================================

/** 全角数字/空白归一(NFKC 把 １２３ 变 123,全角空格变普通空格)。 */
export function normalizeInput(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .trim();
}

/**
 * 从 getupdates 的一条消息里取出**用户文本**(§11:真实形状未验证,全部防御式)。
 * 兼容:item_list[].text_item.text、单个 item、纯字符串 message、content 字段。
 */
export function extractInboundText(msg) {
  if (msg == null) return "";
  if (typeof msg === "string") return msg;
  if (typeof msg !== "object") return "";
  const items = Array.isArray(msg.item_list)
    ? msg.item_list
    : msg.item
      ? [msg.item]
      : Array.isArray(msg.items)
        ? msg.items
        : [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const type = it.type;
    // type 缺失时也认 text_item(形状未验证,宁可多认一次)
    if (type !== undefined && type !== MessageItemType.TEXT) continue;
    const t = it.text_item && typeof it.text_item === "object" ? it.text_item.text : undefined;
    if (typeof t === "string" && t.trim()) return t;
  }
  if (typeof msg.text === "string" && msg.text.trim()) return msg.text;
  if (typeof msg.content === "string" && msg.content.trim()) return msg.content;
  return "";
}

/** 取出用户 id(from_user_id;兼容 fromUser、from)。 */
export function extractFromUserId(msg) {
  if (!msg || typeof msg !== "object") return "";
  for (const k of ["from_user_id", "from_userId", "fromUser", "from"]) {
    const v = msg[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

/**
 * 别名 → 规范指令名。
 * ⚠️ 编排层是按**规范名**分派的(`cmd === "/ls"`),所以别名必须在 `classifyInbound()`
 * 里收敛一次;否则 `/list` 会掉进"未知指令",用户看到一句"不认识"。
 */
export const COMMAND_ALIASES = Object.freeze({
  "/list": "/ls",
  "/sessions": "/ls"
});

/**
 * 支持的指令集合。
 * ⚠️ 别名也要在册:`parseInboundMessage()` 用 COMMANDS 判断"这是不是一条指令",
 * 漏掉别名 → 明明是合法指令却被回成"不认识这条指令"。
 */
export const COMMANDS = Object.freeze([
  "/new",
  "/ls",
  "/list",
  "/sessions",
  "/use",
  "/stop",
  "/status",
  "/summary",
  "/quiet",
  "/unbind",
  "/help"
]);

/**
 * 帮助文案(用户在微信里能看到的唯一说明书 → 短句、动词开头、说清"回什么会发生什么")。
 * ⚠️ COMMANDS 里每一条都必须在这里出现一次,否则用户根本不知道它存在。测试锁死这一点。
 */
export const HELP_TEXT = [
  "【DSH 微信通道】",
  "回数字(如 1)可回执最近一条需要你拍板的消息。",
  "直接发一句话 = 说给当前任务(还没有任务时会新开一个)。",
  "/new <任务> 开新任务并把任务发下去(先不写任务也行)",
  "/ls 列出会话,用 /use <编号> 切换(/list、/sessions 同义)",
  "/use <编号> 切换到某个会话,之后你发的话都进它",
  "/stop 中断当前会话正在跑的回合",
  "/summary 重发当前会话的最近结论",
  "/status 查看绑定与推送状态",
  "/quiet 暂停推送(回复任意消息恢复)",
  "/unbind 解除微信绑定",
  "/help 显示本帮助"
].join("\n");

/**
 * 解析一条入站消息。
 *
 * @param {object} msg getupdates 里的一条消息(形状未验证 → 防御式)
 * @param {object} [opts] { registry, eventId }
 * @returns {{
 *   ok:boolean, kind:'reply'|'command'|'unknown'|'empty', raw:string, from:string,
 *   choice:number|null, digits:string, eventId:string, expired:boolean,
 *   command:string, args:string, replyText:string
 * }}
 * - 数字(含全角、含首尾空白)→ kind:'reply', choice 为 1 基序号;
 * - 有 registry 时用 eventId 解析出对应事件;解析不到(过期/不存在)→ expired:true;
 * - `/xxx` → kind:'command';未知指令 → kind:'unknown'(调用方回帮助,绝不静默)。
 */
export function parseInboundMessage(msg, opts = {}) {
  const raw = extractInboundText(msg);
  const from = extractFromUserId(msg);
  const base = {
    ok: false,
    kind: "empty",
    raw,
    from,
    choice: null,
    digits: "",
    eventId: opts.eventId || "",
    expired: false,
    command: "",
    args: "",
    replyText: ""
  };
  const text = normalizeInput(raw);
  if (!text) return base;

  // 指令
  if (text.startsWith("/")) {
    const [cmdRaw, ...rest] = text.split(/\s+/);
    const cmd = cmdRaw.toLowerCase();
    if (COMMANDS.includes(cmd)) {
      return { ...base, ok: true, kind: "command", command: cmd, args: rest.join(" ") };
    }
    return {
      ...base,
      ok: false,
      kind: "unknown",
      command: cmd,
      args: rest.join(" "),
      replyText: `不认识这条指令:${cmd}\n\n${HELP_TEXT}`
    };
  }

  // 纯数字回执(NFKC 之后全角数字已是半角;这里再兜一层 Unicode 数字判断)
  const digits = extractDigits(text);
  if (digits !== null) {
    const choice = Number(digits);
    const registry = opts.registry;
    const eventId = opts.eventId || "";
    if (registry && eventId) {
      const entry = registry.consume(eventId);
      if (!entry) {
        return {
          ...base,
          ok: true,
          kind: "reply",
          choice,
          digits,
          expired: true,
          replyText: "这条通知已过期或已被处理,请重新发起。"
        };
      }
      const opt = (entry.options || [])[choice - 1];
      if (!opt) {
        return {
          ...base,
          ok: false,
          kind: "unknown",
          choice,
          digits,
          replyText: `没有第 ${choice} 个选项。\n\n${HELP_TEXT}`
        };
      }
      return {
        ...base,
        ok: true,
        kind: "reply",
        choice,
        digits,
        eventId,
        expired: false,
        replyText: `已选择:${opt.label}`
      };
    }
    // 没有注册表(或没有 eventId)→ 仍然是合法回执,交由调用方按"最近一条"处理。
    return { ...base, ok: true, kind: "reply", choice, digits };
  }

  // 其它自由文本:v1 不做对话(§1)→ 给帮助,绝不静默。
  return { ...base, ok: false, kind: "unknown", replyText: HELP_TEXT };
}

/**
 * 提取纯数字(1..2 位)。返回字符串或 null。
 * 接受:裸数字 / 首尾空白 / 全角数字 / 全角空白 / 末尾句点。
 */
export function extractDigits(text) {
  const t = normalizeInput(text);
  if (!t) return null;
  const m = /^([0-9]{1,2})[.。、]?$/.exec(t);
  if (m) return m[1];
  // 中文数字兜底("一"/"二")—— 老人机/语音输入常见
  const cn = { 一: "1", 二: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };
  if (t.length === 1 && cn[t]) return cn[t];
  return null;
}

/**
 * 入站文本**分类**(纯函数、全量,不抛):v2 里同一句话有三种去向,必须先分清。
 *
 * ⚠️ 优先级不能换(编排层就按这个顺序分派):
 *   ① `command` —— 否则「/new 修个 bug」会被当成发给会话的一句普通消息;
 *   ② `choice`  —— 裸数字是**回答上一条待办**;否则用户回「1」做审批时,
 *      这个「1」会被当成发给任务的文本;
 *   ③ `message` —— 其余纯文本 = 说给当前会话的话(产品核心:回复即续接)。
 *
 * @param {string} text 原始入站文本(内部做 NFKC + 去零宽 + trim,调用方不必先处理)
 * @returns {{kind:'command'|'choice'|'message'|'empty', command?:string, args?:string,
 *            choice?:number, text?:string}}
 *   - command: `command` 已**收敛别名并小写**(`/list` → `/ls`),`args` 是其后原文;
 *   - choice:`choice` 是 1 基序号(全角/中文数字已在 normalizeInput/extractDigits 里归一);
 *   - message:`text` 是归一后的原文;
 *   - empty:空/纯空白/纯零宽 → 什么都不做(不打扰用户,也绝不猜)。
 */
export function classifyInbound(text) {
  const t = normalizeInput(text);
  if (!t) return { kind: "empty" };
  if (t.startsWith("/")) {
    const [cmdRaw, ...rest] = t.split(/\s+/);
    const typed = cmdRaw.toLowerCase();
    return { kind: "command", command: COMMAND_ALIASES[typed] || typed, args: rest.join(" ") };
  }
  const digits = extractDigits(t);
  if (digits !== null) return { kind: "choice", choice: Number(digits) };
  return { kind: "message", text: t };
}

/** `/use <n>` 的编号:1 基正整数;非法(非纯数字 / <1 / 过大)返回 null。 */
function useIndexFrom(args) {
  const t = normalizeInput(args);
  if (!t) return null;
  const m = /^([0-9]{1,9})$/.exec(t); // 全角已在 normalizeInput 里变半角
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/**
 * 指令 → 动作(纯函数,便于测试;真正的副作用由 bridge/编排层执行)。
 *
 * ⚠️ 字段名是 **`replyText`**(不是 text)。编排层拿到 replyText 才算"这条指令答复完了"。
 * ⚠️ 需要真实数据的动作(list/summary/status)replyText 只是**一句占位答复**:
 *    编排层应当用真实内容替换它(status 由 renderStatusText() 填,这是既有约定)。
 *
 * @returns {{action:string, params?:object, replyText:string}}
 *   `/new <任务>` → `{action:'new', task, replyText}`(`task` 可能是空串)
 *   `/ls`(及 `/list` `/sessions`) → `{action:'list', replyText}`
 *   `/use <n>` → `{action:'use', index:{number|null}, replyText}`(非法输入 index 为 null)
 *
 * 两种调用形状都支持:`handleCommand("/new", "写周报")`、`handleCommand("/new 写周报")`。
 */
export function handleCommand(command, args = "") {
  // 兼容两种调用形状:`handleCommand("/new", "写周报")` 与 `handleCommand("/new 写周报")`
  const raw = String(command ?? "").trim();
  const [head, ...inline] = raw.split(/\s+/);
  const cmd = (head || "").toLowerCase();
  const rawArgs = String(args ?? "").trim() ? String(args) : inline.join(" ");
  switch (cmd) {
    case "/new": {
      const task = rawArgs.trim();
      return {
        action: "new",
        task,
        replyText: task
          ? `已收到任务:${task}\n正在开一个新会话,开好就下发。`
          : "想让我做什么?把任务写在 /new 后面就行,例如:/new 帮我写一份周报。\n(也可以先开好,再直接把要求发给我。)"
      };
    }
    case "/ls":
    case "/list":
    case "/sessions":
      return { action: "list", replyText: "正在读取会话列表…" };
    case "/use": {
      const index = useIndexFrom(rawArgs);
      if (index === null) {
        return {
          action: "use",
          index: null,
          replyText: `请用 /use <编号> 指定要切到哪个会话,例如 /use 2(编号见 /ls 列表)。这一条没看懂:${rawArgs.trim() || "(空)"}`
        };
      }
      return { action: "use", index, replyText: `正在切换到会话 ${index}…` };
    }
    case "/stop":
      return { action: "stop", replyText: "已发出停止请求,任务停下来后我会把状态推给你。" };
    case "/summary":
      return { action: "summary", replyText: "正在整理当前会话的结论…" };
    case "/unbind":
      return {
        action: "unbind",
        replyText: "已解除微信绑定,不会再向你推送消息。如需重新绑定,请在面板里点「连接微信机器人」。"
      };
    case "/quiet":
      return { action: "quiet", replyText: "已暂停微信推送。回复任意消息即可恢复。" };
    case "/status":
      return { action: "status", replyText: "" }; // bridge 用 renderStatusText() 填
    case "/help":
      return { action: "help", replyText: HELP_TEXT };
    default:
      return { action: "unknown", replyText: `不认识这条指令。\n\n${HELP_TEXT}` };
  }
}

/** /status 的回执文案(只含面板级别信息,绝不含 token —— §8)。 */
export function renderStatusText(account, state, opts = {}) {
  const sanitized = sanitizeAccount(account);
  const st = state || emptyState();
  if (!sanitized.bound) return "当前未绑定微信机器人。请在面板里点「连接微信机器人」。";
  const lines = ["【DSH 微信通道状态】", `绑定: 已绑定(bot ${sanitized.botId || "未知"})`];
  if (st.connected_at) lines.push(`连接: ${new Date(st.connected_at).toLocaleString("zh-CN")}`);
  if (st.last_push_ok_at) lines.push(`最近一次推送: 成功(${new Date(st.last_push_ok_at).toLocaleString("zh-CN")})`);
  if (st.last_error) lines.push(`最近一次错误: ${shorten(st.last_error, 120)}`);
  if (opts.quiet) lines.push("推送: 已暂停(/quiet,回复任意消息恢复)");
  lines.push("在线离线只是提示,不影响绑定状态。");
  return lines.join("\n");
}

// ===========================================================================
// 11. 高层外壳(可选):把客户端的 venv 常量、凭据与状态串起来
// ===========================================================================

/**
 * 便于 bridge 接线的薄封装(不主动起任何循环 —— 轮询由 bridge 决定何时跑)。
 *
 * @param {object} opts { relayDir, baseUrl, logger, clock }
 */
export class WeChatChannel {
  constructor(opts = {}) {
    if (!opts.relayDir) throw new WeChatError("bad_options", "WeChatChannel: 缺少 relayDir");
    this.relayDir = opts.relayDir;
    this.logger = opts.logger || createLogger();
    this.clock = opts.clock || Date.now;
    this.account = loadAccount(this.relayDir);
    if (this.account) this.logger.addSecret(this.account.token);
    this.client = new IlinkClient({
      baseUrl: (this.account && this.account.baseUrl) || opts.baseUrl || DEFAULT_ILINK_BASE_URL,
      token: this.account ? this.account.token : "",
      clientVersion: opts.clientVersion,
      logger: this.logger,
      fetch: opts.fetch
    });
    this.cooldown = new SessionCooldown({ cooldownMs: opts.cooldownMs, clock: this.clock });
    this.registry = new EventRegistry({ clock: this.clock });
    this.updatesBuf = "";
  }

  /** 面板接口用:永不回显 token(§8)。 */
  uiAccount() {
    return sanitizeAccount(this.account);
  }

  /** 落盘状态(§9:bound/unbound 两态)。 */
  readState() {
    return loadState(this.relayDir);
  }

  writeState(patch) {
    return saveState(this.relayDir, patch, (m) => this.logger.warn(m));
  }

  /** 绑定成功后:存凭据 → 建客户端 → 状态标已绑定。 */
  adoptConfirmed(result) {
    const account = saveAccount(
      this.relayDir,
      {
        token: result.token,
        accountId: result.accountId,
        baseUrl: result.baseUrl || this.client.baseUrl,
        userId: result.userId || "",
        boundAt: this.clock()
      },
      (m) => this.logger.warn(m)
    );
    this.account = account;
    this.logger.addSecret(account.token); // 之后任何日志行都会自动脱敏
    this.client = new IlinkClient({
      baseUrl: account.baseUrl,
      token: account.token,
      clientVersion: this.client.clientVersion,
      logger: this.logger,
      fetch: this.client.fetchImpl
    });
    this.writeState({
      bound: true,
      bot_id: account.accountId,
      bound_at: account.boundAt,
      last_error: "",
      connected_at: this.clock()
    });
    // ★ 绑定成功必须**清掉冷却**(2026-09-22 实测 bug)。
    //   冷却原本只按"撞到 -14"计时,但**换绑会拿到全新的 bot_token** ——
    //   旧 token 的会话超时对新 token 毫无意义。不清的后果:用户解绑→重绑拿到新 token,
    //   却仍被旧 token 的 1 小时冷却挡着,表现成"刚绑上就一小时内不能聊天",
    //   而且面板只说"通知会延迟",用户完全不知道为什么。(业主实测撞到)
    this.cooldown.clear();
    return this.uiAccount();
  }

  /**
   * 解绑(§8 顺序:停轮询 → notifystop → 删凭据)。
   * 停止长轮询是调用方的事(它持有循环);这里先 notifystop,再删凭据与状态。
   */
  async unbind() {
    let notifyError = "";
    if (this.account) {
      try {
        this.client.setToken(this.account.token);
        await this.client.notifyStop({});
      } catch (e) {
        notifyError = redact(e.message, [this.account.token]);
        this.logger.warn(`unbind: notifystop 失败(继续删凭据)${notifyError}`);
      }
    }
    const cleared = clearAccount(this.relayDir);
    this.account = null;
    this.client.setToken("");
    this.writeState({ bound: false, bot_id: "", bound_at: 0, connected_at: 0, last_error: notifyError });
    // ★ 解绑同样清冷却:凭据都删了,再"退避"没有任何意义 ——
    //   留着只会让用户重新绑定时继续被挡(见 adoptConfirmed 的注释)。
    this.cooldown.clear();
    return { ok: cleared, notifyError };
  }

  /**
   * 标记推送失败/成功(状态文件里的健康提示;不影响绑定状态)。
   *
   * ⚠️ errText **必须在这里脱敏**,不能指望调用方先脱好 —— 这个状态文件是**面板可读**的,
   * 而错误原文里经常拼着 token/URL。实测:`markPush(false, "发送失败 … <token>")`
   * 会把明文 token 写进 `.wechat-state.json`(违反 §8「凭据永不落进面板可读的地方」)。
   */
  markPush(ok, errText = "") {
    if (ok) return this.writeState({ last_push_ok_at: this.clock(), last_error: "" });
    const known = this.account && this.account.token ? [this.account.token] : [];
    const safe = maskFieldsInText(String(redact(shorten(errText, 200), known)));
    return this.writeState({ last_error: safe });
  }

  /**
   * 收到 -14 / session timeout 时统一入口:arm 冷却 + 记录错误状态。
   * bridge 在 getupdates / sendmessage 返回上调用它,然后按 cooldown.remainingMinutes() 退避。
   */
  noteSessionExpired(where = "api") {
    this.cooldown.arm(`${where}: session timeout(errcode -14)`);
    this.writeState({ last_error: `${where}: token 失效或会话过期(冷却 ${Math.round(SESSION_COOLDOWN_MS / 60000)} 分钟)` });
    this.logger.warn(`cooldown 已启动(${where}),${this.cooldown.remainingMinutes()} 分钟后重试`);
    return this.cooldown.until;
  }
}

// ===========================================================================
// 12. 路径辅助(bridge 接线用)
// ===========================================================================

/** 默认 relayDir 解析:显式参数 > 环境变量 > DSH_HOME/profiles/web。 */
export function resolveRelayDir(explicit) {
  if (explicit) return explicit;
  if (process.env.DSH_RELAY_DIR) return process.env.DSH_RELAY_DIR;
  const home = process.env.DSH_HOME || path.join(process.env.HOME || process.env.USERPROFILE || ".", ".dsh");
  return path.join(home, "profiles", "web");
}

export const MODULE_PATH = fileURLToPath(import.meta.url);
