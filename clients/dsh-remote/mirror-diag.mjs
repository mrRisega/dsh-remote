/**
 * mirror-diag.mjs — bridge 侧注入的「镜像页加载故障采集器」。
 *
 * 注入目标：经隧道回传的**官方 dsh web 文档**（与 mobile-adapter / e2ee-shim 同一注入管线、
 * 同一宿主特征门），在 `</head>` 前插入 `<script id="dsh-mirror-diag-js">`。
 *
 * 为什么需要它（2026-10-17）：用户反馈「装了 UI 插件后打不开界面 / Failed to load plugins」，
 * 本地复现不出来。生产日志只能看到 `/plugins/??…` 出现 499（客户端中断），拿不到浏览器侧
 * 到底哪个资源失败、耗时多少、什么错误。采集器让下一次故障**自己带证据回来**。
 *
 * 与 e2ee 的关系：**刻意不依赖** e2ee.enabled —— 出问题的用户往往没开 E2EE，
 * 只有无条件注入才能覆盖他们。脚本本身零 DOM 改动、只在失败时上报（见 mirror-diag-script.js）。
 *
 * 开关：
 *   - `DSH_MIRROR_DIAG=0` → 完全不注入（逃生口）；
 *   - `?mirror_diag=0` → 页面侧由脚本自身判定（见 mirror-diag-script.js 的注释）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DIAG_ID = "dsh-mirror-diag";
export const DIAG_SCRIPT_PATH = path.join(THIS_DIR, "mirror-diag-script.js");

/** 与 mobile-adapter / e2ee-shim 同源的「官方 dsh web 文档」特征门。 */
const HOST_FEATURE_RE =
  /(__ModuleLoader__|@deepseek-ai\/dsh-client-modules|@deepseek-ai\/dsh-client-connection|<title>\s*DeepSeek Harness)/i;

/** 采集器源码：只在首次注入时读盘并缓存（读失败 → 永不注入，绝不影响主链路）。 */
let scriptCache = null;
function diagScriptText() {
  if (scriptCache !== null) return scriptCache;
  try {
    scriptCache = fs.readFileSync(DIAG_SCRIPT_PATH, "utf8");
  } catch {
    scriptCache = "";
  }
  return scriptCache;
}

/** `DSH_MIRROR_DIAG=0` 关闭注入（默认开启）；测试里可用同样的环境变量。 */
export function mirrorDiagEnabled() {
  const v = process.env.DSH_MIRROR_DIAG;
  return !(v === "0" || v === "false" || v === "off");
}

/** 注入门：text/html + 宿主特征 + 未注入过。 */
export function shouldInjectMirrorDiag({ contentType, html }) {
  const ct = String(contentType || "").toLowerCase();
  if (!ct.includes("text/html")) return false;
  const text = String(html || "");
  if (text.length === 0) return false;
  if (!text.toLowerCase().includes("</head>")) return false;
  if (text.includes(`data-${DIAG_ID}`)) return false; // 幂等：重复注入直接跳过
  return HOST_FEATURE_RE.test(text);
}

/**
 * 纯函数：把采集器注入到上游 HTML 的 `</head>` 之前。
 * @param {string} html
 * @returns {{html: string, injected: boolean}}
 */
export function injectMirrorDiag(html) {
  const src = String(html);
  if (src.includes(`data-${DIAG_ID}`)) return { html: src, injected: false };
  // ★ 注入点必须是 <head> **开头**，不能是 </head> 前：
  //   官方 dsh web 的插件/主干 <script> 就在 <head> 里，注入到 </head> 前会**晚于**
  //   那些脚本执行 —— 启动期错误（本次要抓的正是这类）就漏了。
  //   用字符扫描而不是正则，避免 HTML 里的属性引号/大小写差异把注入点算错。
  const low = src.toLowerCase();
  const headIdx = low.indexOf("<head");
  let pos = -1;
  if (headIdx !== -1) {
    const gt = low.indexOf(">", headIdx);
    pos = gt === -1 ? headIdx : gt + 1;
  } else {
    pos = low.indexOf("</head>"); // 兜底：没有 <head> 时退化为 </head> 前
  }
  if (pos === -1) return { html: src, injected: false };
  const script = diagScriptText();
  if (!script) return { html: src, injected: false };
  // 注入体不能含 </script>（会把文档提前截断）—— 采集器源码里本来就没有，这里再守一道。
  if (/<\/script/i.test(script)) {
    console.warn(`[${DIAG_ID}] 采集器源码含 </script>，拒绝注入`);
    return { html: src, injected: false };
  }
  const block = `<script id="${DIAG_ID}-js" data-${DIAG_ID}>${script}</script>`;
  return { html: src.slice(0, pos) + block + src.slice(pos), injected: true };
}

/**
 * @param {{buf: Buffer, contentType: string}} input
 * @returns {{buf: Buffer, injected: boolean}}
 */
export function maybeInjectMirrorDiag({ buf, contentType }) {
  if (!mirrorDiagEnabled() || !Buffer.isBuffer(buf) || buf.length === 0) {
    return { buf, injected: false };
  }
  const text = buf.toString("utf8");
  if (!shouldInjectMirrorDiag({ contentType, html: text })) return { buf, injected: false };
  const out = injectMirrorDiag(text);
  return { buf: Buffer.from(out.html, "utf8"), injected: out.injected };
}

export default { injectMirrorDiag, maybeInjectMirrorDiag, shouldInjectMirrorDiag, mirrorDiagEnabled };
