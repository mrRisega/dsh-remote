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
 * ⚠️ 2026-09-19 手机端实测第二波修复(用户反馈,真机 390×844 + headless 复现):
 *   A) 微信语音转文字会**提前发送半截话**:官方输入区是 Lexical contenteditable
 *      ([data-composer-input]),它的 Enter 键位图自带的 IME 守卫只看
 *      `isComposing || keyCode===229 || (官方 compositionend 后 **10ms** 窗口)` ——
 *      而微信语音转文字没有标准的 compositionend 时序:实测 compositionend 之后 43ms 到达的
 *      Enter 已经 isComposing=false 且超出 10ms 窗口 → 官方按"用户要发送"处理。
 *      现在适配层在 **捕获阶段** 加了一层输入框专用守卫:① 任何宽度下,识别为"输入法确认"的
 *      Enter 一律 stopPropagation(官方收不到 → 不会发送;不 preventDefault,IME 自己的提交不受影响);
 *      ② ≤820px 时输入框里的 Enter **只换行不发送**(微信/Telegram 等手机 IM 的语义),
 *      发送只由官方发送按钮负责 —— 对"没有标准时序"的输入法一并根治。
 *      实测:守卫只 stopPropagation 时换行仍能插入、继续打字正常,点官方「发送」按钮仍能正常发出。
 *   B) 打开抽屉后点任何东西都没反应 + 右边一个白色框:根因是 `isDrawer()` 的几何判定
 *      只查 `r.right > 8`,而**向右滑出屏外的第三列**右边的坐标是很大的正数(实测 759),
 *      于是"完全看不见的详情列"被判成"展开的详情列" → `dsh-ma-details-open` 常亮 →
 *      那个空的 Details 面板(白色)滑进来盖住整屏,且它的 z-index(300) 与抽屉相同、
 *      DOM 顺序在后 → **压住抽屉吃掉了抽屉里所有点击**;scrim 同时也常亮拦掉剩余区域。
 *      现在:① `isDrawer()` 必须与视口**真正相交**(左右上下四边都查);
 *      ② 详情列不再"官方说展开就滑进来":手机端滑动显示它的唯一开关是**用户在正文区点过一下**
 *      (点工具行必然落在正文区)——"载入时官方就是展开的"多半是宽屏/上次会话遗留状态,
 *      手机端一进来就弹一个空白白面板正是用户报的白框;点空白(遮罩)即收回这个意图;
 *      ③ 遮罩不变量:只要遮罩在拦截点击而视口内没有任何可交互抽屉,立刻摘掉(800ms 看门狗 +
 *      300ms 复核),且**只摘遮罩不动展开 class**(不破坏抽屉的滑入动画与"点一下就打开")。
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
/* ===== 首屏加载提示（0.6.14）=====
   为什么要有它：镜像页首屏要拉 dsh web 的全部客户端插件（实测 ~14 MB，一个不可拆分的
   /plugins/?? 聚合请求），免费档限速下几十秒起步。此前页面上**只有官方那个转圈**，
   用户无法区分"在加载"和"卡死了"，只能反复刷新 —— 反而更慢。
   这里给一句人话提示 + 分阶段的补充说明，加载完成（或超时兜底）即自动移除。
   ⚠️ 刻意**不**放进 @media (max-width:820px)：Windows/桌面浏览器打开镜像页同样要等。
   ⚠️ pointer-events:none + 半透明：万一移除逻辑失效，也绝不挡住任何点击。 */
