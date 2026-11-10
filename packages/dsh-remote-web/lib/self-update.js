/**
 * 自升级核心模块（ESM，零第三方依赖）。
 *
 * 目标：把「把 npm 上更新的插件装进当前 profile 的 dsh-remote-web-plugin 目录」这件事
 * 收敛成一个**可单测、可回滚、不打网络赌**的纯函数集合。面板只负责：选版本 → 调这里 →
 * 提示用户 → apply → 让宿主重载。
 *
 * 为什么默认走 npmmirror：
 *   生产遥测里反复出现 `npm_unreachable`（用户网络打不开 registry.npmjs.org，尤其是国内
 *   移动网络/公司网），而插件过去的一键更新只认官方源 —— 于是"有新版但装不上"。
 *   这里默认 `registry.npmmirror.com` 优先、官方源兜底，并允许 `DSH_REMOTE_REGISTRY`
 *   用逗号分隔覆盖顺序（自建 registry 也能接）。
 *
 * 为什么不在本模块里联网校验"最新版"：resolve 与下载是同一份 packument（`GET <registry>/<name>/<tag>`），
 * 一次请求同时拿到版本号 + tarball + integrity，少一次往返、也少一个"版本号与包不一致"的窗口。
 *
 * 安全红线（与 tarball-update.js 同级，不放松）：
 *   · tar 条目含 `..` 段、绝对路径、或解析后不在目标目录内 → 拒绝（BAD_TARBALL）；
 *   · 符号链接 / 硬链接 / 设备 / FIFO → **直接拒绝**（比 tarball-update.js 的"跳过"更严，
 *     因为升级路径上宁可整包失败也不要留一个"内容不全但看起来装好了"的目录）；
 *   · 条目必须位于 `package/` 前缀下（npm tarball 的固定布局），否则拒绝 ——
 *     否则 stripPrefix 失效时会把文件写到 staging 根目录；
 *   · integrity（sha512 等）先校验再解包；`dist.shasum`（sha1）作为兜底；
 *   · 下载有超时与大小上限（默认 64MB），边下边判，防止坏镜像把内存打爆。
 *
 * 原子性：apply 只用 rename（同盘时是原子的）：先把旧目录整段 rename 成 `<target>.bak-<stamp>`，
 * 再把 staging 里的 `package/` rename 到目标位置；任何一步失败都自动回滚（把 bak 换回去）。
 *
 * 约定：**失败一律 throw**，错误对象带稳定 `code`（见 ERROR_CODES）；成功返回 `{ok:true, ...}`。
 * 这样调用方（面板）可以用 `err.code` 直接决定文案，而不是去 match 错误字符串。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { extractTarGz, readTarEntries } from "./tarball-update.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * registry 上的包名：单一来源，installer / 面板 / doctor 都靠它对齐。
 * 注意这是**仓库根包**（发布产物里含 dsh-setup.mjs 与 packages/…）。
 */
export const PACKAGE_NAME = "@mrrisega/dsh-remote";

/**
 * profile 里真正被替换的那个包（`~/.dsh/profiles/<p>/dsh-remote-web-plugin`）。
 * 它不在 npm 上单独发布，只能从根包的 tarball 里取。
 */
export const PLUGIN_PACKAGE_NAME = "dsh-remote-web";

/** 插件在根包 tarball 里的位置（解包后：`<stageDir>/package/packages/dsh-remote-web/`）。 */
export const PLUGIN_SUBDIR = "packages/dsh-remote-web";

/** 默认源顺序：国内镜像优先，官方源兜底。 */
export const DEFAULT_REGISTRIES = Object.freeze([
  "https://registry.npmmirror.com",
  "https://registry.npmjs.org",
]);

/** 单个 HTTP 请求（含下载）默认上限。 */
export const DEFAULT_TIMEOUT_MS = 20000;

/** tarball 大小上限（防御性）。 */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** staging 里 npm tarball 被 strip 之后的顶层目录名。 */
export const STAGE_PACKAGE_DIR = "package";

/**
 * 稳定错误码。面板文案、重试策略、遥测归因都以这里为准。
 * 前 8 个是需求约定的核心码；其余是同一族里**必须区分**的边界情况（文档里单列）。
 */
export const ERROR_CODES = Object.freeze({
  /** 所有源都连不上（DNS/连接/超时/TLS/非 JSON 响应） */
  REGISTRY_UNREACHABLE: "REGISTRY_UNREACHABLE",
  /** 源返回了非 2xx：`HTTP_404` / `HTTP_500` … */
  BAD_STATUS: "HTTP_",
  /** tarball 无法解析/布局不对/含危险条目/超限 */
  BAD_TARBALL: "BAD_TARBALL",
  /** integrity / shasum 不符 */
  INTEGRITY_MISMATCH: "INTEGRITY_MISMATCH",
  /** staging 里的版本与解析到的版本（或调用方要求的版本）不一致 */
  VERSION_MISMATCH: "VERSION_MISMATCH",
  /** staging 里的包名不是我们的包 */
  NAME_MISMATCH: "NAME_MISMATCH",
  /** 目标目录被占用（rename 返回 EBUSY/ETXTBSY） */
  TARGET_BUSY: "TARGET_BUSY",
  /** 落盘失败（含回滚信息） */
  APPLY_FAILED: "APPLY_FAILED",
  /** 参数不合法（调用方 bug，不该重试） */
  BAD_ARGUMENTS: "BAD_ARGUMENTS",
  /** 源 200 但包里没有该 tag/版本的 tarball */
  SPEC_NOT_FOUND: "SPEC_NOT_FOUND",
  /** 下载超过 maxBytes */
  TARBALL_TOO_BIG: "TARBALL_TOO_BIG",
  /** rollback 时备份目录不存在/恢复失败 */
  ROLLBACK_FAILED: "ROLLBACK_FAILED",
  /** verifyInstalled：目标目录不是有效安装 */
  NOT_INSTALLED: "NOT_INSTALLED",
});

