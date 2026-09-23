/**
 * 零依赖更新通道：直接从 npm registry 取 tarball，用 Node 内置 zlib + 自解析 tar 落到 staging 目录。
 *
 * 为什么必须有这条通道（真实事故，生产遥测近 14 天）：
 *   插件面板的「一键更新」过去一律走 `npx @mrrisega/dsh-remote@<tag>`。在 Windows 上，
 *   Node ≥20.12（CVE-2024-27980 的修复）起 `spawn("npx.cmd")` 不带 shell 会**同步抛 EINVAL**，
 *   0.6.6 及更早正是这么写的 —— 于是**升级通道本身坏掉**：427 台 Windows 里 157 台装机失败
 *   且从未连上，其中 79 台点过「一键更新」、79 台全部 update_failed。这批人在产品内没有任何
 *   出路：装不上、也更新不了。
 *   所以这里提供一条**完全不依赖 npx/npm/子进程/shell** 的通路：HTTPS 取 tarball →
 *   就地解开到 staging 目录 → 由调用方去跑 staging 里的 dsh-setup.mjs。
 *
 * 为什么零第三方依赖、也不用系统 tar：
 *   · 系统 tar 不可靠：Windows 直到 Win10 1803 才自带 bsdtar，PATH 里也不保证有；而且调它
 *     同样要 spawn 子进程 —— 引号/空格/shell 那一串坑正是我们要躲开的东西；
 *   · node_modules 里的 `tar` 不是我们的依赖：插件市场装进 profile 的只有插件自己声明的依赖
 *     （本插件唯一依赖是 ws），require("tar") 会 MODULE_NOT_FOUND —— 不能在"救砖"路径上赌它存在；
 *   · Node 内置 zlib 已能解 gzip，tar 只是「512 字节头 + 数据（补齐 512）+ 零块收尾」，
 *     自解析一百来行就够，而且**全同步**：没有子进程、没有 shell、三平台行为一致。
 *
 * 安全红线（详见 extractTarGz 注释）：
 *   · 条目名含 `..` 段、绝对路径、或解析后不在 destDir 内 → **直接抛错拒绝**，且先整体校验再落盘
 *     （坏包不会留下一半文件）；
 *   · 符号链接/硬链接/设备/FIFO 一律**跳过**，不写也不抛（防止用链接把写入引到目标目录之外）。
 *
 * 只用 node: 内置模块，零第三方依赖。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/** npm 官方 registry；自建/镜像可通过 registry 参数覆盖。 */
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/** tarball 下载上限（防御性：坏镜像/错误响应别把内存打爆）。 */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

const BLOCK = 512;

// ---------------------------------------------------------------------------
// tar 解析
// ---------------------------------------------------------------------------

/** 取 NUL 结尾（也容忍不结尾）的字符串字段。 */
function cstr(buf) {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString("utf8");
}

