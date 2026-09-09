/**
 * mobile-adapter.mjs — bridge 侧注入的“经隧道访问的官方 dsh web”移动端适配层。
 *
 * 注入目标(仅经隧道回传的手机页面;官方包 / 桌面宽屏不受影响):
 *   - 官方 dsh web(dsh-web-frontend 0.1.2-rc.1)index.html 的 </head> 前,由 dsh-bridge.mjs
 *     对 content-type 含 text/html 的上游响应注入 <style id="dsh-mobile-adapter-css"> 与
 *     <script id="dsh-mobile-adapter-js">。
 *
 * 设计依据(实测 390×844 DOM,非猜测):
 *   - 布局外壳:官方 .pI_x6G_frame 为三列 grid(内联 gridTemplateColumns),侧栏/详情列通过
 *     data-sidebar-collapsed / data-details-collapsed 表达状态;官方在 <1024px 时把侧栏自动
 *     收成 56px 图标 rail,再手动展开(narrowExpanded)时却把中心列挤到 ~110px(实测 grid
 *     "280px 110px 0px")——这就是“侧栏挤压/设置内容可视区不足”的根因。
 *   - 适配策略:
 *     1) ≤820px 强制三列轨宽为 0 / 1fr / 0,内容区全宽;侧栏/详情改造成离屏浮层(off-canvas),
 *        顶部放一个小鲸鱼/菜单按钮,点击 = 程序化点击官方 toggle(aria-label 打开/关闭侧边栏),
 *        不复制官方状态,数据属性仍是唯一真源;
 *     2) 设置面板(实测 .VOzbGW_overlay 是 z-index:1000 的 fixed 全屏,panel 内 nav 188px +
 *        content 154px 左右并排)→ 手机改为上下堆叠:顶部固定 tab 行(横向滚动),下面全高滚动内容;
 *     3) 输入控件字号 ≥16px 防 iOS 聚焦缩放;hero 的工作区/模式座位行允许换行,防 212px 座位
 *        右缘伸出视口(实测 cubgiG_seat right=409 > 390);
 *     4) html/body overflow-x 防护、safe-area inset、触控目标友好;配色只用官方 CSS 变量。
 *
 * 宿主特征门(防误注入其它 html):
 *   - 注入前:content-type 必须 text/html 且含 </head> 且原文含官方标记
 *     (__ModuleLoader__ / @deepseek-ai/dsh-client-* / <title>DeepSeek Harness</title>);
 *   - 运行时:注入脚本在 window.innerWidth ≤ 820 且 DOM 出现官方 frame/overlay 特征时才动作。
 *
 * 类名变化退化策略(官方升级重打包导致 pI_x6G_* / hHd-Xa_* / VOzbGW_* 等前缀改变时):
 *   - 结构优先用官方固定输出的 data-* 属性与 aria-label;
 *   - JS 用结构探测(frame → 子列 → 打 dsh-ma-* 稳定类)承载布局,不以 hashed 类为唯一钩子;
 *   - 命中不到 frame 时静默跳过,页面保持官方默认,绝不报错/破坏。
 *
 * 开关:环境变量 DSH_MOBILE_ADAPTER=0 整体关闭(默认开启)。
 */

const ADAPTER_ID = "dsh-mobile-adapter";

/* 注入前 raw HTML 层官方特征(0.1.2-rc.1 index.html 原文稳定存在)。 */
const HOST_FEATURE_RE =
  /(__ModuleLoader__|@deepseek-ai\/dsh-client-modules|@deepseek-ai\/dsh-client-connection|<title>\s*DeepSeek Harness)/i;

/* 运行时 DOM 特征(注入脚本内再次校验;data-* 由官方组件固定输出,不随 CSS modules 改名)。 */
const RUNTIME_HOST_RE =
  /(data-sidebar-collapsed|data-details-collapsed|data-shell-overlay)|(pI_x6G_frame|hHd-Xa_root|hHd-Xa_toggle)/;

