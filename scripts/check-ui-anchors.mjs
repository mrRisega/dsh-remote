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
 * 用法:
 *   node scripts/check-ui-anchors.mjs [框架树路径]
 *   默认路径：$DSH_UI_TREE，否则 <dsh 安装目录>/node_modules/@deepseek-ai
 *
 * 退出码: 0 = 锚点齐全；1 = 有缺失（打印缺失清单）；2 = 用法/环境错误
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const ADAPTER = path.join(ROOT, "clients", "dsh-remote", "mobile-adapter.mjs");

/**
 * 从适配层自身抽取"官方锚点"，而不是另抄一份清单 —— 抄一份会漂移。
 * 判据：适配层自己的类名有固定前缀（dsh-ma- / dshwv-），其余点号类名即官方锚点。
 * @returns {{ classes: string[], attrs: string[] }}
 */
function anchorsFromAdapter() {
  const src = readFileSync(ADAPTER, "utf8");
  const classes = new Set();
  for (const m of src.matchAll(/\.([a-zA-Z][a-zA-Z0-9]*[-_][a-zA-Z0-9_-]{3,})/g)) {
    const name = m[1];
    if (/^(dsh-ma-|dshwv-|dsh-)/.test(name)) continue; // 适配层自己的 / 第三方挂件的 / 本项目命名空间
    if (/^[A-Z0-9_]+$/.test(name)) continue;           // 常量名，不是类名
    if (/^(is-|has-)/.test(name)) continue;            // 通用状态类，不是官方定位锚点
    // 官方生成名形态：短前缀 + 分隔符 + 较长的驼峰/哈希段（如 pI_x6G_frame、hHd-Xa_root）
    if (!/^[A-Za-z][A-Za-z0-9]{1,7}[-_][A-Za-z0-9_-]{4,}$/.test(name)) continue;
    classes.add(name);
  }
  const attrs = new Set();
  for (const m of src.matchAll(/\b(data-[a-z][a-z0-9-]{2,})\b/g)) {
    if (/^data-dsh/.test(m[1])) continue; // 本项目/第三方自己的命名空间（data-dsh-ma-* 等）
    attrs.add(m[1]);
  }
  return { classes: [...classes].sort(), attrs: [...attrs].sort() };
}

/** 递归收集可搜索的构建产物（限制扩展名，避免把二进制读进内存）。 */
function collectAssets(dir, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectAssets(p, out, depth + 1);
    else if (/\.(js|mjs|cjs|css)$/.test(e.name)) {
      try { if (statSync(p).size < 12 * 1024 * 1024) out.push(p); } catch { /* 忽略 */ }
    }
  }
  return out;
}

const tree = process.argv[2] || process.env.DSH_UI_TREE
  || path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "@deepseek-ai");
if (!existsSync(tree)) {
  console.error(`❌ 找不到框架树：${tree}`);
  console.error("   传一个路径，例如：node scripts/check-ui-anchors.mjs ~/.dsh/profiles/node_modules/@deepseek-ai");
  process.exit(2);
}

const { classes, attrs } = anchorsFromAdapter();
console.log(`框架树: ${tree}`);
console.log(`锚点来源: clients/dsh-remote/mobile-adapter.mjs（自动抽取，避免清单漂移）`);
console.log(`待查: ${classes.length} 个官方类名 + ${attrs.length} 个 data-* 属性\n`);

const files = collectAssets(tree);
if (files.length === 0) {
  console.error("❌ 该树下没有可搜索的构建产物（.js/.css）");
  process.exit(2);
}
console.log(`扫描 ${files.length} 个构建产物...`);
const blob = files.map((f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } }).join("\n");

const missing = [];
for (const c of classes) if (!blob.includes(c)) missing.push(`.${c}`);
for (const a of attrs) if (!blob.includes(a)) missing.push(a);

console.log(`\n类名: ${classes.filter((c) => blob.includes(c)).length}/${classes.length} 命中`);
console.log(`属性: ${attrs.filter((a) => blob.includes(a)).length}/${attrs.length} 命中`);

if (missing.length > 0) {
  console.log(`\n❌ 缺失 ${missing.length} 个锚点（手机端布局会静默失效）：`);
  for (const m of missing) console.log("   -", m);
  console.log("\n处置：先在**当前线上版本**上跑同一命令做对照 —— ");
  console.log("若线上也缺同样这几项，说明是历史遗留而非本次升级引入，不必阻塞升级。");
  process.exit(1);
}
console.log("\n✅ 全部锚点齐全");