const HTTP_PREFIX = ERROR_CODES.BAD_STATUS;

/** 允许出现在 npm tarball 里的条目类型：普通文件 `0`、目录 `5`，其余一律拒绝。 */
const SAFE_ENTRY_TYPES = new Set(["0", "5"]);

/** 聚合错误码的"严重度"：这些码比"连不上"更值得原样抛给用户。 */
const SEVERE_CODES = new Set([
  ERROR_CODES.INTEGRITY_MISMATCH,
  ERROR_CODES.BAD_TARBALL,
  ERROR_CODES.TARBALL_TOO_BIG,
  ERROR_CODES.VERSION_MISMATCH,
  ERROR_CODES.NAME_MISMATCH,
]);

const SUPPORTED_INTEGRITY_ALGOS = new Set(["sha512", "sha384", "sha256", "sha1"]);

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/**
 * 造一个带稳定 code 的错误。
 * @param {string} code 见 ERROR_CODES
 * @param {string} message 人读的信息（会进日志/面板）
 * @param {object} [extra] 额外字段（attempts/detail/rollback/url…）
 */
export function updateError(code, message, extra = {}) {
  const err = new Error(message);
  err.name = "SelfUpdateError";
  err.code = code;
  if (extra && typeof extra === "object") {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) continue;
      err[k] = v;
    }
  }
  return err;
}

/** 是不是本模块定义的稳定码（`HTTP_404` 这类模板码也算）。 */
function isOwnCode(code) {
  if (typeof code !== "string") return false;
  if (/^HTTP_\d+$/.test(code)) return true;
  return Object.values(ERROR_CODES).includes(code);
}

/**
 * 把任意异常收敛成带 code 的 SelfUpdateError。
 * 只保留"我们自己的"稳定码：`ECONNREFUSED` / `EACCES` 这类系统码不能直接当成对外错误码
 * （面板要按 err.code 分支，混进 OS 码就不可枚举了）。
 */
function normalizeError(e) {
  if (e && e.name === "SelfUpdateError" && isOwnCode(e.code)) return e;
  const code = e && isOwnCode(e.code) ? e.code : ERROR_CODES.APPLY_FAILED;
  return updateError(code, (e && e.message) || String(e), {
    cause: e,
    errno: e && e.errno,
    syscall: e && e.syscall,
  });
}

/** HTTP 状态码 → 稳定错误码（`HTTP_404` 等）。 */
function statusError(res, url) {
  const status = res && Number.isFinite(Number(res.status)) ? Number(res.status) : 0;
  return updateError(`${HTTP_PREFIX}${status}`, `源返回 HTTP ${status || "?"}：${url}`, {
    status,
    url,
    detail: "http_status",
  });
}

// ---------------------------------------------------------------------------
// registry 顺序
// ---------------------------------------------------------------------------

/** 作用域包按 npm 规范编码：`@scope/name` → `@scope%2fname`（保留 @，斜杠转义）。 */
function encodePackageName(name) {
  return encodeURIComponent(String(name).trim()).replace(/^%40/i, "@").replace(/%2F/g, "%2f");
}

function trimRegistry(value) {
  return String(value == null ? "" : value).trim().replace(/\/+$/, "");
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * 解析可用的 registry 顺序。
 *
 * 默认 `['https://registry.npmmirror.com', 'https://registry.npmjs.org']`；
 * `DSH_REMOTE_REGISTRY`（逗号分隔，允许前后空格与尾部 `/`）可覆盖；
 * 非 `http(s)://` 的项被忽略，全部无效时回落到默认（回归默认比"直接失败"更有用）。
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string[]} 至少一项
 */
export function resolveRegistryOrder(env = process.env) {
  const raw = env && typeof env.DSH_REMOTE_REGISTRY === "string" ? env.DSH_REMOTE_REGISTRY : "";
  const list = dedupe(
    raw
      .split(",")
      .map(trimRegistry)
      .filter((s) => /^https?:\/\//i.test(s)),
  );
  return list.length > 0 ? list : [...DEFAULT_REGISTRIES];
}

/** registries 入参归一化：数组 / 逗号串 / 空 → 默认。 */
function normalizeRegistries(registries, env) {
  if (registries == null || registries === "") return resolveRegistryOrder(env);
  const list = dedupe(
    (Array.isArray(registries) ? registries : String(registries).split(","))
      .map(trimRegistry)
      .filter(Boolean),
  );
  if (list.length === 0) {
    throw updateError(ERROR_CODES.BAD_ARGUMENTS, "registries 为空：至少给一个 http(s) 源", {
      detail: "bad_arguments",
    });
  }
  return list;
}

/**
 * `version` / `tag` 归一成"要问源的 selector"。
 *
 * 语义：**显式给的 version 优先**，`tag` 只是没指定版本时的通道。
 * 面板常见写法是 `{ tag: "latest", version: 用户选的版本 }`（tag 有默认值），
 * 所以这里不把"两个都传"当错误 —— 否则选版本这条路径会被一个默认值拦死。
 */
function normalizeSelector(version, tag) {
  const v = version == null ? "" : String(version).trim();
  const t = tag == null ? "" : String(tag).trim();
  const selector = v || t || "latest";
  if (/[\s/]/.test(selector)) {
    throw updateError(ERROR_CODES.BAD_ARGUMENTS, `版本/tag 不合法：「${selector}」`, {
      detail: "bad_arguments",
    });
  }
  return selector;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

/** `20261111-000435-123`：可排序、可人读、同秒多次调用也能区分。 */
function makeStamp(date = new Date()) {
  return [
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
    pad(date.getMilliseconds(), 3),
  ].join("-");
}

/**
 * 给 promise 套超时上限。
 * 用 AbortController 尽量让底层请求真的取消；同时 race 一个定时器，
 * 这样即使 fetchImpl 忽略 signal（测试替身/老实现）也不会挂死。
 */
async function runWithTimeout(factory, timeoutMs, what) {
  const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer = null;
  try {
    const work = Promise.resolve().then(() => factory(controller ? controller.signal : undefined));
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          if (controller) controller.abort();
        } catch {
          /* abort 失败无所谓 */
        }
        reject(
          updateError(ERROR_CODES.REGISTRY_UNREACHABLE, `请求超时（>${ms}ms）：${what}`, {
            detail: "timeout",
            what,
            timeoutMs: ms,
          }),
        );
      }, ms);
      if (timer && typeof timer.unref === "function") timer.unref();
    });
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 发一次请求，把"连不上/DNS/TLS/被 abort"统一成 REGISTRY_UNREACHABLE。
 * 超时错误已经带 code，原样抛出（面板文案要区分"超时"和"连不上"仍可用 detail）。
 */