const STYLE = `
/* ===== dsh-remote mobile adapter (bridge 注入;仅 ≤820px 生效,桌面宽屏无任何规则) ===== */
@media (max-width: 820px) {
  html, body { max-width: 100%; overflow-x: hidden; }
  html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }

  /* --- 三列 frame → 内容区全宽(官方内联 gridTemplateColumns 用 !important 覆盖) --- */
  div.pI_x6G_frame, div.dsh-ma-frame { grid-template-columns: 0 minmax(0, 1fr) 0 !important; min-width: 0; }
  /* 侧栏/详情已移出 grid 流(fixed),唯一在流的中心列须显式落到 1fr 轨道,否则自动放置会被塞进 0px 轨 */
  div.pI_x6G_centerCol, div.dsh-ma-center { grid-column: 2; min-width: 0; width: auto; }

  /* --- 侧栏 / 详情:离屏浮层(off-canvas),展开态滑入 --- */
  div.pI_x6G_sidebarCol, div.dsh-ma-sidebar {
    position: fixed; left: 0; top: 0; bottom: 0; margin: 0;
    width: min(84vw, 340px); max-width: 92vw;
    z-index: 300; overflow: hidden;
    border-right: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.25));
    box-shadow: 0 10px 44px rgba(0,0,0,.26);
    transform: translateX(-103%);
    transition: transform .22s var(--ds-ease-in-out, ease);
    will-change: transform;
  }
  html.dsh-ma-sidebar-open div.pI_x6G_sidebarCol,
  html.dsh-ma-sidebar-open div.dsh-ma-sidebar { transform: none; }

  div.pI_x6G_detailsCol, div.dsh-ma-details {
    position: fixed; right: 0; top: 0; bottom: 0; margin: 0;
    width: min(92vw, 400px); max-width: 96vw;
    z-index: 300; overflow: hidden;
    border-left: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.25));
    box-shadow: 0 10px 44px rgba(0,0,0,.26);
    transform: translateX(103%);
    transition: transform .22s var(--ds-ease-in-out, ease);
    will-change: transform;
  }
  html.dsh-ma-details-open div.pI_x6G_detailsCol,
  html.dsh-ma-details-open div.dsh-ma-details { transform: none; }

  /* --- 展开遮罩(在浮层下、在官方弹层下) --- */
  div.dsh-ma-scrim {
    position: fixed; inset: 0; z-index: 290;
    background: rgba(0,0,0,.32);
    opacity: 0; pointer-events: none;
    transition: opacity .22s ease;
  }
  html.dsh-ma-sidebar-open div.dsh-ma-scrim,
  html.dsh-ma-details-open div.dsh-ma-scrim { opacity: 1; pointer-events: auto; }

  /* --- 顶部小鲸鱼/菜单按钮(侧栏收起时可见) --- */
  button.dsh-ma-hamburger {
    position: fixed;
    top: max(10px, env(safe-area-inset-top));
    left: max(10px, env(safe-area-inset-left));
    z-index: 260;
    width: 42px; height: 42px; padding: 0;
    display: flex; align-items: center; justify-content: center;
    border-radius: 12px;
    background: var(--dsw-alias-button-elevated-fill, rgba(255,255,255,.96));
    border: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.3));
    box-shadow: 0 1px 6px rgba(0,0,0,.16);
    color: var(--dsw-alias-label-primary, #111);
    cursor: pointer; touch-action: manipulation;
  }
  button.dsh-ma-hamburger:active { transform: scale(.92); }

  /* --- 输入字号 ≥16px(防 iOS 聚焦自动缩放) --- */
  textarea,
  input:not([type]), input[type="text"], input[type="search"], input[type="email"],
  input[type="url"], input[type="tel"], input[type="number"], input[type="password"],
  [contenteditable="true"] { font-size: 16px !important; }
  select, button, a, [role="button"], [role="menuitem"], [role="option"], [role="tab"] { touch-action: manipulation; }

  /* --- hero 工作区/模式座位行:可换行,防右缘被裁(实测 cubgiG_seat right=409>390) --- */
  div.wSkVaW_heroWorkspaceRow { flex-wrap: wrap; row-gap: 8px; column-gap: 8px; justify-content: center; min-width: 0; }
  div.wSkVaW_heroWorkspaceRow > * { max-width: calc(100vw - 32px); }
  div.wSkVaW_composerStack, div.wSkVaW_composerHero, div.uV2eYG_card { min-width: 0; }

  /* --- 设置面板(实测 .VOzbGW_overlay fixed z-index:1000,panel 内 nav 188 + content 154 并排)
        手机改为上下堆叠:顶部 tab 行固定/横向滚动,下方内容区最大化滚动 --- */
  div.VOzbGW_overlay { justify-content: center; align-items: stretch; }
  div.VOzbGW_panel {
    width: 100%; max-width: 100%;
    height: 100%; max-height: 100%;
    border-radius: 0;
    flex-direction: column;
  }
  div.VOzbGW_nav {
    box-sizing: border-box;
    width: 100% !important; height: auto; flex: none;
    flex-direction: row; align-items: center;
    gap: 8px; padding: 8px 10px 4px;
    overflow-x: auto; overflow-y: hidden;
  }
  div.VOzbGW_navTitle { flex: none; }
  div.VOzbGW_navList {
    box-sizing: border-box;
    flex: 1 1 auto; min-width: 0;
    flex-direction: row !important;
    gap: 6px; overflow-x: auto; overflow-y: hidden;
    padding-bottom: 2px;
  }
  div.VOzbGW_navList > button, button.VOzbGW_navCell {
    flex: none; min-width: max-content; padding: 10px 14px;
  }
  div.VOzbGW_content { width: 100% !important; min-width: 0; flex: 1 1 auto; min-height: 0; }
  div.VOzbGW_options {
    flex: 1 1 auto; min-height: 0; overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding-bottom: env(safe-area-inset-bottom);
  }
}

/* 桌面宽屏(>820px):本文件无任何规则 → 对直连/桌面零影响。 */
`;

