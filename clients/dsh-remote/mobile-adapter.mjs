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
 * ⚠️ 官方 0.1.5-rc.2 起第三列改名(2026-09-19 线上事故,Windows 用户先撞到):
 *   第三列 `pI_x6G_detailsCol` → `pI_x6G_rightbarCol`、`data-details-collapsed` →
 *   `data-rightbar-collapsed`,且折叠时不再渲染拖拽把手、`overlayLayer`(data-shell-overlay,
 *   inset:0 全屏)始终留在 frame 末尾。旧实现"详情抽屉兜底 = 取 frame 最后一个子元素"于是把
 *   **官方 overlay 层**当成详情抽屉:属性不存在 → 判成"未折叠",overlay 全屏 → 几何可见
 *   → `dsh-ma-details-open` 常亮 → CSS 让全屏 scrim 拦截整屏点击 → 手机端一打开就是遮罩死局。
 *   现在三处一起兜底:① 第三列按 /details|rightbar/ 识别,且**排除** overlay 层与拖拽把手;
 *   ② 折叠态同时认两个属性名,认不到就只信几何;③ 抽屉必须是"不是全屏的、真的在视口里的"元素,
 *   并加常驻看门狗:遮罩拦截时若没有任何抽屉在视口内,立刻摘掉(任何未来改名都不会再变成死局)。
 *
 * 开关:环境变量 DSH_MOBILE_ADAPTER=0 整体关闭(默认开启)。
 */

const ADAPTER_ID = "dsh-mobile-adapter";

/* 注入前 raw HTML 层官方特征(0.1.2-rc.1 index.html 原文稳定存在)。 */
const HOST_FEATURE_RE =
  /(__ModuleLoader__|@deepseek-ai\/dsh-client-modules|@deepseek-ai\/dsh-client-connection|<title>\s*DeepSeek Harness)/i;

/* 运行时 DOM 特征(注入脚本内再次校验;data-* 由官方组件固定输出,不随 CSS modules 改名)。
   data-rightbar-collapsed = 官方 0.1.5-rc.2 起第三列(原 details)的折叠属性。 */
const RUNTIME_HOST_RE =
  /(data-sidebar-collapsed|data-details-collapsed|data-rightbar-collapsed|data-shell-overlay)|(pI_x6G_frame|hHd-Xa_root|hHd-Xa_toggle)/;

