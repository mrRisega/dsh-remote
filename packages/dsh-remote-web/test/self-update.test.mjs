#!/usr/bin/env node
/**
 * self-update.js —— 自升级核心模块的单元测试（`node --test`，**全程不联网**）。
 *
 * 为什么这些用例是"必须的"而不是"顺手加的"：
 *   升级是唯一会**覆盖用户正在用的插件目录**的操作。历史上一键更新坏掉（Windows 上 npx EINVAL）
 *   让 79 台机器点了升级却永远装不上；而"装到一半"比"装不上"更糟 —— 面板没了、日志也说不清。
 *   所以这里锁的都是"出事了会很难看"的分支：
 *     · 源顺序与回退（国内网络打不开 npmjs 是常态）；
 *     · integrity / 包名 / 版本三关，任一不符都必须**在落盘前**停住；
 *     · tar 里的 `..`、绝对路径、符号链接/硬链接一律拒绝；
 *     · apply 失败必须回滚成"升级前的样子"（连 EBUSY 都不许把用户装好的目录删掉）；
 *     · 同版本重复 apply 必须幂等（面板重复点击不该造出一堆 bak）。
 *
 * 所有 HTTP 都由注入的 fetchImpl 提供，tarball 由本地 tar 构造器生成 → 可离线、可重复。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import {
  DEFAULT_REGISTRIES,
  ERROR_CODES,
  PACKAGE_NAME,
  PLUGIN_PACKAGE_NAME,
  PLUGIN_SUBDIR,
  applyStagedToProfile,
  fetchTarballToStaging,
  readInstalled,
  resolveRegistryOrder,
  resolveStagePayload,
  rollback,
  verifyInstalled,
} from "../lib/self-update.js";

const BLOCK = 512;
const REG_A = "https://registry.npmmirror.com";
const REG_B = "https://registry.npmjs.org";

// ---------------------------------------------------------------------------
// 本地 tar.gz 构造器（不依赖系统 tar，也不联网）
// ---------------------------------------------------------------------------

function octal(value, len) {
  const digits = Math.max(1, len - 1);
  const text = (Number(value) >>> 0).toString(8).padStart(digits, "0").slice(-digits);
  return `${text}\0`;
}

/** 造一个 ustar 头（512 字节，含校验和）。 */
function tarHeader({ name, size = 0, type = "0", mode = 0o644, linkname = "" }) {
  const header = Buffer.alloc(BLOCK, 0);
  Buffer.from(name, "utf8").copy(header, 0, 0, Math.min(Buffer.byteLength(name), 100));
  header.write(octal(mode, 8), 100, 8, "latin1");
  header.write(octal(0, 8), 108, 8, "latin1"); // uid
  header.write(octal(0, 8), 116, 8, "latin1"); // gid
  header.write(octal(size, 12), 124, 12, "latin1");
  header.write(octal(0, 12), 136, 12, "latin1"); // mtime
  header.write("        ", 148, 8, "latin1"); // 校验和先填 8 个空格
  header.write(type, 156, 1, "latin1");
  if (linkname) header.write(linkname, 157, Math.min(Buffer.byteLength(linkname), 100), "latin1");
  header.write("ustar", 257, 5, "latin1");
  header.write("00", 263, 2, "latin1");
  header.write("root", 265, 4, "latin1");
  header.write("root", 297, 4, "latin1");

  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return header;
}

/** @param {{name:string, data?:string|Buffer, type?:string, linkname?:string}[]} entries */
function makeTgz(entries) {
  const parts = [];
  for (const entry of entries) {
    const type = entry.type || "0";
    const data = entry.data == null ? Buffer.alloc(0) : Buffer.from(entry.data);
    const payload = type === "0" ? data : Buffer.alloc(0);
    parts.push(tarHeader({ name: entry.name, size: payload.length, type, linkname: entry.linkname }));
    if (payload.length > 0) {
      parts.push(payload);
      const pad = (BLOCK - (payload.length % BLOCK)) % BLOCK;
      if (pad > 0) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2)); // 两个全零块 = tar 结束
  return zlib.gzipSync(Buffer.concat(parts));
}

/**
 * npm tarball 的真实布局：根包 `@mrrisega/dsh-remote` + `packages/dsh-remote-web/`。
 * 插件目录（profile 里被替换的那个）是**子包**，不是根包 —— 这一点是 2026-11-11 真机实测
 * 才确认的（根包 package.json 里 name 是 @mrrisega/dsh-remote，main 是 dsh-setup.mjs）。
 */
function packageEntries({
  version = "0.8.0",
  rootVersion = version,
  pluginVersion = version,
  rootName = PACKAGE_NAME,
  pluginName = PLUGIN_PACKAGE_NAME,
  extra = [],
} = {}) {
  return [
    { name: "package/package.json", data: JSON.stringify({ name: rootName, version: rootVersion, main: "dsh-setup.mjs" }) },
    { name: "package/dsh-setup.mjs", data: "#!/usr/bin/env node\n// setup\n" },
    {
      name: `package/${PLUGIN_SUBDIR}/package.json`,
      data: JSON.stringify({ name: pluginName, version: pluginVersion, main: "lib/index.js", type: "module" }),
    },
    {
      name: `package/${PLUGIN_SUBDIR}/lib/index.js`,
      data: `export const version = ${JSON.stringify(pluginVersion)};\n`,
    },
    { name: `package/${PLUGIN_SUBDIR}/runtime/marker.txt`, data: `${pluginVersion}\n` },
    ...extra,
  ];
}