.dsh-ma-boot {
  position: fixed; inset: 0; z-index: 2147483000;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
  background: color-mix(in srgb, var(--dsw-alias-bg-base, #0f1115) 88%, transparent);
  backdrop-filter: blur(2px);
  pointer-events: none;
  font-family: inherit; text-align: center; padding: 24px;
  transition: opacity .3s ease;
}
.dsh-ma-boot[data-fading="1"] { opacity: 0; }
.dsh-ma-boot-spin {
  width: 34px; height: 34px; border-radius: 50%;
  border: 3px solid color-mix(in srgb, currentColor 22%, transparent);
  border-top-color: currentColor;
  animation: dsh-ma-boot-spin 1s linear infinite;
}
@keyframes dsh-ma-boot-spin { to { transform: rotate(360deg); } }
.dsh-ma-boot-title { font-size: 15px; font-weight: 600; }
.dsh-ma-boot-sub { font-size: 13px; line-height: 1.6; opacity: .75; max-width: 22em; }
.dsh-ma-boot-elapsed { font-size: 12px; opacity: .55; font-variant-numeric: tabular-nums; }

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
  /* ⚠️ 全部加 :not(.dsh-ma-details):万一某列被同时标成抽屉与详情列(官方改版导致,2026-09-19 在
     0.1.5-rc.2 上真的发生过:第三列里的 "Collapse right sidebar" 按钮被宽松探测命中),
     详情列的定位/层级必须赢 —— 否则抽屉一展开,那一列会被拉到 left:0 盖住抽屉,用户点哪都没反应。 */
  div.pI_x6G_sidebarCol:not(.dsh-ma-details), div.dsh-ma-sidebar:not(.dsh-ma-details) {
    position: fixed; left: 0; top: 0; bottom: 0; margin: 0;
    width: min(84vw, 340px); max-width: 92vw;
    z-index: 300; overflow: hidden;
    border-right: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.25));
    box-shadow: 0 10px 44px rgba(0,0,0,.26);
    transform: translateX(-103%);
    transition: transform .22s var(--ds-ease-in-out, ease);
  }
  html.dsh-ma-sidebar-open div.pI_x6G_sidebarCol:not(.dsh-ma-details),
  html.dsh-ma-sidebar-open div.dsh-ma-sidebar:not(.dsh-ma-details) { transform: none; }
  /* ⚠️ 抽屉展开时必须抬到详情列(第三列)之上 —— 两者同为 z-index:300 时按 DOM 顺序绘制,
     而第三列在 frame 里排在侧栏**之后**,于是"详情列滑进来"会整块压住抽屉:
     实测(2026-09-19 手机端)抽屉里每一行点下去命中的都是详情面板(_2ctAZa_empty),
     用户表现为「展开左边抽屉,无法选择历史会话,点任何东西都没有反应」。
     这里把抽屉抬到 310(>300 详情列,>290 遮罩):抽屉内的点击**永远**有效。 */
  html.dsh-ma-sidebar-open div.pI_x6G_sidebarCol:not(.dsh-ma-details),
  html.dsh-ma-sidebar-open div.dsh-ma-sidebar:not(.dsh-ma-details) { z-index: 310; }

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
  /* 位置由 JS 计算后写 inline left/top（默认右上角，可拖动；见 SCRIPT 里的 fabPos）；
     CSS 只给尺寸/层级/指针语义 —— 用 left/top 而不是 right/bottom，拖动才不会被"贴边"钉住。 */
  left: auto; top: auto; right: 10px; bottom: auto;
  z-index: 400;
  width: 46px; height: 46px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%;
  font: 600 15px/1 -apple-system, system-ui, sans-serif;
  background: var(--dsw-alias-button-elevated-fill, rgba(255,255,255,.96));
  border: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.3));
  box-shadow: 0 2px 12px rgba(0,0,0,.2);
  color: var(--dsw-alias-label-primary, #111);
  cursor: grab; touch-action: none; /* 触屏拖动不被页面滚动抢走 */
  user-select: none; -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
button.dsh-ma-fab:active { transform: scale(.94); }
button.dsh-ma-fab.dsh-ma-fab-dragging { cursor: grabbing; transform: scale(1.06); }
button.dsh-ma-fab .dsh-ma-fab-lock {
  position: absolute; top: -3px; right: -3px;
  font-size: 12px; line-height: 1; padding: 2px 3px; border-radius: 999px;
  background: var(--dsw-alias-bg-elevated, #fff);
  box-shadow: 0 0 0 .5px var(--dsw-alias-border-l3, rgba(127,127,127,.3));
}
/* 菜单卡片:fixed 贴右下，最大高度受限可滚动 */
div.dsh-ma-menu {
  position: fixed;
  /* 打开时按悬浮按钮的位置重算（按钮在上半屏→菜单挂下方；靠左→左对齐），见 placeMenu() */
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

  /* ===== 首屏加载提示（0.6.14）=====
     用户反馈：「普通用户加载进入镜像页面时等待时间较长，目前等待过程中一直在转圈」
     —— 官方那个转圈不告诉用户任何事。这里在**页面解析的第一时间**就挂上一条人话提示，
     并在官方 UI 就绪（或兜底超时）后自动移除。

     ⚠️ 必须放在所有主机判定（HOSTISH / NARROW）之前：首屏慢的正是这些判定等不到的时候。
     ⚠️ 只做提示，不做任何拦截：pointer-events:none，也没有遮罩语义。 */
  var maBootTip = null, maBootTimers = [], maBootStart = Date.now(), maBootElapsedTimer = 0, maBootWatchTimer = 0;
  function maBootSet(cls, text) {
    try { var n = maBootTip && maBootTip.querySelector(cls); if (n) n.textContent = text; } catch (e) { /* 忽略 */ }
  }
  function maBootShow() {
    try {
      if (maBootTip) return;
      if (!document.body) return; // 解析太早（body 还没出来）→ 交给 DOMContentLoaded 再挂
      maBootTip = document.createElement("div");
      maBootTip.className = "dsh-ma-boot";
      maBootTip.setAttribute("role", "status");
      maBootTip.setAttribute("aria-live", "polite");
      maBootTip.innerHTML =
        '<div class="dsh-ma-boot-spin" aria-hidden="true"></div>' +
        '<div class="dsh-ma-boot-title">正在加载远程桌面…</div>' +
        '<div class="dsh-ma-boot-sub">首次打开需要下载较完整的前端资源，请稍候</div>' +
        '<div class="dsh-ma-boot-elapsed">已等待 0 秒</div>';
      document.body.appendChild(maBootTip);
      // 秒表：让"到底等了多久"可见（用户据此判断是慢还是死了）
      maBootElapsedTimer = setInterval(function () {
        try {
          var s = Math.floor((Date.now() - maBootStart) / 1000);
          var n = maBootTip && maBootTip.querySelector(".dsh-ma-boot-elapsed");
          if (n) n.textContent = "已等待 " + s + " 秒";
        } catch (e) { /* 忽略 */ }
      }, 1000);
      maBootTimers.push(setTimeout(function () {
        maBootSet(".dsh-ma-boot-sub", "网络较慢时可能需要一两分钟；加载完成后会自动进入，不用重复刷新");
      }, 8000));
      maBootTimers.push(setTimeout(function () {
        maBootSet(".dsh-ma-boot-sub", "还在加载…如果长时间停在这里，可以下拉刷新重试（重复刷新不会更快）");
      }, 30 * 1000));
    } catch (e) { /* 提示失败绝不影响主功能 */ }
  }
  function maBootHide() {
    try {
      for (var i = 0; i < maBootTimers.length; i++) clearTimeout(maBootTimers[i]);
      maBootTimers = [];
      if (maBootElapsedTimer) { clearInterval(maBootElapsedTimer); maBootElapsedTimer = 0; }
      if (maBootWatchTimer) { try { clearInterval(maBootWatchTimer); } catch (e) { /* 忽略 */ } maBootWatchTimer = 0; }
      var tip = maBootTip;
      maBootTip = null;
      if (tip && tip.parentNode) {
        try { tip.setAttribute("data-fading", "1"); } catch (e) { /* 忽略 */ }
        setTimeout(function () { try { if (tip.parentNode) tip.parentNode.removeChild(tip); } catch (e) { /* 忽略 */ } }, 300);
      }
    } catch (e) { /* 忽略 */ }
  }
  /** 官方 UI 是否已经可用了（= 提示可以撤了）。 */
  function maBootLooksReady() {
    try {
      // ① 适配层认出来的官方 frame（与下方 boot() 同一组选择器）
      if (document.querySelector(".pI_x6G_frame, [data-sidebar-collapsed], [data-details-collapsed], [data-rightbar-collapsed]")) return true;
      // ② 出现输入框/会话区也算"进来了"（官方改版首选信号失灵时的兜底）
      return Boolean(document.querySelector('textarea, [contenteditable="true"], [role="textbox"]'));
    } catch (e) { return false; }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", maBootShow);
  } else {
    maBootShow();
  }
  // 轮询撤下：1s 一次，成本可忽略（只是两次 querySelector）；一旦撤下就自我停止。
  // 上限与"4 分钟兜底"对齐，避免页面异常时留下常驻定时器。
  maBootWatchTimer = setInterval(function () {
    if (maBootLooksReady()) { maBootHide(); return; }
    if (!maBootTip) { try { clearInterval(maBootWatchTimer); } catch (e) { /* 忽略 */ } maBootWatchTimer = 0; }
  }, 1000);
  maBootTimers.push(setTimeout(function () { maBootHide(); }, 240 * 1000));
  // 页面卸载/进 bfcache 时收干净（测试与真机都靠这条不留悬挂定时器）
  try {
    var maBootBye = function () { maBootHide(); };
    window.addEventListener("pagehide", maBootBye);
    window.addEventListener("unload", maBootBye);
  } catch (e) { /* 忽略 */ }

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

    /* ================= 手机端输入框(输入法/IME)防误发 =================
       用户实测反馈(2026-09-19,微信内置浏览器)：「用微信语音转文字输入时,它在自动整理文字的
       过程中会直接触发输入框的发送」—— 半截话被发出去。

       取证(真机官方 GUI 390×844 + CDP 注入 composition 复现):
         · 官方输入区 = Lexical contenteditable,根元素带 data-composer-input / role=textbox /
           aria-multiline / data-lexical-editor;官方键位图自己有一层 IME 守卫
           'isComposingEvent(event, recentlyComposing) = event.isComposing || event.keyCode===229
            || (composing || Date.now() < composingUntil)';但 compositionstart/end 只挂在编辑器根上,
           **composingUntil 窗口只有 10ms**;
         · 实测 compositionend → 43ms 后到达的 Enter:isComposing 已是 false、超出 10ms 窗口
           → 官方把它当成"用户点了发送" → 真的发出 session/prompt(带半截话);
         · 微信语音转文字的"自动整理"正是这个时序:它**没有标准的 compositionend 时序**
           (确认键常在 compositionend 之后几十上百毫秒才到,isComposing 也常为 false),
           所以官方那 10ms 窗口挡不住它。

       本层策略(两条一起,第二条是主推):
         ① **任何宽度**都装一层输入框专用守卫:识别出"这一下 Enter 其实是输入法确认"时,
            在**捕获阶段** stopPropagation —— 官方那一层根本收不到这个 keydown,自然不会发送。
            不改写事件、不 preventDefault:IME 自己的"提交候选/结束合成"动作照旧(乱 preventDefault
            反而会让某些输入法提交不了文本)。
            判定覆盖三种取证:event.isComposing===true / keyCode===229 / compositionend 之后 60ms 内。
         ② **≤820px(手机)时输入框里的 Enter 一律不发送,只换行**;发送交给官方发送按钮
            (微信/Telegram 等主流手机 IM 就是这个语义,用户按 Enter 的期望也是换行)。
            这样"没有标准 compositionend 时序"的输入法被**整类根治**:不再依赖任何 IME 事件
            来判断"能不能发",而是根本不给 Enter 发送语义。

       实现要点(为什么是"捕获阶段 + stopPropagation"):
         · 官方键位图挂在编辑器根(冒泡)与 React 根容器上;document 捕获阶段早于它们,
           stopPropagation 之后官方与 React 都收不到 → 发送逻辑不执行;
         · **只 stopPropagation、不 preventDefault**:浏览器默认动作不受影响,contenteditable 照旧
           插入换行 —— 实测真机 390×844:官方不发送,换行正常插入,继续打字正常;
           (若同时 preventDefault,则是"既不发也不换行",用户按 Enter 像坏了 —— 实测确认。)
         · 组合键(Ctrl/Cmd+Enter = 官方"强制提交")不拦,保留桌面/外接键盘语义;
         · **只作用于输入框**:命中判定走 [data-composer-input] /
           [role=textbox][aria-multiline] / Lexical 根(data-lexical-editor);
           其它地方(弹窗确认、表单提交、快捷键、侧栏搜索框)一律放行 —— 这是硬要求。
         · 非 Enter 的按键不拦(含合成期的其余 keydown):官方发送只认 event.key === "Enter",
           乱拦合成期的其它按键会伤到输入法自身(它与 Lexical 的合成记账有关)。
       实测验证(官方 GUI 390×844,CDP Input.imeSetComposition + dispatchKeyEvent):
         · 无守卫:compositionend 后 43ms 的 Enter → 真的发出(session/prompt) —— 复现用户 bug;
         · 有守卫:同一时序 → 不发送;合成中(isComposing=true)的 Enter → 不发送;
         · 有守卫 + 普通打字后按 Enter(手机窗口)→ 不发送,插入换行,可继续输入;
         · 有守卫时点官方 button[aria-label="Send message"] → 正常发送 —— 发送按钮没被改坏。 */
    (function installComposerEnterGuard() {
      /* compositionend 之后多久内的 Enter 仍算"输入法确认":官方只有 10ms(实测 43ms 就漏),
         这里取 60ms —— 几十毫秒级,只覆盖"合成刚结束"的那一下,毫秒级之外用户正常
         打字后按 Enter 不受影响(手机端本来就是换行,不受此窗口影响)。 */
      const IME_TAIL_MS = 60;
      const COMPOSER_SEL = '[data-composer-input],[role="textbox"][aria-multiline="true"],[data-lexical-editor="true"]';
      let composing = false;
      let composingEndedAt = 0;

      /** 事件目标是否落在官方输入框里;是则返回输入框宿主元素,否则 null。 */
      function composerHost(node) {
        try {
          if (!node || typeof node.closest !== "function") return null;
          const el = node.closest(COMPOSER_SEL);
          if (!el) return null;
          const ce = el.getAttribute("contenteditable");
          if (ce === "false") return null;                                  // 非可编辑态 → 不需要守卫
          if (ce === null && !el.hasAttribute("data-composer-input") && !el.hasAttribute("data-lexical-editor")) return null;
          return el;
        } catch (e) { return null; }
      }
      /** 先用 composedPath(兼容将来把输入区放进 shadow DOM 的改版),退回 e.target。 */
      function composerOf(e) {
        try {
          if (typeof e.composedPath === "function") {
            const path = e.composedPath();
            if (path && path.length) {
              for (let i = 0; i < path.length; i++) { if (composerHost(path[i])) return true; }
              return false;
            }
          }
        } catch (e2) { /* 忽略 */ }
        return !!composerHost(e.target);
      }
      const isImeEnter = (e) => {
        if (e.isComposing === true || e.keyCode === 229) return true;      // ① 标准 ② 部分安卓 IME 只给 229
        if (composing) return true;                                        // ③ 合成进行中
        return composingEndedAt !== 0 && (Date.now() - composingEndedAt) <= IME_TAIL_MS; // ④ 合成刚结束
      };

      try {
        /* 捕获阶段监听:输入区自己的 composition 事件先经过 document,不受 stopPropagation 影响 */
        document.addEventListener("compositionstart", function () { composing = true; composingEndedAt = 0; }, true);
        document.addEventListener("compositionend", function () { composing = false; composingEndedAt = Date.now(); }, true);
      } catch (e) { /* 忽略 */ }

      try {
        document.addEventListener("keydown", function (e) {
          try {
            if (!e || e.key !== "Enter") return;         // 官方发送只认 Enter;其它键一律不碰
            if (!composerOf(e)) return;                  // 不是输入框 → 弹窗/表单/快捷键一律放行
            const ime = isImeEnter(e);
            if (!ime) {
              if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl/Cmd+Enter = 官方"强制提交",保留
              if (!NARROW()) return;                          // 桌面宽屏:非 IME 的 Enter 保持官方语义(发送)
            }
            /* 只截断传播,不 preventDefault:
               官方(以及 React 根容器)收不到这一下 → 不会走发送逻辑;默认动作保留 → 该换行就换行。 */
            e.stopPropagation();
          } catch (e2) { /* 守卫出错绝不能把页面弄挂 */ }
        }, true);
      } catch (e) { /* 忽略 */ }
    })();

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

      /* ---- 悬浮按钮的位置：默认**右上角**（原来在右下角，正好压住输入框的发送按钮）；
              可拖动，位置按"最近的角 + 距边偏移"记忆 —— 旋转屏幕/换窗口宽度都不会跑到屏幕外。 ---- */
      const FAB_KEY = "dsh-ma-fab-pos";
      const FAB_SIZE = 46, FAB_EDGE = 10;
      const readFabPos = () => {
        try {
          const raw = window.localStorage && window.localStorage.getItem(FAB_KEY);
          const p = raw ? JSON.parse(raw) : null;
          if (p && (p.h === "left" || p.h === "right") && (p.v === "top" || p.v === "bottom")
            && typeof p.dx === "number" && typeof p.dy === "number") return p;
        } catch (e) { /* 忽略 */ }
        return null;
      };
      const defaultFabPos = () => ({ h: "right", v: "top", dx: FAB_EDGE, dy: FAB_EDGE });
      let fabPos = readFabPos() || defaultFabPos();
      const fabXY = (pos) => {
        const vw = window.innerWidth || 360, vh = window.innerHeight || 640;
        return {
          left: pos.h === "left" ? pos.dx : vw - FAB_SIZE - pos.dx,
          top: pos.v === "top" ? pos.dy : vh - FAB_SIZE - pos.dy,
        };
      };
      const clampFabXY = (xy) => {
        const vw = window.innerWidth || 360, vh = window.innerHeight || 640;
        return {
          left: Math.max(4, Math.min(xy.left, vw - FAB_SIZE - 4)),
          top: Math.max(4, Math.min(xy.top, vh - FAB_SIZE - 4)),
        };
      };
      const applyFabPos = () => {
        const xy = clampFabXY(fabXY(fabPos));
        fab.style.left = Math.round(xy.left) + "px";
        fab.style.top = Math.round(xy.top) + "px";
        return xy;
      };
      const saveFabPos = () => {
        try { window.localStorage && window.localStorage.setItem(FAB_KEY, JSON.stringify(fabPos)); } catch (e) { /* 忽略 */ }
      };
      /** 拖动落点 → "最近的角 + 偏移"（保留用户的意图，同时保证换尺寸后仍在屏内）。 */
      const fabPosFromXY = (xy) => {
        const vw = window.innerWidth || 360, vh = window.innerHeight || 640;
        const h = xy.left + FAB_SIZE / 2 < vw / 2 ? "left" : "right";
        const v = xy.top + FAB_SIZE / 2 < vh / 2 ? "top" : "bottom";
        return {
          h: h, v: v,
          dx: h === "left" ? Math.max(0, xy.left) : Math.max(0, vw - FAB_SIZE - xy.left),
          dy: v === "top" ? Math.max(0, xy.top) : Math.max(0, vh - FAB_SIZE - xy.top),
        };
      };

      const fab = document.createElement("button");
      fab.type = "button";
      fab.className = "dsh-ma-fab";
      fab.setAttribute("aria-label", "远程控制菜单（可拖动）");
      fab.title = "远程控制：字号 / 加密状态 / 返回设备列表（可拖动移动位置）";
      fab.innerHTML = '<span class="dsh-ma-fab-ico">字</span><span class="dsh-ma-fab-lock" data-role="lock">🔒</span>';
      fab.style.left = Math.round(clampFabXY(fabXY(fabPos)).left) + "px";
      fab.style.top = Math.round(clampFabXY(fabXY(fabPos)).top) + "px";
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
      /* 菜单跟随按钮：按钮在上半屏 → 菜单挂在它下方；按钮靠左 → 菜单左对齐（都不超出视口）。 */
      const placeMenu = () => {
        try {
          const r = fab.getBoundingClientRect();
          const vw = window.innerWidth || 360, vh = window.innerHeight || 640;
          const mr = menu.getBoundingClientRect();
          const mw = mr.width || Math.min(vw * 0.86, 320);
          const mh = mr.height || 300;
          const GAP = 8, EDGE = 8;
          menu.style.top = "auto"; menu.style.bottom = "auto";
          if (r.top + r.height / 2 < vh / 2) {
            menu.style.top = Math.round(Math.max(EDGE, Math.min(r.bottom + GAP, vh - mh - EDGE))) + "px";
          } else {
            menu.style.bottom = Math.round(Math.max(EDGE, vh - r.top + GAP)) + "px";
          }
          menu.style.left = "auto"; menu.style.right = "auto";
          if (r.left + r.width / 2 < vw / 2) {
            menu.style.left = Math.round(Math.max(EDGE, Math.min(r.left, vw - mw - EDGE))) + "px";
          } else {
            menu.style.right = Math.round(Math.max(EDGE, Math.min(vw - r.right, vw - mw - EDGE))) + "px";
          }
        } catch (e) { /* 定位失败不影响功能（退回 CSS 默认位置） */ }
      };
      const closeMenu = () => { menu.hidden = true; };
      const openMenu = () => { renderE2ee(); menu.hidden = false; placeMenu(); };
      let suppressClickUntil = 0; // 拖完的那一下不要当成"点击打开菜单"
      let tapHandledAt = 0;        // 轻点已在 pointerup 里处理过（避免 click 再翻一次）
      const toggleMenu = () => { if (menu.hidden) openMenu(); else closeMenu(); };
      fab.addEventListener("click", (e) => {
        e.stopPropagation(); e.preventDefault();
        if (Date.now() < suppressClickUntil) return;      // 刚拖完 → 不算点击
        if (Date.now() - tapHandledAt < 800) return;      // 轻点已在 pointerup 处理 → 不重复开合
        toggleMenu();                                     // 键盘/老浏览器兜底
      });
      menu.addEventListener("click", (e) => e.stopPropagation());

      /* ---- 拖动：pointer 事件 + 指针捕获（手指拖出按钮范围也不断线）；拖动阈值 6px 区分"点击"与"拖动" ---- */
      let fabDrag = null;
      fab.addEventListener("pointerdown", (e) => {
        if (e.button !== undefined && e.button !== 0) return; // 只认左键/单指
        const xy = clampFabXY(fabXY(fabPos));
        fabDrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: xy.left, oy: xy.top, moved: false };
        try { if (fab.setPointerCapture) fab.setPointerCapture(e.pointerId); } catch (e2) { /* 老浏览器忽略 */ }
        // ⚠️ 这里**不能** preventDefault：实测它会连带掐掉随后的 click 事件（Chrome 触摸语义），
        //    结果是"按钮点了没反应"。防滚动交给 CSS 的 touch-action:none，轻点交给 pointerup 处理。
      });
      fab.addEventListener("pointermove", (e) => {
        if (!fabDrag || e.pointerId !== fabDrag.id) return;
        const dx = e.clientX - fabDrag.sx, dy = e.clientY - fabDrag.sy;
        if (!fabDrag.moved && Math.abs(dx) + Math.abs(dy) < 6) return; // 阈值内视为点击（细微抖动不挪位）
        if (!fabDrag.moved) { fabDrag.moved = true; fab.classList.add("dsh-ma-fab-dragging"); closeMenu(); }
        const xy = clampFabXY({ left: fabDrag.ox + dx, top: fabDrag.oy + dy });
        fab.style.left = Math.round(xy.left) + "px";
        fab.style.top = Math.round(xy.top) + "px";
      });
      const endFabDrag = (e) => {
        if (!fabDrag || (e && e.pointerId !== undefined && e.pointerId !== fabDrag.id)) return;
        const moved = fabDrag.moved;
        fabDrag = null;
        try { fab.classList.remove("dsh-ma-fab-dragging"); } catch (e2) { /* 忽略 */ }
        if (!moved) {
          // 轻点（没超过拖动阈值）→ 在这里开合菜单：pointerdown 不再 preventDefault 之后，
          // 触摸场景的 click 并不总是可靠地跟上来，pointerup 才是稳的那个点。
          tapHandledAt = Date.now();
          toggleMenu();
          return;
        }
        fabPos = fabPosFromXY(clampFabXY({ left: parseFloat(fab.style.left) || 0, top: parseFloat(fab.style.top) || 0 }));
        saveFabPos();
        suppressClickUntil = Date.now() + 400; // 拖动结束后的 click 事件不算"点开菜单"
      };
      fab.addEventListener("pointerup", endFabDrag);
      fab.addEventListener("pointercancel", endFabDrag);
      fab.addEventListener("lostpointercapture", endFabDrag);
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
      try {
        window.addEventListener("resize", () => { applyFabPos(); if (!menu.hidden) placeMenu(); }, { passive: true });
        window.addEventListener("orientationchange", () => { applyFabPos(); if (!menu.hidden) placeMenu(); }, { passive: true });
      } catch (e9) { /* 忽略 */ }
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
            // 只认 401：中继对"会话失效"回 401，对"设备不属于本账号"回 403 —— 后者不是会话过期，
            // 拿它提示"请重新登录"会把人引到错误的动作上。
            if (status !== 401) { strikes = 0; return; }
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

    /* 适配层自己创建的「抽屉入口」引用(汉堡按钮 / 遮罩),提到 boot() 外层保存。
       为什么必须提到外层:官方 SPA 重渲染时会整片替换 body 子树,把这两个节点一起冲掉;
       留住引用才能在下面的「存在性看门狗」里把**同一个节点**补回去(节点不变 → 挂在它上面的
       click 处理、CSS 类、aria 属性全都原样保留,不会出现"补回来点不动"的假按钮)。 */
    let maHamburger = null, maScrim = null;

    /* 节点是否已经脱离文档。判不出来时一律当作"还在"—— 宁可不补,也绝不重复插入。 */
    const maDetached = (el) => {
      if (!el) return false;
      try { if (typeof el.isConnected === "boolean") return !el.isConnected; } catch (eConn) { /* 继续退化 */ }
      try {
        const b = document.body;
        if (b && typeof b.contains === "function") return !b.contains(el);
      } catch (eHas) { /* 继续退化 */ }
      return false;
    };

    /* —— 存在性看门狗:「建好了」不等于「一直都在」----------------------------------
       done=true 只保证**曾经**建出来过。官方在路由/会话切换时会重建 DOM 子树,我们的汉堡按钮
       与遮罩会跟着消失 —— 用户看到的就是"抽屉按钮用着用着又没了"。
       这里按**引用**补回(不是重建),只在窄屏做(宽屏本来就不需要抽屉入口)。
       幂等:节点还在文档里 → 什么都不做;boot 还没成功(引用为 null) → 同样什么都不做。 */
    const ensureDrawerChrome = () => {
      try {
        if (!NARROW() || !document.body) return;
        if (maDetached(maScrim)) document.body.appendChild(maScrim);
        if (maDetached(maHamburger)) document.body.appendChild(maHamburger);
      } catch (eChrome) { /* 补不回去也不能影响抽屉开合本身 */ }
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

      /* 第三列在官方 0.1.2-rc.1 叫 details、0.1.5-rc.2 起叫 rightbar —— 两个名字都认(真机两版都验过)。
         ⚠️ 刻意**不**依赖本机第三方插件(dsh-better-sidebar)写的 data-rightbar-col / data-dsh-center-col 标记:
            那不是官方契约,插件换版本或被卸载就会失灵。只认官方类名 + 结构。 */
      const THIRD_COL_RE = /details|rightbar/i;
      const isThirdCol = (col, cls) => THIRD_COL_RE.test(cls);
      /* ⚠️ 侧栏列的识别必须**排他 + 精确**,否则一列会被赋予两个身份(2026-09-19 在官方 0.1.5-rc.2 上实测到):
         第三列(rightbar)里有一颗按钮 aria-label="Collapse right sidebar",旧代码的宽松探测
         宽松探测 [aria-label*='sidebar' i] 把它当成了"这一列里有侧栏" → rightbar 同时挂上 dsh-ma-sidebar 与
         dsh-ma-details → 抽屉一展开,html.dsh-ma-sidebar-open div.dsh-ma-sidebar{transform:none;z-index:310}
         把 **rightbar** 也拉到 left:0 并盖在真抽屉之上(DOM 顺序在后) → 抽屉里点什么都命中详情面板,
         就是用户报的"白框压住抽屉"。而且它是**间歇性**的:那颗按钮只在右栏面板挂载时才渲染,
         实测 4 次启动里 3 次命中。现在的规则:
           ① 已经判定为第三列(rightbar/details 类名)的列,**绝不是**抽屉列;
           ② 类名含 sidebar 且不含 rightbar/details(0.1.2/0.1.5 的 pI_x6G_sidebarCol 都满足);
           ③ 退到结构信号:列里有官方侧栏组件根 .hHd-Xa_root,或有**整串**匹配的官方侧栏开合按钮
              (精确匹配,绝不再用 *="sidebar" 这种包含匹配 —— 那正是事故来源);
           ④ 同时给 CSS 加了 :not(.dsh-ma-details) 兜底:万一将来又标重,详情列的样式也必须赢。 */
      const SIDEBAR_RE = /sidebar/i;
      const NOT_SIDEBAR_RE = /rightbar|right-bar|details/i;
      const SIDEBAR_TOGGLE_SEL = '[aria-label="Open sidebar"], [aria-label="Close sidebar"], [aria-label="Collapse sidebar"], [aria-label="Expand sidebar"], [aria-label="打开侧边栏"], [aria-label="关闭侧边栏"], [aria-label="收起侧边栏"], [aria-label="展开侧边栏"]';
      const isSidebarCol = (col, cls) => {
        if (isThirdCol(col, cls)) return false;                       // ① 第三列绝不兼任抽屉列
        if (SIDEBAR_RE.test(cls) && !NOT_SIDEBAR_RE.test(cls)) return true; // ② 类名
        try {                                                          // ③ 结构兜底(类名前缀改名时)
          if (col.querySelector(".hHd-Xa_root")) return true;
          if (col.querySelector(SIDEBAR_TOGGLE_SEL)) return true;
        } catch (e) { /* 忽略 */ }
        return false;
      };
      let sidebar = null, details = null, center = null;
      const cols = [...frame.children].filter((c) => c instanceof HTMLElement && !isOverlayLayer(c) && !isHandle(c));
      /* 先把第三列认出来(它优先级最高、也最容易被误认),再从**剩下的**列里认抽屉与中央列。 */
      for (const col of cols) {
        const cls = typeof col.className === "string" ? col.className : "";
        if (isThirdCol(col, cls)) { col.classList.add("dsh-ma-details"); details = details || col; }
      }
      for (const col of cols) {
        if (col === details) continue;
        const cls = typeof col.className === "string" ? col.className : "";
        if (isSidebarCol(col, cls)) {
          col.classList.add("dsh-ma-sidebar"); sidebar = sidebar || col;
        } else if (/center/i.test(cls)) {
          col.classList.add("dsh-ma-center"); center = center || col;
        }
      }
      if (!sidebar) { const c = cols.find((x) => x !== details); if (c) { c.classList.add("dsh-ma-sidebar"); sidebar = c; } }
      if (!center) { const c = cols.find((x) => x !== details && x !== sidebar); if (c) { c.classList.add("dsh-ma-center"); center = c; } }
      /* 🔒 不变量:同一列绝不允许既是抽屉又是详情列。真出现(将来官方再改名)时**以详情列为准** ——
         抽屉还能用汉堡按钮开合,而"自己盖住自己"的详情列会让抽屉彻底点不动。 */
      if (sidebar && details && sidebar === details) {
        sidebar.classList.remove("dsh-ma-sidebar");
        sidebar = null;
        const c = cols.find((x) => x !== details);
        if (c) { c.classList.add("dsh-ma-sidebar"); sidebar = c; }
      }
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
      /* 侧栏折叠态。官方 0.1.2-rc.1 只在**折叠时**写 data-sidebar-collapsed,展开时把属性**移除**
         (实测:窄屏抽屉展开后 frame 上完全没有该属性);也兼容带值写法(=false/=true)与反向的
         data-sidebar-open。所以"属性不在"有两种含义 ——"展开"或"官方根本不叫这个名字" ——必须区分:
           · 只要**见过**它出现过(sidebarAttrSeen),就说明这个名字是活的 → 之后的"不在" = 展开;
           · 从没见过 → 认不到 → **当作收起**(0.6.9-beta.2 加入的兜底):离屏抽屉盖在内容上、
             遮罩跟着下闸才是真正会困住用户的形态,收起态至少还能用汉堡按钮打开。
         ⚠️ 注意 collapsed()/expanded() 只是"官方属性怎么表达"的**猜测**,只能用来**跟随官方**;
            "抽屉此刻是不是开着"适配层自己有确定答案(html 上的 dsh-ma-sidebar-open / 几何),
            凡是要据此做动作的地方(如自动收抽屉)都必须用后者 —— 见下面 autoClose 委托。 */
      let sidebarAttrSeen = false;
      const collapsed = () => {
        if (frame.hasAttribute("data-sidebar-collapsed")) { sidebarAttrSeen = true; return truthyAttr(frame, "data-sidebar-collapsed"); }
        if (frame.hasAttribute("data-sidebar-open")) { sidebarAttrSeen = true; return !truthyAttr(frame, "data-sidebar-open"); }
        return !sidebarAttrSeen;
      };
      const expanded = () => !collapsed();

      /* 遮罩:点击 = 点官方 toggle(走官方 store,无私有状态) */
      const scrim = document.createElement("div");
      scrim.className = "dsh-ma-scrim";
      document.body.appendChild(scrim);
      maScrim = scrim;                          // 供「存在性看门狗」在被官方冲掉后补回
      scrim.addEventListener("click", (e) => {
        e.stopPropagation();
        userWantsOpen = false;                    // 用户明确要关(遮罩的作用就是关抽屉)
        centerTouchedAt = 0; detailsSticky = false; // 顺带收回"要看详情"的意图(下次在正文里点一下即可恢复)
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
      maHamburger = hamburger;                  // 供「存在性看门狗」在被官方冲掉后补回
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
         用户看到的就是"整屏阴影 + 点哪都没反应"。以实测几何为准（isDrawer），误判也不会挡住用户。 */
      /* 抽屉必须"像抽屉"：不是全屏层（overlay 层/主内容区都被排除在外）、不是拖拽把手、
         **与视口真正相交**。任一不满足 → 它就不该让遮罩拦截点击（0.1.5 事故的结构性防线）。
         ⚠️ 2026-09-19 手机实测第二波:旧实现只查 r.right > 8,这对"向右滑出屏外"的第三列是
            **恒真**的 —— 抽屉滑出时右边坐标是很大的正数(实测 left=400,right=759,width=358),
            于是"完全看不见、一个像素都没露"的第三列被判成"展开的详情列":
              · dsh-ma-details-open 常亮 → 那个空的 Details 面板(白框)滑进来盖住整屏;
              · 它的 z-index(300) 与侧栏相同、DOM 顺序在侧栏之后 → 压住抽屉,抽屉里所有点击
                都命中详情面板(实测 elementFromPoint 命中 _2ctAZa_empty);
              · 同时 scrim 常亮 → 剩下没被盖住的地方也被拦掉。
            用户看到的就是「展开左边抽屉,无法选择历史会话,点任何东西都没反应 + 右边一个白框」。
            现在四边都查:必须与视口有实质重叠,整体滑出(左/右/上/下)一律不算"在视口里"。 */
      const isDrawer = (el) => {
        if (!el || isOverlayLayer(el) || isHandle(el)) return false;
        try {
          const r = el.getBoundingClientRect();
          if (!r || r.width <= 40 || r.height <= 20) return false;
          const vw = window.innerWidth || 0;
          const vh = window.innerHeight || 0;
          if (vw > 0 && r.left >= vw - 8) return false; // 整体在视口右侧之外(滑出的抽屉) —— 旧版漏的就是这条
          if (r.right <= 8) return false;               // 整体在视口左侧之外
          if (vh > 0 && r.top >= vh - 8) return false;  // 整体在视口下方之外
          if (r.bottom <= 8) return false;              // 整体在视口上方之外
          return r.width < vw * 0.98;                   // 全屏宽 = 主界面，不是抽屉
        } catch (e2) { return false; }
      };
      const sidebarInView = () => isDrawer(sidebar || document.querySelector(".dsh-ma-sidebar"));
      const detailsInView = () => isDrawer(details || document.querySelector(".dsh-ma-details, .dsh-ma-rightbar"));
      /* 第三列折叠态:官方 0.1.2-rc.1 是 data-details-collapsed,0.1.5-rc.2 起是 data-rightbar-collapsed;
         两个都认;都不存在(未来再改名)时**不当作展开**(见下面 detailsAttrLive)。 */
      const detailsCollapsed = () =>
        truthyAttr(frame, "data-details-collapsed") || truthyAttr(frame, "data-rightbar-collapsed");
      const detailsAttrKnown = () =>
        frame.hasAttribute("data-details-collapsed") || frame.hasAttribute("data-rightbar-collapsed");
      /* 官方这两个属性都是"折叠时才写,展开时**移除**"(实测 0.1.2-rc.1:展开态下属性消失)。
         所以"属性不在"既可能是"展开",也可能是"官方改名了,我们根本不认识这个属性"——必须区分:
           · 只要**见过**它出现过(detailsSeenCollapsed),就说明这个名字是活的 → 之后的"不在"= 展开;
           · 从没见过 → 不认识 → 一律不认(绝不把未知结构当成"展开的详情列",这是白框事故的根因)。
         data-rightbar-fullscreen 一并算作"这个名字是活的"的旁证(0.1.5 起第三列的另一种开合表达)。 */
      const detailsAttrLive = () =>
        detailsAttrKnown() || detailsSeenCollapsed || frame.hasAttribute("data-rightbar-fullscreen");
      /* 状态来源（按优先级）：
         ① 用户意图 userWantsOpen —— 点菜单按钮打开 / 点遮罩关闭，期间**不被几何判定推翻**；
         ② 官方 frame 的 data 属性 —— 用户没表达意图时（初始、官方自己切换）以它为准。
         ⚠️ 上一版把"几何判定"直接作用在展开 class 上，等于「侧栏还没滑进来就不许展开」：
            点菜单按钮加 class → 动画未开始、rect 仍在屏外 → sync 立刻把 class 摘掉 → 抽屉永远打不开。
            现在只让几何判定决定**遮罩能否拦截点击**（最后一道保险），不再否决用户的展开意图。 */
      let userWantsOpen = null; // null=未表达意图（跟随官方）; true/false=用户已明确开/关
      let scrimTimer = 0, scrimWatchdog = 0;
      /* ---- 详情列(第三列)在手机端的显示条件 ----------------------------------------
         ⚠️ 为什么不能"官方属性说展开就滑进来"(2026-09-19 白框事故的根因之一):
            详情列在手机端是**离屏浮层**,我们自己的 CSS 用 translateX(103%) 把它推到屏幕右侧外面,
            到底显不显示**完全由 dsh-ma-details-open 决定**。所以几何永远无法充当"要不要打开"的依据
            (它永远在屏外);反过来,旧实现用带缺陷的几何判定去决定是否滑入,就把
            "官方在宽屏/上次会话遗留的展开态(attr 缺失或 =false)"读成"现在就该显示",
            于是手机一载入就滑出一个**空的白色 Details 面板**盖住界面。
         现在的规则(唯一一条,很保守):
           官方说得清"此刻是展开的" **且** 用户在**主内容列**里点过至少一次 → 才滑入。
           为什么要求"用户点过主内容列":官方表达展开的方式有两种 —— 属性被移除,或写成 =false
           (实测 0.1.2-rc.1 是"收起才写属性";0.1.5 起第三列改名 rightbar,写法可能与旧版不同)。
           "载入时官方就是展开的"多半是宽屏/上次会话留下的状态,手机端一进来就弹一个空白白面板
           正是用户报的那个白框;而"用户在正文里点了一下"是**可靠且唯一的**用户意图信号
           (点工具行必然落在主内容列里)。这样两种写法都能正确处理,也不需要猜官方的时序。
           注:用户点过之后,官方若把属性收回(=收起),下面的 !detailsCollapsed() 立刻让它退出 ——
           关掉详情面板也是即时的。 */
      let detailsSeenCollapsed = false;  // 是否见过官方写出折叠态(证明这个属性名是活的)
      /* 手机端显示详情列的**唯一**依据:用户在主内容列里的点击(见下面 click 委托)。
         · centerTouchedAt:最近一次点击时间 —— 点工具行后官方通常在同一帧内把详情置为展开,
           给一个几秒窗口足够覆盖"点击 → 官方改属性 → 我们收到通知"的时序;
         · detailsSticky:一经用户动作显示过就粘住(官方没说收起之前不自己缩回去),
           否则那些 700/1600/…/12000ms 的兜底 re-sync 会在窗口过期后把面板又收起来。 */
      const CENTER_TOUCH_MS = 8000;
      let centerTouchedAt = 0;
      let detailsSticky = false;
      /* scrim 的"到底有没有在拦"以浏览器算出来的 pointer-events 为准(class 只是我们的意图) */
      const scrimBlocks = () => {
        const html = document.documentElement;
        if (!html.classList.contains("dsh-ma-scrim-on")) return false;
        try {
          const cs = window.getComputedStyle && scrim ? window.getComputedStyle(scrim) : null;
          const pe = cs && cs.pointerEvents;
          if (typeof pe === "string" && pe !== "") return pe === "auto";
        } catch (e2) { /* 忽略 */ }
        return true; // 认不出实际样式 → 以 class 为准(保守:当成在拦)
      };
      const anyDrawerInView = () => sidebarInView() || detailsInView();
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
      /* 🔒 不变量(硬要求):遮罩只要在拦截点击,视口内就必须**存在**至少一层可交互抽屉;
         否则立刻摘掉遮罩。它不看任何判定链(属性/几何/class)的自洽性,只认"实际在拦 + 实际没有抽屉"
         这一对事实 —— 任何未来官方改名、结构变化都不会再变成"点哪都没反应"的死局。
         注意:**只摘遮罩,不动 dsh-ma-sidebar-open** —— 抽屉是滑入动画,动画途中本来就"还没进视口",
         顺手摘掉展开 class 会让抽屉永远打不开(0.6.6-beta.3 的回归点)。 */
      const enforceScrimInvariant = () => {
        try {
          if (!scrimBlocks()) return false;
          if (anyDrawerInView()) return false;
          document.documentElement.classList.remove("dsh-ma-scrim-on");
          return true;
        } catch (e2) { return false; }
      };
      /* 看门狗:遮罩一旦在拦截点击,就必须**始终**有抽屉在视口里;否则立刻摘掉。
         它防的是"未来官方再改名/再改结构"导致的同类死局 —— 用户被遮罩困住的代价太高,
         宁可多这一个每 800ms 的轻量校验（没有遮罩时自会停表）。 */
      const armScrimWatchdog = () => {
        if (scrimWatchdog) return;
        try {
          scrimWatchdog = setInterval(() => {
            if (enforceScrimInvariant()) { /* 不变量被触发:已摘掉遮罩 */ }
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
           保持可见 + 点它可开可关（见其 click 处理），任何异常状态下都留一条出路。
           它的 z-index(320) 高于抽屉(310)/详情列(300)/遮罩(290) —— 判定怎么错都点得到。 */
        if (hamburger) hamburger.style.display = "";
        /* 第三列(详情/rightbar)在手机端要不要滑进来:
           ① 属性说不清(官方未来再改名) → **不显示**,绝不靠几何去猜
              (0.1.5 事故:被误标成 details 的 overlay 层/滑出屏外的列满足"几何可见" → 遮罩常亮 + 白框);
           ② 见过官方写出折叠态 → 证明 details/rightbar 里有一个属性名是活的(见 detailsAttrLive);
           ③ 官方收起 → 立刻退出,并复位"用户要看详情"的粘性标记(下次点正文即可恢复)。 */
        if (detailsCollapsed()) { detailsSeenCollapsed = true; detailsSticky = false; }
        const touchedRecently = centerTouchedAt !== 0 && (Date.now() - centerTouchedAt) <= CENTER_TOUCH_MS;
        const dOpen = detailsAttrLive() && !detailsCollapsed() && (touchedRecently || detailsSticky);
        if (dOpen) detailsSticky = true;
        document.documentElement.classList.toggle("dsh-ma-details-open", dOpen);
        // 遮罩:同步先按当前几何下闸(抽屉已在视口内时无延迟),再在动画开始/结束后复核两次
        applyScrim();
        try {
          if (typeof requestAnimationFrame === "function") requestAnimationFrame(applyScrim);
          clearTimeout(scrimTimer);
          scrimTimer = setTimeout(() => { enforceScrimInvariant(); applyScrim(); }, 300);
        } catch (e2) { /* 忽略 */ }
        armScrimWatchdog();
      };
      /* 用户在主内容列里点一下 → 视为"他要看详情"(手机端显示详情列的唯一开关)。
         为什么必须由用户动作来解锁:官方表达"详情展开"的方式有两种 —— 属性被移除,或写成 =false,
         而"载入时官方就是展开的"多半是宽屏/上次会话留下的状态;手机端一进来就滑出一个空白白面板
         正是用户报的那个白框。点了正文之后才显示,两种写法都能正确处理,也不用去猜官方时序;
         用户点空白(遮罩)即收回这个意图(见 scrim 的 click 处理)。
         只认主内容列(.dsh-ma-center),不认抽屉/菜单/适配层自己的 UI —— 不会误触发。 */
      try {
        document.addEventListener("click", (e) => {
          try {
            if (!NARROW()) return;
            const t = e.target;
            if (!t || !t.closest) return;
            if (t.closest(".dsh-ma-sidebar, .dsh-ma-scrim, .dsh-ma-hamburger, .dsh-ma-fab, .dsh-ma-menu")) return;
            if (!t.closest(".dsh-ma-center, .pI_x6G_centerCol")) return;
            centerTouchedAt = Date.now();
            /* 只有"官方此刻就说详情是展开的"才需要立刻重算 —— 否则这一下点击改变不了任何显示,
               白跑一次 sync()(它要读几次 getBoundingClientRect)。官方稍后把详情置为展开时,
               frame 属性观察器会再触发一次 sync,那时 centerTouchedAt 已经记下了用户意图。 */
            if (detailsCollapsed()) return;
            sync();
          } catch (e2) { /* 忽略 */ }
        }, true);
      } catch (e2) { /* 忽略 */ }
      try {
        /* 观察 frame 的**全部属性**,再在回调里按名字筛(2026-09-19 手机实测后的加固):
           官方 0.1.5-rc.2 起表达抽屉开合的属性改过名(details→rightbar),将来还可能再改;
           用 attributeFilter 白名单就会"官方自己开了抽屉、适配层不知道" → 遮罩/class 与实际不符。
           这里改成名字级正则:任何含 sidebar/details/rightbar/collapsed/expand/open/fullscreen/shell
           的属性变动都会触发一次 sync —— 涵盖官方已知的两种命名(details / rightbar)与任何未来改名,
           而 window.addEventListener("resize"/"orientationchange") 与 700ms~12s 的兜底 re-sync
           继续覆盖"官方只改内联 gridTemplateColumns 而不动属性"的情况。 */
        const FRAME_ATTR_RE = /sidebar|details|rightbar|collapsed|expand|open|fullscreen|shell/i;
        new MutationObserver((records) => {
          try {
            for (let i = 0; i < records.length; i++) {
              const n = records[i].attributeName;
              if (n && FRAME_ATTR_RE.test(n)) { sync(); return; }
            }
          } catch (e3) { sync(); }
        }).observe(frame, { attributes: true });
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
      /* 窄屏抽屉:点选会话/在工作区里新建会话/进 Task Board 后自动收起(官方不做;适配层点官方 toggle)。
         ⚠️ 2026-09-19 回归(用户实测「选择工作区之后抽屉没有收回去」)根因就在这个闸门上:
            旧写法 if (!NARROW() || !expanded()) return; 用**官方属性**判断"抽屉是不是开着",
            而官方表达"展开"的方式恰恰是**把 data-sidebar-collapsed 移除** —— 于是抽屉一打开,
            expanded() 就变成 false(属性名认不到时更恒为 false),委托第一行直接 return,
            **所有**自动收起全部失效。现在改成用适配层自己的确定状态:
              · html.dsh-ma-sidebar-open —— 我们标记的展开态(汉堡按钮/官方切换都会走到 sync);
              · sidebarInView() —— 抽屉此刻**真的**在视口里(几何兜底,class 丢了也认)。
            两者任一成立就认为"抽屉开着,该收"。 */
      const drawerIsOpenNow = () =>
        document.documentElement.classList.contains("dsh-ma-sidebar-open") || sidebarInView();
      /* 点完就该收起抽屉的交互(基于 2026-09-19 真机 DOM 取证,只列**导航/切换上下文**的动作):
           · 会话行:div.YDXeBa_sessionRow[role="treeitem"][aria-selected]      → 切会话
           · 新建会话:aria-label="New session" / "New session in <工作区>"      → 新会话(后者=选择工作区并进入)
           · Task Board:aria-label="Task Board" / [data-dsh-taskboard-entry]    → 切到任务板主视图
         明确**不**收起的(都是"就地操作",收起会把用户正在看的东西一起收掉):
           · 工作区行本身 div.YDXeBa_projectRow[role="treeitem"][aria-expanded](无 aria-selected)
             —— 官方源码里它是 disclosure:onClick: onToggle → setGroupExpanded(group.key, !expanded),
             真机实测点 wikiStore:aria-expanded false→true、会话行 6→11 条。点它=展开/折叠该工作区的
             会话列表(用户正要看里面的会话),收抽屉会让"展开→看不到"。
             (用户说的"选择工作区"在抽屉里的真实入口是行内那颗 ⊕「New session in <工作区>」,
              它属于"新建会话"那一类,已被上面的选择器覆盖并有用例。)
           · 行内「⋯」Workspace actions / 展开折叠 / 滚动 / 勾选:都不是导航。 */
      const AUTO_CLOSE_SEL = [
        '[role="treeitem"][aria-selected]',
        '[aria-label*="新建会话"]',
        '[aria-label*="New session" i]',
        '[aria-label*="Task Board" i]',
        '[data-dsh-taskboard-entry]',
      ].join(",");
      if (!drawerAutoCloseOn) {
        drawerAutoCloseOn = true;
        document.addEventListener("click", (e) => {
          try {
            if (!NARROW() || !drawerIsOpenNow()) return;
            const t = e.target;
            if (!t || !t.closest) return;
            if (t.closest(".dsh-ma-scrim, .dsh-ma-hamburger")) return;
            if (!t.closest(".dsh-ma-sidebar")) return;       // 只处理抽屉内的点选
            if (!t.closest(AUTO_CLOSE_SEL)) return;          // 只认"导航/切换"类,就地操作不收起
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

    /* ================= 执行时机:无限期等待官方 DOM 就绪 =================
       用户实测原话(2026-09-2x):「在网络比较慢的情况下,左边的抽屉按钮有时候出不来。
                                   甭管网络有多慢,都要让那个抽屉能加载出来。」
       ⚠️ 旧实现是**一组写死的固定重试**([700, 1600, 3200, 7000, 12000]ms),而汉堡按钮的创建
          排在 boot() 里 "if (!frame) return;" 那一行之后 —— 官方 SPA bundle 有 13.4MB(实测未压缩),
          免费档被中继限速到 128KB/s 时冷启动要 1-2 分钟,官方 frame 在 12 秒内根本没出现:
          5 次重试全部在那一行返回 → done 永远为 false → 汉堡按钮**永远**不创建
          → 用户看到"左边抽屉按钮出不来"。任何固定窗口都只是把这个阈值往后挪,治不了根。
       现在改成「事件驱动 + 低频兜底」的**无限期**等待,只要抽屉入口还没建好就一直试:
         · MutationObserver(document/subtree):官方 frame 一挂上就立刻跟上(网络快时零延迟);
         · setInterval(1000ms):兜底 + 存在性看门狗 —— observer 不可用/被绕过时照样收敛,
           也负责在 done 之后发现官方重渲染冲掉了我们的节点并补回。
       两条路都只是"再调一次 pump()",pump 内部**全部幂等**(done / fabDone / whaleGuardsOn /
       settingsWatchOn / drawerAutoCloseOn 等守卫都在),重复调用不会产生任何副作用,
       也不改变"执行什么"——开合、遮罩不变量、sync()、isDrawer() 判定一行未动。 */
    let maTorn = false, maInterval = 0, maObserver = null, maRafPending = false;
    /* 廉价的"boot() 还有事可做吗"闸门(只读两个现成的布尔标志,不做任何 DOM 操作):
         · fab 还没建出来(fabDone=false) → 要跑;
         · 抽屉那段还没建好(done=false)且当前是窄屏 → 要跑(旋转/缩放回窄屏也能补建)。
       两者都不成立 → boot() 里已无事可做,**绝不能**再跑:boot() 第一行 HOSTISH() 会把
       documentElement.outerHTML 整个序列化一遍(最长 200KB),而官方流式输出时每帧都有 DOM
       变更 —— 没有这道闸门就会变成每秒几十次全量序列化(旧实现只跑 5 次,不会有这个问题)。 */
    const bootUseful = () => !fabDone || (!done && NARROW());
    const pump = () => {
      if (maTorn) return;
      if (bootUseful()) { try { boot(); } catch (eBoot) { /* 幂等重试 */ } }
      try { ensureDrawerChrome(); } catch (eChrome2) { /* 忽略 */ }
      if (!whaleGuardsOn || !settingsWatchOn) {
        try { whaleHookInit(); watchSettings(); } catch (eHook) { /* 两者内部都自带一次性守卫 */ }
      }
    };
    /* 节流:一次 DOM 变更往往产生几十条记录,逐条 boot() 就是忙轮询。
       统一合并成"本帧最多跑一次"(有 rAF 用 rAF,没有就退化成 0ms 宏任务) —— 天然去重。 */
    const schedulePump = () => {
      if (maTorn || maRafPending) return;
      maRafPending = true;
      const run = () => { maRafPending = false; pump(); };
      try { if (typeof requestAnimationFrame === "function") { requestAnimationFrame(run); return; } } catch (eRaf) { /* 退化 */ }
      setTimeout(run, 0);
    };
    /* 挂上"叫醒"的两条路。做成可重入(先清旧的再建新的),这样 bfcache 恢复后能重新武装。 */
    const maArm = () => {
      maTorn = false;
      maRafPending = false;            // 冻结时若有一帧没跑到,不清掉就会永远挡住后续调度
      try { if (maObserver) maObserver.disconnect(); } catch (eA1) { /* 忽略 */ }
      maObserver = null;
      try { if (maInterval) clearInterval(maInterval); } catch (eA2) { /* 忽略 */ }
      maInterval = 0;
      try {
        if (typeof MutationObserver === "function" && document.documentElement) {
          maObserver = new MutationObserver(schedulePump);
          /* 只观察 childList+subtree:节点被官方换掉/新增才叫醒我们。
             ⚠️ 刻意**不**观察 attributes —— 我们自己的 sync() 就会不停改 class,那会变成自激循环。 */
          maObserver.observe(document.documentElement, { childList: true, subtree: true });
        }
      } catch (eObs) { maObserver = null; /* 退化:只靠下面的兜底表 */ }
      try { maInterval = setInterval(pump, 1000); } catch (eInt) { maInterval = 0; }
    };
    maArm();
    /* 清理:页面卸载时断开观察者与兜底表(bfcache/长驻页面都不留悬挂回调)。
       pagehide 覆盖 bfcache 场景,unload 兜底更老的浏览器。 */
    const maTeardown = () => {
      maTorn = true;
      try { if (maObserver) maObserver.disconnect(); } catch (eD1) { /* 忽略 */ }
      maObserver = null;
      try { if (maInterval) clearInterval(maInterval); } catch (eD2) { /* 忽略 */ }
      maInterval = 0;
    };
    try { window.addEventListener("pagehide", maTeardown); } catch (ePh) { /* 忽略 */ }
    try { window.addEventListener("unload", maTeardown); } catch (eUl) { /* 忽略 */ }
    /* 手机上"切到别的 App 再切回来"走的常是 bfcache:pagehide(persisted=true) → pageshow(persisted=true)。
       DOM 原样保留但计时器/观察者已断 —— 这里重新武装,否则回到页面后看门狗就永久失灵了。 */
    try {
      window.addEventListener("pageshow", (ev) => { try { if (ev && ev.persisted) maArm(); } catch (ePs) { /* 忽略 */ } });
    } catch (ePs2) { /* 忽略 */ }
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
