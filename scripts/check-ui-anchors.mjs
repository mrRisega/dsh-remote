#!/usr/bin/env node
/**
 * 前端 DOM 锚点自检：mobile-adapter 依赖的官方类名 / data-* 在新版 dsh 前端里还在不在。
 *
 * 为什么需要：
 *   mobile-adapter 靠**官方混淆类名**（`.pI_x6G_frame` 这类）与 `data-*` 布局状态属性定位。
 *   这些名字来自官方构建，换版本可能变。一旦变了，适配层会**静默失效** ——
 *   页面照常打开，只是手机端布局全坏，而且**只有真机才看得出来**。
 *
 * 为什么单独做成脚本：
 *   2026-10-08 升级 0.2 时，先用「HTTP 抓首屏资源」的办法判定，得到"12 个锚点全消失"，
 *   差点据此做出错误结论；随后用 0.1.5 做对照实验才发现是**假阴性**（锚点在懒加载 chunk /
 *   在别的包，首屏抓不到）。改成**直接 grep 框架树里的构建产物**才得到可信结果。
 *   把这个正确方法固化下来，下次升级就能一条命令复核。
 *
 * 🔴 2026-10-13 三处修正（此前它会对符号链接树给出假阴/假阳）：
 *   ① **跟随符号链接**：`~/.dsh/profiles/node_modules/@deepseek-ai/*` 全是指向
 *      `/opt/homebrew/.../dsh/node_modules/@deepseek-ai/*` 的符号链接，而 `readdir(..., {withFileTypes})`
 *      对软链报 `isDirectory() === false` → 一个产物都收不到，脚本直接 exit 2
 *      （"该树下没有可搜索的构建产物"）。现在解析 realpath 后递归，并带**环检测**（软链互指不会死循环）。
 *   ② **支持 .asar 归档**：桌面端（0.2.x）的官方前端产物**不在** `app.asar.unpacked`，而是**打包进**
 *      `app.asar`（实测 121MB 里有整套 `dsh/node_modules/@deepseek-ai/dsh-*`）。普通 readdir 看不见它，
 *      于是"0.2 前端产物在哪"一直没人能用一条命令回答。现在可以把 app.asar 当树传进来。
 *   ③ **改判据：按"角色后缀"认等价锚点**，而不是"某个具体前缀必须命中"。
 *      官方每次重新打包都会换前缀（实测：`pI_x6G_*` → `_6Qf49G_*`、`VOzbGW_*` → `Dws9Sa_*`），
 *      但**角色名（frame / centerCol / overlay / navCell …）是稳的**。旧版把"前缀变了"直接判成
 *      "锚点缺失 → exit 1"，于是要么阻塞升级、要么被当噪音忽略 —— 两种都不是可信结论。
 *      现在：同一个角色只要有**任一前缀**命中就算覆盖（并打印是哪个前缀提供的），
 *      只有"这个角色在整个前端里都找不到"才判缺失（那才真的需要改适配层）。
 *
 * 用法:
 *   node scripts/check-ui-anchors.mjs [框架树路径 | app.asar]
 *   默认路径：$DSH_UI_TREE，否则 <dsh 安装目录>/node_modules/@deepseek-ai
 *   0.2 / 桌面端（前端打包在 app.asar 里）：
 *   node scripts/check-ui-anchors.mjs "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"
 *
 * 退出码: 0 = 每个角色都有锚点命中；1 = 有角色真的找不到（打印清单）；2 = 用法/环境错误
 */