const SCRIPT = `(() => {
  "use strict";
  try {
    const HOST_RE = new RegExp(${JSON.stringify(RUNTIME_HOST_RE.source)});
    const NARROW = () => window.innerWidth <= 820;
    const HOSTISH = () =>
      HOST_RE.test(document.documentElement.outerHTML.slice(0, 200000)) ||
      !!document.querySelector("[data-shell-overlay], [data-sidebar-collapsed], [data-details-collapsed]");

    let done = false;
    const boot = () => {
      if (done || !NARROW() || !HOSTISH()) return;
      const frame = document.querySelector(".pI_x6G_frame, [data-sidebar-collapsed], [data-details-collapsed]");
      if (!frame || !frame.querySelector) return;
      done = true;
      frame.classList.add("dsh-ma-frame");

      /* 给 frame 子列打稳定标记(dsh-ma-*),规避官方类名前缀随构建变化 */
      let sidebar = null, details = null, center = null;
      const cols = [...frame.children].filter((c) => c instanceof HTMLElement);
      for (const col of cols) {
        const cls = typeof col.className === "string" ? col.className : "";
        if (/sidebar/i.test(cls) || col.querySelector(".hHd-Xa_root, [aria-label*='侧边栏'], [aria-label*='sidebar' i]")) {
          col.classList.add("dsh-ma-sidebar"); sidebar = sidebar || col;
        } else if (/details/i.test(cls)) {
          col.classList.add("dsh-ma-details"); details = details || col;
        } else if (/center/i.test(cls)) {
          col.classList.add("dsh-ma-center"); center = center || col;
        }
      }
      if (!sidebar && cols[0]) { cols[0].classList.add("dsh-ma-sidebar"); sidebar = sidebar || cols[0]; }
      if (!center && cols[1]) { cols[1].classList.add("dsh-ma-center"); center = center || cols[1]; }
      if (!details && cols[cols.length - 1] && cols[cols.length - 1] !== sidebar && cols[cols.length - 1] !== center) {
        cols[cols.length - 1].classList.add("dsh-ma-details"); details = details || cols[cols.length - 1];
      }

      const toggleSel = '[aria-label="打开侧边栏"], [aria-label="关闭侧边栏"], [aria-label="Open sidebar"], [aria-label="Close sidebar"]';
      const toggleOf = () => document.querySelector(toggleSel) || document.querySelector(".hHd-Xa_toggle");
      const expanded = () => !frame.hasAttribute("data-sidebar-collapsed");

      /* 遮罩:点击 = 点官方 toggle(走官方 store,无私有状态) */
      const scrim = document.createElement("div");
      scrim.className = "dsh-ma-scrim";
      document.body.appendChild(scrim);
      scrim.addEventListener("click", (e) => { e.stopPropagation(); const t = toggleOf(); if (t) t.click(); });

      /* 顶部小鲸鱼/菜单按钮 */
      const hamburger = document.createElement("button");
      hamburger.type = "button";
      hamburger.className = "dsh-ma-hamburger";
      hamburger.setAttribute("aria-label", "打开菜单");
      hamburger.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>';
      document.body.appendChild(hamburger);
      hamburger.addEventListener("click", (e) => {
        e.stopPropagation(); e.preventDefault();
        const t = toggleOf();
        if (t) t.click();
        else document.documentElement.classList.add("dsh-ma-sidebar-open"); /* 兜底 */
      });

      /* 状态唯一真源 = 官方 frame 的 data 属性 */
      const sync = () => {
        const open = expanded();
        document.documentElement.classList.toggle("dsh-ma-sidebar-open", open);
        if (hamburger) hamburger.style.display = open ? "none" : "";
        const dOpen = !frame.hasAttribute("data-details-collapsed") && !!details;
        document.documentElement.classList.toggle("dsh-ma-details-open", dOpen);
      };
      try {
        new MutationObserver(sync).observe(frame, { attributes: true, attributeFilter: ["data-sidebar-collapsed", "data-details-collapsed"] });
      } catch (e2) { /* 退化:仅在下次 boot 同步 */ }
      sync();
    };

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
    /* 官方模块系统异步挂载 UI,晚一点再补几次(幂等,done 守卫) */
    [700, 1600, 3200, 7000, 12000].forEach((ms) => setTimeout(boot, ms));
  } catch (e) { if (window.console) console.warn("[dsh-mobile-adapter]", e && e.message); }
})();`;