function sha512b64(buffer) {
  return `sha512-${crypto.createHash("sha512").update(buffer).digest("base64")}`;
}

function sha1hex(buffer) {
  return crypto.createHash("sha1").update(buffer).digest("hex");
}

// ---------------------------------------------------------------------------
// 假 registry（注入 fetchImpl）
// ---------------------------------------------------------------------------

/** 最小响应替身：只要 ok/status/headers.get/json/body 齐了，模块就能跑。 */
function fakeResponse({ status = 200, jsonBody, jsonError = false, body, chunks, headers = {} }) {
  const buf = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (String(name).toLowerCase() in lower ? lower[String(name).toLowerCase()] : null) },
    async json() {
      if (jsonError) throw new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON");
      return jsonBody;
    },
    async arrayBuffer() {
      return buf;
    },
    body: chunks
      ? (async function* () {
          for (const chunk of chunks) yield Buffer.from(chunk);
        })()
      : buf
        ? (async function* () {
            yield buf;
          })()
        : null,
  };
}

/**
 * @param {object} spec
 * @param {string} spec.base
 * @param {string} [spec.version]
 * @param {object[]} [spec.entries] tarball 内容
 * @param {Buffer} [spec.tarball] 直接给 tarball 字节
 * @param {string} [spec.integrity] 覆盖（用于造"校验不符"）
 * @param {"throw"} [spec.mode] 连不上
 * @param {number} [spec.metaStatus]
 * @param {number} [spec.tarballStatus]
 * @param {number} [spec.maxBytesHint] 伪造 content-length
 */
function makeRegistry(spec) {
  const {
    base,
    version = "0.8.0",
    entries,
    tarball,
    integrity,
    mode,
    metaStatus,
    tarballStatus,
    maxBytesHint,
    tag = "latest",
    name = PACKAGE_NAME,
    rootVersion,
    pluginVersion,
    pluginName,
  } = spec;

  const buffer =
    tarball ||
    makeTgz(
      entries ||
        packageEntries({
          version,
          rootName: name,
          rootVersion: rootVersion === undefined ? undefined : rootVersion,
          pluginVersion: pluginVersion === undefined ? undefined : pluginVersion,
          pluginName: pluginName === undefined ? undefined : pluginName,
        }),
    );
  const tarballUrl = `${base}/${PACKAGE_NAME}/-/${PACKAGE_NAME.split("/")[1]}-${version}.tgz`;
  const doc = {
    name: PACKAGE_NAME,
    "dist-tags": { latest: version, [tag]: version },
    versions: {
      [version]: {
        name,
        version,
        dist: {
          tarball: tarballUrl,
          integrity: integrity === undefined ? sha512b64(buffer) : integrity,
          shasum: sha1hex(buffer),
        },
      },
    },
  };

  return {
    base,
    version,
    buffer,
    tarballUrl,
    doc,
    mode,
    metaStatus,
    tarballStatus,
    maxBytesHint,
    get url() {
      return tarballUrl;
    },
  };
}

function makeFetch(regs) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const reg = regs.find((r) => url.startsWith(`${r.base}/`));
    if (!reg) {
      const err = new TypeError(`fetch failed: 未注册的源 ${url}`);
      err.code = "ECONNREFUSED";
      throw err;
    }
    if (reg.mode === "throw") {
      const err = new TypeError(`fetch failed（connect ECONNREFUSED ${reg.base}）`);
      err.code = "ECONNREFUSED";
      throw err;
    }
    if (url === reg.tarballUrl) {
      if (reg.tarballStatus) return fakeResponse({ status: reg.tarballStatus, body: "denied" });
      const headers = {};
      if (reg.maxBytesHint) headers["content-length"] = String(reg.maxBytesHint);
      return fakeResponse({ body: reg.buffer, headers });
    }
    if (reg.metaStatus) return fakeResponse({ status: reg.metaStatus, body: JSON.stringify({ error: "Not found" }) });
    return fakeResponse({ jsonBody: reg.doc, headers: { "content-type": "application/json" } });
  };
  impl.calls = calls;
  return impl;
}

// ---------------------------------------------------------------------------
// 临时目录 / 安装夹具
// ---------------------------------------------------------------------------

function tempDir(t, prefix = "dsh-selfupdate-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 造一个"已安装"的插件目录（package.json + lib/index.js + 一个内容标记文件）。 */
function writeInstall(dir, version, { name = PLUGIN_PACKAGE_NAME } = {}) {
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version, main: "lib/index.js" }, null, 2));
  fs.writeFileSync(path.join(dir, "lib", "index.js"), `export const version = ${JSON.stringify(version)};\n`);
  fs.writeFileSync(path.join(dir, "marker.txt"), `${version}\n`);
  return dir;
}

