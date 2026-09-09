#!/usr/bin/env node
/**
 * dsh-remote E2EE 客户端基建(bridge 端,Phase-2)
 *
 * 依据 docs/e2ee-protocol.md(评审稿 v0.1)§3/§4/§5/§9 实现,零外部依赖(node:crypto)。
 * 本模块是 **bridge(电脑端)一侧** 的 E2EE 能力:MK 派生 / HKDF 会话密钥调度 /
 * AES-256-GCM 信封(HTTP 请求-响应与 WS 逐消息)/ 控制通道握手(§5.2 桥端应答)/
 * 防重放(http nonce 滑动窗口 + ws 方向计数)。
 *
 * 关键边界(与协议一致):
 *   - MK 只驻内存,绝不落盘、不进日志;密码只在本进程内参与派生。
 *   - 明文回退由「开关」表达:service.enabled===false 时调用方必须走原 v1 路径。
 *   - 本模块不做任何网络层代理,只提供原语与最小会话状态机;帧编排在 dsh-bridge.mjs。
 *
 * ── 本阶段对评审稿的“实现规范化”决定(Phase-3 手机端必须按同样规则实现)──
 *   1. 域/info 分隔符统一用 \x00;所有 HKDF info 形如 "dsh-e2ee/v1\0<用途>"。
 *   2. SHK   = HKDF-SHA256(ikm=MK, salt=sha256(a‖b), info="dsh-e2ee/v1\0shk", 32)
 *      子密钥 = HKDF-SHA256(ikm=SHK, salt=同 H(a‖b), info=域串, 32)
 *      (extract 阶段 salt 固定 = H(a‖b),与协议 §4.1“salt 取 H(a‖b)”一致;浏览器
 *      WebCrypto deriveBits 同样表达,Phase-3 可直接对齐。)
 *   3. 子密钥 info:
 *        http 请求   "dsh-e2ee/v1\0http\0<reqNonceB64>\0p2b"(reqNonce=请求信封 n)
 *        http 响应   "…\0http\0<reqNonceB64>\0b2p"(响应信封 n 回显请求 n)
 *        ws 流       "…\0ws\0<wsLabel>\0p2b|b2p"(wsLabel 见 parseWsE2eeParams)
 *        ctrl 探针   "…\0ctrl\0p2b|b2p"
 *   4. AAD = UTF8("dsh-e2ee/v1\0<kind>\0<sessId>\0<dir>\0<counter>")。
 *      [偏差] 评审稿 §4.3 建议把路径摘要也放进 AAD,但因解密方在打开前并不知道
 *      明文里的路径(循环依赖),v1 规范化 AAD 不含路径;模块保留 extra 参数供后续绑定。
 *   5. 信封字段(§4.2):{ v:2, k, s, c, n, t, d };n = base64(12B nonce),
 *      d = base64(AES-256-GCM 密文 ‖ 16B tag);AAD 在加解密两侧按 4 计算。
 *   6. ctrl 通道(/_e2ee/ctrl)上:hello/hello-ack/error 为不带信封的明文 JSON
 *      {v:2,type,…};e2ee-probe / e2ee-probe-ok 是 k:"ctrl" 的 AEAD 信封。
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  pbkdf2Sync,
  randomBytes
} from "node:crypto";
import fs from "node:fs";

// ---------- 常量(协议 §9.1) ----------

export const E2EE_DOMAIN = "dsh-e2ee/v1";
export const E2EE_MK_LABEL = `${E2EE_DOMAIN}/mk\x00`; // 域标签 + NUL + 盐
export const E2EE_SALT_BYTES = 16;                     // e2ee_salt 长度
export const MK_BYTES = 32;                            // MK/SHK/子密钥 32B
export const NONCE_BYTES = 12;                         // AES-GCM 96-bit nonce
export const TAG_BYTES = 16;                           // GCM tag 128-bit
export const SESS_ID_RE = /^[0-9a-f]{32}$/i;           // sessId = 128-bit hex
export const E2EE_VERSION = 2;
export const ENVELOPE_CONTENT_TYPE = "application/vnd.dsh.e2ee-v2";
export const ENVELOPE_HEADER = "x-dsh-e2ee";
export const E2EE_CAP = "e2ee-v2";
export const CTRL_HELLO = "e2ee-hello";
export const CTRL_HELLO_ACK = "e2ee-hello-ack";
export const CTRL_ERROR = "e2ee-error";
export const DIR_P2B = "p2b"; // phone → bridge
export const DIR_B2P = "b2p"; // bridge → phone
export const HTTP_NONCE_WINDOW_MS = 5 * 60_000; // http 防重放滑动窗口 5min
export const HTTP_NONCE_CACHE_MAX = 4096;        // 每会话上限
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // SHK 24h 滑动 TTL(§9.1)
export const SESSION_CAP = 32;

// 参数缺省(服务端 /api/e2ee-params 未下发参数时的协议 profile;§3.3 profile v1)
export const DEFAULT_MK_KDF = Object.freeze({ alg: "pbkdf2-sha256", iter: 600000, dkLen: MK_BYTES, hash: "sha256" });
export const DEFAULT_MK_PROFILE = Object.freeze({ profile: "pbkdf2-sha256-600k", kdf: DEFAULT_MK_KDF });

// ---------- 密码 / 盐 / MK(§3.3,与 enterprise e2ee.js 参考实现一致) ----------

/** 密码 NFKC 归一化(协议:桥 node 与手机 WebCrypto 两端一致)。 */
export function normalizePassword(password) {
  return String(password ?? "").normalize("NFKC");
}

