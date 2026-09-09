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
 *     2) 设置面板(实测挂载在侧栏 .hHd-Xa_settingsArea 子树里的 fixed 弹层;panel 内
 *        nav 188px + content 154px 左右并排)→ 手机改为上下堆叠:顶部 tab 行(横向滚动)置顶,
 *        下方内容区全高滚动。fix2:官方模块 CSS 运行期才注入 head(晚于本 <style>),普通规则
 *        被官方同特异性后加载规则覆盖(nav 是 <nav>,圆1 的 div.VOzbGW_nav 从未命中;overlay
 *        被官方 min(800px,84vw) 钉成左靠 328px 抽屉感)→ 本版设置区全部用 [class~=...] 精确类
 *        + 几何 !important;并把侧栏/详情浮层的 will-change:transform 去掉(transform 祖先会让
 *        侧栏子树里的 fixed 设置弹层以侧栏为 containing block,被压到 84vw——fix2 设置窄的根因);
 *        顶部 tab 字号 ≤13px、行宽拉满可横向滚动,当前项自动滚入可视;
 *     3) 输入控件字号 ≥16px 防 iOS 聚焦缩放;hero 的工作区/模式座位行允许换行,防 212px 座位
 *        右缘伸出视口(实测 cubgiG_seat right=409 > 390);
 *     4) html/body overflow-x 防护、safe-area inset、触控目标友好;配色只用官方 CSS 变量;
 *     5) 鲸鱼余额挂件(用户另装的第三方 dsh-whale-widget,浮动 .dshwv-root,z-index:9999):
 *        fix2 实测它的窄屏“卡左上角盖标题”与“拖不动”均为其自身缺陷的放大:
 *        - 拖不动:触屏上 pointer 拖拽被页面滚动抢占(pointercancel,坐标归 0 → 挂件被“瞬移”),
 *          鼠标路径正常 → 适配层在鲸鱼实体像素的 touchstart 上 preventDefault(仅 ≤820),
 *          让浏览器不抢滚动,挂件原生拖拽在手机上恢复;
 *        - 默认位置:它把锚点记忆存 localStorage(dshw-pos),一旦曾落在「左+上」就每次载入
 *          盖住左上会话标题 → 适配层在页面解析期(挂件 widget.js 是 defer,晚于本脚本)清掉
 *          left+top 陈旧锚点,默认回到右下;再兜底一次“卡左上角”检测(合成鼠标事件走它自己
 *          的拖拽收尾,state/localStorage 由它自洽)。
 *        仅对 ≤820 且锚点命中 left+top 干预;透明区点击/滚动仍穿透,与桌面语义一致。
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

  /* --- 侧栏 / 详情:离屏浮层(off-canvas),展开态滑入 ---
     注意:不能给浮层设 will-change:transform / 持久 transform —— 官方把设置面板等
     fixed 弹层的 DOM 挂在侧栏子树里,transform 祖先会成为 fixed 的 containing block,
     导致弹层被限制在 84vw 侧栏宽内(实测 328px“抽屉感”,fix2 根因之一)。 */
  div.pI_x6G_sidebarCol, div.dsh-ma-sidebar {
    position: fixed; left: 0; top: 0; bottom: 0; margin: 0;
    width: min(84vw, 340px); max-width: 92vw;
    z-index: 300; overflow: hidden;
    border-right: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.25));
    box-shadow: 0 10px 44px rgba(0,0,0,.26);
    transform: translateX(-103%);
    transition: transform .22s var(--ds-ease-in-out, ease);
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

  /* --- 设置面板(fix2 硬化版;实测 390×844:官方模块 CSS 运行期注入在适配层之后,
        普通规则会被官方后加载样式覆盖——nav 是 <nav> 而非 div,圆1 的 div.VOzbGW_nav
        从未命中;overlay 被官方宽度 min(800px,84vw) 钉在左侧 328px,呈“抽屉感”。
        故本版全部用 [class~=...] 精确类 + 几何 !important,官方前缀变化则整段静默失效) --- */
  [class~="VOzbGW_overlay"] {
    position: fixed !important;
    inset: 0 !important;
    width: auto !important; max-width: none !important;
    height: auto !important; max-height: none !important;
    margin: 0 !important; padding: 0 !important;
    border-radius: 0 !important;
    box-sizing: border-box;
    justify-content: center; align-items: stretch;
  }
  [class~="VOzbGW_panel"] {
    box-sizing: border-box;
    width: 100% !important; max-width: 100% !important;
    height: 100% !important; max-height: 100% !important;
    margin: 0 !important; border-radius: 0 !important;
    flex-direction: column !important;
  }
  /* 顶部 tab 行:整行铺满,字号调小(≤13px),横向可滚动 */
  [class~="VOzbGW_nav"] {
    box-sizing: border-box;
    flex: none;
    width: 100% !important;
    flex-direction: row !important;
    align-items: center;
    gap: 4px;
    padding: max(4px, env(safe-area-inset-top)) 4px 0;
    overflow: visible;
  }
  [class~="VOzbGW_navTitle"] {
    flex: none;
    font-size: 13px !important; line-height: 1.2;
    padding: 0 4px 0 8px;
    white-space: nowrap;
  }
  [class~="VOzbGW_navList"] {
    box-sizing: border-box;
    flex: 1 1 auto; min-width: 0;
    flex-direction: row !important;
    gap: 4px;
    overflow-x: auto; overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    padding: 0 0 6px;
  }
  [class~="VOzbGW_navList"]::-webkit-scrollbar { display: none; }
  [class~="VOzbGW_navCell"] {
    flex: none; min-width: max-content;
    box-sizing: border-box;
    font-size: 13px !important;
    height: 32px !important;
    padding: 0 12px !important;
  }
  /* 内容区:全宽拉满,收敛内边距,最大化有效宽度 */
  [class~="VOzbGW_content"] {
    box-sizing: border-box;
    width: 100% !important; max-width: none !important;
    flex: 1 1 auto; min-width: 0; min-height: 0;
  }
  [class~="VOzbGW_header"] {
    box-sizing: border-box;
    flex: none;
    min-height: 40px;
    padding: 6px 8px 4px 14px !important;
    align-items: center;
  }
  [class~="VOzbGW_close"] { width: 32px; height: 32px; }
  [class~="VOzbGW_options"] {
    box-sizing: border-box;
    flex: 1 1 auto; min-height: 0; overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 2px 14px calc(14px + env(safe-area-inset-bottom)) !important;
  }
}