/** 八进制字段（含 GNU base-256 大数形式，够用且不引入依赖）。 */
function readOctal(buf, off, len) {
  if (buf[off] & 0x80) { // GNU base-256（仅供大文件用，正常 tarball 不会走到）
    let v = 0;
    for (let i = off + 1; i < off + len; i++) v = v * 256 + buf[i];
    return v;
  }
  const raw = buf.subarray(off, off + len).toString("latin1").replace(/\0.*$/s, "").trim();
  if (!raw) return 0;
  const n = parseInt(raw, 8);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** 整块 512 字节是否全零（tar 的结束标记）。 */
function isZeroBlock(buf, off) {
  for (let i = off; i < off + BLOCK; i++) if (buf[i] !== 0) return false;
  return true;
}

/**
 * 解析 PaxHeader（typeflag `x`）的数据区：形如 `LEN key=value\n` 的记录序列，
 * 我们只关心 `path=`（npm tarball 里长路径可能走这里）。
 */
function parsePax(data) {
  const out = {};
  const text = data.toString("utf8");
  let pos = 0;
  while (pos < text.length) {
    const sp = text.indexOf(" ", pos);
    if (sp === -1) break;
    const len = parseInt(text.slice(pos, sp), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(sp + 1, pos + len).replace(/\n$/, "");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return out;
}

/** 头里的条目名：ustar 的 prefix 字段要拼回去（这也是长路径的一种落地方式）。 */
function headerName(header) {
  const name = cstr(header.subarray(0, 100));
  const magic = header.subarray(257, 262).toString("latin1");
  if (magic !== "ustar") return name; // 老式 v7：没有 prefix
  const prefix = cstr(header.subarray(345, 500));
  return prefix ? `${prefix}/${name}` : name;
}

/**
 * 解析（已解压的）tar 缓冲，返回全部条目 `{ name, size, type, data }`。
 * name 已合并 GNU long name（typeflag `L`）与 PaxHeader 的 `path=`。
 */
function parseTar(buffer) {
  const buf = buffer;
  const entries = [];
  let offset = 0;
  let longName = null;
  let pax = null;
  while (offset + BLOCK <= buf.length) {
    if (isZeroBlock(buf, offset)) {
      offset += BLOCK;
      if (offset + BLOCK > buf.length || isZeroBlock(buf, offset)) break; // 连续两个零块 = 结束
      continue;
    }
    const header = buf.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    const size = readOctal(header, 124, 12);
    const dataEnd = offset + size;
    if (dataEnd > buf.length) {
      throw new Error(`tar 数据截断：条目「${headerName(header)}」声明 ${size} 字节，但缓冲已到末尾`);
    }
    const data = buf.subarray(offset, dataEnd);
    offset += Math.ceil(size / BLOCK) * BLOCK;

    let type = String.fromCharCode(header[156]);
    if (type === "\0") type = "0"; // 老式 tar 的普通文件

    if (type === "L") { longName = cstr(data); continue; } // GNU long name
    if (type === "K") continue; // GNU long linkname：我们用不到（链接条目本来就要跳过）
    if (type === "x") { pax = parsePax(data); continue; } // PaxHeader（逐条目）
    if (type === "g") continue; // PaxHeader（全局）：不影响 path 解析，忽略

    let name = headerName(header);
    if (longName) name = longName;
    else if (pax && pax.path) name = pax.path;
    longName = null;
    pax = null;
    entries.push({ name, size, type, data });
  }
  return entries;
}

/** gzip 缓冲 → 裸 tar；已经是裸 tar（少见，测试/诊断会用到）就原样返回。 */
function gunzipMaybe(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf);
  return buf;
}

/**
 * 列出 tar(.gz) 里的条目，便于测试与故障归因。
 * @returns {{name: string, size: number, type: string}[]}
 */
export function readTarEntries(buffer) {
  return parseTar(gunzipMaybe(buffer)).map((e) => ({ name: e.name, size: e.size, type: e.type }));
}

// ---------------------------------------------------------------------------
// 解包
// ---------------------------------------------------------------------------

/** 路径穿越的专用错误码：调用方可以据此区分"包坏了"和"包是恶意的"。 */
function traversalError(rawName) {
  const err = new Error(`拒绝解包：tar 条目「${rawName}」会写到目标目录之外（路径穿越）`);
  err.code = "ETRAVERSAL";
  return err;
}

/**
 * 把条目名换算成 destDir 内的绝对路径。
 * @returns {string|null} null = 处理后为空（如 `package/` 目录条目本身）→ 跳过
 */
function resolveEntryPath(root, rawName, stripPrefix) {
  let name = String(rawName).replace(/\\/g, "/");
  if (!name || name.includes("\0")) throw traversalError(rawName);
  // 绝对路径（POSIX /… 与 Windows 盘符 C:…）直接拒 —— 这不可能是 npm tarball 的合法条目
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw traversalError(rawName);

  if (stripPrefix) {
    const prefix = String(stripPrefix).replace(/\/+$/, "");
    if (name === prefix) name = "";
    else if (name.startsWith(`${prefix}/`)) name = name.slice(prefix.length + 1);
    // 顶层段与 stripPrefix 不一致时**原样保留**：宁可多一层目录，也不要把 lib/a.js 截成 a.js
  }

  const segs = name.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segs.some((s) => s === "..")) throw traversalError(rawName);
  const rel = segs.join("/");
  if (!rel) return null;

  const abs = path.resolve(root, rel);
  const inside = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(inside)) throw traversalError(rawName); // 兜底（含解析后的奇怪形态）
  return abs;
}