/** 解码 base64url e2ee_salt → 16B Buffer;非法返回 null。 */
export function decodeSalt(saltB64) {
  if (typeof saltB64 !== "string" || saltB64 === "") return null;
  let buf;
  try {
    buf = Buffer.from(saltB64, "base64url");
  } catch {
    return null;
  }
  return buf.length === E2EE_SALT_BYTES ? buf : null;
}

/**
 * 派生客户端主密钥 MK(协议 §3.3):
 *   kdfInput = UTF8("dsh-e2ee/v1/mk\0") ‖ rawSalt(16B)
 *   MK(32B)  = PBKDF2-HMAC-SHA256(password=NFKC, salt=kdfInput, iter, dkLen, hash)
 * 参数(kdf.iter/dkLen/hash)按服务端下发的执行,绝不写死。
 * @param {string} password 账号密码(原始输入,内部 NFKC)
 * @param {string} saltB64 e2ee_salt(base64url,16B)
 * @param {{alg?:string,iter?:number,dkLen?:number,hash?:string}|null} [kdf]
 * @returns {Buffer} 32B MK
 */
export function deriveMasterKey(password, saltB64, kdf = null) {
  const salt = decodeSalt(saltB64);
  if (!salt) throw new Error(`e2ee: salt 非法(须为 16B base64url),got=${JSON.stringify(saltB64)}`);
  const { iter, dkLen, hash } = normalizeKdf(kdf);
  const kdfInput = Buffer.concat([Buffer.from(E2EE_MK_LABEL, "utf8"), salt]);
  return pbkdf2Sync(normalizePassword(password), kdfInput, iter, dkLen, hash);
}

/** 把任意 kdf 参数容错归一(兼容 iterations/iter 两种写法);非法抛错。 */
export function normalizeKdf(kdf) {
  if (!kdf || typeof kdf !== "object") return { ...DEFAULT_MK_KDF };
  const iter = Number(kdf.iter ?? kdf.iterations);
  const dkLen = Number(kdf.dkLen ?? kdf.keyLen ?? kdf.length ?? MK_BYTES);
  const hash = typeof kdf.hash === "string" && kdf.hash ? kdf.hash : "sha256";
  if (!Number.isInteger(iter) || iter < 1) throw new Error("e2ee: kdf.iter 非法");
  if (!Number.isInteger(dkLen) || dkLen < 1 || dkLen > 64) throw new Error("e2ee: kdf.dkLen 非法");
  if (!/^sha(256|384|512)$/.test(hash)) throw new Error(`e2ee: kdf.hash 不受支持: ${hash}`);
  return { alg: typeof kdf.alg === "string" && kdf.alg ? kdf.alg : "pbkdf2-sha256", iter, dkLen, hash };
}

// ---------- 参数端点(§3.4 / §6.1) ----------

/**
 * 拉取并解析 GET {apiBase}/api/e2ee-params(Bearer token)。
 * 容错契约(协议 §3.4):任何非 200 / 无 e2ee 字段 / enabled≠true / 材料非法
 * → { enabled:false, reason }(调用方据此明文回退,绝不抛网络异常)。
 * @returns {Promise<{enabled:boolean, reason:string, status?:number, profile?:string,
 *   salt?:string, epoch?:number, kdf?:object}>}
 */