import { readFileSync, readdirSync, statSync, existsSync, realpathSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const ADAPTER = path.join(ROOT, "clients", "dsh-remote", "mobile-adapter.mjs");

/** 单个产物文件的上限（超过就不读，避免把大 bundle 整个吃进内存）。 */
const MAX_ASSET_BYTES = 12 * 1024 * 1024;
/** 整棵树读取总量上限：超过就停止（宁可结论保守，也不要把几 GB 都读一遍）。 */
const MAX_TOTAL_BYTES = 320 * 1024 * 1024;
/** 「改名发现」阶段每个角色的扫描预算：dsh 系包排在最前，真身几十 MB 内必然出现。 */
const RENAME_SCAN_BYTES_PER_ROLE = 40 * 1024 * 1024;
/** 递归深度上限（软链环 + 深目录兜底；正常框架树 < 8 层）。 */
const MAX_DEPTH = 12;

/**
 * 从适配层自身抽取"官方锚点"，而不是另抄一份清单 —— 抄一份会漂移。
 * 判据：适配层自己的类名有固定前缀（dsh-ma- / dshwv- / dru-），其余点号类名即官方锚点；
 * 另外 `[class~="X"]` 这种精确类写法也是官方锚点（0.2 的 Dws9Sa_* 就是这么挂上去的）。
 * @returns {{ classes: string[], attrs: string[] }}
 */
function anchorsFromAdapter() {
  const src = readFileSync(ADAPTER, "utf8");
  const classes = new Set();
  const consider = (name) => {
    if (/^(dsh-ma-|dshwv-|dsh-|dru-)/.test(name)) return; // 适配层自己的 / 第三方挂件的 / 本项目命名空间
    if (/^[A-Z0-9_]+$/.test(name)) return;                 // 常量名，不是类名
    if (/^(is-|has-)/.test(name)) return;                  // 通用状态类，不是官方定位锚点
    // 官方生成名形态：短前缀 + 分隔符 + 角色段（如 pI_x6G_frame、hHd-Xa_root、Dws9Sa_navCell）
    if (!/^[A-Za-z_][A-Za-z0-9]{1,9}[-_][A-Za-z0-9_-]{3,}$/.test(name)) return;
    classes.add(name);
  };
  for (const m of src.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]{3,})/g)) consider(m[1]);
  // 精确类写法 [class~="name"]（0.1.5 的 VOzbGW_* 与 0.2 的 Dws9Sa_* 都在这里）
  for (const m of src.matchAll(/\[class~="([^"]+)"\]/g)) consider(m[1]);
  const attrs = new Set();
  for (const m of src.matchAll(/\b(data-[a-z][a-z0-9-]{2,})\b/g)) {
    if (/^data-dsh/.test(m[1])) continue; // 本项目/第三方自己的命名空间（data-dsh-ma-* 等）
    attrs.add(m[1]);
  }
  return { classes: [...classes].sort(), attrs: [...attrs].sort() };
}

/**
 * 解析 Electron asar 头（Chromium Pickle）：u32[4] = payload 大小；payload 里先是长度字段再是 JSON。
 * 不同 asar 版本的偏移差 4 字节，所以按 [4,0,8] 依次试，最后退到"从第一个 { 开始"。
 */
function parseAsarHeader(fd) {
  const pre = Buffer.alloc(16);
  readSync(fd, pre, 0, 16, 0);
  const headerSize = pre.readUInt32LE(4);
  if (!(headerSize > 0) || headerSize > 64 * 1024 * 1024) throw new Error("asar 头大小异常");
  const hdr = Buffer.alloc(headerSize);
  readSync(fd, hdr, 0, headerSize, 8);
  for (const off of [4, 0, 8]) {
    try {
      const len = hdr.readUInt32LE(off);
      if (len <= 0 || off + 4 + len > hdr.length) continue;
      return { json: JSON.parse(hdr.subarray(off + 4, off + 4 + len).toString("utf8")), dataStart: 8 + headerSize };
    } catch { /* 试下一个偏移 */ }
  }
  const idx = hdr.indexOf(0x7b); // '{'
  return { json: JSON.parse(hdr.subarray(idx).toString("utf8").replace(/\0+$/, "")), dataStart: 8 + headerSize };
}

/** 已打开的 asar 句柄（按路径缓存；扫描结束后统一关闭）——避免把上百 MB 一次性读进内存。 */
const ASAR_FDS = new Map();

