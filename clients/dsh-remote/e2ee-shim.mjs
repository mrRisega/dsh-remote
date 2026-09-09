/**
 * e2ee-shim.mjs — bridge 侧注入的「镜像页 E2EE 加密 shim」(Phase-4)。
 *
 * 注入目标(仅经隧道回传的官方 dsh web 文档;同 mobile-adapter 的注入管线与宿主特征门):
 *   - 官方 dsh web index.html 的 </head> 前,由 dsh-bridge.mjs 在 text/html 响应上,
 *     与 mobile-adapter 同一位置注入 <style id="dsh-e2ee-shim-css"> +
 *     <script id="dsh-e2ee-shim-js">(源码见同目录 e2ee-shim-script.js)。
 *
 * 职责(运行时,全部在镜像页 document-start 完成):
 *   1. 读 native.html 解锁后写入的**一次性交接单**(sessionStorage 键 dsh-e2ee-handover),
 *      读到后**立即删除**,用内存重建同一 E2EE 会话(与桥端已验证会话 sessId 一一对应);
 *      无交接单(明文跳过 / 刷新丢密钥)→ 数据面零行为 + 状态徽标明确提示「⚠ 未加密」。
 *   2. 有会话时 patch window.fetch / window.WebSocket:
 *        - HTTP:命中 §4.5 策略表(/api 排除 SSE、/sidebar、/git、/pet,含 channel/device
 *          两种 /remote 形态)→ 原请求封装 v2 信封 POST → 响应信封解密(gzip)重建 Response;
 *          静态壳/manifest/SSE/router 错误页 保持明文(信封缺失即原样透传);
 *        - WS:URL 追加 &e2ee=<sessId>&w=<8B hex>,逐消息封/解(k:"w"),AAD/子密钥/
 *          nonce/方向计数/wsLabel 与 e2ee-client.mjs / Phase-3 手机端完全一致;
 *        - 解封/会话失败显式「⚠ 无法解密/未加密」,绝不静默降级。
 *   3. 状态徽标(#dsh-e2ee-badge,与 Phase-3 命名一致):🔒 已加密 / ⚠ 未加密(原因)+ 指引。
 *
 * 注入开关:
 *   - DSH_E2EE_SHIM=0 关闭注入(默认开启);
 *   - 灰度:bridge 端 e2ee.enabled 为 false 时 dsh-bridge 不调用本模块 → 零注入、零行为
 *     (灰度默认关 = 本 shim 默认不出现,镜像页保持既有明文路径)。
 *   - 「桌面宽屏/明文零行为」:未交接时数据面不拦截;桌面直连 dsh web 不经 bridge → 无注入。
 *
 * 测试:本模块的纯函数契约 + e2ee-shim-script.js 抽取的
 * ==DSH-E2EE-SHIM-CORE== 区间(见 clients/dsh-remote/test/lib-e2ee-shim.mjs)
 * 在 mock 与真实本地 router+bridge 上对拍(与 e2ee-client.mjs 字节一致)。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SHIM_ID = "dsh-e2ee-shim";
export const SHIM_SCRIPT_PATH = path.join(THIS_DIR, "e2ee-shim-script.js");

/* 注入前 raw HTML 层官方特征(与 mobile-adapter 同源;仅注入官方 dsh web 文档)。 */
const HOST_FEATURE_RE =
  /(__ModuleLoader__|@deepseek-ai\/dsh-client-modules|@deepseek-ai\/dsh-client-connection|<title>\s*DeepSeek Harness)/i;