/**
 * 纯函数:把适配层注入到上游 HTML 的 </head> 之前。
 * @param {string} html
 * @returns {{html:string, injected:boolean}}
 */
export function injectMobileAdapter(html) {
  const src = String(html);
  const headIdx = src.toLowerCase().lastIndexOf("</head>");
  if (headIdx === -1) return { html: src, injected: false };
  const block =
    `\n<style id="${ADAPTER_ID}-css" data-dsh-mobile-adapter>${STYLE}</style>` +
    `\n<script id="${ADAPTER_ID}-js" data-dsh-mobile-adapter>${SCRIPT}</script>\n`;
  return { html: src.slice(0, headIdx) + block + src.slice(headIdx), injected: true };
}

/** 环境开关:DSH_MOBILE_ADAPTER=0 关闭(默认开启)。 */
export function mobileAdapterEnabled() {
  return process.env.DSH_MOBILE_ADAPTER !== "0";
}

/**
 * 判断上游响应是否应注入(仅官方 dsh web 的 text/html)。
 * @param {{contentType?:string, html?:string}} opts
 */
export function shouldInjectHtml({ contentType, html }) {
  const ct = String(contentType || "");
  if (!/text\/html/i.test(ct)) return false;
  const src = String(html || "");
  if (!/<\/head>/i.test(src)) return false;
  if (/\uFFFD/.test(src)) return false; // 非 UTF-8,不冒险改写
  return HOST_FEATURE_RE.test(src);
}

/**
 * bridge 接线主入口:开关 + 类型/特征 gate + 注入,一步完成。
 * @param {{buf:Buffer, contentType?:string}} args
 * @returns {{buf:Buffer, injected:boolean}}
 */
export function maybeInjectMobileAdapter({ buf, contentType }) {
  if (!mobileAdapterEnabled() || !Buffer.isBuffer(buf) || buf.length === 0) {
    return { buf, injected: false };
  }
  const text = buf.toString("utf8");
  if (!shouldInjectHtml({ contentType, html: text })) return { buf, injected: false };
  const out = injectMobileAdapter(text);
  return { buf: Buffer.from(out.html, "utf8"), injected: out.injected };
}

export const ADAPTER_TAG = ADAPTER_ID;
export default { injectMobileAdapter, maybeInjectMobileAdapter, shouldInjectHtml, mobileAdapterEnabled };