/** 收集 asar 里所有 .js/.mjs/.cjs/.css 的**位置**（内容按需再读；unpacked 的走磁盘路径）。 */
function collectFromAsar(asarPath, out) {
  const fd = openSync(asarPath, "r");
  ASAR_FDS.set(asarPath, fd);
  const { json, dataStart } = parseAsarHeader(fd);
  const unpackedRoot = asarPath + ".unpacked";
  const walk = (node, prefix, depth) => {
    if (depth > MAX_DEPTH) return;
    for (const [name, v] of Object.entries(node.files || {})) {
      const p = prefix ? prefix + "/" + name : name;
      if (v.files) { walk(v, p, depth + 1); continue; }
      if (!/\.(js|mjs|cjs|css)$/.test(name)) continue;
      try {
        if (v.unpacked) {
          const up = path.join(unpackedRoot, p);
          if (existsSync(up) && statSync(up).size <= MAX_ASSET_BYTES) out.push({ path: up, size: statSync(up).size });
          continue;
        }
        if (!(v.size > 0) || v.size > MAX_ASSET_BYTES) continue;
        out.push({ path: asarPath + "::" + p, size: v.size, asar: asarPath, offset: dataStart + Number(v.offset) });
      } catch { /* 单个文件读失败不影响整体结论 */ }
    }
  };
  walk(json, "", 0);
  return out;
}

/**
 * 递归收集可搜索的构建产物（限制扩展名，避免把二进制读进内存）。
 * 🔴 跟随符号链接（并带 realpath 环检测）—— 这是 2026-10-13 之前"整棵树收不到产物"的根因。
 */
function collectAssets(target, out = [], depth = 0, seen = new Set()) {
  if (depth > MAX_DEPTH) return out;
  let real;
  try { real = realpathSync(target); } catch { return out; }
  if (seen.has(real)) return out;   // 软链互指 / 重复引用：只走一次
  seen.add(real);
  let st;
  try { st = statSync(real); } catch { return out; }
  if (st.isFile()) {
    if (/\.asar$/.test(real)) { collectFromAsar(real, out); return out; }
    if (/\.(js|mjs|cjs|css)$/.test(real) && st.size <= MAX_ASSET_BYTES) out.push({ path: real, size: st.size });
    return out;
  }
  if (!st.isDirectory()) return out;
  let entries;
  try { entries = readdirSync(real, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(real, e.name);
    if (e.isDirectory()) collectAssets(p, out, depth + 1, seen);
    else if (e.isSymbolicLink()) collectAssets(p, out, depth + 1, seen);   // 🔴 跟随
    else if (/\.(js|mjs|cjs|css)$/.test(e.name)) {
      try { const st2 = statSync(p); if (st2.size <= MAX_ASSET_BYTES) out.push({ path: p, size: st2.size }); } catch { /* 忽略 */ }
    }
  }
  return out;
}

/**
 * 【可选】锚点：适配层里 OPTIONAL_UI_ANCHORS 列的那批（缺了不算故障，见适配层注释）。
 * 直接读适配层常量，避免清单漂移。
 */
function optionalAnchors() {
  const src = readFileSync(ADAPTER, "utf8");
  const m = /const OPTIONAL_UI_ANCHORS\s*=\s*\[([^\]]*)\]/.exec(src);
  if (!m) return new Set();
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}

/**
 * 自动发现本代真实前缀：对"没命中的角色"回到产物里找 `<任意前缀><分隔符><角色>`。
 * 为什么必须有这一步：适配层只声明它**已知**的前缀（pI_x6G_ / Dws9Sa_ …），
 * 官方换前缀后，光看"未命中"分不清"官方改名了"还是"这个角色真的没了" ——
 * 前者只需补前缀，后者才要改适配层逻辑。这里把真实的新名字找出来，结论才可信。
 */