/**
 * 同步解压 gzip + 解析 tar，把文件写到 destDir（自动建目录）。
 *
 * 支持：ustar 的 `prefix` 字段、GNU long name（typeflag `L`）、PaxHeader（typeflag `x`，取 `path=`）。
 * 只处理普通文件（`0`/`\0`）与目录（`5`）；符号链接/硬链接/设备/FIFO **跳过**（不写、不抛）。
 * 条目名含 `..`、绝对路径、或解析后不在 destDir 内 → **抛错拒绝**；校验在落盘之前整体完成，
 * 因此坏包不会留下"写了一半"的目录。
 *
 * @param {Buffer|Uint8Array} buffer tar.gz（也容忍裸 tar）
 * @param {string} destDir 目标目录
 * @param {{stripPrefix?: string}} [options] stripPrefix 默认 "package"（去掉 npm tarball 顶层段）；
 *        传 "" 表示保留原样
 * @returns {number} 写出的**普通文件**数（目录不计）
 */
export function extractTarGz(buffer, destDir, { stripPrefix = "package" } = {}) {
  if (!destDir) throw new Error("extractTarGz: 缺少 destDir");
  const root = path.resolve(destDir);
  const entries = parseTar(gunzipMaybe(buffer));

  // 第一步：整体校验并规划落点（恶意条目在这里就被拒，磁盘上什么都不留）
  const planned = [];
  for (const e of entries) {
    if (e.type !== "0" && e.type !== "5") continue; // 链接/设备/其它一律跳过
    const abs = resolveEntryPath(root, e.name, stripPrefix);
    if (!abs) continue;
    planned.push({ abs, dir: e.type === "5", data: e.data });
  }

  // 第二步：落盘
  fs.mkdirSync(root, { recursive: true });
  let files = 0;
  for (const p of planned) {
    if (p.dir) { fs.mkdirSync(p.abs, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(p.abs), { recursive: true });
    fs.writeFileSync(p.abs, p.data);
    files++;
  }
  return files;
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

/** 作用域包按 npm 规范编码：`@scope/name` → `@scope%2fname`（保留 @，斜杠转义）。 */
function encodePackageName(name) {
  return encodeURIComponent(String(name).trim()).replace(/^%40/i, "@").replace(/%2F/g, "%2f");
}

function httpStatusError(what, res, url, extra) {
  const status = res && res.status ? res.status : "?";
  const err = new Error(`${what} 失败：HTTP ${status} ${url}${extra ? `（${extra}）` : ""}`);
  err.status = res && res.status;
  err.url = url;
  return err;
}

/**
 * 解析 dist-tag / 版本号 → 具体 version 与 tarball URL。
 *
 * 请求 `<registry>/<name>/<tag>`（作用域包的 `/` 编码为 `%2f`）。registry 对
 * 「dist-tag」和「具体版本号」都返回整份 packument，所以两种入参都能解析：
 *   · 命中 `dist-tags[tag]` → 取该版本；
 *   · 否则若 `versions[tag]` 存在 → 说明传的是精确版本号。
 *
 * @returns {Promise<{version: string, tarball: string, url: string}>}
 */
export async function resolveVersion({ name, tag = "latest", registry = DEFAULT_REGISTRY, fetchImpl = fetch } = {}) {
  if (!name) throw new Error("resolveVersion: 缺少包名 name");
  if (typeof fetchImpl !== "function") throw new Error("resolveVersion: fetchImpl 不是函数");
  const base = String(registry || DEFAULT_REGISTRY).replace(/\/+$/, "");
  const wantTag = tag == null || tag === "" ? "latest" : String(tag);
  const url = `${base}/${encodePackageName(name)}/${encodeURIComponent(wantTag)}`;

  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: "application/json" } });
  } catch (e) {
    // 错误信息里带上 name/tag：遥测里归因时一眼能看出是哪个包哪个 tag 打不通
    throw new Error(`resolveVersion 失败：请求出错 ${url}（name=${name}, tag=${wantTag}）: ${e.message}`);
  }
  if (!res || !res.ok) throw httpStatusError("resolveVersion", res, url, `name=${name}, tag=${wantTag}`);

  let doc;
  try {
    doc = await res.json();
  } catch (e) {
    throw new Error(`resolveVersion 失败：响应不是 JSON ${url}（name=${name}, tag=${wantTag}）: ${e.message}`);
  }
  const distTags = (doc && doc["dist-tags"]) || {};
  const versions = (doc && doc.versions) || {};
  let version = distTags[wantTag];
  if (!version && versions[wantTag]) version = wantTag; // 传的是精确版本号
  const meta = version ? versions[version] : null;
  const tarball = meta && meta.dist && meta.dist.tarball;
  if (!version || !tarball) {
    throw new Error(`resolveVersion 失败：${url} 的响应里没有 ${wantTag} 对应的版本或 tarball（name=${name}, tag=${wantTag}）`);
  }
  return { version, tarball, url };
}