/** 造一个"解包后的 tarball"staging：`<root>/package/…`（真实发布产物形状）。 */
function writeTarballStage(root, { version = "0.8.0", rootVersion, pluginVersion, pluginName } = {}) {
  const stageRoot = path.join(root, "package");
  const pluginDir = path.join(stageRoot, ...PLUGIN_SUBDIR.split("/"));
  writeInstall(pluginDir, pluginVersion || version, { name: pluginName || PLUGIN_PACKAGE_NAME });
  fs.writeFileSync(
    path.join(stageRoot, "package.json"),
    JSON.stringify({ name: PACKAGE_NAME, version: rootVersion || version, main: "dsh-setup.mjs" }),
  );
  fs.writeFileSync(path.join(stageRoot, "dsh-setup.mjs"), "#!/usr/bin/env node\n// setup\n");
  return stageRoot;
}

function bakDirs(root) {
  return fs.readdirSync(root).filter((n) => n.includes(".bak-") || n.includes(".failed-"));
}

const FIXED_REGISTRIES = [REG_A, REG_B];
const ONLY_A = [REG_A];

// ---------------------------------------------------------------------------
// 用例：registry 顺序
// ---------------------------------------------------------------------------

test("resolveRegistryOrder：默认 npmmirror 优先、官方源兜底", () => {
  assert.deepEqual(resolveRegistryOrder({}), [...DEFAULT_REGISTRIES]);
  assert.deepEqual(resolveRegistryOrder({}), [REG_A, REG_B]);
  // 空串 / 空白 / 全是非法值 → 回落默认，而不是"一个源都没有"
  assert.deepEqual(resolveRegistryOrder({ DSH_REMOTE_REGISTRY: "   " }), [REG_A, REG_B]);
  assert.deepEqual(resolveRegistryOrder({ DSH_REMOTE_REGISTRY: "ftp://x,file:///y" }), [REG_A, REG_B]);
});

test("resolveRegistryOrder：DSH_REMOTE_REGISTRY 逗号覆盖（去空格/去尾斜杠/去重保序）", () => {
  const env = { DSH_REMOTE_REGISTRY: ` https://r.example.com/ , https://registry.npmjs.org , https://r.example.com ` };
  assert.deepEqual(resolveRegistryOrder(env), ["https://r.example.com", REG_B]);
  assert.deepEqual(resolveRegistryOrder({ DSH_REMOTE_REGISTRY: "https://only.example" }), ["https://only.example"]);
});

// ---------------------------------------------------------------------------
// 用例：正常下载解包
// ---------------------------------------------------------------------------

test("正常：latest 从首个源下载 → integrity 校验 → 解包到 <stageDir>/package/", async (t) => {
  const dir = tempDir(t);
  const stageDir = path.join(dir, "stage");
  const regA = makeRegistry({ base: REG_A, version: "0.8.0" });
  const fetchImpl = makeFetch([regA]);

  const res = await fetchTarballToStaging({ tag: "latest", stageDir, registries: ONLY_A, fetchImpl });

  assert.equal(res.ok, true);
  assert.equal(res.version, "0.8.0");
  assert.equal(res.registry, REG_A);
  assert.equal(res.stageRoot, path.join(stageDir, "package"));
  assert.equal(res.bytes, regA.buffer.length);
  assert.ok(res.ms >= 0);
  assert.equal(res.integrity.checked, true);
  assert.equal(res.integrity.algo, "sha512");
  assert.equal(res.attempts.length, 1);
  assert.deepEqual(res.attempts[0].ok, true);

  // 真的落到磁盘了：根包在 stageRoot，插件包在 payloadRoot（会被 apply 装走的那层）
  const rootPkg = JSON.parse(fs.readFileSync(path.join(res.stageRoot, "package.json"), "utf8"));
  assert.equal(rootPkg.name, PACKAGE_NAME);
  assert.equal(rootPkg.version, "0.8.0");
  assert.equal(res.payloadRoot, path.join(res.stageRoot, ...PLUGIN_SUBDIR.split("/")));
  const pluginPkg = JSON.parse(fs.readFileSync(path.join(res.payloadRoot, "package.json"), "utf8"));
  assert.equal(pluginPkg.name, PLUGIN_PACKAGE_NAME);
  assert.equal(pluginPkg.version, "0.8.0");
  assert.ok(fs.existsSync(path.join(res.payloadRoot, "lib", "index.js")));
  assert.ok(fs.existsSync(path.join(res.stageRoot, "dsh-setup.mjs")));
  assert.ok(res.files >= 5);
  // 只请求了两条 URL：packument（作用域名按 npm 规范编码）+ tarball
  assert.deepEqual(fetchImpl.calls, [
    `${REG_A}/@mrrisega%2fdsh-remote/latest`,
    regA.tarballUrl,
  ]);
});