function discoverRenamedRoles(ordered, roles) {
  const want = new Set(roles);
  const found = new Map();                     // 角色 -> Set(实际命中 token)
  const hashCount = new Map();                 // 角色 -> Map(token -> 出现次数，"官方前缀形态"的投票)
  const roleBytes = new Map();                 // 角色 -> 已扫字节（本阶段是"再扫一遍"，每个角色要有预算上限）
  /* 排序：官方混淆前缀长这样 —— `_6Qf49G_` / `Dws9Sa_` / `jJkEga_` / `ST7X_W_`（大小写混排 + 数字/下划线）。
     纯英文单词连字符（per- / one- / project- / filesystem-）是普通标识符，不是官方前缀，压到最后。 */
  /* "像官方混淆前缀"的形态：`_6Qf49G_`（下划线包裹）或 `Dws9Sa_` / `jJkEga_`（大小写混排 + 数字）。
     命中这种形态就够可信了，立刻停止该角色的继续收集 —— 否则会先收满一堆英文单词连字符。 */
  /* 注意：判据作用在**前缀**上（m[1]，如 `_6Qf49G_` / `Dws9Sa_`），不是整个 token。 */
  const hashish = (p) => /^_[0-9A-Za-z]{5,7}[_-]$/.test(p)
    || (/^(?=.*[A-Z])(?=.*[0-9])[A-Za-z0-9_-]{4,8}[-_]$/.test(p));
  const score = (t) => {
    let sc = 0;
    if (/^_[0-9A-Za-z]{5,7}_$/.test(t)) sc += 4;
    if (/[A-Z]/.test(t) && /[0-9]/.test(t)) sc += 2;
    if (/^[a-z]+[-_]$/.test(t)) sc -= 3;
    if (t.length > 12) sc -= 1;
    return sc;
  };
  for (const a of ordered) {
    if (want.size === 0) break;
    const text = assetText(a);
    if (!text) continue;
    for (const r of [...want]) {
      const seenBytes = (roleBytes.get(r) || 0) + text.length;
      roleBytes.set(r, seenBytes);
      if (seenBytes > RENAME_SCAN_BYTES_PER_ROLE) { want.delete(r); continue; }  // 该角色扫够了，用现有投票收尾
      let re;
      try { re = new RegExp("([A-Za-z_][A-Za-z0-9_-]{1,11}[-_])" + r + "(?![A-Za-z0-9])", "g"); } catch { want.delete(r); continue; }
      let m;
      while ((m = re.exec(text))) {
        if (!found.has(r)) found.set(r, new Set());
        if (hashish(m[1])) {
          /* 出现次数投票：官方前缀会在 CSS + JS 里出现几十次，普通标识符只出现一两次。
             所以收够 40 次就停 —— 既不早停（早停会错过后面包里的真身），也不全量扫。 */
          if (!hashCount.has(r)) hashCount.set(r, new Map());
          const bag = hashCount.get(r);
          bag.set(m[0], (bag.get(m[0]) || 0) + 1);
          let total = 0; for (const v of bag.values()) total += v;
          if (total >= 40) { want.delete(r); break; }
          continue;
        }
        if (found.get(r).size < 8) found.get(r).add(m[0]);
      }
      /* 刻意**不**因为"收满 8 个"就放弃这个角色：真正的官方前缀形态可能出现在后面才扫到的包里
         （实测 role=frame 时，先扫到的是一堆 per-frame/one-frame，真身 `_6Qf49G_frame` 在后面）。 */
    }
  }
  const ranked = new Map();
  for (const r of new Set([...found.keys(), ...hashCount.keys()])) {
    const bag = hashCount.get(r);
    const voted = bag ? [...bag.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]) : [];
    const seen = new Set(voted);
    const rest = [...(found.get(r) || [])].filter((t) => !seen.has(t)).sort((a, b) => score(b) - score(a));
    ranked.set(r, [...voted, ...rest].slice(0, 3));
  }
  return ranked;
}

/**
 * 把锚点名拆成「前缀 + 角色」：官方每次重打包只换前缀，角色（frame / navCell / overlay …）是稳的。
 * 例：`pI_x6G_frame` → { prefix: "pI_x6G", role: "frame" }；`_6Qf49G_frame` → { prefix: "_6Qf49G", role: "frame" }。
 */
function splitAnchor(name) {
  const i = name.lastIndexOf("_");
  if (i <= 0 || i === name.length - 1) return { prefix: name, role: name };
  return { prefix: name.slice(0, i), role: name.slice(i + 1) };
}

const tree = process.argv[2] || process.env.DSH_UI_TREE
  || path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "@deepseek-ai");
if (!existsSync(tree)) {
  console.error(`❌ 找不到框架树：${tree}`);
  console.error("   传一个路径（目录或 .asar），例如：");
  console.error("     node scripts/check-ui-anchors.mjs ~/.dsh/profiles/node_modules/@deepseek-ai");
  console.error("     node scripts/check-ui-anchors.mjs \"/Applications/DeepSeek Harness.app/Contents/Resources/app.asar\"");
  process.exit(2);
}

const { classes, attrs } = anchorsFromAdapter();
console.log(`框架树: ${tree}`);
console.log(`锚点来源: clients/dsh-remote/mobile-adapter.mjs（自动抽取，避免清单漂移）`);
console.log(`待查: ${classes.length} 个官方类名 + ${attrs.length} 个 data-* 属性\n`);

