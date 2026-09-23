/**
 * 零依赖 tarball 更新通道的回归测试（node:test，零框架）。
 *
 * 背景（真实事故，见 lib/tarball-update.js 顶部注释）：
 *   Windows 上「一键更新」走的 `npx` 在 Node ≥20.12 起同步 EINVAL，0.6.6 及更早的升级通道
 *   本身是坏的 —— 79 台点过一键更新的 Windows 机器全部 update_failed，且产品内无出路。
 *   本文件就是给替代通道（HTTPS 取 tarball → 内置 zlib + 自解析 tar 落 staging）上锁：
 *   解包正确性、长路径、**路径穿越必须被拒**、链接条目必须跳过、registry URL 编码、
 *   以及 stagePackage 端到端（主包 + ws 依赖都要落地）。
 *
 * ⚠️ 绝不联网：仓库用 scripts/test-net-guard.cjs 拦外部请求（见 package.json 的 test 脚本），
 *   所以这里所有 HTTP 都发生在**注入的假 fetchImpl** 上：registry 元数据与 tarball 都由
 *   本文件用 zlib.gzipSync + 手写最小 tar 打包函数现场构造。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import {
  DEFAULT_REGISTRY,
  extractTarGz,
  parseSpec,
  readTarEntries,
  resolveVersion,
  downloadTarball,
  stagePackage,
} from "../lib/tarball-update.js";

// ---------------------------------------------------------------------------
// 最小 tar 打包器（测试自备，避免为了造测试数据引第三方包）
// ---------------------------------------------------------------------------

const BLOCK = 512;

function octal(value, len) {
  return value.toString(8).padStart(len - 1, "0") + "\0";
}

function headerBlock({ name = "", size = 0, type = "0", prefix = "", linkname = "" }) {
  const b = Buffer.alloc(BLOCK);
  b.write(name.slice(0, 100), 0, 100, "latin1");
  b.write(octal(0o644, 8), 100, 8, "latin1");   // mode
  b.write(octal(0, 8), 108, 8, "latin1");       // uid
  b.write(octal(0, 8), 116, 8, "latin1");       // gid
  b.write(octal(size, 12), 124, 12, "latin1");  // size
  b.write(octal(0, 12), 136, 12, "latin1");     // mtime
  b.fill(0x20, 148, 156);                       // chksum 先填空格
  b.write(type, 156, 1, "latin1");
  if (linkname) b.write(linkname.slice(0, 100), 157, 100, "latin1");
  b.write("ustar", 257, 5, "latin1");           // magic "ustar\0"
  b.write("00", 263, 2, "latin1");              // version
  if (prefix) b.write(prefix.slice(0, 155), 345, 155, "latin1");
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "latin1"); // 6 位八进制 + NUL + 空格
  return b;
}

function padToBlock(buf) {
  const rem = buf.length % BLOCK;
  return rem ? Buffer.concat([buf, Buffer.alloc(BLOCK - rem)]) : buf;
}

/** PaxHeader 记录：`LEN key=value\n`，LEN 含自身位数（迭代到自洽）。 */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  return `${len}${body}`;
}

/**
 * 打包成裸 tar。
 * 条目：{ name, data?, type?, prefix?, longName?, paxPath? }
 *   · prefix  → ustar 的 prefix 字段（长路径写法之一）
 *   · longName → GNU long name（typeflag L）
 *   · paxPath  → PaxHeader（typeflag x，path= 记录）
 */
function makeTar(entries) {
  const parts = [];
  for (const e of entries) {
    const data = e.data === undefined ? Buffer.alloc(0) : Buffer.from(e.data);
    const size = e.size === undefined ? data.length : e.size;
    const type = e.type || "0";

    if (e.longName) {
      const nameBuf = Buffer.from(`${e.longName}\0`, "utf8");
      parts.push(headerBlock({ name: "././@LongLink", size: nameBuf.length, type: "L" }), padToBlock(nameBuf));
      parts.push(headerBlock({ name: e.name, size, type }));
    } else if (e.paxPath) {
      const rec = Buffer.from(paxRecord("path", e.paxPath), "utf8");
      parts.push(headerBlock({ name: "PaxHeader/entry", size: rec.length, type: "x" }), padToBlock(rec));
      parts.push(headerBlock({ name: e.name, size, type }));
    } else {
      parts.push(headerBlock({ name: e.name, size, type, prefix: e.prefix || "", linkname: e.linkname || "" }));
    }
    if (size) parts.push(padToBlock(data));
  }
  parts.push(Buffer.alloc(BLOCK * 2)); // 结束标记
  return Buffer.concat(parts);
}

