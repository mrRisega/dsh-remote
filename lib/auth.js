import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";

/**
 * dsh-remote 认证模块:口令哈希(带盐 scrypt)、会话令牌、每 IP 登录限流。
 *
 * 口令比较使用恒定时间,防止时序侧信道。会话 cookie 值为 256 位随机 token,
 * 仅存服务端内存(可选手动持久化由 server 层负责)。
 */

const SESSION_COOKIE = "dshr_session";

/** 登录失败限流窗口内的默认最大失败次数。 */
const DEFAULT_RATE_MAX = 5;
const DEFAULT_RATE_WINDOW_MS = 15 * 60 * 1000;

/**
 * 使用 scrypt 派生口令哈希,格式: scrypt$N$r$p$salt$hash(hex)。
 * @param {string} password
 * @returns {string}
 */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const N = 16384;
  const r = 8;
  const p = 1;
  const keyLen = 64;
  const derived = scryptSync(password, salt, keyLen, { N, r, p });
  return [
    "scrypt",
    N,
    r,
    p,
    salt.toString("hex"),
    derived.toString("hex")
  ].join("$");
}

/**
 * 恒定时间校验口令与哈希。
 * @param {string} password
 * @param {string} stored
 * @returns {boolean}
 */
export function verifyPassword(password, stored) {
  if (typeof stored !== "string" || stored === "") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    // 兼容纯文本(仅用于迁移/测试;生产请使用 hash-password)
    const a = Buffer.from(password);
    const b = Buffer.from(stored);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(password, salt, expected.length, { N, r, p });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/**
 * 简单的每 IP 登录失败限流器。
 */
export class LoginRateLimiter {
  /** @type {Map<string, {fails: number, windowStart: number}>} */
  #state = new Map();
  #max;
  #windowMs;

  constructor({ max = DEFAULT_RATE_MAX, windowMs = DEFAULT_RATE_WINDOW_MS } = {}) {
    this.#max = max;
    this.#windowMs = windowMs;
  }

  #prune(now) {
    for (const [ip, rec] of this.#state) {
      if (now - rec.windowStart > this.#windowMs) this.#state.delete(ip);
    }
  }

  /** 该 IP 当前是否被锁定(达到上限)。 */
  isBlocked(ip) {
    const now = Date.now();
    this.#prune(now);
    const rec = this.#state.get(ip);
    return rec !== undefined && rec.fails >= this.#max;
  }

  /** 记录一次失败。返回累计失败次数。 */
  recordFailure(ip) {
    const now = Date.now();
    this.#prune(now);
    const rec = this.#state.get(ip);
    if (rec === undefined || now - rec.windowStart > this.#windowMs) {
      this.#state.set(ip, { fails: 1, windowStart: now });
      return 1;
    }
    rec.fails += 1;
    return rec.fails;
  }

  /** 登录成功后清零。 */
  reset(ip) {
    this.#state.delete(ip);
  }

  /** 剩余冷却毫秒(被锁定时)。 */
  retryAfterMs(ip) {
    const rec = this.#state.get(ip);
    if (rec === undefined) return 0;
    return Math.max(0, rec.windowStart + this.#windowMs - Date.now());
  }
}

/** 生成 256 位随机会话 token(hex)。 */
export function generateSessionToken() {
  return randomBytes(32).toString("hex");
}

/** 会话 token 的指纹(存服务端,避免明文 token 常驻内存)。 */
export function fingerprint(token) {
  return createHash("sha256").update(token).digest("hex");
}

/** 会话 cookie 名。 */
export function sessionCookieName() {
  return SESSION_COOKIE;
}