const STYLE = `
/* ===== dsh-remote mobile adapter (bridge 注入;仅 ≤820px 生效,桌面宽屏无任何规则) ===== */
@media (max-width: 820px) {
  html, body { max-width: 100%; overflow-x: hidden; }
  html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }

  /* --- 三列 frame → 内容区全宽(官方内联 gridTemplateColumns 用 !important 覆盖) --- */
  div.pI_x6G_frame, div.dsh-ma-frame { grid-template-columns: 0 minmax(0, 1fr) 0 !important; min-width: 0; }
  /* 侧栏/详情已移出 grid 流(fixed),唯一在流的中心列须显式落到 1fr 轨道,否则自动放置会被塞进 0px 轨 */
  div.pI_x6G_centerCol, div.dsh-ma-center { grid-column: 2; min-width: 0; width: auto; }

  /* --- 侧栏 / 详情(官方 0.1.5-rc.2 起叫 rightbar):离屏浮层(off-canvas),展开态滑入 ---
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

  div.pI_x6G_detailsCol, div.pI_x6G_rightbarCol, div.dsh-ma-details, div.dsh-ma-rightbar {
    position: fixed; right: 0; top: 0; bottom: 0; margin: 0;
    width: min(92vw, 400px); max-width: 96vw;
    z-index: 300; overflow: hidden;
    border-left: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.25));
    box-shadow: 0 10px 44px rgba(0,0,0,.26);
    transform: translateX(103%);
    transition: transform .22s var(--ds-ease-in-out, ease);
  }
  html.dsh-ma-details-open div.pI_x6G_detailsCol,
  html.dsh-ma-details-open div.pI_x6G_rightbarCol,
  html.dsh-ma-details-open div.dsh-ma-details,
  html.dsh-ma-details-open div.dsh-ma-rightbar { transform: none; }

  /* --- 展开遮罩(在浮层下、在官方弹层下) --- */
  div.dsh-ma-scrim {
    position: fixed; inset: 0; z-index: 290;
    background: rgba(0,0,0,.32);
    opacity: 0; pointer-events: none;
    transition: opacity .22s ease;
  }
  /* ⚠️ 拦截点击**只认 dsh-ma-scrim-on 这一个闸**（2026-09-19 复盘）：
     旧版还并列了一个「html.dsh-ma-details-open div.dsh-ma-scrim」规则，于是"详情展开判定出错"
     会直接变成"整屏被遮罩拦截"——官方 0.1.5 把第三列改名 rightbar 后就是这个死局。
     现在判定收口在 JS 里（必须有一个**真的在视口内、且不是全屏的**抽屉），
     CSS 不再提供第二条能让遮罩生效的路径。 */
  html.dsh-ma-scrim-on div.dsh-ma-scrim { opacity: 1; pointer-events: auto; }

  /* --- 顶部小鲸鱼/菜单按钮(侧栏收起时可见) --- */
  button.dsh-ma-hamburger {
    position: fixed;
    top: max(10px, env(safe-area-inset-top));
    left: max(10px, env(safe-area-inset-left));
    /* 必须高于遮罩(290):抽屉展开时遮罩会拦截整屏点击,若菜单按钮压在遮罩下面
       就会出现"抽屉开了、按钮点不动"——用户实测反馈的正是这个。 */
    z-index: 320;
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

/* ===== 字号档位 + 远程控制悬浮按钮（手机端与电脑端通用） =====
   需求(2026-09-19 用户要求，替代原先"右下角字号按钮 + 右上角加密小锁"两处分散入口):
     合并成**一个**悬浮按钮 → 弹出菜单里同时提供 ①字号档位 ②加密状态 ③返回设备列表。
     "返回设备列表"是用户在镜像页里**唯一的主动退路**，所以它必须在任何宽度都可用。

   字号实现(官方组件大量写死的 px 字号，只改 :root font-size 对它们无效，"尽力而为"叠加):
     ① html { font-size: 计算后的 px } —— 对用 rem 的地方生效;
     ② html { -webkit-text-size-adjust: 百分比 } —— 移动端 Safari/Chrome 对文本整体缩放
        (只影响文字、不影响布局，比 zoom/transform 安全得多);
     ③ 正文气泡走官方自己的变量 --dsh-content-font-size / --dsh-content-font-delta
        (官方聊天正文就是这么取值的)，换算后同步设置，保证正文一定变大。
   适配层自己注入的 UI(.dsh-ma-*)写成固定 px，不参与缩放。 */
html { --dsh-ma-fs-scale: 1; font-size: calc(16px * var(--dsh-ma-fs-scale)); }
html[data-dsh-ma-fs="1"] { --dsh-ma-fs-scale: 1.08; -webkit-text-size-adjust: 108%; }
html[data-dsh-ma-fs="2"] { --dsh-ma-fs-scale: 1.18; -webkit-text-size-adjust: 118%; }
html[data-dsh-ma-fs="3"] { --dsh-ma-fs-scale: 1.32; -webkit-text-size-adjust: 132%; }
/* 注意:不要再给 body 设 font-size —— html 的字号已经缩放过了，
   1rem 此时等于"缩放后的字号"，乘上 scale 会把放大平方(1.32 → 1.74)并连累所有子元素。
   子元素走 -webkit-text-size-adjust(文本整体缩放) + inherit 即可。 */

/* 悬浮按钮:z-index 必须高于遮罩(290)与抽屉(300) —— 遮罩万一因官方改版常亮，
   用户至少还能从这里"返回设备列表"自救(这是 2026-09-19 死局的兜底出口)。 */
button.dsh-ma-fab {
  position: fixed;
  right: max(10px, env(safe-area-inset-right));
  bottom: calc(16px + env(safe-area-inset-bottom));
  z-index: 400;
  width: 46px; height: 46px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%;
  font: 600 15px/1 -apple-system, system-ui, sans-serif;
  background: var(--dsw-alias-button-elevated-fill, rgba(255,255,255,.96));
  border: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.3));
  box-shadow: 0 2px 12px rgba(0,0,0,.2);
  color: var(--dsw-alias-label-primary, #111);
  cursor: pointer; touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
button.dsh-ma-fab:active { transform: scale(.94); }
button.dsh-ma-fab .dsh-ma-fab-lock {
  position: absolute; top: -3px; right: -3px;
  font-size: 12px; line-height: 1; padding: 2px 3px; border-radius: 999px;
  background: var(--dsw-alias-bg-elevated, #fff);
  box-shadow: 0 0 0 .5px var(--dsw-alias-border-l3, rgba(127,127,127,.3));
}
/* 菜单卡片:fixed 贴右下，最大高度受限可滚动 */
div.dsh-ma-menu {
  position: fixed;
  right: max(10px, env(safe-area-inset-right));
  bottom: calc(70px + env(safe-area-inset-bottom));
  z-index: 401;
  width: min(86vw, 320px);
  max-height: min(70vh, 520px);
  overflow-y: auto;
  box-sizing: border-box;
  padding: 12px 14px 14px;
  border-radius: 14px;
  background: var(--dsw-alias-bg-elevated, #fff);
  border: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.28));
  box-shadow: 0 10px 32px rgba(0,0,0,.26);
  color: var(--dsw-alias-label-primary, #111);
  font: 400 14px/1.45 -apple-system, system-ui, sans-serif;
  -webkit-overflow-scrolling: touch;
}
div.dsh-ma-menu[hidden] { display: none; }
div.dsh-ma-menu .dsh-ma-menu-head {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  margin-bottom: 10px;
}
div.dsh-ma-menu .dsh-ma-menu-head b { font-size: 14px; font-weight: 700; }
div.dsh-ma-menu .dsh-ma-menu-dev {
  font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #6b7280);
  max-width: 52%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
div.dsh-ma-menu .dsh-ma-menu-sec {
  font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #57606a);
  margin: 10px 0 4px;
}
div.dsh-ma-menu .dsh-ma-menu-sub { font-size: 12px; color: var(--dsw-alias-label-tertiary, #6b7280); }
div.dsh-ma-menu .dsh-ma-menu-sub b { font-weight: 600; color: var(--dsw-alias-label-primary, #111); }
div.dsh-ma-menu input[type="range"] {
  width: 100%; margin: 8px 0 2px; height: 28px;
  accent-color: var(--dsw-alias-brand-primary, #4d6bfe);
}
div.dsh-ma-menu .dsh-ma-menu-ticks {
  display: flex; justify-content: space-between;
  color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 11px;
}
div.dsh-ma-menu .dsh-ma-menu-preview {
  margin-top: 8px; padding-top: 8px; font-size: 14px;
  border-top: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.22));
}
div.dsh-ma-menu .dsh-ma-menu-e2ee {
  display: flex; align-items: flex-start; gap: 8px;
  font-size: 12.5px; line-height: 1.6;
  background: var(--dsw-alias-bg-base, rgba(127,127,127,.08));
  border-radius: 10px; padding: 9px 11px;
}
div.dsh-ma-menu .dsh-ma-menu-e2ee .ico { flex: none; }
div.dsh-ma-menu .dsh-ma-menu-e2ee .txt { min-width: 0; overflow-wrap: anywhere; }
/* ⚠️ 必须显式写 [hidden]：UA 的 [hidden]{display:none} 会被上面的 display:flex 盖过（实测过）。 */
div.dsh-ma-menu .dsh-ma-e2ee-sec[hidden],
div.dsh-ma-menu .dsh-ma-menu-e2ee[hidden] { display: none !important; }
button.dsh-ma-fab .dsh-ma-fab-lock[hidden] { display: none !important; }
div.dsh-ma-menu .dsh-ma-menu-e2ee.is-warn .txt { color: var(--dsw-alias-label-warning, #9a6700); }
div.dsh-ma-menu .dsh-ma-menu-e2ee.is-err .txt { color: var(--dsw-alias-label-danger, #cf222e); }
div.dsh-ma-menu .dsh-ma-menu-e2ee a { color: var(--dsw-alias-brand-primary, #4d6bfe); }
button.dsh-ma-menu-back {
  display: block; width: 100%; box-sizing: border-box;
  margin-top: 12px; padding: 11px 12px;
  border-radius: 10px; border: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.3));
  background: var(--dsw-alias-button-elevated-fill, rgba(127,127,127,.08));
  color: var(--dsw-alias-label-primary, #111);
  font: 600 14px/1 -apple-system, system-ui, sans-serif;
  cursor: pointer; touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
button.dsh-ma-menu-back:active { transform: scale(.98); }
div.dsh-ma-menu .dsh-ma-menu-note {
  margin-top: 8px; font-size: 11.5px; line-height: 1.7;
  color: var(--dsw-alias-label-tertiary, #6b7280);
}

/* 会话过期引导条:镜像页在会话过期后只会"连不上"，这里给一句能照做的话 + 一个出口。
   非阻塞(顶部细条)，点关闭即消失；不拦截任何请求。 */
div.dsh-ma-sessionbar {
  position: fixed; left: 0; right: 0; top: 0;
  z-index: 402;
  display: flex; align-items: center; gap: 10px;
  padding: max(8px, env(safe-area-inset-top)) 12px 8px;
  background: #fff8e6; color: #7a4b00;
  border-bottom: .5px solid rgba(154,103,0,.35);
  font: 500 13px/1.5 -apple-system, system-ui, sans-serif;
  box-shadow: 0 2px 10px rgba(0,0,0,.12);
}
div.dsh-ma-sessionbar[hidden] { display: none; }
div.dsh-ma-sessionbar .msg { flex: 1 1 auto; min-width: 0; }
div.dsh-ma-sessionbar button {
  flex: none; padding: 6px 12px; border-radius: 8px; cursor: pointer;
  border: .5px solid rgba(154,103,0,.5); background: #fff; color: #7a4b00;
  font: 600 12.5px/1 -apple-system, system-ui, sans-serif;
}

/* 官方 E2EE 徽标(#dsh-e2ee-badge，shim 注入的右上角小药丸)已并入本菜单:
   隐藏独立徽标，状态显示在悬浮按钮的锁图标与菜单的「加密状态」行里。 */
html[data-dsh-ma-merged-e2ee] #dsh-e2ee-badge { display: none !important; }

/* 桌面宽屏(>820px):只有上面这些 .dsh-ma-* 元素可见(悬浮按钮/菜单/引导条)，
   官方界面本身不受任何影响。 */
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
      !!document.querySelector("[data-shell-overlay], [data-sidebar-collapsed], [data-details-collapsed], [data-rightbar-collapsed]");

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
    } catch (e3) { /* 私有模式等:忽略 */ }

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

    /* 悬浮按钮/菜单：任何宽度都要有（电脑端访问镜像页同样需要「返回设备列表」的出口），
       与手机端布局改造分开守门；失败也不影响布局适配。 */
    let fabDone = false;
    const buildRemoteMenu = () => {
      /* ===== 统一「远程控制」悬浮按钮：字号 + 加密状态 + 返回设备列表 =====
         2026-09-19 用户要求原话：「把字体的菜单和加密小锁的菜单合并成一个小悬浮按钮；点击后可以弹菜单
         调节字体，也可以返回设备拉取列表，让用户主动返回回去，这一点很重要」「手机端要有，电脑端也可以有」。
         要点：
           · 与「手机端布局改造」分开守门：本段只要求 HOSTISH（确实是官方 dsh web 页），不看 NARROW；
           · z-index 400/401 高于遮罩(290)与抽屉(300)：万一日后官方再改版把遮罩判错，
             用户仍然点得到这颗按钮 → 能主动返回设备列表（唯一自救出口）；
           · 加密状态来自 E2EE shim 的 #dsh-e2ee-badge：本层只**读**状态并隐藏那颗独立药丸，
             不碰加解密逻辑（耦合面最小：window.__dshE2eeBadge + dsh-e2ee-badge 事件）。 */
      const FS_KEY = "dsh-ma-font-scale";
      const FS_LEVELS = [
        { name: "最小", scale: 1.00, content: 14 },
        { name: "中",   scale: 1.08, content: 15 },
        { name: "大",   scale: 1.18, content: 16.5 },
        { name: "超大", scale: 1.32, content: 18.5 }
      ];
      const readFsLevel = () => {
        try {
          const raw = window.localStorage && window.localStorage.getItem(FS_KEY);
          const i = Number(raw);
          return Number.isInteger(i) && i >= 0 && i < FS_LEVELS.length ? i : 0;
        } catch (e) { return 0; }
      };
      const applyFsLevel = (level) => {
        const L = FS_LEVELS[level] || FS_LEVELS[0];
        const root = document.documentElement;
        if (level === 0) root.removeAttribute("data-dsh-ma-fs");
        else root.setAttribute("data-dsh-ma-fs", String(level));
        // 官方聊天正文:直接喂它自己的变量(它就是这样取值的)
        try {
          root.style.setProperty("--dsh-content-font-size", L.content + "px");
          root.style.setProperty("--dsh-content-font-delta", (L.content - 14) + "px");
        } catch (e2) { /* 忽略 */ }
        return L;
      };
      /* 当前设备 id:镜像页路径形如 /remote/<deviceId>/…（旧入口是根路径 → 留空不显示） */
      const deviceIdOfPath = () => {
        try {
          const parts = String(window.location.pathname || "").split("/").filter(Boolean);
          if (parts[0] !== "remote" || !parts[1]) return "";
          return decodeURIComponent(parts[1]);
        } catch (e) { return ""; }
      };
      const gotoApp = (to) => {
        try { window.location.assign(to); } catch (e) { try { window.location.href = to; } catch (e2) { /* 忽略 */ } }
      };
      const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

      const menu = document.createElement("div");
      menu.className = "dsh-ma-menu";
      menu.hidden = true;
      menu.setAttribute("role", "dialog");
      menu.setAttribute("aria-label", "远程控制菜单");
      menu.innerHTML =
        '<div class="dsh-ma-menu-head"><b>远程控制</b><span class="dsh-ma-menu-dev"></span></div>' +
        '<div class="dsh-ma-menu-sec">显示字号</div>' +
        '<div class="dsh-ma-menu-sub">当前 <b class="dsh-ma-menu-fsval">最小</b> · 只影响这台设备的远程页面</div>' +
        '<input type="range" min="0" max="3" step="1" value="0" aria-label="显示字号">' +
        '<div class="dsh-ma-menu-ticks"><span>最小</span><span>中</span><span>大</span><span>超大</span></div>' +
        '<div class="dsh-ma-menu-preview">预览：手机远程控制，随手可用。</div>' +
        '<div class="dsh-ma-e2ee-sec" data-role="e2ee-sec">' +
          '<div class="dsh-ma-menu-sec">加密状态</div>' +
          '<div class="dsh-ma-menu-e2ee" data-role="e2ee"><span class="ico">🔒</span><span class="txt">正在读取…</span></div>' +
        '</div>' +
        '<button type="button" class="dsh-ma-menu-back">← 返回设备列表</button>' +
        '<div class="dsh-ma-menu-note">返回后可重新选择设备；端到端加密需在设备列表页重新解锁（会话密钥只存在本机内存里，刷新即失效）。</div>';
      document.body.appendChild(menu);

      const fab = document.createElement("button");
      fab.type = "button";
      fab.className = "dsh-ma-fab";
      fab.setAttribute("aria-label", "远程控制菜单");
      fab.innerHTML = '<span class="dsh-ma-fab-ico">字</span><span class="dsh-ma-fab-lock" data-role="lock">🔒</span>';
      document.body.appendChild(fab);

      const fsRange = menu.querySelector('input[type="range"]');
      const fsVal = menu.querySelector(".dsh-ma-menu-fsval");
      const fsPreview = menu.querySelector(".dsh-ma-menu-preview");
      const setLevel = (level, persist) => {
        const L = applyFsLevel(level);
        if (fsVal) fsVal.textContent = L.name;
        if (fsRange && Number(fsRange.value) !== level) fsRange.value = String(level);
        if (fsPreview) fsPreview.style.fontSize = L.content + "px";
        if (persist) { try { window.localStorage && window.localStorage.setItem(FS_KEY, String(level)); } catch (e3) { /* 忽略 */ } }
      };
      setLevel(readFsLevel(), false);

      /* ---- 加密状态：只读 E2EE shim 的徽标状态，并把它合并进本菜单 ---- */
      const e2eeSec = menu.querySelector('[data-role="e2ee-sec"]');
      const e2eeRow = menu.querySelector('[data-role="e2ee"]');
      const lockIcon = fab.querySelector('[data-role="lock"]');
      const renderE2ee = () => {
        let st = null;
        try { st = window.__dshE2eeBadge && window.__dshE2eeBadge.state ? window.__dshE2eeBadge.state() : null; } catch (e4) { st = null; }
        if (!st) {
          // shim 未注入（旧版 bridge / 自建关闭 E2EE）→ 整段隐藏（含标题），不留"正在读取…"这种误导文案
          if (e2eeSec) e2eeSec.hidden = true;
          if (e2eeRow) e2eeRow.hidden = true;
          if (lockIcon) lockIcon.hidden = true;
          return;
        }
        if (e2eeSec) e2eeSec.hidden = false;
        const mode = st.mode === "ok" ? "ok" : (st.mode === "err" ? "err" : "warn");
        if (e2eeRow) {
          e2eeRow.hidden = false;
          e2eeRow.className = "dsh-ma-menu-e2ee" + (mode === "ok" ? "" : mode === "err" ? " is-err" : " is-warn");
          const ico = e2eeRow.querySelector(".ico");
          const txt = e2eeRow.querySelector(".txt");
          if (ico) ico.textContent = mode === "ok" ? "🔒" : "⚠";
          if (txt) txt.textContent = st.text || (mode === "ok" ? "已加密" : "未加密");
        }
        if (lockIcon) { lockIcon.hidden = false; lockIcon.textContent = mode === "ok" ? "🔒" : "⚠"; }
      };
      try {
        // 合并成功后隐藏独立药丸（CSS 认 html[data-dsh-ma-merged-e2ee]）
        if (window.__dshE2eeBadge) document.documentElement.setAttribute("data-dsh-ma-merged-e2ee", "1");
        document.addEventListener("dsh-e2ee-badge", renderE2ee);
        window.addEventListener("dsh-e2ee-badge", renderE2ee);
      } catch (e4b) { /* 忽略 */ }
      renderE2ee();
      [600, 2000, 5000].forEach((ms) => setTimeout(renderE2ee, ms)); // shim 可能晚于本层挂牌

      /* ---- 交互 ---- */
      const closeMenu = () => { menu.hidden = true; };
      const openMenu = () => { renderE2ee(); menu.hidden = false; };
      fab.addEventListener("click", (e) => {
        e.stopPropagation(); e.preventDefault();
        if (menu.hidden) openMenu(); else closeMenu();
      });
      menu.addEventListener("click", (e) => e.stopPropagation());
      if (fsRange) {
        fsRange.addEventListener("input", (e) => { e.stopPropagation(); setLevel(Number(fsRange.value), true); });
        fsRange.addEventListener("click", (e) => e.stopPropagation());
        fsRange.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
      }
      const backBtn = menu.querySelector(".dsh-ma-menu-back");
      if (backBtn) {
        backBtn.addEventListener("click", (e) => {
          e.stopPropagation(); e.preventDefault();
          // 绝对路径：镜像页当前路径可能是 /remote/<deviceId>/…，必须回到 APP 外壳的根
          gotoApp("/app/");
        });
      }
      // 点菜单外部关闭（菜单内的事件都 stopPropagation）
      document.addEventListener("click", (e) => {
        if (menu.hidden) return;
        const t = e.target;
        if (t === fab || (t && t.closest && t.closest(".dsh-ma-menu, .dsh-ma-fab"))) return;
        closeMenu();
      });
      const devEl = menu.querySelector(".dsh-ma-menu-dev");
      if (devEl) {
        const d = deviceIdOfPath();
        if (d) devEl.textContent = d; else devEl.hidden = true;
      }

      /* ===== 会话过期引导（非阻塞） =====
         镜像页的会话（dsh_token）过期后，官方客户端只会表现为"连不上/一直重试"，用户看不到任何解释。
         这里**只观察**同源 API 的 401/403 响应（不拦截、不改写、不读 body），连续两次就给一条可点的
         提示条：「登录状态已过期 → 去重新登录」（跳到 /app/ 由外壳决定是回设备列表还是回登录页）。 */
      try {
        if (!window.__dshMaSessionWatch) {
          window.__dshMaSessionWatch = true;
          const bar = document.createElement("div");
          bar.className = "dsh-ma-sessionbar";
          bar.hidden = true;
          bar.innerHTML = '<span class="msg">登录状态已过期，请返回设备列表重新登录。</span>' +
            '<button type="button" data-role="go">去重新登录</button>' +
            '<button type="button" data-role="close" aria-label="关闭">✕</button>';
          document.body.appendChild(bar);
          bar.addEventListener("click", (e) => {
            const t = e.target;
            if (!t || !t.getAttribute) return;
            const role = t.getAttribute("data-role");
            if (role === "go") gotoApp("/app/?reason=expired");
            if (role === "close") bar.hidden = true;
          });
          let strikes = 0;
          const noteStatus = (status) => {
            if (status !== 401 && status !== 403) { strikes = 0; return; }
            strikes += 1;
            if (strikes >= 2) bar.hidden = false;
          };
          const origFetch = window.fetch;
          if (typeof origFetch === "function") {
            window.fetch = function (input, init) {
              let url = "";
              try { url = typeof input === "string" ? input : (input && input.url) || ""; } catch (e5) { url = ""; }
              const p = origFetch.call(this, input, init);
              try {
                const abs = url.slice(0, 8).toLowerCase();
                const sameOrigin = !(abs.indexOf("http://") === 0 || abs.indexOf("https://") === 0) || url.indexOf(window.location.origin) === 0;
                const apiish = url.indexOf("/api/") >= 0 || url.indexOf("/remote/") >= 0 || url.indexOf("_devices") >= 0 || url.indexOf("_quota") >= 0;
                if (sameOrigin && apiish && p && typeof p.then === "function") {
                  p.then((res) => { try { noteStatus(res && res.status); } catch (e6) { /* 忽略 */ } },
                         () => { /* 网络错误不算会话过期 */ });
                }
              } catch (e7) { /* 忽略 */ }
              return p;
            };
          }
        }
      } catch (e8) { /* 引导条失败绝不能影响主功能 */ }
    };

    let done = false;
    const boot = () => {
      if (!HOSTISH()) return;
      /* 悬浮按钮/菜单：任何宽度都要有（电脑端访问镜像页时同样需要返回设备列表的出口）。
         失败也不影响手机端布局适配 —— 两条链路各自独立。 */
      if (!fabDone) { fabDone = true; try { buildRemoteMenu(); } catch (eFabDone) { /* 忽略 */ } }
      if (done || !NARROW()) return;
      const frame = document.querySelector(".pI_x6G_frame, [data-sidebar-collapsed], [data-details-collapsed], [data-rightbar-collapsed]");
      if (!frame || !frame.querySelector) return;
      done = true;
      frame.classList.add("dsh-ma-frame");

      /* 给 frame 子列打稳定标记(dsh-ma-*),规避官方类名前缀随构建变化。
         ⚠️ 必须先把**不是列**的节点剔掉（2026-09-19 事故根因）：
            · overlayLayer（data-shell-overlay / *overlayLayer*）= 官方 shell.overlay 宿主，inset:0 全屏，
              在 0.1.5-rc.2 里**始终**是 frame 的最后一个子元素；
            · 拖拽把手（*handle* / [data-side]）= 8px 宽绝对定位条（折叠时官方根本不渲染）。
           旧实现的"详情抽屉兜底 = 取 frame 最后一个子元素"会把 overlay 层当成抽屉：
           属性认不到 → 判成未折叠，overlay 全屏 → 几何可见 → 遮罩常亮拦住整屏。 */
      const isOverlayLayer = (el) => {
        try {
          if (el.hasAttribute && el.hasAttribute("data-shell-overlay")) return true;
          const c = typeof el.className === "string" ? el.className : "";
          return /overlaylayer/i.test(c);
        } catch (e) { return false; }
      };
      const isHandle = (el) => {
        try {
          if (el.hasAttribute && el.hasAttribute("data-side")) return true;
          const c = typeof el.className === "string" ? el.className : "";
          return /handle|resizer/i.test(c);
        } catch (e) { return false; }
      };
      const overlayLayer = () => frame.querySelector('[data-shell-overlay]');

      /* 第三列在官方 0.1.2-rc.1 叫 details、0.1.5-rc.2 起叫 rightbar —— 两个名字都认。 */
      const THIRD_COL_RE = /details|rightbar/i;
      let sidebar = null, details = null, center = null;
      const cols = [...frame.children].filter((c) => c instanceof HTMLElement && !isOverlayLayer(c) && !isHandle(c));
      for (const col of cols) {
        const cls = typeof col.className === "string" ? col.className : "";
        if (/sidebar/i.test(cls) || col.querySelector(".hHd-Xa_root, [aria-label*='侧边栏'], [aria-label*='sidebar' i]")) {
          col.classList.add("dsh-ma-sidebar"); sidebar = sidebar || col;
        } else if (THIRD_COL_RE.test(cls)) {
          col.classList.add("dsh-ma-details"); details = details || col;
        } else if (/center/i.test(cls)) {
          col.classList.add("dsh-ma-center"); center = center || col;
        }
      }
      if (!sidebar && cols[0]) { cols[0].classList.add("dsh-ma-sidebar"); sidebar = sidebar || cols[0]; }
      if (!center && cols[1]) { cols[1].classList.add("dsh-ma-center"); center = center || cols[1]; }
      /* 兜底:只在**剩下的候选列**里取最后一个（overlay/把手/已认领的列都已排除）——
         命中不到就老实放弃（details=null），绝不再把全屏层当抽屉。 */
      if (!details) {
        const rest = cols.filter((c) => c !== sidebar && c !== center);
        const cand = rest.length ? rest[rest.length - 1] : null;
        if (cand) { cand.classList.add("dsh-ma-details"); details = cand; }
      }

      const toggleSel = '[aria-label="打开侧边栏"], [aria-label="关闭侧边栏"], [aria-label="Open sidebar"], [aria-label="Close sidebar"]';
      const toggleOf = () => document.querySelector(toggleSel) || document.querySelector(".hHd-Xa_toggle");
      /* 官方用 data-sidebar-collapsed 表达折叠态，但写法有两种可能：只输出属性本身，
         或输出 attribute 的值（例如 =false）。旧实现只看 hasAttribute 是否存在，
         只兼容前一种：一旦官方用带值写法，就会被永久判定为「展开」→ 遮罩常亮且拦截点击、
         汉堡按钮被隐藏 → 手机端整屏阴影、点哪都没反应（用户实测）。
         这里改成读值，两种写法都能正确判断。 */
      const truthyAttr = (el, name) => {
        const v = el.getAttribute(name);
        if (v === null) return false;
        const s = String(v).trim().toLowerCase();
        return !(s === "" || s === "false" || s === "0" || s === "off" || s === "no");
      };
      const collapsed = () => truthyAttr(frame, "data-sidebar-collapsed");
      const expanded = () => !collapsed();

      /* 遮罩:点击 = 点官方 toggle(走官方 store,无私有状态) */
      const scrim = document.createElement("div");
      scrim.className = "dsh-ma-scrim";
      document.body.appendChild(scrim);
      scrim.addEventListener("click", (e) => {
        e.stopPropagation();
        userWantsOpen = false;                    // 用户明确要关(遮罩的作用就是关抽屉)
        const t = toggleOf();
        if (t) { t.click(); }
        /* 兜底 + 保险:无论官方 toggle 在不在,都确保"点空白处"能关掉/不再拦截 */
        document.documentElement.classList.remove("dsh-ma-sidebar-open", "dsh-ma-details-open", "dsh-ma-scrim-on");
      });

      /* 顶部小鲸鱼/菜单按钮 */
      const hamburger = document.createElement("button");
      hamburger.type = "button";
      hamburger.className = "dsh-ma-hamburger";
      hamburger.setAttribute("aria-label", "打开菜单");
      hamburger.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>';
      document.body.appendChild(hamburger);
      hamburger.addEventListener("click", (e) => {
        e.stopPropagation(); e.preventDefault();
        const nowOpen = document.documentElement.classList.contains("dsh-ma-sidebar-open");
        // 先登记用户意图:即便官方 toggle 不存在、或几何判定一时不满足,这次展开也必须成立
        userWantsOpen = !nowOpen;
        const t = toggleOf();
        if (t && !nowOpen) { t.click(); }        // 官方 toggle 存在 → 交给官方(state 一致)
        else if (t && nowOpen) { t.click(); }
        sync();                                   // 立刻按意图生效(不依赖官方属性回调)
      });

      /* 侧栏是否**真的**滑进了视口。这是"遮罩能不能拦截点击"的最后一道保险：
         只要官方属性语义与我们理解的不一致，光看属性就可能误判；而遮罩一旦拦截整屏，
         用户看到的就是"整屏阴影 + 点哪都没反应"。以实测几何为准，误判也不会挡住用户。 */
      const inView = (el) => {
        if (!el) return false;
        try { const r = el.getBoundingClientRect(); return !!r && r.right > 8 && r.width > 40; }
        catch (e2) { return false; }
      };
      /* 抽屉必须"像抽屉"：不是全屏层（overlay 层/主内容区都被排除在外）、不是拖拽把手、
         此刻真的在视口里。任一不满足 → 它就不该让遮罩拦截点击（0.1.5 事故的结构性防线）。 */
      const isDrawer = (el) => {
        if (!el || isOverlayLayer(el) || isHandle(el)) return false;
        try {
          const r = el.getBoundingClientRect();
          if (!r || r.width <= 40 || r.right <= 8) return false;
          return r.width < window.innerWidth * 0.98; // 全屏宽 = 主界面，不是抽屉
        } catch (e2) { return false; }
      };
      const sidebarInView = () => isDrawer(sidebar || document.querySelector(".dsh-ma-sidebar"));
      const detailsInView = () => isDrawer(details || document.querySelector(".dsh-ma-details, .dsh-ma-rightbar"));
      /* 第三列折叠态:官方 0.1.2-rc.1 是 data-details-collapsed,0.1.5-rc.2 起是 data-rightbar-collapsed;
         两个都认;都不存在(未来再改名)时**不当作展开**,只由几何判定决定(见 detailsInView)。 */
      const detailsCollapsed = () =>
        truthyAttr(frame, "data-details-collapsed") || truthyAttr(frame, "data-rightbar-collapsed");
      const detailsAttrKnown = () =>
        frame.hasAttribute("data-details-collapsed") || frame.hasAttribute("data-rightbar-collapsed");
      /* 状态来源（按优先级）：
         ① 用户意图 userWantsOpen —— 点菜单按钮打开 / 点遮罩关闭，期间**不被几何判定推翻**；
         ② 官方 frame 的 data 属性 —— 用户没表达意图时（初始、官方自己切换）以它为准。
         ⚠️ 上一版把"几何判定"直接作用在展开 class 上，等于「侧栏还没滑进来就不许展开」：
            点菜单按钮加 class → 动画未开始、rect 仍在屏外 → sync 立刻把 class 摘掉 → 抽屉永远打不开。
            现在只让几何判定决定**遮罩能否拦截点击**（最后一道保险），不再否决用户的展开意图。 */
      let userWantsOpen = null; // null=未表达意图（跟随官方）; true/false=用户已明确开/关
      let scrimTimer = 0, scrimWatchdog = 0;
      /* 遮罩闸门：**只有此刻真的看得见抽屉**才允许拦截点击。
         抽屉是滑入动画（.22s），所以同步判定必然"还看不见" —— 那一瞬间不下闸即可，
         真正的下闸交给下一帧与动画结束后的复核（applyScrim），既不误拦也不影响手感。
         另外 CSS 侧已收口成"只认 dsh-ma-scrim-on 一个闸"，不会再出现"某个 class 常亮 → 整屏被拦"。 */
      const scrimShouldBeOn = () => {
        const html = document.documentElement;
        if (html.classList.contains("dsh-ma-sidebar-open") && sidebarInView()) return true;
        if (html.classList.contains("dsh-ma-details-open") && detailsInView()) return true;
        return false;
      };
      const applyScrim = () => {
        try { document.documentElement.classList.toggle("dsh-ma-scrim-on", scrimShouldBeOn()); }
        catch (e2) { /* 忽略 */ }
      };
      /* 看门狗:遮罩一旦在拦截点击,就必须**始终**有抽屉在视口里;否则立刻摘掉。
         它防的是"未来官方再改名/再改结构"导致的同类死局 —— 用户被遮罩困住的代价太高,
         宁可多这一个每 800ms 的轻量校验（没有遮罩时自会停表）。 */
      const armScrimWatchdog = () => {
        if (scrimWatchdog) return;
        try {
          scrimWatchdog = setInterval(() => {
            applyScrim();
            const html = document.documentElement;
            if (!html.classList.contains("dsh-ma-scrim-on") && !html.classList.contains("dsh-ma-sidebar-open") && !html.classList.contains("dsh-ma-details-open")) {
              clearInterval(scrimWatchdog); scrimWatchdog = 0;
            }
          }, 800);
        } catch (e2) { scrimWatchdog = 0; }
      };
      const sync = () => {
        const open = userWantsOpen !== null ? userWantsOpen : expanded();
        document.documentElement.classList.toggle("dsh-ma-sidebar-open", open);
        /* 汉堡按钮**始终可见**：以前判定为"展开"时会把它 display:none 隐藏，
           于是判定一旦出错（或遮罩因异常常亮），用户既点不动内容、也没有任何入口 —— 死局。
           保持可见 + 点它可开可关（见其 click 处理），任何异常状态下都留一条出路。 */
        if (hamburger) hamburger.style.display = "";
        /* 第三列(详情/rightbar):属性说展开 **且** 真的是个在视口里的抽屉,才算展开。
           ⚠️ 这里就是 2026-09-19 的根因点:旧版只判属性 + inView,而官方 0.1.5 把属性改名后,
           被误标成 details 的 overlay 层(全屏)满足 inView → 遮罩常亮。现在多了 isDrawer 的结构约束。 */
        const dOpen = detailsAttrKnown() ? (!detailsCollapsed() && detailsInView()) : detailsInView();
        document.documentElement.classList.toggle("dsh-ma-details-open", dOpen);
        // 遮罩:同步先按当前几何下闸(抽屉已在视口内时无延迟),再在动画开始/结束后复核两次
        applyScrim();
        try {
          if (typeof requestAnimationFrame === "function") requestAnimationFrame(applyScrim);
          clearTimeout(scrimTimer);
          scrimTimer = setTimeout(applyScrim, 300);
        } catch (e2) { /* 忽略 */ }
        armScrimWatchdog();
      };
      try {
        new MutationObserver(sync).observe(frame, {
          attributes: true,
          attributeFilter: ["data-sidebar-collapsed", "data-details-collapsed", "data-rightbar-collapsed", "data-rightbar-fullscreen"],
        });
      } catch (e2) { /* 退化:仅在下次 boot 同步 */ }
      // 几何变化（旋转屏幕 / 窗口缩放 / 侧栏动画结束）也要重算，否则会把 boot 时的判定一直沿用
      try {
        window.addEventListener("resize", sync, { passive: true });
        window.addEventListener("orientationchange", sync, { passive: true });
        if (sidebar && typeof ResizeObserver === "function") new ResizeObserver(sync).observe(sidebar);
      } catch (e2) { /* 非关键 */ }
      sync();
      /* 兜底复核:官方模块异步挂载、字体/主题切换都会改尺寸 —— 断点各复核一次遮罩闸门。 */
      [400, 1200, 3000].forEach((ms) => setTimeout(applyScrim, ms));
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
            userWantsOpen = false;
            const togg = toggleOf();
            if (togg) setTimeout(() => { try { togg.click(); } catch (e5) { /* ignore */ } }, 0);
            setTimeout(sync, 0);
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