const makeTgz = (entries) => zlib.gzipSync(makeTar(entries));

async function tmpDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-tarball-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** 假 fetch：routes 的 key 是完整 URL；值是 { json } 或 { tgz } 或 { status }。 */
function makeFetch(routes, log = []) {
  return async (url) => {
    log.push(String(url));
    const r = routes[String(url)];
    if (!r) return new Response("not found", { status: 404 });
    if (r.status && r.status !== 200) return new Response(r.body || "error", { status: r.status });
    if (r.json) {
      return new Response(JSON.stringify(r.json), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(r.tgz, { status: 200, headers: { "content-type": "application/octet-stream" } });
  };
}

// ---------------------------------------------------------------------------
// 解包
// ---------------------------------------------------------------------------

test("解包：目录/文件/嵌套路径 + stripPrefix 生效 + 返回文件数", async (t) => {
  const root = await tmpDir(t);
  const dest = path.join(root, "staging");
  const tgz = makeTgz([
    { name: "package/", type: "5" },
    { name: "package/README.md", data: "# hello" },
    { name: "package/lib/", type: "5" },
    { name: "package/lib/a.js", data: "export const a = 1;\n" },
    { name: "package/lib/nested/deep/b.mjs", data: "export const b = 2;\n" },
  ]);

  const files = extractTarGz(tgz, dest);
  assert.equal(files, 3, "返回写出的普通文件数（目录不计）");
  assert.equal(await readFile(path.join(dest, "README.md"), "utf8"), "# hello");
  assert.equal(await readFile(path.join(dest, "lib", "a.js"), "utf8"), "export const a = 1;\n");
  assert.equal(await readFile(path.join(dest, "lib", "nested", "deep", "b.mjs"), "utf8"), "export const b = 2;\n");
  assert.ok(!existsSync(path.join(dest, "package")), "默认 stripPrefix='package' 必须把顶层目录去掉");

  // 诊断用 readTarEntries：条目名是原始（未 strip）的
  const listed = readTarEntries(tgz);
  assert.deepEqual(listed.find((e) => e.name === "package/lib/a.js"), { name: "package/lib/a.js", size: 20, type: "0" });
  assert.equal(listed.filter((e) => e.type === "5").length, 2);
});

test("解包：stripPrefix: '' 保留顶层目录", async (t) => {
  const root = await tmpDir(t);
  const dest = path.join(root, "keep");
  const files = extractTarGz(makeTgz([{ name: "package/keep.txt", data: "keep" }]), dest, { stripPrefix: "" });
  assert.equal(files, 1);
  assert.equal(await readFile(path.join(dest, "package", "keep.txt"), "utf8"), "keep");
});

test("解包：超长路径（>100 字符）走 ustar prefix 与 GNU long name 都能正确落盘", async (t) => {
  const root = await tmpDir(t);
  const dest = path.join(root, "long");

  // ① ustar prefix：prefix + "/" + name 合起来远超 100 字符
  const longDir = "a".repeat(90);
  const fileName = `${"b".repeat(60)}.js`;
  const fullName = `package/${longDir}/${fileName}`;
  assert.ok(fullName.length > 100, "构造的路径必须超过 100 字符才叫长路径");
  const viaPrefix = makeTgz([{ name: fileName, prefix: `package/${longDir}` }].map((e) => ({ ...e, data: "via-prefix" })));

  // ② GNU long name（typeflag L）
  const segs = Array.from({ length: 12 }, (_, i) => `seg${String(i).padStart(2, "0")}${"x".repeat(6)}`);
  const gnuName = `package/${segs.join("/")}/long.txt`;
  assert.ok(gnuName.length > 100, "GNU long name 用例的路径必须超过 100 字符");
  const viaGnu = makeTgz([
    { longName: gnuName, name: `${gnuName.slice(0, 90)} (truncated)`, data: "via-gnu" },
  ]);

  // ③ PaxHeader（typeflag x，path= 记录）—— 另起一个目录，避免与上面同名
  const paxName = `package/pax/${segs.join("/")}/pax.txt`;
  const viaPax = makeTgz([{ paxPath: paxName, name: "package/pax/placeholder.txt", data: "via-pax" }]);

  extractTarGz(viaPrefix, path.join(dest, "prefix"));
  extractTarGz(viaGnu, path.join(dest, "gnu"));
  extractTarGz(viaPax, path.join(dest, "pax"));

  assert.equal(await readFile(path.join(dest, "prefix", longDir, fileName), "utf8"), "via-prefix");
  assert.equal(await readFile(path.join(dest, "gnu", ...segs, "long.txt"), "utf8"), "via-gnu");
  assert.equal(await readFile(path.join(dest, "pax", "pax", ...segs, "pax.txt"), "utf8"), "via-pax");

  // 解析出的条目名也要是完整长名（不是头里被截断的 100 字符）
  assert.equal(readTarEntries(viaGnu)[0].name, gnuName);
  assert.equal(readTarEntries(viaPax)[0].name, paxName);
});

test("安全红线：路径穿越条目被拒，且目录外不落任何文件", async (t) => {
  const root = await tmpDir(t);
  const evil = [
    { name: "../evil.txt", data: "pwn" },            // 相对穿越
    { name: "package/../../evil.txt", data: "pwn" }, // 带合法前缀的穿越
    { name: "/abs-evil.txt", data: "pwn" },          // 绝对路径
  ];

  for (const entry of evil) {
    const dest = path.join(root, `st-${evil.indexOf(entry)}`);
    assert.throws(
      () => extractTarGz(makeTgz([entry]), dest),
      (err) => err.code === "ETRAVERSAL" && /路径穿越/.test(err.message),
      `条目 ${entry.name} 必须被拒绝`,
    );
    assert.ok(!existsSync(path.join(root, "evil.txt")), "绝不能写出 destDir 之外的文件");
    assert.ok(!existsSync("/abs-evil.txt"), "绝不能写到绝对路径");
  }

  // 校验在落盘之前整体完成：坏条目 + 合法条目混合时，合法文件也不该被写出来
  const dest = path.join(root, "mixed");
  assert.throws(() => extractTarGz(makeTgz([
    { name: "package/ok.txt", data: "ok" },
    { name: "package/../../evil.txt", data: "pwn" },
  ]), dest), (err) => err.code === "ETRAVERSAL");
  assert.ok(!existsSync(path.join(dest, "ok.txt")), "坏包不该留下写了一半的目录");
  assert.ok(!existsSync(path.join(root, "evil.txt")));
});

test("安全红线：符号链接/硬链接/设备条目被跳过而不是抛错", async (t) => {
  const root = await tmpDir(t);
  const dest = path.join(root, "links");
  const files = extractTarGz(makeTgz([
    { name: "package/link-to-passwd", type: "2", linkname: "/etc/passwd" },
    { name: "package/link-to-escape", type: "2", linkname: "../../../etc/passwd" },
    { name: "package/hard.txt", type: "1", linkname: "package/real.txt" },
    { name: "package/dev-null", type: "3" },
    { name: "package/pipe", type: "6" },
    { name: "package/real.txt", data: "real" },
  ]), dest);

  assert.equal(files, 1, "只有普通文件计数");
  assert.equal(await readFile(path.join(dest, "real.txt"), "utf8"), "real");
  for (const name of ["link-to-passwd", "link-to-escape", "hard.txt", "dev-null", "pipe"]) {
    assert.ok(!existsSync(path.join(dest, name)), `${name} 必须被跳过（连符号链接本身也不该存在）`);
  }
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

const MAIN_TARBALL_URL = "https://registry.example.test/@mrrisega/dsh-remote/-/dsh-remote-0.6.12.tgz";
const WS_TARBALL_URL = "https://registry.example.test/ws/-/ws-8.18.2.tgz";
const SCOPE_TARBALL_URL = "https://registry.example.test/@mrrisega/dsh-util/-/dsh-util-1.0.0.tgz";

const MAIN_TGZ = makeTgz([
  { name: "package/", type: "5" },
  { name: "package/dsh-setup.mjs", data: "// dsh-setup stub\n" },
  { name: "package/lib/index.js", data: "export const main = 1;\n" },
]);
const WS_TGZ = makeTgz([{ name: "package/index.js", data: "module.exports = require('./lib/ws');\n" }]);
const SCOPE_TGZ = makeTgz([{ name: "package/index.js", data: "export const util = 1;\n" }]);

function packument(version, tarball, distTags) {
  return {
    "dist-tags": distTags,
    versions: { [version]: { name: "x", version, dist: { tarball } } },
  };
}

test("resolveVersion：@scope/name 的 URL 编码正确，并解析出版本与 tarball", async () => {
  const log = [];
  const fetchImpl = makeFetch({
    [`${DEFAULT_REGISTRY}/@mrrisega%2fdsh-remote/latest`]: {
      json: packument("0.6.12", MAIN_TARBALL_URL, { latest: "0.6.12", beta: "0.6.13-beta.1" }),
    },
    [`${DEFAULT_REGISTRY}/@mrrisega%2fdsh-remote/beta`]: {
      json: packument("0.6.13-beta.1", MAIN_TARBALL_URL, { latest: "0.6.12", beta: "0.6.13-beta.1" }),
    },
    [`${DEFAULT_REGISTRY}/ws/latest`]: { json: packument("8.18.2", WS_TARBALL_URL, { latest: "8.18.2" }) },
  }, log);

  const main = await resolveVersion({ name: "@mrrisega/dsh-remote", fetchImpl });
  assert.deepEqual(main, {
    version: "0.6.12",
    tarball: MAIN_TARBALL_URL,
    url: `${DEFAULT_REGISTRY}/@mrrisega%2fdsh-remote/latest`,
  });
  // 作用域包的斜杠必须编码成 %2f（@ 保留），这是 registry 的规范形式
  assert.deepEqual(log, [`${DEFAULT_REGISTRY}/@mrrisega%2fdsh-remote/latest`]);

  const beta = await resolveVersion({ name: "@mrrisega/dsh-remote", tag: "beta", fetchImpl });
  assert.equal(beta.version, "0.6.13-beta.1");
  assert.equal(log[1], `${DEFAULT_REGISTRY}/@mrrisega%2fdsh-remote/beta`);

  const ws = await resolveVersion({ name: "ws", fetchImpl });
  assert.equal(ws.version, "8.18.2");
  assert.equal(log[2], `${DEFAULT_REGISTRY}/ws/latest`, "非作用域包不加任何多余转义");
});

test("resolveVersion：失败时错误信息带 HTTP 状态与 name/tag（便于遥测归因）", async () => {
  const fetchImpl = makeFetch({});
  await assert.rejects(
    () => resolveVersion({ name: "@mrrisega/dsh-remote", tag: "beta", fetchImpl }),
    (err) => {
      assert.match(err.message, /HTTP 404/);
      assert.match(err.message, /name=@mrrisega\/dsh-remote/);
      assert.match(err.message, /tag=beta/);
      assert.equal(err.status, 404);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 下载
// ---------------------------------------------------------------------------

test("downloadTarball：超过 maxBytes 抛错", async () => {
  // 伪随机内容 → gzip 压不掉，才能真的超过 maxBytes（全 0 缓冲会被压到几百字节）
  const big = zlib.gzipSync(Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => (i * 37 + (i >> 3)) % 251)));
  assert.ok(big.length > 1024);
  await assert.rejects(
    () => downloadTarball({ tarballUrl: "https://registry.example.test/ws/-/ws.tgz", maxBytes: 1024, fetchImpl: async () => new Response(big) }),
    (err) => err.code === "E2BIG" && /过大/.test(err.message),
  );

  // content-length 就已经超限 → 连读都不读（用最小的假响应，直接盯住 body 有没有被碰）
  let readStarted = false;
  const fakeRes = {
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": String(10 * 1024 * 1024) }),
    body: { getReader() { readStarted = true; return { read: async () => ({ done: true }) }; } },
    arrayBuffer: async () => { readStarted = true; return new ArrayBuffer(0); },
  };
  await assert.rejects(
    () => downloadTarball({
      tarballUrl: "https://registry.example.test/ws/-/ws.tgz",
      maxBytes: 1024,
      fetchImpl: async () => fakeRes,
    }),
    (err) => err.code === "E2BIG",
  );
  assert.equal(readStarted, false, "content-length 超限时不该继续读 body");
});

test("downloadTarball：返回 gzip Buffer（并拒绝非 gzip 内容）", async () => {
  const buf = await downloadTarball({
    tarballUrl: MAIN_TARBALL_URL,
    fetchImpl: async () => new Response(MAIN_TGZ),
  });
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.length, MAIN_TGZ.length);
  assert.equal(zlib.gunzipSync(buf).length % BLOCK, 0);

  await assert.rejects(
    () => downloadTarball({ tarballUrl: MAIN_TARBALL_URL, fetchImpl: async () => new Response("<html>404</html>") }),
    /不是 gzip/,
  );
});

// ---------------------------------------------------------------------------
// stagePackage 端到端
// ---------------------------------------------------------------------------

test("stagePackage：主包 + ws 依赖端到端落到 staging（含 dist-tag 回退）", async (t) => {
  const root = await tmpDir(t);
  const dest = path.join(root, "staging");
  const log = [];
  const fetchImpl = makeFetch({
    [`${DEFAULT_REGISTRY}/@mrrisega%2fdsh-remote/latest`]: {
      json: packument("0.6.12", MAIN_TARBALL_URL, { latest: "0.6.12" }),
    },
    [`${DEFAULT_REGISTRY}/ws/%5E8.18.0`]: { status: 404 }, // 版本范围当 tag 请求必然打不到
    [`${DEFAULT_REGISTRY}/ws/latest`]: { json: packument("8.18.2", WS_TARBALL_URL, { latest: "8.18.2" }) },
    [`${DEFAULT_REGISTRY}/@mrrisega%2fdsh-util/1.0.0`]: {
      json: packument("1.0.0", SCOPE_TARBALL_URL, { latest: "1.0.0" }),
    },
    [MAIN_TARBALL_URL]: { tgz: MAIN_TGZ },
    [WS_TARBALL_URL]: { tgz: WS_TGZ },
    [SCOPE_TARBALL_URL]: { tgz: SCOPE_TGZ },
  }, log);

  const res = await stagePackage({
    spec: "@mrrisega/dsh-remote@latest",
    destDir: dest,
    fetchImpl,
    dependencies: { ws: "^8.18.0", "@mrrisega/dsh-util": "1.0.0" },
  });

  assert.equal(res.name, "@mrrisega/dsh-remote");
  assert.equal(res.version, "0.6.12", "返回的 version 必须是 registry 解析出来的那个");
  assert.equal(res.dir, dest);
  assert.equal(res.files, 2);

  // 主包：staging 根目录就是包根（dsh-setup.mjs 在这里）
  assert.equal(await readFile(path.join(dest, "dsh-setup.mjs"), "utf8"), "// dsh-setup stub\n");
  assert.equal(await readFile(path.join(dest, "lib", "index.js"), "utf8"), "export const main = 1;\n");

  // 依赖：ws 落到 node_modules/ws，作用域依赖落到 node_modules/@scope/x
  const ws = res.deps.find((d) => d.name === "ws");
  assert.equal(await readFile(path.join(dest, "node_modules", "ws", "index.js"), "utf8"), "module.exports = require('./lib/ws');\n");
  assert.equal(ws.version, "8.18.2");
  assert.equal(ws.dir, path.join(dest, "node_modules", "ws"));
  assert.equal(ws.requested, "^8.18.0", "如实记录调用方原本写的范围");
  assert.equal(ws.resolvedBy, "latest-fallback", "范围当 tag 用不了 → 必须如实标注回退到 latest");
  assert.equal(ws.distTag, "latest");

  const util = res.deps.find((d) => d.name === "@mrrisega/dsh-util");
  assert.equal(await readFile(path.join(dest, "node_modules", "@mrrisega", "dsh-util", "index.js"), "utf8"), "export const util = 1;\n");
  assert.equal(util.version, "1.0.0");
  assert.equal(util.resolvedBy, "requested-tag", "精确版本号能直接命中，不该回退");
  assert.equal(util.dir, path.join(dest, "node_modules", "@mrrisega", "dsh-util"));

  // 请求序列：作用域名编码正确、范围失败后才请求 latest
  assert.ok(log.includes(`${DEFAULT_REGISTRY}/@mrrisega%2fdsh-remote/latest`));
  assert.ok(log.indexOf(`${DEFAULT_REGISTRY}/ws/%5E8.18.0`) < log.indexOf(`${DEFAULT_REGISTRY}/ws/latest`));
  assert.ok(!log.some((u) => /^https?:\/\/(?!registry\.npmjs\.org)/.test(u) && !u.includes("example.test")), "绝不碰真实外部地址");
});

test("stagePackage：不带版本、带 @version 的 spec 解析", async (t) => {
  const root = await tmpDir(t);
  const log = [];
  const fetchImpl = makeFetch({
    [`${DEFAULT_REGISTRY}/@mrrisega%2fdsh-remote/0.6.12`]: {
      json: packument("0.6.12", MAIN_TARBALL_URL, { latest: "0.6.12" }),
    },
    [MAIN_TARBALL_URL]: { tgz: MAIN_TGZ },
  }, log);

  const res = await stagePackage({ spec: "@mrrisega/dsh-remote@0.6.12", destDir: path.join(root, "s"), fetchImpl });
  assert.equal(res.version, "0.6.12");
  assert.equal(log[0], `${DEFAULT_REGISTRY}/@mrrisega%2fdsh-remote/0.6.12`, "作用域名里的 @ 不能被当成版本分隔符");

  assert.deepEqual(parseSpec("@mrrisega/dsh-remote"), { name: "@mrrisega/dsh-remote", tag: "latest" });
  assert.deepEqual(parseSpec("@mrrisega/dsh-remote@0.6.12"), { name: "@mrrisega/dsh-remote", tag: "0.6.12" });
  assert.deepEqual(parseSpec("pkg@beta"), { name: "pkg", tag: "beta" });
  assert.deepEqual(parseSpec("ws"), { name: "ws", tag: "latest" });
  assert.throws(() => parseSpec(""), /不能为空/);
  assert.throws(() => parseSpec("@scope"), /不合法/);
});

test("stagePackage：staging 里能找到 dsh-setup.mjs（调用方要跑的就是它）", async (t) => {
  const root = await tmpDir(t);
  const dest = path.join(root, "staging");
  mkdirSync(dest, { recursive: true }); // 允许调用方先建好空目录
  await stagePackage({
    spec: "@mrrisega/dsh-remote",
    destDir: dest,
    fetchImpl: makeFetch({
      [`${DEFAULT_REGISTRY}/@mrrisega%2fdsh-remote/latest`]: { json: packument("0.6.12", MAIN_TARBALL_URL, { latest: "0.6.12" }) },
      [MAIN_TARBALL_URL]: { tgz: MAIN_TGZ },
    }),
  });
  const setup = path.join(dest, "dsh-setup.mjs");
  assert.ok(existsSync(setup), "staging 根目录必须有 dsh-setup.mjs");
  assert.equal(await readFile(setup, "utf8"), "// dsh-setup stub\n");
});