const STYLE = `
/* ===== dsh-e2ee-shim(Phase-4 镜像页加密状态徽标;固定右上角,不影响官方布局) ===== */
#dsh-e2ee-badge {
  position: fixed;
  top: max(10px, env(safe-area-inset-top));
  right: max(10px, env(safe-area-inset-right));
  z-index: 2147483000;
  display: flex; align-items: center; gap: 7px;
  max-width: min(86vw, 380px);
  box-sizing: border-box;
  padding: 6px 12px;
  border-radius: 999px;
  cursor: pointer;
  font: 12px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Segoe UI", Roboto, sans-serif;
  -webkit-user-select: none; user-select: none;
  background: rgba(255, 255, 255, .96);
  border: 1px solid rgba(127, 127, 127, .35);
  box-shadow: 0 2px 12px rgba(0, 0, 0, .16);
  color: #222;
}
#dsh-e2ee-badge .dsh-e2ee-badge-ico { flex: none; font-size: 13px; }
#dsh-e2ee-badge .dsh-e2ee-badge-txt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#dsh-e2ee-badge.ok  { color: #14532d; border-color: rgba(26, 127, 55, .5);  background: rgba(225, 244, 232, .97); }
#dsh-e2ee-badge.warn{ color: #7a4a00; border-color: rgba(181, 121, 0, .5);  background: rgba(255, 247, 224, .97); }
#dsh-e2ee-badge.err { color: #8f1d26; border-color: rgba(207, 34, 46, .55); background: rgba(255, 236, 237, .97); }
#dsh-e2ee-badge .dsh-e2ee-badge-note {
  display: none;
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: max-content;
  max-width: min(84vw, 320px);
  padding: 10px 12px;
  border-radius: 12px;
  font-weight: 400;
  white-space: normal; word-break: break-word;
  background: #fff;
  border: 1px solid rgba(127, 127, 127, .3);
  box-shadow: 0 4px 18px rgba(0, 0, 0, .2);
}
#dsh-e2ee-badge.expanded .dsh-e2ee-badge-note { display: block; }
#dsh-e2ee-badge .dsh-e2ee-badge-note a { color: #0b57d0; text-decoration: underline; }
@media (max-width: 480px) {
  #dsh-e2ee-badge { padding: 5px 10px; font-size: 11px; }
}
`;

/** 读镜像 shim 脚本源码(缓存;文件缺失/读取失败 → 空串 + 警告,注入自然跳过)。 */
let cachedScript = null;
export function shimScriptText() {
  if (cachedScript === null) {
    try {
      cachedScript = fs.readFileSync(SHIM_SCRIPT_PATH, "utf8");
    } catch (e) {
      console.warn(`[bridge] e2ee-shim 脚本缺失(${SHIM_SCRIPT_PATH}): ${e.message}(镜像页不回注 shim)`);
      cachedScript = "";
    }
  }
  return cachedScript;
}

/** 环境开关:DSH_E2EE_SHIM=0 关闭注入(默认开启;叠加桥端 e2ee.enabled 灰度门)。 */
export function e2eeShimEnabled() {
  return process.env.DSH_E2EE_SHIM !== "0";
}

/**
 * 纯函数:把 shim 注入到上游 HTML 的 </head> 之前(与 injectMobileAdapter 同 splice 位置)。
 * @param {string} html
 * @returns {{html:string, injected:boolean}}
 */
export function injectE2eeShim(html) {
  const src = String(html);
  const headIdx = src.toLowerCase().lastIndexOf("</head>");
  if (headIdx === -1) return { html: src, injected: false };
  if (src.includes(`data-${SHIM_ID}`)) return { html: src, injected: false }; // 防重复注入
  const script = shimScriptText();
  if (!script) return { html: src, injected: false };
  const block =
    `\n<style id="${SHIM_ID}-css" data-${SHIM_ID}>${STYLE}</style>` +
    `\n<script id="${SHIM_ID}-js" data-${SHIM_ID}>${script}</script>\n`;
  return { html: src.slice(0, headIdx) + block + src.slice(headIdx), injected: true };
}

/**
 * 判断上游响应是否应注入 shim(与 mobile-adapter.shouldInjectHtml 同 gate:
 * 仅官方 dsh web 的 text/html,含 </head>、无替换字符)。e2ee.enabled 由调用方(dsh-bridge)
 * 决定,本函数只做类型/特征门 —— 「灰度关 = 不调用 = 零注入」。
 */
export function shouldInjectE2eeShim({ contentType, html }) {
  const ct = String(contentType || "");
  if (!/text\/html/i.test(ct)) return false;
  const src = String(html || "");
  if (!/<\/head>/i.test(src)) return false;
  if (/\uFFFD/.test(src)) return false; // 非 UTF-8,不冒险改写
  return HOST_FEATURE_RE.test(src);
}

/**
 * bridge 接线主入口:类型/特征 gate + 注入,一步完成。
 * @param {{buf:Buffer, contentType?:string}} args
 * @returns {{buf:Buffer, injected:boolean}}
 */
export function maybeInjectE2eeShim({ buf, contentType }) {
  if (!e2eeShimEnabled() || !Buffer.isBuffer(buf) || buf.length === 0) {
    return { buf, injected: false };
  }
  const text = buf.toString("utf8");
  if (!shouldInjectE2eeShim({ contentType, html: text })) return { buf, injected: false };
  const out = injectE2eeShim(text);
  return { buf: Buffer.from(out.html, "utf8"), injected: out.injected };
}

export default { injectE2eeShim, maybeInjectE2eeShim, shouldInjectE2eeShim, e2eeShimEnabled, shimScriptText };