const assets = collectAssets(tree);
if (assets.length === 0) {
  console.error("❌ 该树下没有可搜索的构建产物（.js/.css；目录与 .asar 都会跟随符号链接递归）");
  process.exit(2);
}
console.log(`发现 ${assets.length} 个构建产物（含 .asar 内文件；符号链接已跟随），按需读取（dsh 系包优先）...`);

/** 单个产物的文本：asar 内的按 offset 现读，磁盘的现读（都不常驻，避免几百 MB 常驻内存）。 */
function assetText(a) {
  try {
    if (a.asar && a.offset !== undefined) {
      /* 句柄可能在主扫描后已关闭（改名发现阶段还要再读一遍），按需重开。 */
      let fd = ASAR_FDS.get(a.asar);
      if (fd === undefined) { fd = openSync(a.asar, "r"); ASAR_FDS.set(a.asar, fd); }
      const buf = Buffer.alloc(a.size);
      readSync(fd, buf, 0, a.size, a.offset);
      return buf.toString("utf8");
    }
    return readFileSync(a.path, "utf8");
  } catch { return ""; }
}

/**
 * 分批短路扫描：dsh 系包优先（官方客户端代码都在 @deepseek-ai/dsh-*），
 * 第三方依赖占绝大多数体积，只有"还有没命中的锚点"时才继续读 —— 正常只读几十 MB。
 */
const ORDERED = [...assets].sort((a, b) => (isDshAsset(a) ? 0 : 1) - (isDshAsset(b) ? 0 : 1));
function isDshAsset(a) { return /(^|[/\\])dsh[-.]/.test(a.path) || /::.*[/\\]dsh[-.]/.test(a.path); }
const allNeedles = [...classes, ...attrs];
const remaining = new Set(allNeedles);
const foundBy = new Map();
let readCount = 0, readBytes = 0;
for (const a of ORDERED) {
  if (remaining.size === 0) break;
  if (readBytes > MAX_TOTAL_BYTES) { console.warn(`⚠️ 已读取 ${Math.round(readBytes / 1048576)}MB，达上限后停止（结论可能偏保守）`); break; }
  const text = assetText(a);
  if (!text) continue;
  readCount++; readBytes += text.length;
  for (const n of [...remaining]) if (text.includes(n)) { remaining.delete(n); foundBy.set(n, a.path); }
}
for (const fd of ASAR_FDS.values()) { try { closeSync(fd); } catch { /* 忽略 */ } }
ASAR_FDS.clear();   // 必须清空：改名发现阶段要按需重开，留着已关闭的句柄会读到 EBADF
console.log(`实际读取 ${readCount} 个产物 / ${Math.round(readBytes / 1048576)}MB；未命中才继续读下一批。\n`);
const blob = { includes: (n) => foundBy.has(n) };   // 命中判据统一走它（供下面沿用）

// ── 命中判定：先按"角色"归组，再判是否被任一前缀覆盖 ────────────────────────────
const hit = new Map();               // 角色 -> Set(实际命中的锚点名)
for (const c of classes) {
  if (!blob.includes(c)) continue;
  const { role } = splitAnchor(c);
  if (!hit.has(role)) hit.set(role, new Set());
  hit.get(role).add(c);
}
const coveredNames = new Set();
for (const [, names] of hit) for (const n of names) coveredNames.add(n);
const directMiss = [];               // 该前缀没命中，但同角色有别的前缀顶上（改名，非缺失）
const missingRole = [];              // 角色全无命中 = 真的缺失（要改适配层）
for (const c of classes) {
  if (coveredNames.has(c)) continue;
  const { role } = splitAnchor(c);
  if (hit.has(role)) directMiss.push({ name: c, by: [...hit.get(role)].join(", ") });
  else missingRole.push({ name: c, role });
}