export async function fetchE2eeParams(apiBase, token, { timeoutMs = 8000 } = {}) {
  const base = String(apiBase || "").replace(/\/+$/, "");
  if (!base) return { enabled: false, reason: "no_api" };
  let res;
  try {
    res = await fetch(`${base}/api/e2ee-params`, {
      headers: {
        authorization: `Bearer ${String(token || "")}`,
        accept: "application/json"
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    return { enabled: false, reason: "params_unreachable" };
  }
  if (res.status !== 200) {
    return { enabled: false, reason: res.status === 401 ? "server_unauthorized" : res.status === 404 ? "server_no_params" : `http_${res.status}`, status: res.status };
  }
  let data;
  try {
    data = await res.json();
  } catch {
    return { enabled: false, reason: "bad_params", status: 200 };
  }
  const e2 = data && typeof data === "object" ? data.e2ee : null;
  if (!e2 || typeof e2 !== "object") return { enabled: false, reason: "server_no_params", status: 200 };
  if (e2.enabled !== true) return { enabled: false, reason: "server_disabled", status: 200 };
  if (typeof e2.salt !== "string" || !decodeSalt(e2.salt)) return { enabled: false, reason: "bad_params", status: 200 };
  let kdf;
  try {
    kdf = normalizeKdf(e2.kdf);
  } catch {
    return { enabled: false, reason: "bad_params", status: 200 };
  }
  return {
    enabled: true,
    reason: "ok",
    status: 200,
    profile: typeof e2.profile === "string" && e2.profile ? e2.profile : DEFAULT_MK_PROFILE.profile,
    salt: e2.salt,
    epoch: Number(e2.epoch) || 0,
    kdf
  };
}

// ---------- 随机数 / 随机工具 ----------

export function randomB64(byteLen) {
  return randomBytes(byteLen).toString("base64url");
}

export function randomHex(byteLen) {
  return randomBytes(byteLen).toString("hex");
}

/** 新建会话 id(128-bit hex,32 字符)。 */
export function newSessId() {
  return randomHex(16);
}

export function sha256(...bufs) {
  const h = createHash("sha256");
  for (const b of bufs) h.update(b);
  return h.digest();
}

// ---------- 会话密钥调度(§4.1 规范化,见文件头决定 1–6) ----------

/**
 * 由 MK 与握手随机数 a/b 派生 SHK:
 *   saltH = sha256(a‖b)(32B)
 *   SHK   = HKDF-SHA256(ikm=MK, salt=saltH, info="dsh-e2ee/v1\0shk", 32)
 * @param {Buffer} mk 32B 主密钥
 * @param {string|Buffer} a 手机侧随机数(32B)
 * @param {string|Buffer} b bridge 侧随机数(32B)
 * @returns {{shk: Buffer, saltH: Buffer}}
 */
export function deriveShk(mk, a, b) {
  if (!Buffer.isBuffer(mk) || mk.length !== MK_BYTES) throw new Error("e2ee: MK 非法");
  const aBuf = Buffer.isBuffer(a) ? a : Buffer.from(String(a), "base64url");
  const bBuf = Buffer.isBuffer(b) ? b : Buffer.from(String(b), "base64url");
  if (aBuf.length !== MK_BYTES || bBuf.length !== MK_BYTES) throw new Error("e2ee: 握手随机数须为 32B");
  const saltH = sha256(aBuf, bBuf);
  // 注意:新版 node 的 hkdfSync 返回 ArrayBuffer(未传 encoding 时),统一 Buffer 化
  const shk = Buffer.from(hkdfSync("sha256", mk, saltH, Buffer.from(`${E2EE_DOMAIN}\x00shk`, "utf8"), MK_BYTES));
  return { shk, saltH };
}

/** 会话级错误,带稳定 code(bridge 据此记日志/回显;不得携带密钥材料)。 */
export class E2eeError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = "E2eeError";
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * 一个解锁会话(一「隧道页 × 设备」一次握手一个;密钥仅内存)。
 * 提供子密钥派生 + 信封加解密原语;不持有密码/MK。
 */
export class E2eeSession {
  /**
   * @param {object} o
   * @param {string} o.sessId 32hex
   * @param {Buffer} o.shk 32B
   * @param {Buffer} o.saltH sha256(a‖b)
   * @param {string} [o.profile]
   * @param {number} [o.epoch]
   */
  constructor({ sessId, shk, saltH, profile = "", epoch = 0 }) {
    if (typeof sessId !== "string" || !SESS_ID_RE.test(sessId)) throw new E2eeError("bad_session", `e2ee: sessId 非法: ${sessId}`);
    if (!Buffer.isBuffer(shk) || shk.length !== MK_BYTES) throw new E2eeError("bad_session", "e2ee: SHK 非法");
    if (!Buffer.isBuffer(saltH) || saltH.length !== MK_BYTES) throw new E2eeError("bad_session", "e2ee: saltH 非法");
    this.sessId = sessId;
    this.shk = shk;
    this.saltH = saltH;
    this.profile = profile;
    this.epoch = epoch;
    this.verified = false; // 探针通过前不接受任何数据流/请求
    this.createdAt = Date.now();
    this.usedAt = this.createdAt;
  }

  /** 子密钥(§4.1 / 文件头决定 3)。kind∈http|http-resp|w|ctrl。 */
  keyFor({ kind, dir, reqNonceB64 = "", wsLabel = "" }) {
    let use;
    if (kind === "http" || kind === "http-resp") {
      if (!reqNonceB64) throw new E2eeError("bad_keyinfo", "e2ee: http 子密钥需要 reqNonceB64");
      use = `http\x00${reqNonceB64}\x00${dir}`;
    } else if (kind === "w") {
      if (!wsLabel) throw new E2eeError("bad_keyinfo", "e2ee: ws 子密钥需要 wsLabel");
      use = `ws\x00${wsLabel}\x00${dir}`;
    } else if (kind === "ctrl") {
      use = `ctrl\x00${dir}`;
    } else {
      throw new E2eeError("bad_keyinfo", `e2ee: 未知信封 kind: ${kind}`);
    }
    if (dir !== DIR_P2B && dir !== DIR_B2P) throw new E2eeError("bad_keyinfo", `e2ee: 未知方向: ${dir}`);
    return Buffer.from(hkdfSync("sha256", this.shk, this.saltH, Buffer.from(`${E2EE_DOMAIN}\x00${use}`, "utf8"), MK_BYTES));
  }

  /** AAD(文件头决定 4)。 */
  aadOf({ kind, dir, counter }) {
    return Buffer.from(`${E2EE_DOMAIN}\x00${kind}\x00${this.sessId}\x00${dir}\x00${String(counter ?? 0)}`, "utf8");
  }

  /**
   * 密封一条消息 → 信封对象。
   * @param {object} o
   * @param {"http"|"http-resp"|"w"|"ctrl"} o.kind
   * @param {string} o.dir p2b|b2p
   * @param {number} o.counter 方向计数(c 字段;http 侧仅日志/调试)
   * @param {Buffer|string} o.data 明文(文本传 string,二进制传 Buffer)
   * @param {0|1} [o.t] 0=文本 1=二进制(默认按 data 推断)
   * @param {string} [o.reqNonceB64] http/http-resp 用:请求 nonce
   * @param {string} [o.wsLabel] w 用:ws 流标签
   * @param {Buffer} [o.nonce] 显式 nonce(默认随机 12B;测试/回放用)
   * @returns {{v:number,k:string,s:string,c:number,n:string,t:number,d:string}}
   */
  seal({ kind, dir, counter = 0, data, t, reqNonceB64 = "", wsLabel = "", nonce }) {
    const pt = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""), "utf8");
    // t 语义:ws 消息按载荷区分文本/二进制;http/http-resp/ctrl 载荷一律为文本 JSON(t=0)
    const isText = t !== undefined ? t === 0 : kind === "w" ? !Buffer.isBuffer(data) : true;
    const n = nonce || randomBytes(NONCE_BYTES);
    if (!Buffer.isBuffer(n) || n.length !== NONCE_BYTES) throw new E2eeError("bad_nonce", "e2ee: nonce 须为 12B");
    // 规范:http 请求信封的 key-info reqNonce 默认即本信封 n(自描述,开包方无需额外状态);
    // http-resp 的 key-info reqNonce 必须是其对应请求的 n(由桥端显式传入)。
    const keyNonce = kind === "http-resp" ? reqNonceB64 : reqNonceB64 || n.toString("base64url");
    const key = this.keyFor({ kind, dir, reqNonceB64: keyNonce, wsLabel });
    const aad = this.aadOf({ kind, dir, counter });
    const c = createCipheriv("aes-256-gcm", key, n);
    c.setAAD(aad);
    const enc = Buffer.concat([c.update(pt), c.final()]);
    const tag = c.getAuthTag();
    this.touch();
    return {
      v: E2EE_VERSION,
      k: kind,
      s: this.sessId,
      c: counter,
      n: n.toString("base64url"),
      t: isText ? 0 : 1,
      d: Buffer.concat([enc, tag]).toString("base64url")
    };
  }

  /**
   * 打开(解密+认证)一条消息。认证失败/字段不符抛 E2eeError。
   * @returns {{data: Buffer, t: number}} 明文(二进制原样;文本 utf8 由调用方转)
   */
  open({ kind, dir, env, counter, reqNonceB64 = "", wsLabel = "" }) {
    if (!env || typeof env !== "object") throw new E2eeError("bad_envelope", "e2ee: 信封缺失");
    if (env.v !== E2EE_VERSION) throw new E2eeError("bad_version", `e2ee: 信封版本 ${env.v} 不受支持`);
    if (env.k !== kind) throw new E2eeError("bad_kind", `e2ee: 信封 kind=${env.k} 期望 ${kind}`);
    if (env.s !== this.sessId) throw new E2eeError("bad_session", "e2ee: 信封会话不符");
    const raw = typeof env.d === "string" ? Buffer.from(env.d, "base64url") : null;
    if (!raw || raw.length < TAG_BYTES + 1) throw new E2eeError("bad_cipher", "e2ee: 密文非法");
    const n = Buffer.from(String(env.n || ""), "base64url");
    if (n.length !== NONCE_BYTES) throw new E2eeError("bad_nonce", "e2ee: nonce 非法");
    // 与 seal 对称:http 请求开包默认用信封 n 做 key-info;http-resp 须显式传对应请求 n
    const keyNonce = kind === "http-resp" ? reqNonceB64 : reqNonceB64 || String(env.n || "");
    const key = this.keyFor({ kind, dir, reqNonceB64: keyNonce, wsLabel });
    const aad = this.aadOf({ kind, dir, counter });
    const ct = raw.subarray(0, raw.length - TAG_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const d = createDecipheriv("aes-256-gcm", key, n);
    d.setAAD(aad);
    d.setAuthTag(tag);
    let out;
    try {
      out = Buffer.concat([d.update(ct), d.final()]);
    } catch {
      throw new E2eeError("auth_failed", "e2ee: AEAD 打开失败(密文被篡改或密钥不一致)");
    }
    this.touch();
    return { data: out, t: env.t === 1 ? 1 : 0 };
  }

  touch() {
    this.usedAt = Date.now();
  }
}

// ---------- 防重放原语(§4.4) ----------

/** HTTP 防重放:(sessId, nonce) 5 分钟滑动窗口,LRU 上限 4096。 */
export class HttpNonceGuard {
  constructor({ windowMs = HTTP_NONCE_WINDOW_MS, max = HTTP_NONCE_CACHE_MAX } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.seen = new Map(); // "sessId\0n" → ts(插入序即 LRU 序)
  }

  /** 全新 nonce → true;窗口内重复 → false。 */
  check(sessId, nonceB64) {
    const key = `${sessId}\x00${nonceB64}`;
    const now = Date.now();
    if (this.seen.has(key)) {
      const ts = this.seen.get(key);
      if (now - ts < this.windowMs) return false; // 重放
      this.seen.delete(key); // 过期条目允许再次出现
    }
    // 顺带清扫过期条目(防止 Map 无限增长)
    if (this.seen.size >= 256) {
      for (const [k, ts] of this.seen) {
        if (now - ts >= this.windowMs) this.seen.delete(k);
      }
    }
    if (this.seen.size >= this.max) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.set(key, now);
    return true;
  }
}

/** WS/ctrl 方向计数:每 (会话,流,方向) 单调 +1;重复/回退即拒绝。 */
export class SequenceGuard {
  constructor() {
    this.last = -1;
  }
  /** c 必须严格大于 last(首条可为 0)。 */
  check(c) {
    if (!Number.isInteger(c) || c < 0) throw new E2eeError("bad_counter", `e2ee: 计数非法: ${c}`);
    if (c <= this.last) throw new E2eeError("replay", `e2ee: 计数重放/乱序 ${c} <= ${this.last}`);
    this.last = c;
    return true;
  }
}

// ---------- ws 流标签(§4.6 规范化) ----------

/**
 * 解析数据 WS 打开路径中的 e2ee 标记(query 的 &e2ee=<sessId>&w=<8B hex>)。
 *   upstreamPath: 去掉 e2ee 与 w 两参后的干净上游路径;
 *   wsLabel:      仅去掉 e2ee 的重组 query(path+query,内含 w → 每流唯一)。
 * 返回 null 表示非 e2ee 标记流。
 */
export function parseWsE2eeParams(fullPath) {
  if (typeof fullPath !== "string" || !fullPath.startsWith("/")) return null;
  const qIdx = fullPath.indexOf("?");
  const path = qIdx === -1 ? fullPath : fullPath.slice(0, qIdx);
  if (qIdx === -1) return null;
  const params = new URLSearchParams(fullPath.slice(qIdx + 1));
  const sessId = params.get("e2ee") || "";
  const w = params.get("w") || "";
  if (!sessId || !w || !SESS_ID_RE.test(sessId)) return null;
  params.delete("e2ee");
  const qsLabel = params.size ? `?${params.toString()}` : "";
  const labelWithW = `${path}${qsLabel}`; // w 保留其中(协议 “剥离后 path+query ‖ w”)
  params.delete("w");
  const qsUp = params.size ? `?${params.toString()}` : "";
  return { sessId, w, wsLabel: labelWithW, upstreamPath: `${path}${qsUp}` };
}

// ---------- 信封标记头(§4.3:头即信号) ----------

/**
 * 组装外 HTTP 信封标记头(手机 shim / 测试端封包用):
 *   content-type: application/vnd.dsh.e2ee-v2
 *   x-dsh-e2ee:   v=2;s=<sessId>;k=<kind>
 */
export function envelopeRequestHeaders(sessId, kind = "http") {
  return {
    "content-type": ENVELOPE_CONTENT_TYPE,
    [ENVELOPE_HEADER]: `v=${E2EE_VERSION};s=${sessId};k=${kind}`
  };
}

/** 解析 x-dsh-e2ee 头 → {v,s,k} | null。 */
export function parseEnvelopeMarker(headers = {}) {
  const val = headerValueOf(headers, ENVELOPE_HEADER);
  if (!val) return null;
  const m = /^v=(\d+);s=([0-9a-f]{32});k=([a-z-]+)$/i.exec(val.trim());
  return m ? { v: Number(m[1]), s: m[2], k: m[3] } : null;
}

/** 头里是否带信封信号(content-type 或 x-dsh-e2ee)。 */
export function hasEnvelopeMarker(headers = {}) {
  const ct = headerValueOf(headers, "content-type").split(";")[0].trim().toLowerCase();
  if (ct === ENVELOPE_CONTENT_TYPE) return true;
  return parseEnvelopeMarker(headers) !== null;
}

export function headerValueOf(headers, name) {
  const lk = name.toLowerCase();
  for (const [k, v] of Object.entries(headers || {})) {
    if (String(k).toLowerCase() === lk) return Array.isArray(v) ? v.join(", ") : String(v);
  }
  return "";
}

// ---------- http 明文载荷编解码(§4.3) ----------

/**
 * 请求信封明文(§4.3):{ "m":method, "p":path(含 query), "h":{头部}, "b":<b64 正文> }
 * @returns {{method:string, path:string, headers:object, bodyB64:string, hasBody:boolean}}
 */
export function decodeHttpRequestPlain(buf) {
  let pt;
  try {
    pt = JSON.parse(Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf));
  } catch {
    throw new E2eeError("bad_plain", "e2ee: http 请求明文不是 JSON");
  }
  if (!pt || typeof pt !== "object") throw new E2eeError("bad_plain", "e2ee: http 请求明文缺失");
  const method = typeof pt.m === "string" && pt.m ? pt.m.toUpperCase() : "GET";
  const path = typeof pt.p === "string" && pt.p ? pt.p : "/";
  const headers = pt.h && typeof pt.h === "object" ? pt.h : {};
  const b = typeof pt.b === "string" ? pt.b : "";
  return { method, path, headers, bodyB64: b, hasBody: b !== "" };
}

/** 编码请求信封明文(测试端/手机侧对称实现用;b 一律为 base64 正文)。 */
export function encodeHttpRequestPlain({ method = "GET", path = "/", headers = {}, bodyB64 = "", bodyBase64 = true } = {}) {
  const b = bodyBase64 ? String(bodyB64 ?? "") : Buffer.from(String(bodyB64 ?? ""), "utf8").toString("base64");
  return Buffer.from(JSON.stringify({ m: String(method).toUpperCase(), p: path, h: headers, b }), "utf8");
}

/**
 * 响应信封明文(§4.3):{ "st":status, "h":{头, 去 content-length/encoding}, "enc":"gzip|", "b":<b64> }
 * @returns {{status:number, headers:object, enc:string, bodyBuffer:Buffer}}
 */
export function decodeHttpResponsePlain(buf) {
  let pt;
  try {
    pt = JSON.parse(Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf));
  } catch {
    throw new E2eeError("bad_plain", "e2ee: http 响应明文不是 JSON");
  }
  if (!pt || typeof pt !== "object") throw new E2eeError("bad_plain", "e2ee: http 响应明文缺失");
  const status = Number(pt.st) || 502;
  const headers = pt.h && typeof pt.h === "object" ? pt.h : {};
  const enc = typeof pt.enc === "string" ? pt.enc : "";
  let bodyBuffer = Buffer.alloc(0);
  if (typeof pt.b === "string" && pt.b) {
    try {
      bodyBuffer = Buffer.from(pt.b, "base64");
    } catch {
      throw new E2eeError("bad_plain", "e2ee: http 响应 body base64 非法");
    }
  }
  return { status, headers, enc, bodyBuffer };
}