async function fetchOnce(fetchImpl, url, init, timeoutMs, what) {
  try {
    return await runWithTimeout((signal) => fetchImpl(url, { ...init, signal }), timeoutMs, what);
  } catch (e) {
    if (e && e.name === "SelfUpdateError") throw e;
    throw updateError(ERROR_CODES.REGISTRY_UNREACHABLE, `请求失败（连不上/传输中断）：${what}（${e && e.message}）`, {
      detail: "fetch_failed",
      url: what,
      cause: e,
    });
  }
}

function headerValue(res, name) {
  try {
    const headers = res && res.headers;
    if (!headers) return null;
    if (typeof headers.get === "function") return headers.get(name);
    const lower = String(name).toLowerCase();
    for (const [k, v] of Object.entries(headers)) if (String(k).toLowerCase() === lower) return v;
    return null;
  } catch {
    return null;
  }
}

/** 把响应体读成 Buffer，边读边判 maxBytes（不信 content-length）。 */
async function readBodyLimited(res, limit, url) {
  const tooBig = (got) =>
    updateError(ERROR_CODES.TARBALL_TOO_BIG, `tarball 过大：${got} > 上限 ${limit} 字节（${url}）`, {
      detail: "too_big",
      bytes: got,
      maxBytes: limit,
      url,
    });

  const declared = Number(headerValue(res, "content-length"));
  if (Number.isFinite(declared) && declared > limit) throw tooBig(declared);

  const chunks = [];
  let total = 0;
  const push = (chunk) => {
    const c = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += c.length;
    if (total > limit) throw tooBig(total);
    chunks.push(c);
  };

  const body = res && res.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) push(value);
      }
    } catch (e) {
      try {
        await reader.cancel();
      } catch {
        /* 取消失败无所谓 */
      }
      throw e;
    }
  } else if (body && typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) push(chunk);
  } else if (typeof res.arrayBuffer === "function") {
    push(await res.arrayBuffer());
  } else if (typeof res.text === "function") {
    push(Buffer.from(await res.text(), "utf8"));
  } else {
    throw updateError(ERROR_CODES.REGISTRY_UNREACHABLE, `响应体不可读：${url}`, { detail: "no_body", url });
  }

  return Buffer.concat(chunks, total);
}

/** 校验 integrity（优先）或 shasum（兜底）。返回 `{checked, algo}`。 */
function verifyIntegrity(buffer, dist, url) {
  const integrity = dist && typeof dist.integrity === "string" ? dist.integrity.trim() : "";
  for (const token of integrity ? integrity.split(/\s+/).filter(Boolean) : []) {
    const dash = token.indexOf("-");
    if (dash <= 0) continue;
    const algo = token.slice(0, dash).toLowerCase();
    const b64 = token.slice(dash + 1);
    if (!SUPPORTED_INTEGRITY_ALGOS.has(algo) || !b64) continue;
    let want;
    try {
      want = Buffer.from(b64, "base64");
    } catch {
      continue;
    }
    const got = crypto.createHash(algo).update(buffer).digest();
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
      throw updateError(ERROR_CODES.INTEGRITY_MISMATCH, `tarball 完整性校验失败（${algo}）：${url}`, {
        detail: "integrity_mismatch",
        algo,
        url,
      });
    }
    return { checked: true, algo, source: "integrity" };
  }

  const shasum = dist && typeof dist.shasum === "string" ? dist.shasum.trim().toLowerCase() : "";
  if (/^[0-9a-f]{40}$/.test(shasum)) {
    const got = crypto.createHash("sha1").update(buffer).digest("hex");
    if (got !== shasum) {
      throw updateError(ERROR_CODES.INTEGRITY_MISMATCH, `tarball shasum 校验失败（sha1）：${url}`, {
        detail: "integrity_mismatch",
        algo: "sha1",
        url,
      });
    }
    return { checked: true, algo: "sha1", source: "shasum" };
  }

  return { checked: false, algo: null };
}

/** 解包前的整体安全校验：布局必须是 `package/…`，且只允许普通文件与目录。 */
function assertSafeEntries(entries, url) {
  for (const e of entries) {
    const type = e && typeof e.type === "string" && e.type ? e.type : "0";
    if (!SAFE_ENTRY_TYPES.has(type)) {
      const kind = type === "1" ? "硬链接" : type === "2" ? "符号链接" : `类型 ${JSON.stringify(type)}`;
      throw updateError(ERROR_CODES.BAD_TARBALL, `拒绝解包：tarball 含${kind}条目「${e && e.name}」（${url}）`, {
        detail: "unsafe_entry",
        entry: e && e.name,
        entryType: type,
        url,
      });
    }
    const raw = String((e && e.name) || "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (!raw || raw.includes("\0")) {
      throw updateError(ERROR_CODES.BAD_TARBALL, `拒绝解包：tarball 条目名不合法（${url}）`, {
        detail: "bad_entry",
        entry: e && e.name,
        url,
      });
    }
    if (!(raw === STAGE_PACKAGE_DIR || raw.startsWith(`${STAGE_PACKAGE_DIR}/`))) {
      throw updateError(
        ERROR_CODES.BAD_TARBALL,
        `拒绝解包：tarball 条目「${raw}」不在 package/ 下（npm tarball 布局异常，${url}）`,
        { detail: "bad_layout", entry: raw, url },
      );
    }
  }
}

