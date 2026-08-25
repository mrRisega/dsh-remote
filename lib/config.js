import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * dsh-remote 配置模块。
 *
 * 配置来源优先级(高→低):
 *   1. 环境变量 DSH_REMOTE_* (便于 launchd/systemd 注入)
 *   2. --config <path> 指定的 JSON 文件
 *   3. 默认值
 */

/** 默认上游:dsh web 的 loopback 地址。 */
const DEFAULT_UPSTREAM = "http://127.0.0.1:3080";

/** 本包 public/ 目录(登录页静态资源)。 */
function defaultDistDir() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "public");
}

/**
 * 解析一个端口配置:允许 "0" 表示由 OS 分配,也允许 "auto"。
 * @returns {number}
 */
function parsePort(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === "auto" || value === 0) return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`invalid port: ${JSON.stringify(value)}`);
  }
  return n;
}

/** 从 JSON 文件读取配置对象(不存在则返回空对象)。 */
function readJsonFile(file) {
  if (!file) return {};
  if (!existsSync(file)) {
    throw new Error(`config file not found: ${file}`);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * 环境变量解析:DSH_REMOTE_PORT / DSH_REMOTE_UPSTREAM / DSH_REMOTE_PASSWORD /
 * DSH_REMOTE_TLS_CERT / DSH_REMOTE_TLS_KEY / DSH_REMOTE_HOST / DSH_REMOTE_ALLOW_IPS /
 * DSH_REMOTE_SESSION_TTL_HOURS / DSH_REMOTE_RATE_LIMIT / DSH_REMOTE_DIST_DIR /
 * DSH_REMOTE_PASSWORD_HASH
 */
function envOverrides(env = process.env) {
  const out = {};
  if (env.DSH_REMOTE_PORT !== undefined) out.port = parsePort(env.DSH_REMOTE_PORT, 3443);
  if (env.DSH_REMOTE_UPSTREAM !== undefined) out.upstream = env.DSH_REMOTE_UPSTREAM;
  if (env.DSH_REMOTE_PASSWORD !== undefined) out.password = env.DSH_REMOTE_PASSWORD;
  if (env.DSH_REMOTE_PASSWORD_HASH !== undefined) out.passwordHash = env.DSH_REMOTE_PASSWORD_HASH;
  if (env.DSH_REMOTE_TLS_CERT !== undefined) out.tls = { ...(out.tls ?? {}), cert: env.DSH_REMOTE_TLS_CERT };
  if (env.DSH_REMOTE_TLS_KEY !== undefined) out.tls = { ...(out.tls ?? {}), key: env.DSH_REMOTE_TLS_KEY };
  if (env.DSH_REMOTE_HOST !== undefined) out.host = env.DSH_REMOTE_HOST;
  if (env.DSH_REMOTE_ALLOW_IPS !== undefined) out.allowIps = env.DSH_REMOTE_ALLOW_IPS.split(",").map((s) => s.trim()).filter(Boolean);
  if (env.DSH_REMOTE_TRUST_PROXY !== undefined) out.trustProxy = env.DSH_REMOTE_TRUST_PROXY === "1" || env.DSH_REMOTE_TRUST_PROXY === "true";
  if (env.DSH_REMOTE_SESSION_FILE !== undefined) out.sessionFile = env.DSH_REMOTE_SESSION_FILE;
  if (env.DSH_REMOTE_SESSION_TTL_HOURS !== undefined) out.sessionTtlHours = Number(env.DSH_REMOTE_SESSION_TTL_HOURS);
  if (env.DSH_REMOTE_RATE_LIMIT !== undefined) {
    const [max, windowMs] = env.DSH_REMOTE_RATE_LIMIT.split(":").map((s) => Number(s));
    out.rateLimit = { max: max || 5, windowMs: windowMs || 15 * 60 * 1000 };
  }
  if (env.DSH_REMOTE_DIST_DIR !== undefined) out.distDir = env.DSH_REMOTE_DIST_DIR;
  return out;
}

/** 合并三层配置并补默认值。 */
export function loadConfig({ configFile, env = process.env } = {}) {
  const file = readJsonFile(configFile);
  const envCfg = envOverrides(env);
  const merged = {
    ...file,
    ...envCfg
  };

  const upstreamRaw = merged.upstream ?? DEFAULT_UPSTREAM;
  let upstream;
  try {
    upstream = new URL(upstreamRaw);
  } catch {
    throw new Error(`invalid upstream URL: ${JSON.stringify(upstreamRaw)}`);
  }
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error(`upstream must be http(s), got ${upstream.protocol}`);
  }

  const config = {
    host: merged.host ?? "0.0.0.0",
    port: parsePort(merged.port, 3443),
    upstream,
    password: merged.password ?? null,
    passwordHash: merged.passwordHash ?? null,
    sessionTtlMs: (merged.sessionTtlHours ?? 12) * 3600 * 1000,
    rateLimit: {
      max: merged.rateLimit?.max ?? 5,
      windowMs: merged.rateLimit?.windowMs ?? 15 * 60 * 1000
    },
    allowIps: Array.isArray(merged.allowIps) ? merged.allowIps : [],
    trustProxy: merged.trustProxy ?? false,
    tls: merged.tls && (merged.tls.cert || merged.tls.key) ? {
      cert: resolve(merged.tls.cert),
      key: resolve(merged.tls.key)
    } : null,
    distDir: merged.distDir ? resolve(merged.distDir) : defaultDistDir(),
    sessionFile: merged.sessionFile ? resolve(merged.sessionFile) : null
  };

  if (!config.password && !config.passwordHash) {
    throw new Error(
      "no password configured: set DSH_REMOTE_PASSWORD, or \"password\" in config, " +
      "or \"passwordHash\" (generate with: dsh-remote hash-password)"
    );
  }
  if (config.tls) {
    if (!existsSync(config.tls.cert)) throw new Error(`TLS cert not found: ${config.tls.cert}`);
    if (!existsSync(config.tls.key)) throw new Error(`TLS key not found: ${config.tls.key}`);
  }

  return config;
}