/**
 * 下载 tarball 为 Buffer。
 * 超过 maxBytes 抛错（含先看 content-length 的快速失败），避免坏响应把内存打爆。
 */
export async function downloadTarball({ tarballUrl, fetchImpl = fetch, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!tarballUrl) throw new Error("downloadTarball: 缺少 tarballUrl");
  if (typeof fetchImpl !== "function") throw new Error("downloadTarball: fetchImpl 不是函数");
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : DEFAULT_MAX_BYTES;
  const tooBig = (got) => {
    const err = new Error(`tarball 过大：${got} > 上限 ${limit} 字节（${tarballUrl}）`);
    err.code = "E2BIG";
    return err;
  };

  let res;
  try {
    res = await fetchImpl(tarballUrl, { headers: { accept: "application/octet-stream" } });
  } catch (e) {
    throw new Error(`downloadTarball 失败：请求出错 ${tarballUrl}: ${e.message}`);
  }
  if (!res || !res.ok) throw httpStatusError("downloadTarball", res, tarballUrl);

  const declared = res.headers && typeof res.headers.get === "function" ? Number(res.headers.get("content-length")) : 0;
  if (Number.isFinite(declared) && declared > limit) throw tooBig(declared);

  const chunks = [];
  let total = 0;
  const push = (chunk) => {
    const c = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += c.length;
    if (total > limit) throw tooBig(total); // 边下边判：别等下载完才发现超限
    chunks.push(c);
  };

  const body = res.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) push(value);
      }
    } catch (e) {
      try { await reader.cancel(); } catch { /* 取消失败无所谓 */ }
      throw e;
    }
  } else if (body && typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) push(chunk);
  } else {
    push(await res.arrayBuffer());
  }

  const buf = Buffer.concat(chunks, total);
  if (buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
    // 200 但内容不是 gzip：通常是镜像返回了 HTML 错误页，报清楚比后面 gunzip 抛 zlib 错好归因
    throw new Error(`downloadTarball 失败：内容不是 gzip（前 ${Math.min(buf.length, 16)} 字节） ${tarballUrl}`);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// staging
// ---------------------------------------------------------------------------

/**
 * 解析 `spec`：`"@scope/name"` / `"@scope/name@0.6.12"` / `"pkg@beta"`。
 * 注意作用域包名里的 `@`：必须从**名字部分之后**再找版本分隔的 `@`。
 * @returns {{name: string, tag: string}}
 */
export function parseSpec(spec) {
  const raw = String(spec == null ? "" : spec).trim();
  if (!raw) throw new Error("stagePackage: spec 不能为空");
  if (raw.startsWith("@")) {
    const slash = raw.indexOf("/");
    if (slash <= 1) throw new Error(`stagePackage: 作用域包名不合法「${raw}」（应形如 @scope/name[@tag]）`);
    const at = raw.indexOf("@", slash);
    if (at === -1) return { name: raw, tag: "latest" };
    const name = raw.slice(0, at);
    const tag = raw.slice(at + 1).trim();
    if (!name.slice(slash + 1)) throw new Error(`stagePackage: 包名不合法「${raw}」`);
    return { name, tag: tag || "latest" };
  }
  const at = raw.indexOf("@");
  if (at === -1) return { name: raw, tag: "latest" };
  const name = raw.slice(0, at);
  if (!name) throw new Error(`stagePackage: 包名不合法「${raw}」`);
  return { name, tag: raw.slice(at + 1).trim() || "latest" };
}

/**
 * 把 `spec` 对应的包（含 dependencies）落到本地 staging 目录，供调用方去跑里面的 dsh-setup.mjs。
 *
 * 依赖解析策略：先把依赖的**版本范围**（如 `^8.18.0`）当 dist-tag 去请求 —— registry 对
 * 「精确版本号」能直接命中（`versions[tag]` 分支），而范围（`^`/`~`/`>=`）必然 404，此时
 * 回退 `latest` 并在返回值里如实标注（`requested` / `resolvedBy` / `distTag`）。
 * 为什么这样就够用：本项目唯一的运行时依赖是 `ws`，且它**没有子依赖**，
 * 装 latest 不会拖出一条不一致的依赖图；真需要精确复现时，调用方可以直接传 dist-tag/精确版本。
 *
 * 注意：destDir 应当是一个**新建的空目录**（这里只保证 mkdir -p，不会删除已有内容）。
 *
 * @returns {Promise<{name: string, version: string, dir: string, files: number, deps: object[]}>}
 */
export async function stagePackage({ spec, destDir, registry = DEFAULT_REGISTRY, fetchImpl = fetch, dependencies = {} } = {}) {
  if (!destDir) throw new Error("stagePackage: 缺少 destDir");
  const { name, tag } = parseSpec(spec);
  const root = path.resolve(destDir);
  fs.mkdirSync(root, { recursive: true });

  const main = await resolveVersion({ name, tag, registry, fetchImpl });
  const mainBuf = await downloadTarball({ tarballUrl: main.tarball, fetchImpl });
  const files = extractTarGz(mainBuf, root, { stripPrefix: "package" });

  const deps = [];
  for (const [depName, depRange] of Object.entries(dependencies || {})) {
    if (!depName) continue;
    const requested = depRange == null || depRange === "" ? "latest" : String(depRange);
    let resolved;
    let resolvedBy = "requested-tag";
    let distTag = requested;
    try {
      resolved = await resolveVersion({ name: depName, tag: requested, registry, fetchImpl });
    } catch {
      // 版本范围当 tag 请求必然 404（registry 的 dist-tags 里没有 "^8.18.0"）→ 回退 latest
      resolved = await resolveVersion({ name: depName, tag: "latest", registry, fetchImpl });
      resolvedBy = "latest-fallback";
      distTag = "latest";
    }
    const buf = await downloadTarball({ tarballUrl: resolved.tarball, fetchImpl });
    // @scope/x 要落到 node_modules/@scope/x（按段建目录，别把整个名字当一个目录名）
    const depDir = path.join(root, "node_modules", ...depName.split("/").filter(Boolean));
    const depFiles = extractTarGz(buf, depDir, { stripPrefix: "package" });
    deps.push({
      name: depName,
      version: resolved.version,
      requested,   // 调用方原本写的（可能是 "^8.18.0"）
      resolvedBy,  // "requested-tag" | "latest-fallback"
      distTag,     // 实际生效的 tag（回退时是 "latest"）
      dir: depDir,
      files: depFiles,
    });
  }

  return { name, version: main.version, dir: root, files, deps };
}