test("tag=beta 走 dist-tags.beta，精确 version 也接受", async (t) => {
  const dir = tempDir(t);
  const reg = makeRegistry({ base: REG_A, version: "0.7.12-beta.3", tag: "beta" });
  const fetchImpl = makeFetch([reg]);

  const byTag = await fetchTarballToStaging({
    tag: "beta",
    stageDir: path.join(dir, "a"),
    registries: ONLY_A,
    fetchImpl,
  });
  assert.equal(byTag.version, "0.7.12-beta.3");
  assert.equal(byTag.requested, "beta");

  const byVersion = await fetchTarballToStaging({
    version: "0.7.12-beta.3",
    stageDir: path.join(dir, "b"),
    registries: ONLY_A,
    fetchImpl,
  });
  assert.equal(byVersion.version, "0.7.12-beta.3");
  assert.equal(byVersion.requested, "0.7.12-beta.3");

  // 显式 version 优先于 tag（面板会带着默认 tag="latest" 传用户选的版本）
  const preferVersion = await fetchTarballToStaging({
    version: "0.7.12-beta.3",
    tag: "latest",
    stageDir: path.join(dir, "c"),
    registries: ONLY_A,
    fetchImpl,
  });
  assert.equal(preferVersion.version, "0.7.12-beta.3");
  assert.equal(preferVersion.requested, "0.7.12-beta.3");
});

// ---------------------------------------------------------------------------
// 用例：源回退 / 全失败 / HTTP 状态
// ---------------------------------------------------------------------------

test("registry 回退：npmmirror 连不上 → 自动换 npmjs，并在 attempts 里留证据", async (t) => {
  const dir = tempDir(t);
  const stageDir = path.join(dir, "stage");
  const dead = makeRegistry({ base: REG_A, mode: "throw" });
  const alive = makeRegistry({ base: REG_B, version: "0.8.0" });
  const fetchImpl = makeFetch([dead, alive]);

  const res = await fetchTarballToStaging({ tag: "latest", stageDir, registries: FIXED_REGISTRIES, fetchImpl });

  assert.equal(res.ok, true);
  assert.equal(res.registry, REG_B);
  assert.equal(res.attempts.length, 2);
  assert.equal(res.attempts[0].registry, REG_A);
  assert.equal(res.attempts[0].ok, false);
  assert.equal(res.attempts[0].code, ERROR_CODES.REGISTRY_UNREACHABLE);
  assert.equal(res.attempts[1].ok, true);
  assert.ok(res.attempts[0].ms >= 0 && res.attempts[1].ms >= 0);
  // staging 只保留最终成功的那个包（换源前会清空）
  assert.equal(JSON.parse(fs.readFileSync(path.join(stageDir, "package", "package.json"), "utf8")).version, "0.8.0");
});

test("全部源失败：抛 REGISTRY_UNREACHABLE，带逐个源的 attempts 与耗时", async (t) => {
  const dir = tempDir(t);
  const fetchImpl = makeFetch([
    makeRegistry({ base: REG_A, mode: "throw" }),
    makeRegistry({ base: REG_B, mode: "throw" }),
  ]);

  await assert.rejects(
    () => fetchTarballToStaging({ tag: "latest", stageDir: path.join(dir, "stage"), registries: FIXED_REGISTRIES, fetchImpl }),
    (err) => {
      assert.equal(err.code, ERROR_CODES.REGISTRY_UNREACHABLE);
      assert.equal(err.attempts.length, 2);
      assert.ok(err.attempts.every((a) => a.ok === false));
      assert.ok(err.attempts.every((a) => typeof a.error === "string" && a.error.includes(ERROR_CODES.REGISTRY_UNREACHABLE)));
      return true;
    },
  );
});

test("源返回 404 → 稳定错误码 HTTP_404（可据此区分「包不存在」与「连不上」）", async (t) => {
  const dir = tempDir(t);
  const fetchImpl = makeFetch([makeRegistry({ base: REG_A, metaStatus: 404 })]);

  await assert.rejects(
    () => fetchTarballToStaging({ version: "9.9.9", stageDir: path.join(dir, "stage"), registries: [REG_A], fetchImpl }),
    (err) => err.code === "HTTP_404" && err.status === 404,
  );
});

test("tarball 下载 500 → HTTP_500，且会去试下一个源", async (t) => {
  const dir = tempDir(t);
  const bad = makeRegistry({ base: REG_A, tarballStatus: 500 });
  const good = makeRegistry({ base: REG_B });
  const fetchImpl = makeFetch([bad, good]);

  const res = await fetchTarballToStaging({
    tag: "latest",
    stageDir: path.join(dir, "stage"),
    registries: FIXED_REGISTRIES,
    fetchImpl,
  });
  assert.equal(res.registry, REG_B);
  assert.equal(res.attempts[0].code, "HTTP_500");
});

// ---------------------------------------------------------------------------
// 用例：三关校验（integrity / 版本 / 包名）
// ---------------------------------------------------------------------------