/** 编码响应信封明文(status/headers/原始正文;content-encoding 提取到 enc)。 */
export function encodeHttpResponsePlain({ status = 200, headers = {}, bodyBuffer = Buffer.alloc(0) }) {
  const h = {};
  let enc = "";
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = String(k).toLowerCase();
    if (["content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive"].includes(lk)) {
      if (lk === "content-encoding") enc = String(v);
      continue; // 实体头进 enc/由外层重建,不进密文内头部
    }
    h[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return Buffer.from(JSON.stringify({
    st: Number(status) || 200,
    h,
    enc,
    b: Buffer.isBuffer(bodyBuffer) && bodyBuffer.length ? bodyBuffer.toString("base64") : ""
  }), "utf8");
}

// ---------- 桥端会话服务(启动派生 + 握手 + 帧级编排辅助) ----------

/**
 * E2EE 运行时开关/服务。enabled=false 时调用方必须完全走 v1 明文路径。
 * 构造后仅持有:params 元数据 + MK(Buffer,内存)。
 */
export class E2eeService {
  /**
   * @param {object} o
   * @param {boolean} o.enabled
   * @param {string} o.reason enabled=false 时的原因(见 init)
   * @param {Buffer|null} o.mk
   * @param {string} [o.profile] [o.salt] [o.epoch] [o.kdf]
   */
  constructor({ enabled = false, reason = "disabled", mk = null, profile = "", salt = "", epoch = 0, kdf = null } = {}) {
    this.enabled = enabled && Buffer.isBuffer(mk) && mk.length === MK_BYTES;
    this.reason = this.enabled ? "ok" : reason;
    this.profile = profile;
    this.salt = salt;
    this.epoch = epoch;
    this.kdf = kdf;
    this.mk = this.enabled ? mk : null;
    this.sessions = new Map(); // sessId → E2eeSession
    this.ctrlCounters = new Map(); // sessId → { p2b: SequenceGuard, b2p: SequenceGuard }
    this.httpNonces = new HttpNonceGuard();
  }

  /** 静态工厂:启动派生(失败即禁用并说明原因;绝不抛)。 */
  static async init({ apiBase, token, password, allowed = true, profileHint = "" } = {}) {
    if (!allowed) return new E2eeService({ enabled: false, reason: "disabled_by_config" });
    if (String(token || "") === "") return new E2eeService({ enabled: false, reason: "no_token" });
    if (String(password ?? "") === "") return new E2eeService({ enabled: false, reason: "no_password" });
    const params = await fetchE2eeParams(apiBase, token);
    if (!params.enabled) return new E2eeService({ enabled: false, reason: params.reason });
    let mk;
    try {
      mk = deriveMasterKey(password, params.salt, params.kdf);
    } catch {
      return new E2eeService({ enabled: false, reason: "derive_failed" });
    }
    return new E2eeService({
      enabled: true,
      reason: "ok",
      mk,
      profile: profileHint || params.profile || DEFAULT_MK_PROFILE.profile,
      salt: params.salt,
      epoch: params.epoch || 0,
      kdf: params.kdf
    });
  }

  caps() {
    return this.enabled ? [E2EE_CAP] : [];
  }

  state() {
    return { enabled: this.enabled, reason: this.reason, profile: this.profile, epoch: this.epoch };
  }

  prune() {
    const now = Date.now();
    if (this.sessions.size > SESSION_CAP) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt).slice(0, this.sessions.size - SESSION_CAP);
      for (const [k] of oldest) this.dropSession(k);
    }
    for (const [k, s] of this.sessions) {
      if (now - s.usedAt > SESSION_TTL_MS) this.dropSession(k);
    }
  }

  dropSession(sessId) {
    this.sessions.delete(sessId);
    this.ctrlCounters.delete(sessId);
  }

  sessionOf(sessId) {
    this.prune();
    const s = this.sessions.get(sessId);
    if (s) s.touch();
    return s || null;
  }

  /**
   * 桥端应答 e2ee-hello(§5.2 步骤 1→2)。
   * @returns {{session:E2eeSession, ack:object}} 或抛 E2eeError
   */
  handleHello(hello) {
    if (!this.enabled) throw new E2eeError("disabled", "e2ee: bridge 未启用端到端加密");
    if (!hello || typeof hello !== "object") throw new E2eeError("bad_msg", "e2ee: hello 缺失");
    if (hello.v !== E2EE_VERSION || hello.type !== CTRL_HELLO) throw new E2eeError("bad_msg", "e2ee: hello 字段非法");
    const sessId = String(hello.s || "");
    if (!SESS_ID_RE.test(sessId)) throw new E2eeError("bad_msg", "e2ee: hello.s 非法");
    if (hello.role !== "phone") throw new E2eeError("bad_msg", `e2ee: hello.role=${hello.role}`);
    const a = String(hello.a || "");
    let aBuf;
    try {
      aBuf = Buffer.from(a, "base64url");
    } catch {
      aBuf = Buffer.alloc(0);
    }
    if (aBuf.length !== MK_BYTES) throw new E2eeError("bad_msg", "e2ee: hello.a 须为 32B");
    // 手机侧必须使用与 bridge 相同的 e2ee_salt/profile(否则 MK 域不一致 → 明文回退提示)
    if (hello.salt !== this.salt) throw new E2eeError("params", "e2ee: 手机端 e2ee_salt 与本机不一致(可能密码/服务端参数已更换)");
    if (this.profile && hello.profile && hello.profile !== this.profile) throw new E2eeError("params", "e2ee: 手机端 profile 与本机不一致");
    this.prune();
    if (this.sessions.has(sessId)) this.dropSession(sessId); // 同页重解锁 → 新随机数新会话
    const b = randomB64(MK_BYTES);
    const { shk, saltH } = deriveShk(this.mk, aBuf, b);
    const session = new E2eeSession({ sessId, shk, saltH, profile: this.profile, epoch: this.epoch });
    this.sessions.set(sessId, session);
    this.ctrlCounters.set(sessId, { p2b: new SequenceGuard(), b2p: new SequenceGuard() });
    const ack = {
      v: E2EE_VERSION,
      type: CTRL_HELLO_ACK,
      s: sessId,
      b,
      caps: this.caps(),
      ts: Date.now()
    };
    return { session, ack };
  }

  /**
   * 桥端应答 e2ee-probe(§5.2 步骤 4→5)。成功后会话 verified=true。
   * @returns {{reply: object, session: E2eeSession}} reply 为 probe-ok 信封(b2p)
   */
  handleProbe(sessId, env) {
    const session = this.sessionOf(sessId);
    if (!session) throw new E2eeError("unknown_session", "e2ee: 会话不存在或已过期(请重新解锁)");
    // 先解密成功再推进计数:失败的尝试(密钥不符)不得消耗合法探针的计数
    const opened = session.open({ kind: "ctrl", dir: DIR_P2B, env, counter: env?.c ?? 0, reqNonceB64: env?.n });
    let pt;
    try {
      pt = JSON.parse(opened.data.toString("utf8"));
    } catch {
      throw new E2eeError("bad_key", "e2ee: 探针明文非法(密钥不一致?)");
    }
    if (pt?.p !== "dsh-e2ee-probe-v1") throw new E2eeError("bad_key", "e2ee: 探针载荷不符");
    const guards = this.ctrlCounters.get(sessId) || { p2b: new SequenceGuard(), b2p: new SequenceGuard() };
    guards.p2b.check(Number(env?.c) || 0); // 成功后推进,后续重放被拒
    session.verified = true;
    const reply = session.seal({
      kind: "ctrl",
      dir: DIR_B2P,
      counter: 0,
      data: JSON.stringify({ p: "dsh-e2ee-probe-ok", t: pt.t ?? 0, c: 0 })
    });
    this.ctrlCounters.set(sessId, guards);
    return { reply, session };
  }

  /** 对 http 请求信封做打开前的会话语义校验(取会话/查重放)。 */
  guardHttpRequest(sessId, env) {
    const session = this.sessionOf(sessId);
    if (!session) throw new E2eeError("unknown_session", "e2ee: 会话不存在或已过期(请重新解锁)");
    if (!session.verified) throw new E2eeError("not_verified", "e2ee: 会话未完成探针校验");
    if (!this.httpNonces.check(sessId, env.n)) throw new E2eeError("replay", "e2ee: HTTP 信封 nonce 重放");
    return session;
  }
}

/** 把 E2EE 开关状态写入 relayDir/.e2ee-state.json(供 Phase-4 面板 UI 读取)。 */
export function writeE2eeStateFile(dir, state) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      `${dir}/.e2ee-state.json`,
      JSON.stringify({ ...state, at: Date.now() }, null, 2),
      { mode: 0o600 }
    );
  } catch {
    /* 状态文件非关键路径:写失败只记日志,不影响隧道 */
  }
}