// ── 前缀族汇总（升级时最有用的一行：哪一代前缀还在、哪一代已经被换掉） ─────────
const OPTIONAL = optionalAnchors();
const attrHit = attrs.filter((a) => blob.includes(a));
const attrMiss = attrs.filter((a) => !blob.includes(a));
/* 可选锚点（适配层 OPTIONAL_UI_ANCHORS：缺了会自动按结构/几何退化）不计入故障。 */
const attrMissHard = attrMiss.filter((a) => !OPTIONAL.has(a));
const attrMissOptional = attrMiss.filter((a) => OPTIONAL.has(a));
const families = new Map();
for (const c of classes) {
  const { prefix, role } = splitAnchor(c);
  const fam = families.get(prefix) || { total: 0, ok: 0, roles: new Set() };
  fam.total++;
  fam.roles.add(role);
  if (blob.includes(c)) fam.ok++;
  families.set(prefix, fam);
}
console.log("\n前缀族（官方重新打包会换前缀：换掉的那个 0 命中是**正常**的，看同角色有没有别的族顶上来）:");
for (const [fam, s] of [...families.entries()].sort((a, b) => b[1].total - a[1].total)) {
  const samples = [...s.roles].slice(0, 6).join("/");
  console.log(`   ${fam.padEnd(10)} ${String(s.ok).padStart(2)}/${String(s.total).padEnd(2)} 命中   角色: ${samples}`);
}

console.log(`\n角色覆盖: ${hit.size}/${new Set(classes.map((c) => splitAnchor(c).role)).size} 个角色至少有一个前缀命中`);
console.log(`data-* 属性: ${attrHit.length}/${attrs.length} 命中（其中 ${OPTIONAL.size} 个是适配层声明的**可选**锚点，缺失不算故障）`);

if (directMiss.length > 0) {
  console.log(`\nℹ️ 以下 ${directMiss.length} 个锚点这一代没命中，但**同角色**有别的前缀顶上（官方改名，适配层已按结构兜底）：`);
  for (const d of directMiss) console.log(`   - ${d.name}  ←  由 ${d.by} 提供`);
}

if (attrMissOptional.length > 0) {
  console.log(`\nℹ️ 以下 ${attrMissOptional.length} 个 data-* 这一代没命中，但适配层已声明为**可选**（自动退化，不影响布局）：`);
  for (const a of attrMissOptional) console.log("   -", a);
}

/* 对未命中的角色做一次"真实前缀发现"：找到新 token = 官方改名（补前缀即可），
   找不到 = 这个角色真的没了（要改适配层逻辑，手机端只能靠结构兜底）。 */
const renamedFound = discoverRenamedRoles(ORDERED, missingRole.map((m) => m.role));
const renamedOk = [], realMissing = [];
for (const m of missingRole) {
  const toks = renamedFound.get(m.role);          // 数组（已排序、最多 3 个候选）
  if (Array.isArray(toks) && toks.length) renamedOk.push({ name: m.name, role: m.role, toks: toks.join(", ") });
  else realMissing.push(m);
}
if (renamedOk.length > 0) {
  const byRole = new Map();
  for (const r of renamedOk) { if (!byRole.has(r.role)) byRole.set(r.role, { toks: r.toks, names: [] }); byRole.get(r.role).names.push(r.name); }
  console.log(`\nℹ️ 有 ${missingRole.length - realMissing.length} 个锚点这一代没命中，但脚本在产物里**找到了同角色的新名字**（官方改名，适配层已按结构兜底）：`);
  for (const [role, v] of byRole) console.log(`   - 角色 ${role}: ${v.names.join(", ")}  →  本代实际是 ${v.toks}`);
}

if (realMissing.length > 0 || attrMissHard.length > 0) {
  console.log(`\n❌ 有 ${realMissing.length} 个角色 / ${attrMissHard.length} 个 data-* 在整个前端里都找不到（手机端会退化到结构兜底）：`);
  for (const m of realMissing) console.log(`   - ${m.name}（角色 ${m.role}）`);
  for (const a of attrMissHard) console.log("   -", a);
  console.log("\n处置：① 真机 390×844 复核设置面板/抽屉是否仍可用（结构兜底会接管，并打印适配层 console.warn）；");
  console.log("      ② 找到官方新锚点后补进 mobile-adapter.mjs（CSS 的 [class~=...] + JS 的已知前缀常量）。");
  process.exit(1);
}
console.log("\n✅ 每个角色都有锚点命中（其余前缀的 0 命中属于正常改名，已被同角色锚点覆盖）");