/* 桌面宽屏(>820px):本文件无任何规则 → 对直连/桌面零影响。 */
`;

const SCRIPT = `(() => {
  "use strict";

  /* —— 主机门解除(2026-09):镜像页(如 n.risegao.cn)经设备流认证回连同一台 127.0.0.1:3080,
     桥已把 Host 回环化并剥 Origin(不扩大信任面)。官方客户端以 transport.ownsHost 判定
     「自有主机」,非回环域名下不置 true 会把设置页置为 memory(不可用)镜像 →
     模型/提供方设置无法加载(“Settings are unavailable in this browser”)。
     在模块执行前安装定义陷阱:任何 __DSH_TRANSPORT__ 赋值都带 ownsHost=true。 —— */
  (function () {
    function forceOwns(v) {
      try {
        if (v && typeof v === "object") {
          const d = Object.getOwnPropertyDescriptor(v, "ownsHost");
          if (!d || d.configurable || d.writable) {
            try {
              Object.defineProperty(v, "ownsHost", { configurable: true, enumerable: true, get() { return true; }, set() {} });
            } catch (e) { v.ownsHost = true; }
          } else { v.ownsHost = true; }
        }
      } catch (e) { /* 忽略 */ }
      return v;
    }
    let tr = (() => { try { return globalThis.__DSH_TRANSPORT__ || null; } catch (e) { return null; } })();
    if (tr) { tr = forceOwns(tr); }
    else { tr = { ownsHost: true }; } // 壳未注入 transport 的镜像页也按「自有主机」处理
    try {
      Object.defineProperty(globalThis, "__DSH_TRANSPORT__", {
        configurable: true,
        enumerable: true,
        get() { return tr; },
        set(v) { tr = v ? forceOwns(v) : tr; }
      });
    } catch (e) {
      try { globalThis.__DSH_TRANSPORT__ = tr; } catch (e2) { /* 忽略 */ }
    }
  })();

  try {
    const HOST_RE = new RegExp(${JSON.stringify(RUNTIME_HOST_RE.source)});
    const NARROW = () => window.innerWidth <= 820;
    const HOSTISH = () =>
      HOST_RE.test(document.documentElement.outerHTML.slice(0, 200000)) ||
      !!document.querySelector("[data-shell-overlay], [data-sidebar-collapsed], [data-details-collapsed]");

    /* —— 鲸鱼余额挂件(dsh-whale-widget,第三方插件的浮动组件)窄屏协同 ——
       若挂件记忆的锚点是「左+上」(实测会盖住左上角会话标题/左上菜单按钮),在页面解析期
       (鲸鱼 widget.js 是 defer 脚本,一定晚于本脚本执行)清掉该陈旧锚点 → 挂件回到自身
       默认右下角。仅窄屏 & 仅命中 left+top 组合,不影响其它自定义位置。 */
    try {
      if (window.innerWidth <= 820 && window.localStorage) {
        const rawPos = window.localStorage.getItem("dshw-pos");
        if (rawPos) {
          const pos = JSON.parse(rawPos);
          if (pos && pos.hAnchor === "left" && pos.vAnchor === "top") {
            window.localStorage.removeItem("dshw-pos");
          }
        }
      }
    } catch (e3) { /* 私有模式/配额等:忽略 */ }

    /* ================= 鲸鱼挂件手机辅助(仅 ≤820 生效;挂件类名 .dshwv-* 稳定) ========= */
    let whaleGuardsOn = false;
    let whaleHitMap = null;    let whaleUnstuckDone = false;
    let drawerAutoCloseOn = false; // 窄屏“选中会话后自动收抽屉”委托只挂一次

    const WHALE_IMG = () => document.querySelector(".dshwv-img");
    const WHALE_ROOT = () => document.querySelector(".dshwv-root");

    /* 命中测试与挂件自身一致:鲸鱼图按 610×610 采样 alpha>10;贴左(镜像)时水平翻转。 */
    function whaleBodyAt(x, y) {
      const img = WHALE_IMG();
      const root = WHALE_ROOT();
      if (!img || !root) return false;
      const flip = root.classList.contains("dshwv-left");
      const r = img.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return false;
      const lx0 = ((x - r.left) / r.width) * 610;
      const ly0 = ((y - r.top) / r.height) * 610;
      if (lx0 < 0 || ly0 < 0 || lx0 >= 610 || ly0 >= 610) return false;
      const key = img.currentSrc || img.src || "";
      if (!whaleHitMap || whaleHitMap.key !== key) {
        if (!img.complete || !img.naturalWidth || img.naturalWidth === 0) return false; /* 图未就绪→不挡 */
        try {
          const cv = document.createElement("canvas");
          cv.width = 610; cv.height = 610;
          const ctx = cv.getContext("2d");
          if (!ctx) return false;
          ctx.drawImage(img, 0, 0, 610, 610);
          whaleHitMap = { key: key, data: ctx.getImageData(0, 0, 610, 610).data };
        } catch (e4) { whaleHitMap = null; return false; }
      }
      const lx = flip ? 610 - lx0 : lx0;
      const ix = Math.min(609, Math.max(0, Math.floor(lx)));
      const iy = Math.min(609, Math.max(0, Math.floor(ly0)));
      return whaleHitMap.data[(iy * 610 + ix) * 4 + 3] > 10;
    }

    /* 手机上挂件自身拖拽被滚动抢占:触摸点在鲸鱼实体上时浏览器默认滚动 → pointercancel,
       挂件 pointermove 收不到且把它“瞬移”到取消点(实测拖到左上角)。鼠标路径无此问题。
       在 document capture 阶段对鲸鱼实体像素的 touchstart preventDefault → 浏览器不抢滚动,
       挂件原生的 pointer 拖拽在触屏上随之恢复;透明区仍穿透(与桌面一致)。仅窄屏注册。 */
    function onWhaleTouchStart(ev) {
      try {
        if (!NARROW()) return;
        const t = ev.touches && ev.touches[0];
        if (!t) return;
        const tg = ev.target;
        if (tg && tg.closest && tg.closest(".dshwv-menu, .dshwv-menu-btn, .dshwv-bubble")) return;
        if (whaleBodyAt(t.clientX, t.clientY)) ev.preventDefault();
      } catch (e5) { /* 忽略 */ }
    }

    function whaleHookInit() {
      if (whaleGuardsOn || !NARROW() || !WHALE_ROOT()) return;
      whaleGuardsOn = true;
      try { document.addEventListener("touchstart", onWhaleTouchStart, { capture: true, passive: false }); } catch (e6) {}
      /* 兜底:极端时序下挂件若仍以 (0,0) 卡在左上(如解析期清锚点被竞态错过),settle 完再扶正一次 */
      [1000, 3500].forEach(function (ms) {
        setTimeout(function () { try { whaleUnstickIfStuck(); } catch (e7) {} }, ms);
      });
    }

    function safeInsetSides() {
      const ins = { right: 0, bottom: 0 };
      try {
        const p = document.createElement("div");
        p.style.cssText = "position:fixed;top:0;left:0;width:10px;height:10px;visibility:hidden;pointer-events:none";
        document.body.appendChild(p);
        p.style.bottom = "env(safe-area-inset-bottom, 0px)";
        p.style.top = "auto"; p.style.left = "0px"; p.style.right = "auto";
        let r = p.getBoundingClientRect();
        ins.bottom = Math.max(0, Math.round(window.innerHeight - r.top - 10));
        p.style.bottom = "auto"; p.style.top = "0px";
        p.style.right = "env(safe-area-inset-right, 0px)"; p.style.left = "auto";
        r = p.getBoundingClientRect();
        ins.right = Math.max(0, Math.round(window.innerWidth - r.left - 10));
        p.remove();
      } catch (e8) { /* 忽略 */ }
      return ins;
    }

    function whaleBodyPoint() {
      const img = WHALE_IMG();
      if (!img) return null;
      const r = img.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return null;
      const cands = [[0.5, 0.5], [0.62, 0.64], [0.5, 0.72], [0.72, 0.6], [0.35, 0.58], [0.8, 0.68]];
      for (let i = 0; i < cands.length; i++) {
        const x = r.left + cands[i][0] * r.width;
        const y = r.top + cands[i][1] * r.height;
        if (whaleBodyAt(x, y)) return { x: Math.round(x), y: Math.round(y) };
      }
      return { x: Math.round(r.left + r.width * 0.62), y: Math.round(r.top + r.height * 0.66) };
    }

    function dispatchWhalePointer(type, x, y) {
      try {
        document.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, composed: true, pointerType: "mouse",
          pointerId: 61001, isPrimary: true,
          button: type === "pointerup" ? -1 : 0,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: x, clientY: y
        }));
      } catch (e9) { /* 不支持 PointerEvent 的环境:跳过 */ }
    }

    /* 走挂件自己(鼠标路径)的拖拽把它送回右下:state/localStorage 全部由挂件收尾,我们只发合成事件。 */
    function whaleNativeDragToBottomRight() {
      const root = WHALE_ROOT();
      if (!root || root.classList.contains("dshwv-dragging")) return false;
      const start = whaleBodyPoint();
      if (!start) return false;
      const rect = root.getBoundingClientRect();
      const w = rect.width || 122;
      const h = rect.height || 122;
      const ins = safeInsetSides();
      const cx = window.innerWidth - w / 2 - Math.max(ins.right, 10);
      const cy = window.innerHeight - h / 2 - Math.max(ins.bottom, 10);
      if (cx < 0 || cy < 0 || cx < window.innerWidth * 0.5 || cy < window.innerHeight * 0.5) return false;
      dispatchWhalePointer("pointerdown", start.x, start.y);
      let started = false;
      try { started = root.classList.contains("dshwv-dragging"); } catch (e10) {}
      if (!started) { try { dispatchWhalePointer("pointerup", start.x, start.y); } catch (e11) {} return false; }
      const N = 14;
      for (let i = 1; i <= N; i++) {
        const x = Math.round(start.x + ((cx - start.x) * i) / N);
        const y = Math.round(start.y + ((cy - start.y) * i) / N);
        dispatchWhalePointer("pointermove", x, y);
      }
      dispatchWhalePointer("pointerup", cx, cy);
      return true;
    }

    function whaleUnstickIfStuck() {
      if (!NARROW() || whaleUnstuckDone) return;
      const root = WHALE_ROOT();
      if (!root || root.classList.contains("dshwv-dragging")) return;
      const rect = root.getBoundingClientRect();
      if (rect.top > 20 || rect.left > 20) return; /* 只扶“真卡左上角”的,用户自己放的位置不动 */
      whaleUnstuckDone = true;
      try { if (window.localStorage) window.localStorage.removeItem("dshw-pos"); } catch (e12) {}
      whaleNativeDragToBottomRight();
    }

    /* 设置面板打开时,把当前 tab 滚进横向可视区(顶部 tab 行手机横向滚动) */
    let settingsWatchOn = false;
    let settingsTick = 0;
    function scrollActiveSettingsTab() {
      const act = document.querySelector(
        '[class~="VOzbGW_navCell"].VOzbGW_active, [class~="VOzbGW_navCell"][aria-current="true"]'
      );
      if (act && act.scrollIntoView) {
        try { act.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (e13) {
          try { act.scrollIntoView(); } catch (e14) {}
        }
      }
    }
    function watchSettings() {
      if (settingsWatchOn || !NARROW()) return;
      settingsWatchOn = true;
      try {
        const ob = new MutationObserver(function () {
          clearTimeout(settingsTick);
          settingsTick = setTimeout(function () { if (NARROW()) scrollActiveSettingsTab(); }, 140);
        });
        ob.observe(document.body, { childList: true, subtree: true });
      } catch (e15) {}
    }

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
      /* 窄屏抽屉:点选会话(激活行)/点侧栏内「新建会话」后自动收起(官方不做;适配层点官方 toggle)。
         仅当:窄屏 && 抽屉展开 && 点击发生在侧栏抽屉内;行内「⋯」按钮 stopPropagation 不会误触。 */
      if (!drawerAutoCloseOn) {
        drawerAutoCloseOn = true;
        document.addEventListener("click", (e) => {
          try {
            if (!NARROW() || !expanded()) return;
            const t = e.target;
            if (!t || !t.closest) return;
            if (t.closest(".dsh-ma-scrim, .dsh-ma-hamburger")) return;
            if (!t.closest(".dsh-ma-sidebar")) return; // 只处理抽屉内的点选
            const row = t.closest('[role="treeitem"][aria-selected]');
            const isNew = t.closest('[aria-label*="新建会话"], [aria-label*="New session" i]');
            if (!row && !isNew) return;
            const togg = toggleOf();
            if (togg) setTimeout(() => { try { togg.click(); } catch (e5) { /* ignore */ } }, 0);
          } catch (e6) { /* 忽略 */ }
        });
      }
      whaleHookInit();
      watchSettings();
    };

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
    /* 官方模块系统异步挂载 UI,晚一点再补几次(幂等,done 守卫);同时等鲸鱼/设置弹层就位 */
    [700, 1600, 3200, 7000, 12000].forEach((ms) =>
      setTimeout(() => { try { boot(); whaleHookInit(); watchSettings(); } catch (e) { /* 幂等重试 */ } }, ms)
    );
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