test("integrity 不符：拒绝且不落盘（staging 被清空）", async (t) => {
  const dir = tempDir(t);
  const stageDir = path.join(dir, "stage");
  const reg = makeRegistry({ base: REG_A, integrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}` });
  const fetchImpl = makeFetch([reg]);

  await assert.rejects(
    () => fetchTarballToStaging({ tag: "latest", stageDir, registries: ONLY_A, fetchImpl }),
    (err) => {
      assert.equal(err.code, ERROR_CODES.INTEGRITY_MISMATCH);
      assert.equal(err.algo, "sha512");
      assert.equal(err.attempts.length, 1);
      return true;
    },
  );
  assert.equal(fs.existsSync(stageDir), false, "校验失败的包不能留在 staging 里");
});

test("版本不符：根包或插件包的 version 与源解析出的版本不一致 → VERSION_MISMATCH", async (t) => {
  const dir = tempDir(t);
  // 源声称 0.8.0，根包里却写 0.9.0（镜像错版/投毒都会长这样）
  const badRoot = makeRegistry({ base: REG_A, version: "0.8.0", entries: packageEntries({ version: "0.9.0" }) });
  await assert.rejects(
    () =>
      fetchTarballToStaging({
        tag: "latest",
        stageDir: path.join(dir, "root"),
        registries: ONLY_A,
        fetchImpl: makeFetch([badRoot]),
      }),
    (err) => {
      assert.equal(err.code, ERROR_CODES.VERSION_MISMATCH);
      assert.equal(err.expected, "0.8.0");
      assert.equal(err.actual, "0.9.0");
      return true;
    },
  );
  assert.equal(fs.existsSync(path.join(dir, "root")), false);

  // 根包对、插件包版本不对（发布脚本漏改子包版本）→ 一样拒绝
  const badPlugin = makeRegistry({
    base: REG_A,
    version: "0.8.0",
    entries: packageEntries({ version: "0.8.0", pluginVersion: "0.9.0" }),
  });
  await assert.rejects(
    () =>
      fetchTarballToStaging({
        tag: "latest",
        stageDir: path.join(dir, "plugin"),
        registries: ONLY_A,
        fetchImpl: makeFetch([badPlugin]),
      }),
    (err) => err.code === ERROR_CODES.VERSION_MISMATCH && err.actual === "0.9.0",
  );
});

test("name 不符：根包名不对 / 插件包名不对 都拒绝", async (t) => {
  const dir = tempDir(t);
  const evilRoot = makeRegistry({ base: REG_A, entries: packageEntries({ version: "0.8.0", rootName: "evil-package" }) });
  await assert.rejects(
    () =>
      fetchTarballToStaging({
        tag: "latest",
        stageDir: path.join(dir, "root"),
        registries: ONLY_A,
        fetchImpl: makeFetch([evilRoot]),
      }),
    (err) => err.code === ERROR_CODES.NAME_MISMATCH && err.actual === "evil-package",
  );

  const evilPlugin = makeRegistry({
    base: REG_A,
    entries: packageEntries({ version: "0.8.0", pluginName: "evil-plugin" }),
  });
  await assert.rejects(
    () =>
      fetchTarballToStaging({
        tag: "latest",
        stageDir: path.join(dir, "plugin"),
        registries: ONLY_A,
        fetchImpl: makeFetch([evilPlugin]),
      }),
    (err) => err.code === ERROR_CODES.NAME_MISMATCH && err.actual === "evil-plugin",
  );
});

test("resolveStagePayload：根包自动定位子包；两层都不匹配才抛 NAME_MISMATCH", (t) => {
  const root = tempDir(t);
  const stageRoot = writeTarballStage(root, { version: "0.8.0" });
  assert.equal(resolveStagePayload({ stageRoot }), path.join(stageRoot, ...PLUGIN_SUBDIR.split("/")));

  const payloadOnly = writeInstall(path.join(root, "payload"), "0.8.0");
  assert.equal(resolveStagePayload({ stageRoot: payloadOnly }), payloadOnly);

  const alien = writeInstall(path.join(root, "alien"), "0.8.0", { name: "not-ours" });
  assert.throws(
    () => resolveStagePayload({ stageRoot: alien }),
    (err) => err.code === ERROR_CODES.NAME_MISMATCH && err.actual === "not-ours",
  );
});

// ---------------------------------------------------------------------------
// 用例：tar 安全
// ---------------------------------------------------------------------------

test("路径穿越（../）被拒绝：BAD_TARBALL / detail=traversal，目标目录外无文件", async (t) => {
  const dir = tempDir(t);
  const stageDir = path.join(dir, "stage");
  const reg = makeRegistry({
    base: REG_A,
    entries: [
      ...packageEntries({ version: "0.8.0" }),
      { name: "package/../../evil.txt", data: "pwned\n" },
    ],
  });
  const fetchImpl = makeFetch([reg]);

  await assert.rejects(
    () => fetchTarballToStaging({ tag: "latest", stageDir, registries: ONLY_A, fetchImpl }),
    (err) => err.code === ERROR_CODES.BAD_TARBALL && err.detail === "traversal",
  );
  assert.equal(fs.existsSync(path.join(dir, "evil.txt")), false);
  assert.equal(fs.existsSync(path.join(path.dirname(dir), "evil.txt")), false);
});

test("绝对路径条目被拒绝（BAD_TARBALL）", async (t) => {
  const dir = tempDir(t);
  const reg = makeRegistry({
    base: REG_A,
    entries: [...packageEntries({ version: "0.8.0" }), { name: "/tmp/evil-abs.txt", data: "pwned\n" }],
  });
  await assert.rejects(
    () =>
      fetchTarballToStaging({
        tag: "latest",
        stageDir: path.join(dir, "stage"),
        registries: ONLY_A,
        fetchImpl: makeFetch([reg]),
      }),
    (err) => err.code === ERROR_CODES.BAD_TARBALL,
  );
  assert.equal(fs.existsSync("/tmp/evil-abs.txt"), false);
});

test("符号链接 / 硬链接条目被拒绝（BAD_TARBALL / detail=unsafe_entry）", async (t) => {
  const dir = tempDir(t);
  const fetchImpl = makeFetch([
    makeRegistry({
      base: REG_A,
      entries: [
        ...packageEntries({ version: "0.8.0" }),
        { name: "package/link-to-etc", type: "2", linkname: "/etc/passwd" },
      ],
    }),
  ]);
  await assert.rejects(
    () => fetchTarballToStaging({ tag: "latest", stageDir: path.join(dir, "a"), registries: ONLY_A, fetchImpl }),
    (err) => err.code === ERROR_CODES.BAD_TARBALL && err.detail === "unsafe_entry",
  );

  const hardlinkFetch = makeFetch([
    makeRegistry({
      base: REG_A,
      entries: [
        ...packageEntries({ version: "0.8.0" }),
        { name: "package/hard", type: "1", linkname: "package/lib/index.js" },
      ],
    }),
  ]);
  await assert.rejects(
    () =>
      fetchTarballToStaging({
        tag: "latest",
        stageDir: path.join(dir, "b"),
        registries: ONLY_A,
        fetchImpl: hardlinkFetch,
      }),
    (err) => err.code === ERROR_CODES.BAD_TARBALL && err.detail === "unsafe_entry",
  );
});

test("布局异常（文件不在 package/ 下）被拒绝，不会写到 staging 根目录", async (t) => {
  const dir = tempDir(t);
  const fetchImpl = makeFetch([
    makeRegistry({ base: REG_A, entries: [{ name: "package.json", data: JSON.stringify({ name: PACKAGE_NAME, version: "0.8.0" }) }] }),
  ]);
  await assert.rejects(
    () =>
      fetchTarballToStaging({
        tag: "latest",
        stageDir: path.join(dir, "stage"),
        registries: ONLY_A,
        fetchImpl,
      }),
    (err) => err.code === ERROR_CODES.BAD_TARBALL && err.detail === "bad_layout",
  );
});

test("下载超过大小上限 → TARBALL_TOO_BIG（看 content-length 就先失败）", async (t) => {
  const dir = tempDir(t);
  const fetchImpl = makeFetch([makeRegistry({ base: REG_A, maxBytesHint: 8 * 1024 * 1024 })]);
  await assert.rejects(
    () =>
      fetchTarballToStaging({
        tag: "latest",
        stageDir: path.join(dir, "stage"),
        registries: ONLY_A,
        fetchImpl,
        maxBytes: 1024,
      }),
    (err) => err.code === ERROR_CODES.TARBALL_TOO_BIG && err.bytes === 8 * 1024 * 1024,
  );
});

// ---------------------------------------------------------------------------
// 用例：apply 原子性 / 幂等 / 回滚
// ---------------------------------------------------------------------------

test("apply 正常：从根包 staging 自动取子包 → 旧目录变 backup、新版本就位", (t) => {
  const root = tempDir(t);
  const target = writeInstall(path.join(root, "plugin"), "0.7.0");
  // 真实形状：stageRoot 是根包解出来的 package/，插件在 packages/dsh-remote-web/
  const stageRoot = writeTarballStage(path.join(root, "stage"), { version: "0.8.0" });

  const res = applyStagedToProfile({ stageRoot, targetDir: target });

  assert.equal(res.ok, true);
  assert.equal(res.applied, true);
  assert.equal(res.fromVersion, "0.7.0");
  assert.equal(res.toVersion, "0.8.0");
  assert.equal(res.payloadRoot, path.join(stageRoot, ...PLUGIN_SUBDIR.split("/")));
  assert.equal(readInstalled({ targetDir: target }).name, PLUGIN_PACKAGE_NAME);
  assert.ok(res.backupDir && fs.existsSync(res.backupDir));
  assert.equal(readInstalled({ targetDir: res.backupDir }).version, "0.7.0");
  assert.equal(readInstalled({ targetDir: target }).version, "0.8.0");
  assert.equal(fs.readFileSync(path.join(target, "marker.txt"), "utf8").trim(), "0.8.0");
  assert.equal(verifyInstalled({ targetDir: target, expectedVersion: "0.8.0" }).version, "0.8.0");
  // 只有插件子目录被搬走，根包其它内容留在 staging（不会被塞进 profile）
  assert.equal(fs.existsSync(res.payloadRoot), false);
  assert.ok(fs.existsSync(path.join(stageRoot, "dsh-setup.mjs")));
});

test("apply 原子性：stage → target 的 rename 失败 → 自动回滚，目标保持原样", (t) => {
  const root = tempDir(t);
  const target = writeInstall(path.join(root, "plugin"), "0.7.0");
  const stageRoot = writeInstall(path.join(root, "stage", "package"), "0.8.0");
  const before = fs.readdirSync(target).sort();

  // 只让「stage → target」这一步失败（模拟权限/占用），其余 rename 走真实 fs
  const failingFs = Object.create(fs);
  failingFs.renameSync = (from, to) => {
    if (path.resolve(from) === path.resolve(stageRoot)) {
      const err = new Error(`EACCES: permission denied, rename '${from}' -> '${to}'`);
      err.code = "EACCES";
      throw err;
    }
    return fs.renameSync(from, to);
  };

  let failure = null;
  try {
    applyStagedToProfile({ stageRoot, targetDir: target, fsImpl: failingFs });
    assert.fail("apply 应该失败");
  } catch (err) {
    failure = err;
  }

  assert.equal(failure.code, ERROR_CODES.APPLY_FAILED);
  assert.equal(failure.rollback.ok, true, `回滚必须成功：${JSON.stringify(failure.rollback)}`);
  assert.equal(failure.rollback.restored, true);
  // 目标目录：内容、版本、文件清单都与升级前一致
  assert.equal(readInstalled({ targetDir: target }).version, "0.7.0");
  assert.equal(fs.readFileSync(path.join(target, "marker.txt"), "utf8").trim(), "0.7.0");
  assert.deepEqual(fs.readdirSync(target).sort(), before);
  // 没有留下 bak-* / failed-* 垃圾
  assert.deepEqual(bakDirs(root), []);
});

test("TARGET_BUSY：旧目录被占用时不动磁盘（不能把用户装好的目录删了）", (t) => {
  const root = tempDir(t);
  const target = writeInstall(path.join(root, "plugin"), "0.7.0");
  const stageRoot = writeInstall(path.join(root, "stage", "package"), "0.8.0");

  const busyFs = Object.create(fs);
  busyFs.renameSync = (from, to) => {
    if (path.resolve(from) === path.resolve(target)) {
      const err = new Error("EBUSY: resource busy or locked");
      err.code = "EBUSY";
      throw err;
    }
    return fs.renameSync(from, to);
  };

  assert.throws(
    () => applyStagedToProfile({ stageRoot, targetDir: target, fsImpl: busyFs }),
    (err) => err.code === ERROR_CODES.TARGET_BUSY && err.rollback.restored === true,
  );

  assert.equal(fs.existsSync(target), true, "目标目录不能被删");
  assert.equal(readInstalled({ targetDir: target }).version, "0.7.0");
  assert.equal(fs.readFileSync(path.join(target, "marker.txt"), "utf8").trim(), "0.7.0");
  assert.deepEqual(bakDirs(root), []);
});

test("同版本幂等：已装 0.8.0 再 apply 0.8.0 → noop，不动磁盘、不造 bak", (t) => {
  const root = tempDir(t);
  const target = writeInstall(path.join(root, "plugin"), "0.8.0");
  const stageRoot = writeInstall(path.join(root, "stage", "package"), "0.8.0");
  const markerBefore = fs.readFileSync(path.join(target, "marker.txt"), "utf8");
  const inoBefore = fs.statSync(target).ino;

  const res = applyStagedToProfile({ stageRoot, targetDir: target });

  assert.equal(res.ok, true);
  assert.equal(res.applied, false);
  assert.equal(res.noop, true);
  assert.equal(res.fromVersion, "0.8.0");
  assert.equal(res.backupDir, null);
  assert.equal(fs.existsSync(stageRoot), true, "noop 不该消费 staging");
  assert.equal(fs.readFileSync(path.join(target, "marker.txt"), "utf8"), markerBefore);
  assert.equal(fs.statSync(target).ino, inoBefore, "noop 不该替换目录 inode");
  assert.deepEqual(bakDirs(root), []);

  // force=true 才真的重装
  const forced = applyStagedToProfile({ stageRoot, targetDir: target, force: true });
  assert.equal(forced.applied, true);
  assert.equal(forced.fromVersion, "0.8.0");
  assert.ok(forced.backupDir);
});

test("apply 校验：stage 的 name/version 不符时直接拒绝（不碰目标目录）", (t) => {
  const root = tempDir(t);
  const target = writeInstall(path.join(root, "plugin"), "0.7.0");
  const badName = writeInstall(path.join(root, "bad-name", "package"), "0.8.0", { name: "evil-package" });
  const badVersion = writeInstall(path.join(root, "bad-version", "package"), "0.8.1");

  assert.throws(
    () => applyStagedToProfile({ stageRoot: badName, targetDir: target }),
    (err) => err.code === ERROR_CODES.NAME_MISMATCH,
  );
  assert.throws(
    () => applyStagedToProfile({ stageRoot: badVersion, targetDir: target, expectedVersion: "0.8.0" }),
    (err) => err.code === ERROR_CODES.VERSION_MISMATCH,
  );
  assert.equal(readInstalled({ targetDir: target }).version, "0.7.0");
  assert.deepEqual(bakDirs(root), []);
});

test("keepBackup=false：成功后不保留 bak", (t) => {
  const root = tempDir(t);
  const target = writeInstall(path.join(root, "plugin"), "0.7.0");
  const stageRoot = writeInstall(path.join(root, "stage", "package"), "0.8.0");

  const res = applyStagedToProfile({ stageRoot, targetDir: target, keepBackup: false });
  assert.equal(res.applied, true);
  assert.equal(res.backupDir, null);
  assert.deepEqual(bakDirs(root), []);
  assert.equal(readInstalled({ targetDir: target }).version, "0.8.0");
});

test("rollback：用 bak 还原旧版本，新版本挪到 .failed-* 留证", (t) => {
  const root = tempDir(t);
  const target = writeInstall(path.join(root, "plugin"), "0.7.0");
  const stageRoot = writeInstall(path.join(root, "stage", "package"), "0.8.0");

  const applied = applyStagedToProfile({ stageRoot, targetDir: target });
  assert.equal(readInstalled({ targetDir: target }).version, "0.8.0");

  const rb = rollback({ backupDir: applied.backupDir, targetDir: target });

  assert.equal(rb.ok, true);
  assert.equal(rb.restored, true);
  assert.equal(rb.version, "0.7.0");
  assert.equal(readInstalled({ targetDir: target }).version, "0.7.0");
  assert.equal(fs.readFileSync(path.join(target, "marker.txt"), "utf8").trim(), "0.7.0");
  assert.ok(rb.movedAside && fs.existsSync(rb.movedAside));
  assert.equal(readInstalled({ targetDir: rb.movedAside }).version, "0.8.0");
  // 备份被消费掉（rename 走），不会出现"还原了但 bak 还占着"的歧义
  assert.equal(fs.existsSync(rb.consumedBackup), false);
});

test("rollback 失败路径：备份不存在 → ROLLBACK_FAILED（不误删当前版本）", (t) => {
  const root = tempDir(t);
  const target = writeInstall(path.join(root, "plugin"), "0.8.0");
  assert.throws(
    () => rollback({ backupDir: path.join(root, "nope.bak-1"), targetDir: target }),
    (err) => err.code === ERROR_CODES.ROLLBACK_FAILED && err.detail === "no_backup",
  );
  assert.equal(readInstalled({ targetDir: target }).version, "0.8.0");
});

// ---------------------------------------------------------------------------
// 用例：verifyInstalled / readInstalled
// ---------------------------------------------------------------------------

test("verifyInstalled：未安装 / 版本不符 / 包名不符 各自报对应错误码", (t) => {
  const root = tempDir(t);
  const empty = path.join(root, "empty");
  fs.mkdirSync(empty, { recursive: true });

  assert.throws(() => verifyInstalled({ targetDir: empty }), (err) => err.code === ERROR_CODES.NOT_INSTALLED);
  assert.throws(
    () => verifyInstalled({ targetDir: path.join(root, "missing") }),
    (err) => err.code === ERROR_CODES.NOT_INSTALLED,
  );

  const target = writeInstall(path.join(root, "plugin"), "0.8.0");
  assert.equal(verifyInstalled({ targetDir: target }).version, "0.8.0");
  assert.throws(
    () => verifyInstalled({ targetDir: target, expectedVersion: "0.8.1" }),
    (err) => err.code === ERROR_CODES.VERSION_MISMATCH,
  );

  const wrongName = writeInstall(path.join(root, "other"), "0.8.0", { name: "other-pkg" });
  assert.throws(
    () => verifyInstalled({ targetDir: wrongName }),
    (err) => err.code === ERROR_CODES.NAME_MISMATCH,
  );

  const info = readInstalled({ targetDir: target });
  assert.equal(info.installed, true);
  assert.equal(info.version, "0.8.0");
  assert.equal(readInstalled({ targetDir: empty }).installed, false);
});

// ---------------------------------------------------------------------------
// 用例：一次完整的"下载 → 校验 → apply"
// ---------------------------------------------------------------------------

test("端到端（注入 fetch）：npmmirror 下载 0.8.0 → apply 到 0.7.0 的目录 → verify", async (t) => {
  const root = tempDir(t);
  const target = writeInstall(path.join(root, "plugin"), "0.7.0");
  const stageDir = path.join(root, "stage");
  const reg = makeRegistry({ base: REG_A, version: "0.8.0" });
  const fetchImpl = makeFetch([reg]);

  const dl = await fetchTarballToStaging({ tag: "latest", stageDir, registries: ONLY_A, fetchImpl });
  const applied = applyStagedToProfile({ stageRoot: dl.stageRoot, targetDir: target });

  assert.equal(applied.fromVersion, "0.7.0");
  assert.equal(applied.toVersion, "0.8.0");
  assert.equal(applied.payloadRoot, dl.payloadRoot);
  assert.equal(verifyInstalled({ targetDir: target, expectedVersion: dl.version }).version, "0.8.0");
  // 新版本自带的文件确实在（lib/index.js 里的 version 常量已是新的）
  assert.match(fs.readFileSync(path.join(target, "lib", "index.js"), "utf8"), /0\.8\.0/);
});