function readJsonFile(file, fsImpl = fs) {
  try {
    return JSON.parse(fsImpl.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 下载 → staging
// ---------------------------------------------------------------------------

/**
 * 从单个 registry 完成"解析版本 → 下载 → 校验 → 解包到 staging"。
 * 任何异常都抛带 code 的 SelfUpdateError，由上层决定是否换源。
 */
async function fetchFromRegistry({ registry, selector, stage, timeout, limit, fetchImpl, requestedVersion }) {
  const base = registry.replace(/\/+$/, "");
  const metaUrl = `${base}/${encodePackageName(PACKAGE_NAME)}/${encodeURIComponent(selector)}`;

  const metaRes = await fetchOnce(fetchImpl, metaUrl, { headers: { accept: "application/json" } }, timeout, metaUrl);
  if (!metaRes) {
    throw updateError(ERROR_CODES.REGISTRY_UNREACHABLE, `源没有返回响应：${metaUrl}`, {
      detail: "no_response",
      url: metaUrl,
    });
  }
  if (!metaRes.ok) throw statusError(metaRes, metaUrl);

  let doc;
  try {
    doc = await runWithTimeout(() => metaRes.json(), timeout, `${metaUrl}（body）`);
  } catch (e) {
    if (e && e.name === "SelfUpdateError") throw e;
    throw updateError(ERROR_CODES.REGISTRY_UNREACHABLE, `源返回的 packument 不是 JSON：${metaUrl}`, {
      detail: "bad_json",
      url: metaUrl,
      cause: e,
    });
  }

  // 两种响应形状都要吃：
  //   ① 完整 packument（GET /<name>）：有 dist-tags / versions；
  //   ② 单版本清单（GET /<name>/<tag|version>，**npm 实际返回的就是这个**）：
  //      形如 { name, version, dist: { tarball, integrity, shasum } }，既没有 dist-tags 也没有 versions。
  //   2026-11-11 的实测才发现：只按 packument 解析会让"真实下载"永远 SPEC_NOT_FOUND。
  const distTags = (doc && doc["dist-tags"]) || {};
  const versions = (doc && doc.versions) || {};
  let version = typeof distTags[selector] === "string" ? distTags[selector] : "";
  let dist = null;
  if (version) dist = ((versions[version] || {}).dist) || null;
  if (!version && versions[selector]) {
    version = selector; // 传的是精确版本号
    dist = versions[selector].dist || null;
  }
  if (!version && requestedVersion && versions[requestedVersion]) {
    version = requestedVersion;
    dist = versions[requestedVersion].dist || null;
  }
  if (!version && doc && typeof doc.version === "string" && doc.version) {
    version = doc.version; // 单版本清单
    dist = (doc && doc.dist) || null;
  }
  if (!version) {
    throw updateError(ERROR_CODES.SPEC_NOT_FOUND, `源里没有 ${selector} 对应的版本：${metaUrl}`, {
      detail: "spec_not_found",
      selector,
      url: metaUrl,
    });
  }
  if (requestedVersion && requestedVersion !== version) {
    throw updateError(
      ERROR_CODES.VERSION_MISMATCH,
      `源返回的版本（${version}）与请求的（${requestedVersion}）不一致：${metaUrl}`,
      { detail: "version_mismatch", requestedVersion, version, url: metaUrl },
    );
  }

  dist = dist || {};
  const tarball = typeof dist.tarball === "string" ? dist.tarball.trim() : "";
  if (!tarball) {
    throw updateError(ERROR_CODES.SPEC_NOT_FOUND, `源里 ${version} 没有 dist.tarball：${metaUrl}`, {
      detail: "no_tarball",
      version,
      url: metaUrl,
    });
  }

  const tarRes = await fetchOnce(fetchImpl, tarball, { headers: { accept: "application/octet-stream" } }, timeout, tarball);
  if (!tarRes || !tarRes.ok) throw statusError(tarRes, tarball);

  let buffer;
  try {
    buffer = await runWithTimeout(() => readBodyLimited(tarRes, limit, tarball), timeout, `${tarball}（body）`);
  } catch (e) {
    if (e && e.name === "SelfUpdateError") throw e;
    throw updateError(ERROR_CODES.REGISTRY_UNREACHABLE, `下载中断：${tarball}（${e && e.message}）`, {
      detail: "download_failed",
      url: tarball,
      cause: e,
    });
  }
  const integrity = verifyIntegrity(buffer, dist, tarball);

  if (buffer.length < 2 || buffer[0] !== 0x1f || buffer[1] !== 0x8b) {
    throw updateError(ERROR_CODES.BAD_TARBALL, `下载内容不是 gzip（可能是镜像的错误页）：${tarball}`, {
      detail: "not_gzip",
      bytes: buffer.length,
      url: tarball,
    });
  }

  let entries;
  try {
    entries = readTarEntries(buffer);
  } catch (e) {
    throw updateError(ERROR_CODES.BAD_TARBALL, `tarball 解析失败：${tarball}（${e.message}）`, {
      detail: "bad_tar",
      url: tarball,
      cause: e,
    });
  }
  assertSafeEntries(entries, tarball);

  // staging 是本模块独占的临时目录：先清空，避免上一次失败的残留混进来
  try {
    fs.rmSync(stage, { recursive: true, force: true });
  } catch {
    /* 清不掉就在下面 mkdir 时暴露问题 */
  }
  fs.mkdirSync(stage, { recursive: true });

  // extractTarGz 的 stripPrefix 是"去掉这一层再落到 destDir"，所以 destDir 要**直接给
  // <stageDir>/package**，而不是 stageDir 根（否则文件会散落在 staging 根下）。
  const stageRootDir = path.join(stage, STAGE_PACKAGE_DIR);
  let files = 0;
  try {
    files = extractTarGz(buffer, stageRootDir, { stripPrefix: STAGE_PACKAGE_DIR });
  } catch (e) {
    // extractTarGz 对路径穿越抛 ETRAVERSAL，其它是 tar 结构问题 —— 对外统一 BAD_TARBALL
    throw updateError(ERROR_CODES.BAD_TARBALL, `解包被拒绝：${tarball}（${e.message}）`, {
      detail: e && e.code === "ETRAVERSAL" ? "traversal" : "extract_failed",
      url: tarball,
      cause: e,
    });
  }

  const stageRoot = stageRootDir;
  const pkg = readJsonFile(path.join(stageRoot, "package.json"));
  if (!pkg || typeof pkg !== "object") {
    throw updateError(ERROR_CODES.BAD_TARBALL, `解包后没有 package/package.json：${tarball}`, {
      detail: "no_package_json",
      url: tarball,
    });
  }
  if (pkg.name !== PACKAGE_NAME) {
    throw updateError(ERROR_CODES.NAME_MISMATCH, `包名不符：期望 ${PACKAGE_NAME}，实际 ${pkg.name}`, {
      detail: "name_mismatch",
      expected: PACKAGE_NAME,
      actual: pkg.name,
    });
  }
  if (pkg.version !== version) {
    throw updateError(
      ERROR_CODES.VERSION_MISMATCH,
      `包内版本（${pkg.version}）与源解析出的版本（${version}）不一致`,
      { detail: "version_mismatch", expected: version, actual: pkg.version },
    );
  }

  // 根包版本对了还不够：真正会被装进 profile 的是 packages/dsh-remote-web，
  // 它的 name/version 也必须对得上（发布脚本漏改版本时会在这里被拦下）。
  const payloadRoot = resolveStagePayload({ stageRoot });
  const payloadPkg = readJsonFile(path.join(payloadRoot, "package.json"));
  if (!payloadPkg || payloadPkg.version !== version) {
    throw updateError(
      ERROR_CODES.VERSION_MISMATCH,
      `插件包版本（${payloadPkg && payloadPkg.version}）与源解析出的版本（${version}）不一致`,
      { detail: "version_mismatch", expected: version, actual: payloadPkg && payloadPkg.version, payloadRoot },
    );
  }

  return { version, stageRoot, payloadRoot, bytes: buffer.length, tarball, integrity, files };
}

/**
 * 按 registry 顺序下载 tarball 并解包到 `<stageDir>/package/`。
 *
 * 成功：`{ok:true, registry, version, stageRoot, bytes, ms, attempts, requested, tarball, integrity, files}`
 * 失败：throw，`err.code` 见 ERROR_CODES，且带 `err.attempts`（逐个源的耗时与原因）。
 *
 * 语义细节：
 *   · `version` 显式优先，`tag` 只在没给 version 时生效；都不给 = `latest`；
 *   · `tag` 也可以是精确版本号（`0.8.0`），registry 对两者返回同一份 packument；
 *   · 每个源失败后都会清空 staging，避免把半个包交给下一个源；
 *   · 单请求（含下载）超时 = `timeoutMs`（默认 20s），按请求计，不是总预算；
 *   · 不重写 tarball URL 的 host：镜像给的 URL 就打镜像，官方源给的打官方源 —— 避免
 *     "镜像返回了官方 URL 但我们偷偷换 host"导致 integrity 假设失效。
 *
 * @param {object} options
 * @param {string} [options.version] 精确版本
 * @param {string} [options.tag] dist-tag（latest/beta/…）
 * @param {string} options.stageDir staging 根目录（本模块独占，会被清空重建）
 * @param {string[]|string} [options.registries]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {Record<string,string|undefined>} [options.env]
 */
export async function fetchTarballToStaging(options = {}) {
  const {
    version,
    tag,
    stageDir,
    registries,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    fetchImpl,
    env = process.env,
  } = options || {};

  const fetchFn = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw updateError(ERROR_CODES.BAD_ARGUMENTS, "fetchTarballToStaging: 没有可用的 fetch（Node ≥18）", {
      detail: "bad_arguments",
    });
  }
  const selector = normalizeSelector(version, tag);
  if (!stageDir) {
    throw updateError(ERROR_CODES.BAD_ARGUMENTS, "fetchTarballToStaging: 缺少 stageDir", {
      detail: "bad_arguments",
    });
  }
  const stage = path.resolve(stageDir);
  const list = normalizeRegistries(registries, env);
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : DEFAULT_MAX_BYTES;
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const requestedVersion = version == null || String(version).trim() === "" ? null : String(version).trim();

  const attempts = [];
  const failures = [];
  const startedAll = Date.now();

  for (const registry of list) {
    const started = Date.now();
    try {
      const got = await fetchFromRegistry({
        registry,
        selector,
        stage,
        timeout,
        limit,
        fetchImpl: fetchFn,
        requestedVersion,
      });
      attempts.push({ registry, ok: true, ms: Date.now() - started, error: null, code: null });
      return {
        ok: true,
        registry,
        version: got.version,
        stageRoot: got.stageRoot,
        payloadRoot: got.payloadRoot,
        bytes: got.bytes,
        ms: Date.now() - startedAll,
        attempts,
        requested: selector,
        tarball: got.tarball,
        integrity: got.integrity,
        files: got.files,
      };
    } catch (e) {
      const err = normalizeError(e);
      failures.push(err);
      attempts.push({
        registry,
        ok: false,
        ms: Date.now() - started,
        error: `${err.code}: ${err.message}`,
        code: err.code,
        detail: err.detail,
      });
      try {
        fs.rmSync(stage, { recursive: true, force: true });
      } catch {
        /* 清不掉不影响结论 */
      }
    }
  }

  // 全部源失败：选一个"最能说明问题"的码
  const severeIdx = attempts.findIndex((a) => SEVERE_CODES.has(a.code));
  const allUnreachable = attempts.every((a) => a.code === ERROR_CODES.REGISTRY_UNREACHABLE);
  const code = severeIdx >= 0
    ? attempts[severeIdx].code
    : allUnreachable
      ? ERROR_CODES.REGISTRY_UNREACHABLE
      : attempts[attempts.length - 1].code;

  // 把"那个最能说明问题"的失败的细节带出来：expected/actual/algo/status/bytes 让面板不用解析字符串
  const chosen = severeIdx >= 0 ? failures[severeIdx] : failures[failures.length - 1];
  const summary = attempts.map((a) => `${a.registry} → ${a.error || "ok"}`).join("；");
  throw updateError(code, `所有源都失败（${attempts.length} 个）：${summary}`, {
    attempts,
    allRegistriesFailed: true,
    detail: chosen ? chosen.detail : "all_registries_failed",
    expected: chosen && chosen.expected,
    actual: chosen && chosen.actual,
    algo: chosen && chosen.algo,
    status: chosen && chosen.status,
    bytes: chosen && chosen.bytes,
    requested: selector,
    registries: list,
  });
}

// ---------------------------------------------------------------------------
// 校验 / 应用 / 回滚
// ---------------------------------------------------------------------------

/**
 * 从 staging 里定位"真正要装进 profile 的那个目录"。
 *
 * 两种情况都要支持：
 *   · stageRoot 直接就是插件包（package.json.name === `dsh-remote-web`）：
 *     手工准备 staging / 单元测试会这样用；
 *   · stageRoot 是根包（name === `@mrrisega/dsh-remote`）：
 *     真实 npm tarball 解出来就是这个形状，插件在 `<stageRoot>/packages/dsh-remote-web/`。
 *
 * 只认 `package.json` 里的 name 来判断，不靠目录名猜 —— 目录名可以被包里任何内容伪造。
 *
 * @returns {string} 插件目录的绝对路径
 * @throws NAME_MISMATCH / BAD_TARBALL
 */
export function resolveStagePayload({ stageRoot, fsImpl = fs } = {}) {
  if (!stageRoot) {
    throw updateError(ERROR_CODES.BAD_ARGUMENTS, "resolveStagePayload: 缺少 stageRoot", {
      detail: "bad_arguments",
    });
  }
  const root = path.resolve(stageRoot);
  const rootPkg = readJsonFile(path.join(root, "package.json"), fsImpl);
  if (!rootPkg || typeof rootPkg !== "object") {
    throw updateError(ERROR_CODES.APPLY_FAILED, `staging 里没有可用的 package.json：${root}`, {
      detail: "stage_invalid",
      stageRoot: root,
    });
  }
  if (rootPkg.name === PLUGIN_PACKAGE_NAME) return root;

  if (rootPkg.name === PACKAGE_NAME) {
    const sub = path.join(root, ...PLUGIN_SUBDIR.split("/"));
    const subPkg = readJsonFile(path.join(sub, "package.json"), fsImpl);
    if (!subPkg) {
      throw updateError(
        ERROR_CODES.BAD_TARBALL,
        `根包里没有 ${PLUGIN_SUBDIR}/package.json（发布产物布局异常）：${root}`,
        { detail: "missing_plugin", stageRoot: root },
      );
    }
    if (subPkg.name !== PLUGIN_PACKAGE_NAME) {
      throw updateError(
        ERROR_CODES.NAME_MISMATCH,
        `${PLUGIN_SUBDIR} 里的包名不符：期望 ${PLUGIN_PACKAGE_NAME}，实际 ${subPkg.name}`,
        { detail: "name_mismatch", expected: PLUGIN_PACKAGE_NAME, actual: subPkg.name, stageRoot: root },
      );
    }
    return sub;
  }

  throw updateError(
    ERROR_CODES.NAME_MISMATCH,
    `staging 包名不符：期望 ${PACKAGE_NAME}（根包）或 ${PLUGIN_PACKAGE_NAME}（插件包），实际 ${rootPkg.name}`,
    { detail: "name_mismatch", expected: PACKAGE_NAME, actual: rootPkg.name, stageRoot: root },
  );
}

/**
 * 读取目标目录里已安装的包信息（不抛错）。
 * @returns {{installed: boolean, dir: string, name: string|null, version: string|null, pkg: object|null}}
 */
export function readInstalled({ targetDir, fsImpl = fs } = {}) {
  if (!targetDir) {
    throw updateError(ERROR_CODES.BAD_ARGUMENTS, "readInstalled: 缺少 targetDir", { detail: "bad_arguments" });
  }
  const dir = path.resolve(targetDir);
  const pkg = readJsonFile(path.join(dir, "package.json"), fsImpl);
  if (!pkg || typeof pkg !== "object") return { installed: false, dir, name: null, version: null, pkg: null };
  return {
    installed: true,
    dir,
    name: typeof pkg.name === "string" ? pkg.name : null,
    version: typeof pkg.version === "string" ? pkg.version : null,
    pkg,
  };
}

/**
 * 校验目标目录确实装上了期望版本（apply 之后的收尾检查，面板也可单独调用）。
 * @returns {{ok:true, dir:string, name:string, version:string}}
 * @throws NOT_INSTALLED / NAME_MISMATCH / VERSION_MISMATCH
 */
export function verifyInstalled({ targetDir, expectedVersion, expectedName = PLUGIN_PACKAGE_NAME, fsImpl = fs } = {}) {
  const info = readInstalled({ targetDir, fsImpl });
  if (!info.installed) {
    throw updateError(ERROR_CODES.NOT_INSTALLED, `目标目录里没有可读的 package.json：${info.dir}`, {
      detail: "not_installed",
      targetDir: info.dir,
    });
  }
  if (expectedName && info.name !== expectedName) {
    throw updateError(ERROR_CODES.NAME_MISMATCH, `已安装的包名不符：期望 ${expectedName}，实际 ${info.name}`, {
      detail: "name_mismatch",
      expected: expectedName,
      actual: info.name,
      targetDir: info.dir,
    });
  }
  if (expectedVersion != null && String(expectedVersion).trim() !== "" && info.version !== String(expectedVersion).trim()) {
    throw updateError(
      ERROR_CODES.VERSION_MISMATCH,
      `已安装版本（${info.version}）不是期望的（${expectedVersion}）`,
      { detail: "version_mismatch", expected: String(expectedVersion).trim(), actual: info.version, targetDir: info.dir },
    );
  }
  return { ok: true, dir: info.dir, name: info.name, version: info.version };
}

/** rename 失败时区分"被占用"与"真失败"。 */
function classifyRenameError(e, what) {
  const code = e && e.code;
  const map = { EBUSY: ERROR_CODES.TARGET_BUSY, ETXTBSY: ERROR_CODES.TARGET_BUSY };
  const mapped = map[code];
  if (mapped) {
    return updateError(mapped, `${what}：目标被占用（${code}）${e.message ? `：${e.message}` : ""}`, {
      detail: "busy",
      syscall: e && e.syscall,
      errno: e && e.errno,
      cause: e,
    });
  }
  return updateError(ERROR_CODES.APPLY_FAILED, `${what} 失败（${code || "?"}）${e.message ? `：${e.message}` : ""}`, {
    detail: "rename_failed",
    syscall: e && e.syscall,
    errno: e && e.errno,
    cause: e,
  });
}

/** 找 backupDir 名字：撞名就加序号（同一毫秒内连续升级两次也不会互相覆盖）。 */
function uniqueBackupDir(target, fsImpl) {
  const stamp = makeStamp();
  let candidate = `${target}.bak-${stamp}`;
  let n = 1;
  while (fsImpl.existsSync(candidate)) candidate = `${target}.bak-${stamp}-${n++}`;
  return candidate;
}

function removeTree(dir, fsImpl = fs) {
  try {
    fsImpl.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function copyTree(src, dest, fsImpl = fs) {
  if (typeof fsImpl.cpSync === "function") {
    fsImpl.cpSync(src, dest, { recursive: true, force: true });
    return;
  }
  fsImpl.mkdirSync(dest, { recursive: true });
  for (const entry of fsImpl.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(s, d, fsImpl);
    else if (entry.isSymbolicLink()) throw updateError(ERROR_CODES.APPLY_FAILED, `拒绝复制符号链接：${s}`, { detail: "symlink" });
    else fsImpl.copyFileSync(s, d);
  }
}

/**
 * 把 staging 里的插件目录原子地换到 profile 的插件目录。
 *
 * stageRoot 可以直接是插件包目录，也可以是根包解出来的 `package/`（会自动定位
 * `packages/dsh-remote-web/`，用 package.json 的 name 判断，不靠目录名）。
 *
 * 流程：定位并校验 payload 的 name/version → 旧目录 rename 成 `<target>.bak-<stamp>` →
 * payload rename 到 target → 再 verifyInstalled 一次。任一步失败都会回滚（把 bak 换回去），
 * 所以调用方看到的要么是"旧的完好"，要么是"新的完好"，不会出现半个安装。
 *
 * 幂等：target 已有相同版本时直接返回 `{ok:true, applied:false, noop:true}`（不动磁盘）；
 * 想强制重装传 `force:true`。
 *
 * @param {object} options
 * @param {string} options.stageRoot staging 根（`<stageDir>/package`）或插件包目录
 * @param {string} options.targetDir profile 下的插件目录（如 `~/.dsh/profiles/desktop/dsh-remote-web-plugin`）
 * @param {boolean} [options.keepBackup=true] 成功后是否保留 bak（保留便于人工回滚）
 * @param {string} [options.expectedVersion] 期望落到 target 的版本（默认取 stage 的 version）
 * @param {boolean} [options.force=false] 同版本也强制重装
 * @param {object} [options.fsImpl] 仅测试注入用（同步 fs 兼容接口）
 * @returns {{ok:true, applied:boolean, noop:boolean, backupDir:string|null, fromVersion:string|null, toVersion:string, targetDir:string, payloadRoot:string}}
 */
export function applyStagedToProfile(options = {}) {
  const { stageRoot, targetDir, keepBackup = true, expectedVersion, force = false, fsImpl = fs } = options || {};
  if (!stageRoot || !targetDir) {
    throw updateError(ERROR_CODES.BAD_ARGUMENTS, "applyStagedToProfile: 缺少 stageRoot 或 targetDir", {
      detail: "bad_arguments",
    });
  }
  const stage = path.resolve(stageRoot);
  const target = path.resolve(targetDir);

  // 校验的是"真正要装进去的插件包"，不是根包
  const payload = resolveStagePayload({ stageRoot: stage, fsImpl });
  const stagePkg = readJsonFile(path.join(payload, "package.json"), fsImpl);
  const toVersion = typeof (stagePkg && stagePkg.version) === "string" ? stagePkg.version.trim() : "";
  if (!toVersion) {
    throw updateError(ERROR_CODES.VERSION_MISMATCH, `staging 的插件包没有 version：${payload}`, {
      detail: "version_mismatch",
      stageRoot: stage,
      payloadRoot: payload,
    });
  }
  if (expectedVersion != null && String(expectedVersion).trim() !== "" && toVersion !== String(expectedVersion).trim()) {
    throw updateError(
      ERROR_CODES.VERSION_MISMATCH,
      `staging 版本（${toVersion}）不是期望的（${expectedVersion}）`,
      { detail: "version_mismatch", expected: String(expectedVersion).trim(), actual: toVersion },
    );
  }

  const current = readInstalled({ targetDir: target, fsImpl });
  const fromVersion = current.version;
  const targetExists = fsImpl.existsSync(target);

  if (targetExists && !force && fromVersion === toVersion) {
    return {
      ok: true,
      applied: false,
      noop: true,
      backupDir: null,
      fromVersion,
      toVersion,
      targetDir: target,
      payloadRoot: payload,
    };
  }

  fsImpl.mkdirSync(path.dirname(target), { recursive: true });

  const backupDir = targetExists ? uniqueBackupDir(target, fsImpl) : null;
  let movedOld = false;
  // wroteInto：target 这个位置上已经有"我们写的（可能写了一半的）内容"。
  // 没写过就绝不能删 target —— 否则一次 EBUSY 会把用户装好的插件删掉。
  let wroteInto = false;

  // 回滚：目标位置先清空（可能是写了一半的新目录），再把备份换回去
  const restore = () => {
    const report = { ok: false, restored: false, removedNew: false, error: null };
    try {
      if (wroteInto && fsImpl.existsSync(target)) {
        report.removedNew = removeTree(target, fsImpl);
        if (!report.removedNew) {
          // 删不掉就别硬来：留个可诊断的结论，避免把备份也弄丢
          report.error = `清理目标目录失败：${target}`;
          report.code = "EBUSY";
          return report;
        }
      }
      if (movedOld && backupDir) {
        fsImpl.renameSync(backupDir, target);
        report.restored = true;
      } else {
        report.restored = true; // 本来就没有目标目录：清掉半成品即回到原状
      }
      report.ok = report.restored;
    } catch (e) {
      report.error = (e && e.message) || String(e);
      report.code = e && e.code;
    }
    return report;
  };

  try {
    if (targetExists) {
      try {
        fsImpl.renameSync(target, backupDir);
      } catch (e) {
        throw classifyRenameError(e, `把旧目录挪到备份（${backupDir}）`);
      }
      movedOld = true;
    }

    try {
      fsImpl.renameSync(payload, target);
      wroteInto = true;
    } catch (e) {
      if (e && e.code === "EXDEV") {
        // stage 与 target 不在同一个文件系统（/tmp 与 home 常见）：退化成复制，
        // 失败由下面的回滚兜底；此时"原子"退化为"可回滚"。
        wroteInto = true; // 复制可能已经写了一部分
        try {
          copyTree(payload, target, fsImpl);
        } catch (e2) {
          throw updateError(ERROR_CODES.APPLY_FAILED, `跨盘复制 staging 失败：${e2.message}`, {
            detail: "copy_failed",
            cause: e2,
          });
        }
        removeTree(payload, fsImpl);
      } else {
        throw classifyRenameError(e, `把 staging 插件目录挪到目标（${target}）`);
      }
    }
    verifyInstalled({ targetDir: target, expectedVersion: toVersion, fsImpl });
  } catch (e) {
    const err = normalizeError(e);
    const rb = restore();
    throw updateError(err.code, err.message, {
      detail: err.detail,
      stageRoot: stage,
      payloadRoot: payload,
      targetDir: target,
      backupDir,
      fromVersion,
      toVersion,
      rollback: rb,
      cause: err,
    });
  }

  let keptBackup = backupDir;
  if (backupDir && !keepBackup) {
    removeTree(backupDir, fsImpl);
    keptBackup = null;
  }

  return {
    ok: true,
    applied: true,
    noop: false,
    backupDir: keptBackup,
    fromVersion,
    toVersion,
    targetDir: target,
    payloadRoot: payload,
  };
}

/**
 * 用备份目录换回旧版本（`applyStagedToProfile` 失败时已自动做过一次；这里给"升级后
 * 发现新版有问题"的手动回滚用）。
 *
 * 当前 target（新版本）不会被删除，而是挪到 `<target>.failed-<stamp>`，方便事后取证。
 *
 * @returns {{ok:true, restored:true, version:string|null, targetDir:string, movedAside:string|null, consumedBackup:string}}
 * @throws ROLLBACK_FAILED
 */
export function rollback(options = {}) {
  const { backupDir, targetDir, fsImpl = fs } = options || {};
  if (!backupDir || !targetDir) {
    throw updateError(ERROR_CODES.BAD_ARGUMENTS, "rollback: 缺少 backupDir 或 targetDir", {
      detail: "bad_arguments",
    });
  }
  const backup = path.resolve(backupDir);
  const target = path.resolve(targetDir);

  if (!fsImpl.existsSync(backup)) {
    throw updateError(ERROR_CODES.ROLLBACK_FAILED, `备份目录不存在：${backup}`, {
      detail: "no_backup",
      backupDir: backup,
    });
  }
  const backupInfo = readInstalled({ targetDir: backup, fsImpl });
  if (!backupInfo.installed) {
    throw updateError(ERROR_CODES.ROLLBACK_FAILED, `备份目录里没有可读的 package.json：${backup}`, {
      detail: "bad_backup",
      backupDir: backup,
    });
  }

  let movedAside = null;
  if (fsImpl.existsSync(target)) {
    movedAside = `${target}.failed-${makeStamp()}`;
    try {
      fsImpl.renameSync(target, movedAside);
    } catch (e) {
      throw updateError(ERROR_CODES.ROLLBACK_FAILED, `先把当前版本挪走时失败（${e.code || "?"}）：${e.message}`, {
        detail: "move_aside_failed",
        cause: e,
      });
    }
  }

  try {
    fsImpl.renameSync(backup, target);
  } catch (e) {
    if (e && e.code === "EXDEV") {
      try {
        copyTree(backup, target, fsImpl);
        removeTree(backup, fsImpl);
      } catch (e2) {
        if (movedAside) {
          removeTree(target, fsImpl); // 复制可能留了半个目录，先清掉再放回旧版本
          try {
            fsImpl.renameSync(movedAside, target);
          } catch {
            /* 尽力而为 */
          }
        }
        throw updateError(ERROR_CODES.ROLLBACK_FAILED, `跨盘恢复备份失败：${e2.message}`, {
          detail: "copy_failed",
          cause: e2,
          movedAside,
        });
      }
    } else {
      if (movedAside) {
        try {
          fsImpl.renameSync(movedAside, target);
        } catch {
          /* 尽力而为 */
        }
      }
      throw updateError(ERROR_CODES.ROLLBACK_FAILED, `恢复备份失败（${e.code || "?"}）：${e.message}`, {
        detail: "restore_failed",
        cause: e,
        movedAside,
      });
    }
  }

  return {
    ok: true,
    restored: true,
    version: backupInfo.version,
    targetDir: target,
    movedAside,
    consumedBackup: backup,
  };
}
