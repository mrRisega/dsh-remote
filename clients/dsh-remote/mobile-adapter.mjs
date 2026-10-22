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
 *     6)【0.6.15】**手机图片上传兼容**:官方只把 image/png|jpeg|webp|gif 当图片(本地编码随 prompt
 *        发给模型),其余一律当普通文件后台上传 —— 模型于是"看不到图"。而手机最容易产出非白名单
 *        类型(iPhone「高效」= image/heic;部分 Android 图库给空 type)。适配层在**捕获阶段**拦下
 *        官方隐藏 input[type=file] 的 change,把这类文件**无损改 MIME**(扩展名可判时)或
 *        canvas 转 JPEG 后重新派发;任何失败都原样重发,绝不丢文件。详见脚本内长注释。
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
 * ⚠️ 官方 0.1.5-rc.2 起第三列改名(2026-09-19 线上故障,Windows 用户先撞到):
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
 * 🔴 2026-10-13 手机端设置面板「挤成一条竖线」根治(用户反馈,真机 390×844 + 本机 0.2 宿主实测):
 *   现象:窄屏打开「设置」,左侧 nav(通用设置/模型/内置插件/…)是一条竖列,右侧内容被压成
 *         四五字宽的竖条并向右溢出被裁。用户明确要求的目标形态:**tab 放顶部(横排)+ 下方内容满宽**。
 *   根因(实测数字):官方设置弹层是**桌面两栏**布局 —— 本机 0.2.0-rc.2(dsh-web-frontend
 *         0.2 + dsh-client-ui-settings-general 0.2)实测 panel 342×796、`nav` 188 宽(flex column)、
 *         `content` 可视宽只剩 **154px**。而适配层只挂了 `[class~="VOzbGW_*"]` 精确类,那是
 *         **0.1.2–0.1.5** 的混淆前缀;0.2 重新打包后前缀变成 **`Dws9Sa_*`**(结构、类名一一对应:
 *         Dws9Sa_overlay/panel/nav/navTitle/navList/navCell/content/header/close/options)
 *         → 整段设置区 CSS **静默失效**。这正是文件开头"类名变化退化策略"预言过的失效模式:
 *         页面照常打开、只有真机看得出布局坏,而且没人会收到任何信号。
 *   修法(三层识别,任一层命中即可成型,不再可能整段静默失效):
 *     ① 已知前缀:`[class~="VOzbGW_*"]` 与 `[class~="Dws9Sa_*"]` 并挂(CSS 与 JS 都改);
 *     ② **结构兜底**:JS 按 `[role=dialog]/[aria-modal] + 直接子 <nav> + 近似全屏` 认面板,
 *        再按"子元素最多者为 tab 列表"认 navList,打 `dsh-ma-settings-*` 稳定类,由 CSS 成型
 *        —— 前缀再改也是"仍然基本可用",而不是彻底坏掉;
 *     ③ CSS `:has()` 兜底(`div[role="dialog"]:has(> nav)` 等):支持 :has 的浏览器连 JS 都不等。
 *   降级诊断(**可见**,但不引入任何覆盖层 —— 护栏明令禁止):① 前缀认不出 → 报
 *     `console.warn("[dsh-mobile-adapter]", …注意 …混淆前缀已变化…)` 一次;② 有"大弹层"却认不出
 *     设置面板结构 → 报一次"手机端可能仍是桌面两栏布局"。两条都只在 ≤820px 发生。
 *   同批:窄屏**通用弹层**按手机尺寸收敛(`[role=dialog]/[role=alertdialog]/[aria-modal]/.dru-popup-card`
 *     宽 ≤ 100vw-24px、高 ≤ 100dvh-24px 且内部可滚、圆角收敛 12px),修掉"内容裁在右边"。
 *   ⚠️ 顺序有讲究:通用弹层规则必须排在设置弹层规则**之前** —— 两者特异性相同,靠顺序让
 *      "设置面板铺满全屏"赢(否则设置面板会被 100vw-24px 钉住,又变成带边的浮层)。
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

/**
 * 【可选】官方锚点清单 —— 供 scripts/check-ui-anchors.mjs 分类用(它直接读这个常量)。
 * 这些名字**存在就用、不存在就按结构/几何退化**,所以它们缺失**不算故障**:
 *   · data-details-collapsed —— 官方 0.1.5-rc.2 已改名 data-rightbar-collapsed,这里只为兼容旧版保留;
 *   · data-sidebar-open      —— 官方是否输出这个属性本身就不确定(见下面对 sidebarAttrSeen 的注释),
 *                               适配层刻意做了"认不到就只信几何"的分支;
 *   · data-rtt               —— 适配层**自己**的延迟角标属性(不是官方锚点),列出只为让自检脚本不去它身上找。
 * 约定:这里**只放**这种"缺了也无所谓"的锚点;凡是缺了会让布局坏掉的锚点,一律不要写进来。
 */
const OPTIONAL_UI_ANCHORS = ["data-details-collapsed", "data-sidebar-open", "data-rtt"];

const STYLE = `

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

  /* 🔒 0.6.18 白柱兜底（用户报的「点官方抽屉里的收起按钮 → 左半边一片白色占位，只有刷新能出去」）：
     **官方说收起 + 我们此刻没有活的展开意图** → 这一列一律留在屏外，不管别的 class 怎么说。
     为什么必须放在 CSS 层：那根白柱是 sidebarCol 被钉成 fixed + translateX(0) + z-index:310 的
     **空壳**（官方已把列宽压成 0、内容收起，只剩一个没有内容的白色固定柱盖住左半屏），
     而且它几何上"在视口里"，连遮罩不变量都会误判成"抽屉还在" → 整屏被困、只有刷新能出去。
     JS 侧已经会在官方收起时放弃过期意图（见 sync() 的 collapsedEdge 判定），这一条是不依赖任何
     JS 判定链的最后一道硬保证。
     ⚠️ 必须带 :not(.dsh-ma-user-wants-open)：用户明确要开时必须能开 —— 哪怕官方 toggle 坏了、
        属性永远停在"收起"（那是 0.6.9-beta.2 就定下的自救路径，护栏用例守着）。
        "官方收起 + 用户仍要开"是**合法**状态（离屏抽屉滑进来），不是白柱。 */
  html.dsh-ma-official-collapsed:not(.dsh-ma-user-wants-open) div.pI_x6G_sidebarCol:not(.dsh-ma-details),
  html.dsh-ma-official-collapsed:not(.dsh-ma-user-wants-open) div.dsh-ma-sidebar:not(.dsh-ma-details) { transform: translateX(-103%) !important; }

/*
   ══════════════════════════════════════════════════════════════════════════════
   🚫 这里**故意什么都不写** —— 第三列（官方右栏）的显示/隐藏完全交还给官方。
   ══════════════════════════════════════════════════════════════════════════════
   历史（2026-09-27 根治，用户拍板 B 方案）：
   0.6.13 起我们把这列改造成自绘浮层 —— position:fixed; right:0; width:min(92vw,400px);
   transform:translateX(103%)，再用 html.dsh-ma-details-open … { transform:none } 滑进来。
   因为"自绘浮层会白框压屏"（2026-09-19 故障），又加了一道很严的闸门（必须"用户 8 秒内
   在正文里点过"才允许滑入）；而 better-sidebar 这类插件只翻**它自己**的 store、官方
   cols.rightbar 永远是 0 → 闸门永远不开 → 于是又在悬浮菜单里补了颗「打开右侧栏」按钮。
   
   🔴 为什么这条路是错的（真机症状：点开之后整屏一层黑遮罩、看不到右栏内容）：
   官方右栏在窄屏**本来就是全屏浮层**，由官方自己做：
   · .P3OORG_panel[data-sidebar-right-panel=fullscreen]{ z-index:40; position:fixed; inset:0 }
   （见 @deepseek-ai/dsh-client-ui-sidebar-right）
   · 官方 ctx.layout.openRightbar(track, fullscreen) —— 窄屏打开时还会顺手收掉左栏
   （viewportWidth < 1024 → narrowExpanded = false）。
   而 CSS 里**只要祖先有 transform，就会给 position:fixed 的后代创建新的包含块** ——
   我们那行 translateX(103%) 于是把官方那个 inset:0 的全屏面板**一起推到屏幕外**；
   与此同时我们的闸门又把 dsh-ma-scrim-on（rgba(0,0,0,.32) 全屏遮罩）打开
   ⇒ 用户看到的正是"整屏变黑、什么也没有"。
   **官方本来就做对了，是我们把它挡住的。**
   
   现在的契约（护栏用例 mobile-adapter-guards 守着）：
   ① 适配层**不得**给第三列设 position / transform / width / z-index / 背景；
   ② 不得用类名（如 dsh-ma-details-open）驱动第三列的显隐；
   ③ 不得为第三列开遮罩；
   ④ 不再需要「打开右侧栏」按钮 —— 官方右栏自己的 tab / 会话头按钮就会调 openRightbar。
   宽屏时官方把它当普通 grid 列（computeColumns），窄屏时当全屏浮层 —— 两种都不需要我们插手。
   我们只保留 (.dsh-ma-details) 这个**标记**用于"别把第三列误认成左抽屉"（见上面的 :not 守卫）。
*/

  /* --- 展开遮罩(在浮层下、在官方弹层下) --- */
  div.dsh-ma-scrim {
    position: fixed; inset: 0; z-index: 290;
    background: rgba(0,0,0,.32);
    opacity: 0; pointer-events: none;
    transition: opacity .22s ease;
  }
  /* ⚠️ 拦截点击**只认 dsh-ma-scrim-on 这一个闸**（2026-09-19 回顾）：
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

  /* ===== 通用弹层(dialog/modal)按手机尺寸收敛(2026-10-13)=====
     官方弹层(设置 / 审批 / 确认 / 各类 modal)在桌面上写死 px 宽高,窄屏会右溢被裁;
     本项目自己的 .dru-popup 卡片同理。这里只加三条**尺寸**硬约束,不动配色与结构:
       · 宽 ≤ 100vw - 24px(两侧各留 12px)—— 用户报的"内容裁在右边"根治;
       · 高 ≤ 100dvh - 24px 且自身可滚(先写 100vh 给不认 dvh 的老浏览器兜底);
       · 窄屏圆角收敛到 12px(官方 --dsw-radius-panel 在手机上偏大)。
     ⚠️ 必须放在设置弹层规则**之前**:两者特异性相同,靠顺序让"设置面板铺满全屏"赢。 */
  [role="dialog"], [role="alertdialog"], [aria-modal="true"], .dru-popup-card {
    box-sizing: border-box;
    max-width: calc(100vw - 24px) !important;
    max-height: calc(100vh - 24px) !important;
    max-height: calc(100dvh - 24px) !important;
    border-radius: 12px !important;
    overflow: auto !important;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }
  /* .dru-popup 是遮罩层,卡片 .dru-popup-card 才是"弹窗":窄屏把 24px 外边距收到 12px */
  .dru-popup { padding: 12px !important; }
  .dru-popup-card { width: 100% !important; max-width: calc(100vw - 24px) !important; }

  /* ===== 设置弹层:窄屏「顶部横向 tab 行 + 下方内容区满宽」(2026-10-13 重写)=====
     🔴 根因(真机 390×844 实测,用户报「设置界面挤成一条竖线」):
        官方弹层是**桌面两栏** —— 0.2.0-rc.2 实测 panel 342×796、nav 188 宽竖排、
        content(内容区)只剩 **154px** 可视宽 → 内容被压成竖条并向右溢出被裁。
        旧实现只有 [class~="VOzbGW_*"](0.1.2–0.1.5 的混淆前缀);0.2.0-rc.2 重新打包后
        前缀变成 Dws9Sa_*,**整段 CSS 静默失效** —— 页面照常打开,只有真机看得出坏。
        所以识别分三层,任一层命中即可成型(这是"不再静默失效"的核心):
          ① 已知前缀 [class~="VOzbGW_*"] / [class~="Dws9Sa_*"](最短路径,随版本追加);
          ② JS 结构识别后打的稳定类 .dsh-ma-settings-*(role=dialog + 直接子 <nav> + 几何,
             见脚本里的 maTagSettingsDialog)—— 前缀再改也照样生效;
          ③ CSS :has() 兜底(div[role="dialog"]:has(> nav) 等),不必等 JS 就能成型。
     ⚠️ 全部 !important:官方模块 CSS 是**运行期**注入 head 的(晚于本 <style>),
        同特异性下后加载者赢 —— fix2 之前 nav 选择器"从未命中"正是这个原因。 */
  [class~="VOzbGW_overlay"], [class~="Dws9Sa_overlay"], .dsh-ma-settings-overlay,
  div[role="presentation"]:has(> div[role="dialog"] > nav) {
    position: fixed !important;
    inset: 0 !important;
    width: auto !important; max-width: none !important;
    height: auto !important; max-height: none !important;
    margin: 0 !important; padding: 0 !important;
    border-radius: 0 !important;
    box-sizing: border-box;
    justify-content: center; align-items: stretch;
  }
  /* 面板:nav 在上、content 在下的**竖排**,并铺满视口(圆角/外边距在窄屏收敛为 0) */
  [class~="VOzbGW_panel"], [class~="Dws9Sa_panel"], .dsh-ma-settings-panel,
  div[role="dialog"]:has(> nav) {
    box-sizing: border-box;
    width: 100% !important; max-width: 100% !important;
    height: 100% !important; max-height: 100% !important;
    margin: 0 !important; border-radius: 0 !important;
    flex-direction: column !important;
    overflow: hidden !important; /* 内层 options 自己滚 */
  }
  /* 顶部 tab 行:整行铺满,字号调小(≤13px),横向可滚动 */
  [class~="VOzbGW_nav"], [class~="Dws9Sa_nav"], .dsh-ma-settings-nav,
  div[role="dialog"] > nav {
    box-sizing: border-box;
    flex: none;
    width: 100% !important;
    flex-direction: row !important;
    align-items: center;
    gap: 4px;
    padding: max(4px, env(safe-area-inset-top)) 8px 6px;
    overflow: visible;
  }
  [class~="VOzbGW_navTitle"], [class~="Dws9Sa_navTitle"], .dsh-ma-settings-navtitle,
  div[role="dialog"] > nav > :first-child {
    flex: none;
    font-size: 13px !important; line-height: 1.2;
    padding: 0 4px 0 8px;
    white-space: nowrap;
  }
  [class~="VOzbGW_navList"], [class~="Dws9Sa_navList"], .dsh-ma-settings-navlist,
  div[role="dialog"] > nav > :last-child {
    box-sizing: border-box;
    flex: 1 1 auto; min-width: 0;
    flex-direction: row !important;
    gap: 4px;
    overflow-x: auto; overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    padding: 0 0 6px;
  }
  [class~="VOzbGW_navList"]::-webkit-scrollbar,
  [class~="Dws9Sa_navList"]::-webkit-scrollbar,
  .dsh-ma-settings-navlist::-webkit-scrollbar { display: none; }
  [class~="VOzbGW_navCell"], [class~="Dws9Sa_navCell"], .dsh-ma-settings-cell,
  div[role="dialog"] > nav > :last-child > * {
    flex: none; min-width: max-content;
    box-sizing: border-box;
    font-size: 13px !important;
    height: 32px !important;
    padding: 0 12px !important;
    white-space: nowrap;
  }
  /* 内容区:全宽拉满,收敛内边距,最大化有效宽度 */
  [class~="VOzbGW_content"], [class~="Dws9Sa_content"], .dsh-ma-settings-content,
  div[role="dialog"]:has(> nav) > div {
    box-sizing: border-box;
    width: 100% !important; max-width: none !important;
    flex: 1 1 auto; min-width: 0; min-height: 0;
  }
  [class~="VOzbGW_header"], [class~="Dws9Sa_header"], .dsh-ma-settings-header {
    box-sizing: border-box;
    flex: none;
    min-height: 40px; height: auto !important;
    padding: 6px 8px 4px 14px !important;
    align-items: center;
  }
  [class~="VOzbGW_close"], [class~="Dws9Sa_close"], .dsh-ma-settings-close {
    width: 32px !important; height: 32px !important;
  }
  [class~="VOzbGW_options"], [class~="Dws9Sa_options"], .dsh-ma-settings-options {
    box-sizing: border-box;
    flex: 1 1 auto; min-height: 0; overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 4px 14px calc(14px + env(safe-area-inset-bottom)) !important;
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
/* 手机图标（内联 SVG，0.6.18 起替代原来的「字」）：flex 居中，颜色继承按钮的 color
   （暗色主题/官方变量变化都跟着走），尺寸由 SVG 的 width/height 决定。 */
button.dsh-ma-fab .dsh-ma-fab-ico { display: flex; align-items: center; justify-content: center; color: inherit; }
/* 延迟角标：**必须**在 FAB 内部（绝对定位子元素）——右上角已经是 .dsh-ma-fab-lock 的位置
   （top:-3px;right:-3px），所以放正下方；也**不得**做成 body 级浮层（护栏：
   test/mobile-adapter-guards.test.mjs「提示行必须在菜单内、不得有固定层」）。
   pointer-events:none：角标压在按钮下沿外，别把按钮的拖动/轻点热区吃掉。 */
button.dsh-ma-fab .dsh-ma-fab-rtt {
  position: absolute; left: 50%; bottom: -13px; transform: translateX(-50%);
  font-size: 9.5px; line-height: 1; padding: 1px 4px; border-radius: 999px; white-space: nowrap;
  pointer-events: none;
  background: var(--dsw-alias-bg-elevated, #fff); color: var(--dsw-alias-label-tertiary, #6b7280);
  box-shadow: 0 0 0 .5px var(--dsw-alias-border-l3, rgba(127,127,127,.3));
}
button.dsh-ma-fab .dsh-ma-fab-rtt[hidden] { display: none !important; }
button.dsh-ma-fab .dsh-ma-fab-rtt[data-rtt="ok"] { color: var(--dsw-alias-label-success, #1a7f37); }
button.dsh-ma-fab .dsh-ma-fab-rtt[data-rtt="mid"] { color: var(--dsw-alias-label-warning, #9a6700); }
button.dsh-ma-fab .dsh-ma-fab-rtt[data-rtt="bad"] { color: var(--dsw-alias-label-danger, #cf222e); }
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
/* 网络延迟行（0.6.18）：与「加密状态」行同款方块，纯只读。
   ⚠️ 它**不是**测速：样本全部来自适配层已经包装过的 window.fetch（会话过期探测那一处），
   零新增请求；没有样本时显示「测速中…」而不是 0ms（0ms 是谎言，见 SCRIPT 里的注释）。 */
div.dsh-ma-menu .dsh-ma-menu-e2ee,
div.dsh-ma-menu .dsh-ma-menu-net {
  display: flex; align-items: flex-start; gap: 8px;
  font-size: 12.5px; line-height: 1.6;
  background: var(--dsw-alias-bg-base, rgba(127,127,127,.08));
  border-radius: 10px; padding: 9px 11px;
}
div.dsh-ma-menu .dsh-ma-menu-e2ee .ico,
div.dsh-ma-menu .dsh-ma-menu-net .ico { flex: none; }
div.dsh-ma-menu .dsh-ma-menu-e2ee .txt,
div.dsh-ma-menu .dsh-ma-menu-net .txt { min-width: 0; overflow-wrap: anywhere; }
div.dsh-ma-menu .dsh-ma-menu-net[data-rtt="ok"] .txt { color: var(--dsw-alias-label-success, #1a7f37); }
div.dsh-ma-menu .dsh-ma-menu-net[data-rtt="mid"] .txt { color: var(--dsw-alias-label-warning, #9a6700); }
div.dsh-ma-menu .dsh-ma-menu-net[data-rtt="bad"] .txt { color: var(--dsw-alias-label-danger, #cf222e); }
/* ⚠️ 必须显式写 [hidden]：UA 的 [hidden]{display:none} 会被上面的 display:flex 盖过（实测过）。 */
div.dsh-ma-menu .dsh-ma-e2ee-sec[hidden],
div.dsh-ma-menu .dsh-ma-menu-e2ee[hidden] { display: none !important; }
button.dsh-ma-fab .dsh-ma-fab-lock[hidden] { display: none !important; }
div.dsh-ma-menu .dsh-ma-menu-e2ee.is-warn .txt { color: var(--dsw-alias-label-warning, #9a6700); }
div.dsh-ma-menu .dsh-ma-menu-e2ee.is-err .txt { color: var(--dsw-alias-label-danger, #cf222e); }
div.dsh-ma-menu .dsh-ma-menu-e2ee a { color: var(--dsw-alias-brand-primary, #4d6bfe); }
button.dsh-ma-menu-back,
button.dsh-ma-menu-right {
  display: block; width: 100%; box-sizing: border-box;
  margin-top: 12px; padding: 11px 12px;
  border-radius: 10px; border: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.3));
  background: var(--dsw-alias-button-elevated-fill, rgba(127,127,127,.08));
  color: var(--dsw-alias-label-primary, #111);
  font: 600 14px/1 -apple-system, system-ui, sans-serif;
  cursor: pointer; touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
button.dsh-ma-menu-back:active,
button.dsh-ma-menu-right:active { transform: scale(.98); }
/* 「打开右侧栏」是本层**唯一**能主动把第三列（官方右栏）滑进手机的入口，
   用品牌色描边与「返回设备列表」区分开（后者是退路，前者是功能）。 */
button.dsh-ma-menu-right {
  margin-top: 8px;
  color: var(--dsw-alias-brand-primary, #4d6bfe);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 45%, transparent);
}
div.dsh-ma-menu .dsh-ma-menu-note {
  margin-top: 8px; font-size: 11.5px; line-height: 1.7;
  color: var(--dsw-alias-label-tertiary, #6b7280);
}
/* 加载疑似没完成时的一行提示 —— **只放进已有的「远程控制」菜单**，不新增任何层。
   2026-09-25 教训：首屏提示层（全屏覆盖 + 启发式退出）会永久盖住已加载完的界面，已整块删除。
   这里换成**安全的失败方向**：判断错了最坏只是菜单里多一行字，绝不遮挡、绝不拦截。 */
div.dsh-ma-menu .dsh-ma-load-warn {
  display: flex; gap: 8px; align-items: flex-start; margin-top: 8px; padding: 8px 10px;
  border-radius: 8px; cursor: pointer; font-size: 12px; line-height: 1.6;
  background: color-mix(in srgb, var(--dsw-alias-label-warning, #9a6700) 12%, transparent);
  color: var(--dsw-alias-label-warning, #9a6700);
}
div.dsh-ma-menu .dsh-ma-load-warn[hidden] { display: none !important; }
div.dsh-ma-menu .dsh-ma-load-warn .ico { flex: none; }
div.dsh-ma-menu .dsh-ma-load-warn .txt { min-width: 0; overflow-wrap: anywhere; }

/* ===== 旧浏览器兼容提示条（2026-10-18 真机事故）=====
   事故：iOS 16.1 / 17.3 的 Safari 打不开镜像页（缺 Promise.withResolvers / AbortSignal.any /
   甚至不支持新语法）。补不了的 API 已在注入体最前面尽量补齐；补不了的（语法级）用这条**顶部轻量条**
   明确告诉用户"升级系统或换浏览器"，而不是让他干等。
   安全边界：只占顶部一条、限高可滚、可关闭、不覆盖整屏、z-index 低于 FAB（400）—— 
   和「加载卡住」底部条同一套安全方向：判断错最坏只是多一条可关的提示，绝不遮挡主界面。 */
div.dsh-ma-compatbar {
  position: fixed; top: 0; left: 0; right: 0; z-index: 398;
  box-sizing: border-box;
  padding: calc(10px + env(safe-area-inset-top, 0px)) 14px 10px;
  max-height: min(42vh, 300px); overflow: auto;
  background: #fff8e6; color: #6b4a00;
  border-bottom: 1px solid rgba(154, 103, 0, .35);
  box-shadow: 0 2px 10px rgba(0, 0, 0, .12);
  font: 400 12.5px/1.65 -apple-system, system-ui, sans-serif;
  text-align: left;
}
div.dsh-ma-compatbar[hidden] { display: none !important; }
div.dsh-ma-compatbar .dsh-ma-compatbar-title { font-weight: 700; font-size: 13.5px; margin-bottom: 4px; }
div.dsh-ma-compatbar .dsh-ma-compatbar-detail { color: #7a5a10; word-break: break-word; }
div.dsh-ma-compatbar .dsh-ma-compatbar-hint { margin-top: 4px; color: #7a5a10; }
div.dsh-ma-compatbar .dsh-ma-compatbar-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
div.dsh-ma-compatbar button {
  min-height: 40px; padding: 8px 12px; border-radius: 8px;
  border: .5px solid rgba(154, 103, 0, .45); background: #fffdf5; color: #6b4a00;
  font: 600 12.5px/1 -apple-system, system-ui, sans-serif; cursor: pointer;
}
div.dsh-ma-compatbar button.primary { background: #9a6700; border-color: #9a6700; color: #fff; }
div.dsh-ma-compatbar button.dsh-ma-compatbar-x {
  position: absolute; top: calc(6px + env(safe-area-inset-top, 0px)); right: 8px;
  min-height: 32px; min-width: 36px; padding: 4px 8px; border: none; background: transparent;
  color: #7a5a10; font-size: 14px;
}

/* ===== 加载疑似卡住时的**可操作**底部提示条（2026-10-17 事故新增） =====
   事故现场：用户本机 ~/.dsh-remote（bridge 运行时 + 账号配对信息/设备密钥）被误删 → bridge 起不来、
   手机端镜像页第一次加载**干等 47 秒**才报错；页面上只有悬浮菜单里一行"已等 N 秒…复制给客服"，
   没有任何可点的操作。这里补一条**底部轻量提示条**（不是全屏层、不遮挡主界面）：
     · 只在 12 秒看门狗判定 slow 之后才**懒创建**（解析期一个节点都不往页面塞）；
     · 只占视口底部一条、高度受限（max-height），浮层外的区域照常可点 → 用户还能继续操作；
     · 三个按钮：重试 / 返回设备列表 / 复制诊断信息，外加 ✕ 关闭；关掉后本页不再弹；
     · 认出官方界面后自动收起（判断错了也不会一直挂着）——失败方向仍然安全：
       最坏只是底部多一条**可关闭**的提示，而不是"永远盖住整片界面"。
   动画只在「支持 prefers-reduced-motion 且用户没要求减少动效」时挂上：
   老浏览器不认识这个媒体查询 → 不匹配 → 无动画（无需用 matchMedia 判断，也不会有兼容异常）。 */
div.dsh-ma-loadbar {
  position: fixed;
  left: max(10px, env(safe-area-inset-left));
  right: max(10px, env(safe-area-inset-right));
  bottom: calc(10px + env(safe-area-inset-bottom));
  /* 低于 FAB(400) 与菜单(401)：提示条不得压住"自救出口"（悬浮按钮永远点得到） */
  z-index: 399;
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  box-sizing: border-box;
  width: auto;
  max-height: min(38vh, 260px);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-elevated, #fff);
  border: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.3));
  box-shadow: 0 6px 24px rgba(0,0,0,.24);
  color: var(--dsw-alias-label-primary, #111);
  font: 400 13px/1.5 -apple-system, system-ui, sans-serif;
}
/* ⚠️ 必须显式写 [hidden]：UA 的 [hidden]{display:none} 会被上面的 display:flex 盖过（本仓踩过）。 */
div.dsh-ma-loadbar[hidden] { display: none !important; }
div.dsh-ma-loadbar .dsh-ma-loadbar-txt { flex: 1 1 160px; min-width: 0; overflow-wrap: anywhere; }
div.dsh-ma-loadbar .dsh-ma-loadbar-actions { display: flex; flex-wrap: wrap; gap: 6px; }
div.dsh-ma-loadbar button {
  flex: none; padding: 8px 12px; border-radius: 9px; cursor: pointer;
  border: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35));
  background: var(--dsw-alias-button-elevated-fill, rgba(127,127,127,.08));
  color: var(--dsw-alias-label-primary, #111);
  font: 600 13px/1 -apple-system, system-ui, sans-serif;
  touch-action: manipulation; -webkit-tap-highlight-color: transparent;
}
div.dsh-ma-loadbar button:active { transform: scale(.98); }
div.dsh-ma-loadbar button.dsh-ma-loadbar-close {
  padding: 6px 9px; border-color: transparent; background: transparent;
  color: var(--dsw-alias-label-tertiary, #6b7280);
}
@media (prefers-reduced-motion: no-preference) {
  div.dsh-ma-loadbar { animation: dsh-ma-loadbar-in .18s ease-out; }
  @keyframes dsh-ma-loadbar-in {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: none; }
  }
}
/* 双保险：显式要求减少动效时一律无动画（老浏览器不匹配上面的 no-preference → 天然无动画） */
@media (prefers-reduced-motion: reduce) {
  div.dsh-ma-loadbar { animation: none !important; transition: none !important; }
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

/**
 * 悬浮按钮上的手机图标（0.6.18 起替代原来的「字」）。
 *
 * 为什么内联 SVG：仓库里**没有**可复用的手机图标 —— 全工作区唯一的 SVG 是
 * `image/icon.svg`（应用图标，含「远程控制」文字 + 显示器，viewBox 512，做 20px 图标不可用）；
 * 产品其它地方用的「手机图标」是 📱 emoji（client.js:804/4287），但 emoji 的字形与基线随系统变，
 * 放在 46×46 的圆形按钮里会偏。写法照本文件汉堡按钮（viewBox 24 + stroke="currentColor"），
 * 这样颜色跟着按钮的 color 走，暗色主题/官方变量变化都不用另写规则。
 */
const FAB_PHONE_SVG =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" aria-hidden="true">' +
  '<rect x="6" y="2.5" width="12" height="19" rx="3"/>' +
  '<path d="M10 5.5h4"/>' +
  '<circle cx="12" cy="18.6" r="1.1" fill="currentColor" stroke="none"/>' +
  "</svg>";

const SCRIPT = `(() => {
  "use strict";

  /* ===DSH-MA-COMPAT-START===
     旧浏览器兼容层（2026-10-18 真机事故）。
     事故：iPhone iOS 16.1 / 17.3 的 Safari 打开镜像页永远卡住、出不来对话界面 ——
     诊断上报抓到真实错误（mirror_diag）：
       · TypeError: Promise.withResolvers is not a function   （Safari 17.4+ 才有）
       · AbortSignal.any is not a function                    （Safari 17.4+ 才有）
       · SyntaxError: Unexpected token '{'（iOS 16.1 连新语法都解析不了 → 只能提示升级）
     DSH web 前端按现代浏览器构建；镜像页在**它的模块执行之前**补齐缺失的运行时 API，
     能让 iOS 17.x / 老 Safari 直接可用；补不了的（语法级不支持）明确提示用户升级/换浏览器。
     注入体纪律：本段不得出现反引号；只用 ES5 语法（老 Safari 也要能解析这段）。 */

  // ① 运行时 API 补齐（全部有 typeof 守卫，绝不覆盖已有实现）
  (function () {
    try {
      if (typeof Promise !== "undefined" && typeof Promise.withResolvers !== "function") {
        Object.defineProperty(Promise, "withResolvers", {
          configurable: true, writable: true,
          value: function () {
            var resolve, reject;
            var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
            return { promise: promise, resolve: resolve, reject: reject };
          }
        });
      }
    } catch (e) { /* 补齐失败不影响页面 */ }
    try {
      if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any !== "function") {
        AbortSignal.any = function (signals) {
          var ctrl = new AbortController();
          var list = [];
          try { list = Array.prototype.slice.call(signals || []); } catch (e2) { list = []; }
          for (var i = 0; i < list.length; i++) {
            try { if (list[i] && list[i].aborted) { ctrl.abort(list[i].reason); return ctrl.signal; } } catch (e3) { /* 忽略 */ }
          }
          function onAbort(e) {
            var sig = e && e.target;
            try { ctrl.abort(sig && sig.reason); } catch (e4) { try { ctrl.abort(); } catch (e5) { /* 忽略 */ } }
          }
          for (var j = 0; j < list.length; j++) {
            try {
              if (list[j] && typeof list[j].addEventListener === "function") {
                list[j].addEventListener("abort", onAbort, { once: true });
              }
            } catch (e6) { /* 忽略 */ }
          }
          return ctrl.signal;
        };
      }
    } catch (e) { /* 同上 */ }
    try {
      if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout !== "function") {
        AbortSignal.timeout = function (ms) {
          var ctrl = new AbortController();
          setTimeout(function () {
            try { ctrl.abort(new Error("TimeoutError")); } catch (e2) { try { ctrl.abort(); } catch (e3) { /* 忽略 */ } }
          }, Number(ms) || 0);
          return ctrl.signal;
        };
      }
    } catch (e) { /* 同上 */ }
    try {
      if (typeof Array.prototype.findLast !== "function") {
        Array.prototype.findLast = function (fn, thisArg) {
          for (var i = this.length - 1; i >= 0; i--) {
            if (fn.call(thisArg, this[i], i, this)) return this[i];
          }
          return undefined;
        };
      }
      if (typeof Array.prototype.findLastIndex !== "function") {
        Array.prototype.findLastIndex = function (fn, thisArg) {
          for (var i = this.length - 1; i >= 0; i--) {
            if (fn.call(thisArg, this[i], i, this)) return i;
          }
          return -1;
        };
      }
      if (typeof Array.prototype.toSorted !== "function") {
        Array.prototype.toSorted = function (cmp) { return this.slice().sort(cmp); };
      }
      if (typeof Array.prototype.toReversed !== "function") {
        Array.prototype.toReversed = function () { return this.slice().reverse(); };
      }
      if (typeof Object.hasOwn !== "function") {
        Object.hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
      }
    } catch (e) { /* 同上 */ }
  })();

  // ② 探测"补不了的"：语法级不支持（老 Safari 解析不到新版构建）→ 只能提示升级/换浏览器
  var maCompat = (function () {
    var why = "";
    try {
      // 静态块（Safari 16.4+）。CSP 禁 eval 时抛的是 EvalError 而非 SyntaxError —— 不能误判
      new Function("class __DshCompatProbe { static { this.ok = 1; } }");
    } catch (e) {
      if (e && e.name === "SyntaxError") why = "系统版本过旧（不支持现代 JavaScript 语法）";
    }
    var missing = [];
    try { if (typeof Promise.withResolvers !== "function") missing.push("Promise.withResolvers"); } catch (e2) { /* 忽略 */ }
    try { if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any !== "function") missing.push("AbortSignal.any"); } catch (e3) { /* 忽略 */ }
    if (!why && missing.length) why = "缺少浏览器能力：" + missing.join(" / ");
    return { ok: !why, why: why };
  })();
  /* ===DSH-MA-COMPAT-END=== */

  /* ===== 【0.6.16 已删除】首屏加载提示层（0.6.14 引入，0.6.15 仍在）=====
     为什么删掉（用户实测，2026-09-25）：「界面都已经加载完了，十几秒就把插件的接口加载好了，
     但这个遮罩一直不消失」—— 截图里官方 UI 就在下面透出来，秒表走到 187 秒。

     根因是**设计错误**，不是某个选择器写错：
       · 那是个 position:fixed / inset:0 / z-index:2147483000 的**全屏层**（88% 不透明背景 +
         backdrop-blur），视觉上盖住整个应用；
       · 它唯一的退出条件是 maBootLooksReady() 这组**DOM 启发式**（官方 frame 的
         data-*-collapsed / 类名前缀，或 textarea/[contenteditable]/[role=textbox]）。
         官方改版、会话尚未挂载输入框、或前缀变化时两组信号全不命中 → 层就永远留着。
       · 当时我给自己写的安慰是「pointer-events:none，万一移除失效也绝不挡住点击」——
         可对用户来说，**盖住视线和进不去没有区别**：刷新也一样，每次都要等 4 分钟兜底。
     结论（用户要求）：**直接删掉这个功能**。首屏反馈交给官方自己的转圈；
     我们不再在用户页面上放任何会覆盖整屏的东西 —— 这类层一旦判断失误就是"永远进不去"，
     代价远大于它带来的提示价值（何况限速放开后首屏本来就快了）。

     护栏见 test/mobile-adapter-guards.test.mjs：适配层不得再引入全屏覆盖层。 */
  void 0;


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

  /* ===== 「加载疑似没完成」看门狗（2026-09-25 起；2026-10-17 提速并改成**可操作**提示）=====
     历史：0.6.14 的首屏提示层是全屏覆盖 + 启发式退出 —— 判断错一次就把**已经加载完**的界面永久盖住
     （用户实测：秒表走到 187 秒，刷新也一样）。所以 0.6.16 换了安全的失败方向：只置 slow 标记，
     在**已有的**悬浮菜单里多一行字。这个方向本身是对的，但**提示太晚、且没有操作入口**——
     2026-10-17 真实事故：用户本机 ~/.dsh-remote（运行时 + 账号配对信息/设备密钥）被误删后，
     手机端镜像页第一次加载**干等 47 秒**才报错，页面上只有一行"已等 N 秒…复制给客服"，
     用户完全不知道该重新安装还是重新登录。

     现在（2026-10-17）：
       · 解析期仍然**不创建任何 DOM**（只有几个变量 + 一个定时器）—— 页面还没过主机门，
         更不该有任何覆盖层；
       · **12 秒**后仍认不出官方界面 → 置 slow + 显示**底部轻量提示条**（懒创建）：
         文案「电脑端可能未连接 / 页面加载较慢」+ 已等待秒数；
         按钮：重试（location.reload）/ 返回设备列表（/app/）/ 复制诊断信息 / ✕ 关闭；
       · 提示条**不是全屏层**：只占底部一条、高度受限、浮层外照常可点、可关闭，
         关掉后本页不再弹；认出官方界面后自动收起 —— 失败方向仍然安全；
       · 菜单里那一行字**保留**（被动展开，不打扰，也仍可复制诊断话术）。

     ⚠️ 12 秒是"开始提示"的阈值，不是"判定失败"：限速放开后正常首屏 1~3 秒，
        12 秒既能及时帮到用户，也不至于刚打开就吓人（宁可晚一点，也别误报）。
     ⚠️ 注入体是模板字符串：本段注释/文案**一律用「」**，不得出现反引号。 */
  try {
    maWireCompatErrors();
    if (maCompat && maCompat.ok === false) {
      var maCompatKick = function () { setTimeout(function () { maShowCompatBar(); }, 800); };
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", maCompatKick);
      else maCompatKick();
    }
  } catch (e) { /* 兼容提示失败绝不影响主功能 */ }

  var maLoadWatch = { startedAt: Date.now(), slow: false, wired: false, bound: false, warnEl: null, warnTxt: null,
                      reported: false, reportMs: 0,
                      // 2026-10-17：底部可操作提示条（barEl = 懒创建的节点；barTimer = 秒数刷新）
                      barEl: null, barTxt: null, barTimer: 0, dismissed: false,
                      // 2026-10-20（C4）：镜像页里**唯一**可靠的"电脑端不可达"信号 ——
                      // 受保护的 /api/* 请求被回 5xx 或直接网络错误（presence 不在镜像页这条链路上；
                      // E2EE 死会话的 502 另带 x-dsh-e2ee-error，不算离线，见 maInstallNetSampler）。
                      apiFails: 0, apiFailAt: 0, lastApiStatus: 0 };
  /* ===== 旧浏览器兼容提示条（2026-10-18）=====
     只有两种触发：① 注入体最前面的 maCompat 探测到"补不了的"（语法级不支持）；
     ② 页面脚本报出 SyntaxError / is not a function 这类典型兼容错误且界面还没就绪。
     只显示一条、可关闭、不遮挡整屏；提供「返回设备列表」与「复制诊断信息」两个出口。 */
  var maCompatBar = { el: null, txt: null, detail: null, dismissed: false, wired: false };
  function maCompatReason(msg) {
    var why = "";
    try { why = String(msg ? msg : (maCompat && maCompat.why) || "").slice(0, 200); } catch (e) { why = ""; }
    return why;
  }
  function maMountCompatBar(reason) {
    try {
      if (maCompatBar.dismissed) return;
      if (maCompatBar.el && maCompatBar.el.parentNode) { maCompatRender(reason); return; }
      if (!document.body) return;
      var bar = document.createElement("div");
      bar.className = "dsh-ma-compatbar";
      bar.setAttribute("role", "alert");

      var title = document.createElement("div");
      title.className = "dsh-ma-compatbar-title";
      title.textContent = "浏览器版本过旧，远程界面可能无法打开";

      var detail = document.createElement("div");
      detail.className = "dsh-ma-compatbar-detail";

      var hint = document.createElement("div");
      hint.className = "dsh-ma-compatbar-hint";
      hint.textContent = "建议：把系统/浏览器升级到最新（iOS 17.4 及以上），或改用 Chrome、电脑端访问。";

      var row = document.createElement("div");
      row.className = "dsh-ma-compatbar-row";
      var back = document.createElement("button");
      back.className = "primary";
      back.textContent = "返回设备列表";
      back.addEventListener("click", function () {
        try { location.href = "/app/"; } catch (e) { try { location.assign("/app/"); } catch (e2) { /* 忽略 */ } }
      });
      var copy = document.createElement("button");
      copy.textContent = "复制诊断信息";
      copy.addEventListener("click", function () {
        var line = "";
        try {
          var ua = String((navigator && navigator.userAgent) || "").slice(0, 120);
          line = "dsh-remote 浏览器兼容问题：缺少能力 = " + maCompatReason(reason) + "；UA=" + ua + "；页面=" + String(location.href || "").slice(0, 120);
        } catch (e) { line = "dsh-remote 浏览器兼容问题（无法读取 UA）"; }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(line).then(function () { hint.textContent = "已复制诊断信息，可直接发给客服。"; }, function () { hint.textContent = line; });
            return;
          }
        } catch (e2) { /* 落到下面 */ }
        hint.textContent = line;
      });
      var x = document.createElement("button");
      x.className = "dsh-ma-compatbar-x";
      x.setAttribute("aria-label", "关闭提示");
      x.textContent = "✕";
      x.addEventListener("click", function () { maCompatBar.dismissed = true; try { bar.hidden = true; } catch (e) { /* 忽略 */ } });

      row.appendChild(back);
      row.appendChild(copy);
      bar.appendChild(x);
      bar.appendChild(title);
      bar.appendChild(detail);
      bar.appendChild(hint);
      bar.appendChild(row);
      document.body.appendChild(bar);
      maCompatBar.el = bar; maCompatBar.txt = title; maCompatBar.detail = detail;
      maCompatRender(reason);
    } catch (e) { /* 提示失败绝不影响主功能 */ }
  }
  function maCompatRender(reason) {
    try {
      if (!maCompatBar.el) return;
      var why = maCompatReason(reason);
      if (why && maCompatBar.detail) maCompatBar.detail.textContent = "检测到：" + why;
      maCompatBar.el.hidden = !!maCompatBar.dismissed;
    } catch (e) { /* 忽略 */ }
  }
  /** 显示兼容提示（带就绪保护：界面已经能用了就不再打扰）。 */
  function maShowCompatBar(reason) {
    try {
      if (maCompatBar.dismissed) return;
      if (maLoadReadyNow()) return; // 页面其实正常 → 不吓人
      maMountCompatBar(reason);
    } catch (e) { /* 忽略 */ }
  }
  /** 页面脚本报出"典型兼容错误"时也要提示（有些内联报错早于我们的探测）。 */
  function maWireCompatErrors() {
    try {
      window.addEventListener("error", function (e) {
        try {
          var msg = String((e && e.message) || "");
          if (!/SyntaxError|Unexpected token|is not a function|Cannot read propert/i.test(msg)) return;
          if (!/(withResolvers|AbortSignal|Promise|assets\\/|plugins\\/)/i.test(msg + " " + String((e.target && (e.target.src || e.target.href)) || ""))) return;
          maShowCompatBar(msg.slice(0, 200));
        } catch (e2) { /* 忽略 */ }
      }, true);
    } catch (e) { /* 忽略 */ }
  }

  /** 看门狗阈值（毫秒）：**20 秒**仍认不出官方界面才开始提示。
   *  为什么 12→20（2026-10-20 诊断 C4，03 报告 §2.3）：mirror_load 当天 858 样本 p50 2682ms、
   *  **p90 15285ms**、≥12s 占 **17.6%** —— 12 秒阈值比真实 p90 还短，1/10 的正常加载会被贴上
   *  "电脑端可能未连接"，与代码里"宁可晚一点也别误报"的意图正好相反。20 秒在 p90 之上留了余量，
   *  又远低于用户无法忍耐的 40 秒级。测试按常量断言，不要散落魔法数。 */
  var MA_LOAD_WATCH_MS = 20 * 1000;

  /* ===== C4：首屏关键资源失败 → 自动重试（2026-10-20 诊断，03 报告 §2.3） =====
     现场：文档 / assets/*.js / plugins 聚合包只要失败一次就**永远卡住** —— 旧实现只弹
     "已等 N 秒 + 重试"，页面不会自愈；而用户按「重试」会 abort 掉仍在传输的资源 → nginx 499，
     反复点就是 499 风暴（当天文档导航 22.3% 失败/中断，499 集中在 3 台设备 = 人肉重试的指纹）。
     现在分两层重试，都不打扰用户：
       ① **就地重建**：首屏关键资源（/assets/、/plugins/、manifest）加载失败一次 → 2s/4s 指数退避
          重建那一个 <script>/<link>（同一 URL 最多 2 次）。页面里已经跑起来的东西完全不动。
       ② **受控整页重试**：出现官方启动失败文案（Failed to load plugins / did not activate，实测
          22:01:44 的现场）且界面还没就绪 → 整页刷新一次（同一标签页最多 2 次，sessionStorage 计数，
          90 秒后自动过期）。这才是"重新拉一次首屏"。
       ③ 「重试」按钮：先取消在途请求与排队中的自动重试，再刷新（不再制造新的 499）。
     所有阈值都是常量（测试按常量断言）；任何异常都吞掉，绝不影响页面。 */
  var MA_RES_RETRY_MAX = 2;          // 同一个 URL 最多就地重试 2 次
  var MA_RES_RETRY_BASE_MS = 2000;   // 退避基数：2s → 4s（指数）
  var MA_PAGE_RETRY_MAX = 2;         // 整页自动重试上限（同一标签页）
  var MA_PAGE_RETRY_KEY = "dsh-ma-firstscreen-retry";
  var MA_PAGE_RETRY_TTL_MS = 90 * 1000; // 计数过期：90 秒后算"一次新的打开页面"
  var maRetry = {
    page: 0,            // 本标签页已整页重试次数（从 sessionStorage 恢复）
    resFails: [],       // 已观测到的关键资源失败（诊断 + 文案分档用）
    perUrl: {},         // url -> 已就地重试次数
    resRetries: 0,      // 已发出的就地重试次数
    bootFail: false,    // 是否看到官方启动失败文案
    pageTimer: 0,       // 排队中的整页重试
    lastRetryClickAt: 0,
    manual: false,      // 用户点过「重试」→ 不再自动排队（避免刚重载又自己重载）
    exhausted: false
  };
  var maRetryTimers = [];  // 排队中的就地重试（「重试」按钮先清掉它们）
  var maInflight = [];     // 我们跟踪到的在途 fetch（AbortController）——「重试」前取消，避免 499
  var maRetryStats = { page: 0, res: 0, lastKind: "", at: 0 }; // 对外只读诊断（mirror-diag 会带上）
  /* C6 诊断计数：用户报"又点不动了"时，要能区分「遮罩在拦」与「遮罩早被摘了」。 */
  var maScrimStats = { activations: 0, invariantHits: 0, lastActivationAt: 0 };
  var maCompatOfficial = { on: false, reasons: [] };

  /** 诊断出口：这些计数不参与任何判定，只为了让用户上报现场时能说清楚。 */
  function maPublishDiag() {
    try {
      if (typeof window === "undefined" || !window) return;
      window.__dshMaRetryStats = maRetryStats;
      window.__dshMaDiag = {
        compatOfficial: maCompatOfficial,
        scrim: maScrimStats,
        retry: maRetryStats,
        load: { slow: maLoadWatch.slow, apiFails: maLoadWatch.apiFails, lastApiStatus: maLoadWatch.lastApiStatus },
        // E2EE 死会话自动恢复 / 回前台重连（2026-10-23）：只作诊断，不参与任何判定。
        // var 提升在此处可能尚未赋值（maPublishDiag 在恢复层定义之前就会被调用一次）→ 用 typeof 兜住。
        resume: (typeof maResumeState !== "undefined" && maResumeState)
          ? {
              armed: !!maResumeState.armed, done: !!maResumeState.done,
              reason: maResumeState.reason, lastAt: maResumeState.lastAt,
              fg: (typeof maFgState !== "undefined" && maFgState)
                ? { count: maFgState.count, lastAt: maFgState.lastAt, src: maFgState.lastSrc, probing: !!maFgState.probing }
                : null
            }
          : null
      };
    } catch (e) { /* 诊断失败绝不影响页面 */ }
  }

  /** 首屏关键资源：文档主干 JS（/assets/）、插件聚合包（/plugins/）、manifest。
   *  设备作用域形态 /remote/<dev>/assets/... 先归一（与 e2ee-shim 的 seUpstreamPathOf 同向）。
   *  文档本身（HTML）失败时注入脚本根本不会执行 —— 那种情况只能靠服务端修复，
   *  不在本层职责内；这里覆盖的是"页面起来了、资源没起来"。 */
  function maIsBootCriticalPath(urlStr) {
    try {
      var p = String(urlStr || "");
      /* 用字符串切分而不是正则字面量：本文件是**模板字符串**，注入体里的「\/」会被吃掉一层，
         正则一旦少一层转义就变成语法错误（整段脚本不执行，页面直接裸奔）。 */
      var schemeAt = p.indexOf("://");
      if (schemeAt >= 0) {
        var pathAt = p.indexOf("/", schemeAt + 3);
        p = pathAt >= 0 ? p.slice(pathAt) : "/";
      }
      p = p.split("?")[0].split("#")[0];
      /* 设备作用域归一：/remote/<dev>/assets/… → /assets/…（与 e2ee-shim 的 seUpstreamPathOf 同向） */
      if (p.indexOf("/remote/") === 0) {
        var rest = p.slice("/remote/".length);
        var slashAt = rest.indexOf("/");
        p = slashAt >= 0 ? rest.slice(slashAt) : "/";
      }
      if (p.indexOf("/assets/") === 0 || p.indexOf("/plugins/") === 0) return true;
      if (p === "/manifest.json") return true;
      return false;
    } catch (e) { return false; }
  }

  /** 排队一个重试（统一登记，便于「重试」按钮一键取消）。unref：不拖住测试进程。 */
  function maSchedule(fn, ms) {
    try {
      var id = setTimeout(function () { try { fn(); } catch (e) { /* 重试失败绝不影响页面 */ } }, ms);
      try { if (id && id.unref) id.unref(); } catch (eU) { /* 忽略 */ }
      maRetryTimers.push(id);
      return id;
    } catch (e) { return 0; }
  }

  /** 取消所有排队中的自动重试（用户点了「重试」= 他自己要重来）。 */
  function maCancelPendingRetries() {
    try {
      for (var i = 0; i < maRetryTimers.length; i++) { try { clearTimeout(maRetryTimers[i]); } catch (e) { /* 忽略 */ } }
      maRetryTimers.length = 0;
      if (maRetry.pageTimer) { try { clearTimeout(maRetry.pageTimer); } catch (e2) { /* 忽略 */ } }
      maRetry.pageTimer = 0;
    } catch (e3) { /* 忽略 */ }
  }

  /** 取消我们跟踪到的在途 fetch：先取消再 reload，别让上一轮请求被浏览器 abort 成 499。 */
  function maAbortInflight() {
    var n = 0;
    try {
      while (maInflight.length) {
        var it = maInflight.pop();
        try { if (it && it.ac && it.ac.abort) { it.ac.abort(); n += 1; } } catch (e) { /* 忽略 */ }
      }
    } catch (e2) { /* 忽略 */ }
    return n;
  }

  /** 本标签页的存储（sessionStorage 优先，退化 localStorage；都不可用返回 null）。 */
  function maTabStore() {
    try {
      var w = typeof window !== "undefined" ? window : null;
      if (w && w.sessionStorage) return w.sessionStorage;
      if (w && w.localStorage) return w.localStorage;
    } catch (e) { /* 无痕模式等 */ }
    return null;
  }
  /** 读"本标签页已整页重试次数"（90 秒后过期 → 算一次新的打开页面）。 */
  function maPageRetryRead() {
    try {
      var st = maTabStore();
      if (!st) return 0;
      var raw = st.getItem(MA_PAGE_RETRY_KEY);
      if (!raw) return 0;
      var o = JSON.parse(raw);
      if (!o || typeof o.n !== "number") return 0;
      if (Date.now() - Number(o.at || 0) > MA_PAGE_RETRY_TTL_MS) return 0;
      return Math.max(0, Math.min(MA_PAGE_RETRY_MAX, o.n));
    } catch (e) { return 0; }
  }
  function maPageRetrySave(n) {
    try {
      var st = maTabStore();
      if (st) st.setItem(MA_PAGE_RETRY_KEY, JSON.stringify({ n: n, at: Date.now() }));
    } catch (e) { /* 存不了就算了（最坏是少一次防重保护） */ }
  }
  /* 启动时恢复"本标签页已自动重试过几次"（90 秒内有效）。必须在这里读：同一标签页刷新后
     计数要接着走，否则"每页最多 2 次"每次刷新都重新开始（又能刷 2 次 = reload 风暴）。 */
  try { maRetry.page = maPageRetryRead(); } catch (eR) { maRetry.page = 0; }

  /** 就地重建一个失败的首屏资源元素（只认 <script>/<link>，其余跳过）。 */
  function maRetryBootResource(el, url, tag) {
    try {
      var t = String(tag || (el && el.tagName) || "").toLowerCase();
      if (t !== "script" && t !== "link") return false;
      var clone = document.createElement(t);
      var attr = t === "script" ? "src" : "href";
      clone.setAttribute(attr, url);
      /* ⚠️ 模块类型必须保留（官方 SPA 是 type=module 的队列加载），否则重建出来的脚本不执行；
         integrity 刻意**不**沿用：同一个坏响应带 integrity 重建只会再失败一次，白费这 2 秒。 */
      if (t === "script") {
        var ty = el && el.getAttribute ? el.getAttribute("type") : null;
        if (ty) clone.setAttribute("type", ty);
      } else {
        clone.setAttribute("rel", "stylesheet");
      }
      clone.setAttribute("data-dsh-ma-retry", "1");
      var host = (el && el.parentNode) || document.head || document.body || document.documentElement;
      if (!host) return false;
      host.appendChild(clone);
      maRetry.resRetries += 1;
      maBumpRetryStats("res:" + t);
      return true;
    } catch (e) { return false; }
  }

  function maBumpRetryStats(kind) {
    try {
      maRetryStats.page = maRetry.page;
      maRetryStats.res = maRetry.resRetries;
      maRetryStats.lastKind = String(kind || "");
      maRetryStats.at = Date.now();
      maPublishDiag();
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 观测到首屏关键资源失败：登记 + 排队一次就地重建（同一 URL 最多 2 次，2s→4s）。
   * 为什么"就地重建"而不是直接刷新：官方 SPA 的模块加载器是队列模式（__ModuleLoader__ mode=queue），
   * 单个聚合包失败时重建那一个 <script> 就够；整页刷新成本高得多，还可能把已渲染的界面清掉。
   */
  function maNoteResourceFail(url, tag, el) {
    try {
      var key = String(url || "");
      if (!key) return false;
      var n = maRetry.perUrl[key] || 0;
      maRetry.resFails.push({ url: key, tag: String(tag || ""), at: Date.now() });
      if (maRetry.resFails.length > 12) maRetry.resFails.shift();
      /* 界面已经就绪 = 这次失败没有卡住首屏。此时重建元素可能让模块/插件**再执行一遍**
         （官方模块加载器是队列式），风险大于收益 —— 只记录、不重试。 */
      if (maLoadReadyNow()) return false;
      if (n >= MA_RES_RETRY_MAX) { maRetry.exhausted = true; return false; }
      maRetry.perUrl[key] = n + 1;
      var delay = MA_RES_RETRY_BASE_MS * Math.pow(2, n); // 2s → 4s（指数退避）
      maSchedule(function () { maRetryBootResource(el, key, tag); }, delay);
      return true;
    } catch (e) { return false; }
  }

  /** 整页受控重试：仅当"官方界面还没就绪 + 没被用户手动接管 + 每标签页额度没用完"。 */
  function maSchedulePageRetry(why) {
    try {
      if (maRetry.manual) return false;          // 用户已点过「重试」→ 我们不替他再刷
      if (maRetry.pageTimer) return false;       // 已经排了一个
      if (maCompat && maCompat.ok === false) return false; // 语法级不兼容：刷新也起不来
      if (maLoadReadyNow()) return false;        // 界面其实好了 → 绝不打扰
      if (maRetry.page >= MA_PAGE_RETRY_MAX) { maRetry.exhausted = true; return false; }
      var delay = MA_RES_RETRY_BASE_MS * Math.pow(2, maRetry.page); // 2s → 4s
      maRetry.page += 1;
      maPageRetrySave(maRetry.page);
      maRetry.pageTimer = setTimeout(function () {
        maRetry.pageTimer = 0;
        maRetryHardReload(why);
      }, delay);
      try { if (maRetry.pageTimer && maRetry.pageTimer.unref) maRetry.pageTimer.unref(); } catch (eU) { /* 忽略 */ }
      maBumpRetryStats("page:" + String(why || ""));
      return true;
    } catch (e) { return false; }
  }

  /** 取消在途请求 + 清排队重试，然后真正刷新页面。 */
  function maRetryHardReload(why) {
    try {
      maCancelPendingRetries();
      maAbortInflight();
      maBumpRetryStats("reload:" + String(why || ""));
      try { window.location.reload(); return; } catch (e) { /* 落到下面 */ }
      try { location.reload(); } catch (e2) { /* 忽略 */ }
    } catch (e3) { /* 忽略 */ }
  }

  /**
   * 「重试」按钮：**先取消在途请求与排队中的自动重试，再刷新**（2026-10-20 C4 第 3 条）。
   * 为什么（03 报告 §2.3）：旧实现直接 location.reload() —— 上一轮还在传输的文档/JS/插件包
   * 被浏览器 abort → nginx 499；用户连点几次就是 499 风暴，把瞬时故障放大成"永久打不开"。
   * 现在：① 2 秒冷却（连点不再叠加，人肉风暴的机械成因被掐掉）；
   *       ② abort 我们跟踪到的在途 fetch + 清掉排队的自动重试；
   *       ③ 再刷新（留 120ms 让浏览器真的取消，而不是同一拍里直接跳走）。
   * @returns {boolean} 是否受理了这次点击
   */
  function maRetryNow() {
    try {
      var now = Date.now();
      if (maRetry.lastRetryClickAt && now - maRetry.lastRetryClickAt < 2000) return false;
      maRetry.lastRetryClickAt = now;
      maRetry.manual = true;
      maCancelPendingRetries();
      maAbortInflight();
      var doReload = function () { try { window.location.reload(); } catch (e) { try { location.reload(); } catch (e2) { /* 忽略 */ } } };
      try { setTimeout(doReload, 120); } catch (e3) { doReload(); }
      return true;
    } catch (e) { return false; }
  }

  /**
   * 首次打开页面时的"官方启动失败文案"探测（Failed to load plugins / did not activate）。
   * 为什么只在 3 个时间点扫、不挂 MutationObserver：body.innerText 是重操作，
   * 官方流式输出时每帧扫一次会把主线程拖死（mirror-diag 是服务端采集器，代价模型不同）。
   */
  function maScanBootFailure() {
    try {
      if (maRetry.manual) return false;
      var b = document.body;
      var txt = String((b && b.innerText) || "");
      if (!txt) return false;
      if (txt.indexOf("Failed to load plugins") < 0 && txt.indexOf("did not activate") < 0) return false;
      maRetry.bootFail = true;
      return maSchedulePageRetry("boot_failed");
    } catch (e) { return false; }
  }

  /** 底部提示条"原因分档"：offline（电脑端不可达）/ resource（首屏资源失败）/ slow（网络慢）。 */
  function maLoadReason() {
    try {
      var now = Date.now();
      /* 10 秒内的不可达证据才算：过期的失败不能把文案一直钉在"未连接"上（那正是 03 报告
         说的"文案归因错误"——截图 09 面板同时显示 95ms 顺畅）。 */
      if ((maLoadWatch.apiFails || 0) > 0 && now - (maLoadWatch.apiFailAt || 0) < 10000) return "offline";
      if (maRetry.resFails.length > 0) return "resource";
    } catch (e) { /* 落到 slow */ }
    return "slow";
  }

  /** 响应带 x-dsh-e2ee-error = 桥端在说"这个加密会话我不认"，不是"电脑端离线"。 */
  function maResHasE2eeError(res) {
    try {
      var h = res && res.headers;
      if (!h || typeof h.get !== "function") return false;
      return !!h.get("x-dsh-e2ee-error");
    } catch (e) { return false; }
  }

  /**
   * 受保护 API 请求失败（5xx/网络错误）—— 镜像页里**唯一**可靠的"电脑端不可达"信号。
   * 为什么不用 presence：presence 不在镜像页这条链路上（镜像页只有一个隧道 + 官方客户端），
   * 而 03 报告里所有"电脑端未连接"的现场同时都伴随着 /api 的 502/504。
   * 只做计数与文案分档，绝不据此做任何重试/跳转。
   */
  function maNotePresenceFail(status) {
    try {
      maLoadWatch.apiFails = (maLoadWatch.apiFails || 0) + 1;
      maLoadWatch.apiFailAt = Date.now();
      maLoadWatch.lastApiStatus = Number(status) || 0;
      maPublishDiag();
      if (maLoadWatch.slow) maLoadRenderBar(); // 提示条已经出来了 → 立刻按新原因换文案
    } catch (e) { /* 纯诊断，失败忽略 */ }
  }

  /* ===== C6：官方 UI 锚点探测 → compat-official 降级（2026-10-20 诊断，00 §6.2 C6 / 04 §V-4） =====
     故障形态：装了「dsh web all」（或官方重新打包）后，我们的自绘抽屉/全屏 scrim 依赖的一组官方锚点
     可能整组失效：「.pI_x6G_frame」外壳、「.pI_x6G_sidebarCol」/「.hHd-Xa_root」侧栏列、
     侧栏开合按钮（aria-label / .hHd-Xa_toggle）、折叠态「data-sidebar-collapsed / data-sidebar-open」
     （以及 0.1.5 起改名的「data-details-collapsed / data-rightbar-collapsed」）。
     认不出这些锚点时的**最坏结局不是"没有手势"，而是"自绘抽屉盖住官方界面 + scrim 常亮 → 点哪都没反应"**。
     所以启动时一次性判定：
       锚点齐全 → 原行为（不变量看门狗照旧，见 enforceScrimInvariant）；
       锚点缺失/异常 → 「compat-official」模式：**不建自绘抽屉、不建 scrim、不代替用户点官方 toggle**，
       只保留字号 + E2EE 徽标这些纯悬浮件（FAB/菜单在上一步已经建好），侧栏完全交还官方。
     ⚠️ 一次性判定（不是每拍重算）：官方重新打包时整页锚点是一齐变的，反复探测只会反复误判。
     @param {Element} frameEl boot 里用官方特征选择器找到的 frame
     @returns {{on: boolean, reasons: string[]}} reasons 只作诊断（进 __dshMaDiag / 客服话术） */
  /** 读元素类名：className 优先，空则退回 class 属性（真实 DOM 两者等价，但假 DOM/合成节点不一定同步）。 */
  function maClassOf(el) {
    try {
      var c = (el && typeof el.className === "string") ? el.className : "";
      if (c) return c;
      if (el && typeof el.getAttribute === "function") return String(el.getAttribute("class") || "");
    } catch (e) { /* 忽略 */ }
    return "";
  }

  function maProbeOfficialAnchors(frameEl) {
    var reasons = [];
    try {
      if (!frameEl) return { on: true, reasons: ["no_frame"] };
      var cls = maClassOf(frameEl);
      var sidebarAttrs = ["data-sidebar-collapsed", "data-sidebar-open"];
      var shellAttrs = sidebarAttrs.concat(["data-details-collapsed", "data-rightbar-collapsed", "data-shell-overlay"]);
      var hasSidebarAttr = false, hasShellAttr = false;
      for (var i = 0; i < shellAttrs.length; i++) {
        var has = false;
        try { has = !!(frameEl.hasAttribute && frameEl.hasAttribute(shellAttrs[i])); } catch (eH) { has = false; }
        if (has) { hasShellAttr = true; if (i < sidebarAttrs.length) hasSidebarAttr = true; }
      }
      var isOfficialFrame = /pI_x6G_frame/.test(cls) || hasShellAttr;
      if (!isOfficialFrame) reasons.push("frame_anchor_missing");
      /* 侧栏列：类名含 sidebar（排除第三列 rightbar/details、拖拽把手、overlay 层），
         或结构上真的有官方侧栏组件根 .hHd-Xa_root。 */
      var cols = [];
      try { cols = [].slice.call((frameEl && frameEl.children) || []); } catch (eC) { cols = []; }
      /* frame 已挂载但**一个子列都没有** = 官方 React 子树还没渲染完（或正在重渲染）。
         这不是"锚点变了"，不能据此永久降级 —— 交给 pump 下一拍再看（return pending）。 */
      if (cols.length === 0) return { on: false, pending: true, reasons: [] };
      var sidebarCol = null;
      for (var k = 0; k < cols.length; k++) {
        var c = cols[k];
        var ccls = maClassOf(c);
        if (/rightbar|right-bar|details|handle|resizer|overlaylayer/i.test(ccls)) continue;
        if (/sidebar/i.test(ccls)) { sidebarCol = c; break; }
        try { if (c && c.querySelector && c.querySelector(".hHd-Xa_root")) { sidebarCol = c; break; } } catch (eQ) { /* 忽略 */ }
      }
      if (!sidebarCol) reasons.push("sidebar_anchor_missing");
      /* 能不能**驱动**官方侧栏：官方开合按钮，或官方折叠态属性。
         两者都没有 = 我们的汉堡按钮点了也不会动官方状态 → 自绘抽屉只会变成一个死按钮 + 可能的遮罩死局。 */
      var drive = null;
      try {
        drive = document.querySelector('[aria-label="Open sidebar"], [aria-label="Close sidebar"], [aria-label="Collapse sidebar"], [aria-label="Expand sidebar"], [aria-label="打开侧边栏"], [aria-label="关闭侧边栏"], [aria-label="收起侧边栏"], [aria-label="展开侧边栏"], .hHd-Xa_toggle');
      } catch (eD) { drive = null; }
      if (!drive && !hasSidebarAttr) reasons.push("sidebar_toggle_missing");
      return { on: reasons.length > 0, reasons: reasons };
    } catch (e) { return { on: true, reasons: ["probe_threw"] }; }
  }

  /** 进入 compat-official 模式：只记诊断 + 一条**可见**的 console 说明；不碰官方 DOM 结构。
   *  为什么不加页面提示条：护栏禁止适配层引入覆盖层，而"少一组手势"用户其实感觉得到
   *  （官方自己的侧栏按钮就在），不需要再弹一条打扰。 */
  function maEnterCompatOfficial(reasons) {
    try {
      maCompatOfficial.on = true;
      maCompatOfficial.reasons = [].slice.call(reasons || []);
      var html = document.documentElement;
      if (html && html.classList) html.classList.add("dsh-ma-compat-official");
      try {
        if (window && window.console && window.console.warn) {
          window.console.warn("[dsh-mobile-adapter] 官方界面锚点缺失/异常(" + maCompatOfficial.reasons.join(",")
            + ") → 进入 compat-official 模式：不自绘抽屉/scrim，不代替用户点官方入口，侧栏完全交还官方。");
        }
      } catch (eW) { /* 诊断出不来也不能影响主功能 */ }
      maPublishDiag();
    } catch (e) { /* 降级本身失败 = 维持现状（至少不比旧行为更糟） */ }
  }

  /* C6：能不能**代替用户**点官方侧栏 toggle。点失败过一次就永久停手 —— 最坏退化成
     "没有手势"（用户还能用官方自己的入口），而不是把官方状态点乱后两态互相打架（点哪都没反应）。
     「window.__dshMaOfficialClicks = false」是给真机排查用的开关（不占 UI）。 */
  var maOfficialClickOK = true;
  function maClickOfficialToggle(el) {
    if (!el || !maOfficialClickOK) return false;
    try { if (typeof window !== "undefined" && window && window.__dshMaOfficialClicks === false) return false; } catch (e0) { /* 忽略 */ }
    try { el.click(); return true; } catch (e) { maOfficialClickOK = false; return false; }
  }

  /* ---- C4 接线：资源失败捕获（捕获阶段才能拿到 <script>/<link> 的 error target）---- */
  try {
    window.addEventListener("error", function (ev) {
      try {
        var t = ev && ev.target;
        if (!t || t === window) return;               // 脚本运行期错误不是资源失败
        var url = String(t.src || t.href || "");
        if (!maIsBootCriticalPath(url)) return;
        maNoteResourceFail(url, String(t.tagName || ""), t);
      } catch (e2) { /* 采集失败绝不影响页面 */ }
    }, true);
  } catch (e0) { /* 老浏览器:忽略 */ }
  /* 启动失败文案：6s/14s/18s 三个时间点（刻意避开 12s/20s 这两个既有定时器，
     免得测试与真机上"哪一路先到"变得不可预测）。 */
  try {
    maSchedule(maScanBootFailure, 6000);
    maSchedule(maScanBootFailure, 14000);
    maSchedule(maScanBootFailure, 18000);
  } catch (e1) { /* 忽略 */ }
  maPublishDiag();
  /** 官方界面是否已经可用（只看最强信号；只用于决定"要不要多显示一行字"）。 */
  function maLoadReadyNow() {
    try {
      if (document.querySelector(".pI_x6G_frame, div.dsh-ma-frame, [data-sidebar-collapsed], [data-details-collapsed], [data-rightbar-collapsed]")) return true;
      return Boolean(document.querySelector('[data-composer-input], [contenteditable="true"], [role="textbox"], textarea'));
    } catch (e) { return false; }
  }
  function maLoadWaitedSec() {
    return Math.max(0, Math.round((Date.now() - maLoadWatch.startedAt) / 1000));
  }
  /**
   * 单调时钟（performance.now；不可用时退回 Date.now）。
   * 延迟采样与 mirror_load 量测共用：**同一次量测的两端必须用同一个时钟**，
   * 否则 performance.now 与 Date.now 混用会算出负数/巨值。
   */
  function maNowMs() {
    try {
      if (typeof performance !== "undefined" && performance && typeof performance.now === "function") return performance.now();
    } catch (e) { /* 继续退化 */ }
    return Date.now();
  }
  /**
   * 镜像页就绪耗时（毫秒）——**约定见 docs/TELEMETRY-CONTRACT.md / 迭代冻结文档 §2.3**：
   *   · 起点 = **导航开始**（performance.now() 的零点 = performance.timeOrigin ≈ 导航开始），
   *     所以一条值同时覆盖 DNS+TLS+HTML TTFB + 解析 + 界面就绪；
   *   · **不能**用 Date.now() - maLoadWatch.startedAt：那个起点是"注入脚本解析时刻"，会**漏掉
   *     HTML TTFB**（HAR 实测那 79 秒里 TTFB 就有 8.7 秒），报出来的数会系统性小于用户体感；
   *     而且 bfcache 恢复（pageshow persisted）不会重置 startedAt，那约定还能报出几十分钟。
   *   · 没有 performance 时退化回 startedAt 约定（老浏览器兜底，宁可粗糙也不能漏报）。
   */
  function maLoadElapsedMs() {
    try {
      if (typeof performance !== "undefined" && performance && typeof performance.now === "function") {
        var v = performance.now();
        if (typeof v === "number" && isFinite(v) && v >= 0) return v;
      }
    } catch (e) { /* 继续退化 */ }
    return Math.max(0, Date.now() - maLoadWatch.startedAt);
  }
  /**
   * 上报镜像页加载耗时（事件名 mirror_load；宿主半路由由 D6 线新增）。
   *
   * 纪律（三条都来自"绝不打扰用户"）：
   *   ① **同一页只报一次**（reported 标志）—— bfcache 恢复/多路兜底重复触发都不再报；
   *   ② **全程静默**：任何异常都吞掉，失败绝不影响页面，也绝不做重试；
   *   ③ 只在**已有的**同一批请求之外发这一次（一次 POST，几十字节），不是测速、不轮询。
   * body = { ms, outcome, at }：ms=耗时毫秒（截到 [0,600000]，与契约一致）；outcome ∈ {ok,slow}
   * （slow = 12 秒看门狗兜底，是"删失下限"，后台只把 ok 计入 P50/P90）；at=事件发生的 epoch ms。
   * ⚠️ 2026-10-17：阈值 25s→12s，**字段与一次语义一律不变**（后台契约不动）。 */
  function maReportMirrorLoad(outcome) {
    if (maLoadWatch.reported) return;
    maLoadWatch.reported = true;
    /* 首屏成功就绪 = 这次打开是好的 → 把"整页自动重试"额度清零，别让一次偶发失败
       把接下来 90 秒的额度一起吃掉（额度只该限制**连续失败**，不该跨页面累计）。 */
    if (outcome !== "slow") {
      try { maRetry.page = 0; maPageRetrySave(0); } catch (eReset) { /* 忽略 */ }
    }
    try {
      var ms = Math.round(maLoadElapsedMs());
      if (!isFinite(ms) || ms < 0) ms = 0;
      if (ms > 600000) ms = 600000;
      maLoadWatch.reportMs = ms;
      var body = JSON.stringify({ ms: ms, outcome: outcome === "slow" ? "slow" : "ok", at: Date.now() });
      var p = null;
      try {
        p = fetch("/dsh-remote/telemetry/mirror-load", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body,
          keepalive: true
        });
      } catch (e) { p = null; }
      // 失败静默：不重试、不提示、不 console.error（这是纯遥测，任何噪音都是打扰）
      if (p && typeof p.catch === "function") p.catch(function () { /* 忽略 */ });
    } catch (e) { /* 遥测绝不把页面拖挂 */ }
  }
  /** 给客服看的一句话（含等待时长与 UA，便于直接定位）。 */
  function maLoadCopyLine() {
    let ua = "";
    try { ua = String((navigator && navigator.userAgent) || "").slice(0, 120); } catch (e) { /* 忽略 */ }
    return "dsh-remote 手机端加载疑似卡住：等待 " + maLoadWaitedSec() + " 秒后仍未出现对话界面。"
      + "原因=" + maLoadReason() + "，首屏资源失败=" + maRetry.resFails.length + "，自动重试="
      + (maRetry.page + maRetry.resRetries) + " 次；scrim 拦截=" + maScrimStats.activations
      + " 次/不变量摘除=" + maScrimStats.invariantHits + " 次。UA=" + ua;
  }

  /* ===== 底部可操作提示条（2026-10-17，见上方看门狗注释）=====
     纪律：
       · **懒创建**：只有 slow 且用户没关过时才创建节点；
       · **绝不阻塞**：只占底部一条（CSS 限高），浮层外照常可点；按钮动作全部就地完成；
       · **任何异常都吞掉**：提示层坏掉也绝不影响页面（每个入口都有 try/catch）；
       · **只提示一次**：用户点 ✕ 后 dismissed=true，本页不再弹（不骚扰）。 */
  /** 提示条主文案：**按原因分档** + 已等待秒数（秒数由 barTimer 每秒刷新）。
   *  为什么分档（2026-10-20 诊断 C4，03 报告 §2.3「文案归因错误」）：旧实现把
   *  HTML 502 / JS 500 / 插件包失败 / E2EE 会话未建立 / nginx 连接打满**统统**说成
   *  "电脑端可能未连接"；截图 09 的反证最强 —— 面板同时显示「网络延迟 95ms·顺畅」。
   *  现在：· 电脑端不可达（受保护 API 请求 5xx/网络错误）→「电脑端可能未连接」；
   *        · 首屏关键资源失败 →「页面资源加载失败，正在重试…」（重试用尽时如实说明）；
   *        · 其余 →「网络较慢」+ 已等待秒数（不再替用户猜原因）。 */
  function maLoadBarText() {
    var sec = maLoadWaitedSec();
    var reason = maLoadReason();
    if (reason === "offline") return "电脑端可能未连接（已等待 " + sec + " 秒）";
    if (reason === "resource") {
      if (maRetry.exhausted) return "页面资源加载失败，自动重试已用尽（已等待 " + sec + " 秒）";
      return "页面资源加载失败，正在重试…（已等待 " + sec + " 秒）";
    }
    return "网络较慢（已等待 " + sec + " 秒）";
  }
  /** 收起提示条并停掉秒数刷新（不改变 dismissed：用于"认出界面后自动收起"这类临时收起）。 */
  function maLoadHideBar() {
    try { if (maLoadWatch.barEl) maLoadWatch.barEl.hidden = true; } catch (e) { /* 忽略 */ }
    try {
      if (maLoadWatch.barTimer) { clearInterval(maLoadWatch.barTimer); maLoadWatch.barTimer = 0; }
    } catch (e2) { /* 忽略 */ }
  }
  /** 用户点 ✕：本页不再弹（dismissed 是**本页**语义；刷新页面会重新开始一次提示机会）。 */
  function maLoadDismissBar() {
    try {
      maLoadWatch.dismissed = true;
      maLoadHideBar();
      maLoadRenderWarn(); // 菜单里那一行也一起收起（关闭 = 本页只提示一次）
    } catch (e) { /* 忽略 */ }
  }
  /** 导航（返回设备列表）：assign 失败退回 href。 */
  function maLoadGoto(to) {
    try { window.location.assign(to); return; } catch (e) { /* 继续 */ }
    try { window.location.href = to; } catch (e2) { /* 忽略 */ }
  }
  /** 复制诊断信息（沿用 maLoadCopyLine：含 UA 与耗时）；剪贴板不可用时把整句显示在提示条上让用户截图。 */
  function maLoadCopyDiag() {
    var line = maLoadCopyLine();
    var show = function (t) {
      try { if (maLoadWatch.barTxt) maLoadWatch.barTxt.textContent = t; } catch (e) { /* 忽略 */ }
    };
    try {
      if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        var p = navigator.clipboard.writeText(line);
        if (p && typeof p.then === "function") {
          p.then(function () { show("已复制诊断信息（含等待时长与机型），可直接发给客服。"); },
                 function () { show(line); });
          return;
        }
      }
    } catch (e) { /* 落到显示 */ }
    show(line);
  }
  /** 懒创建提示条（只在 slow 之后调用；解析期绝不碰 DOM）。 */
  function maLoadMountBar() {
    try {
      if (maLoadWatch.barEl || maLoadWatch.dismissed) return maLoadWatch.barEl;
      var body = document.body || document.documentElement;
      if (!body || !body.appendChild) return null;
      var bar = document.createElement("div");
      bar.className = "dsh-ma-loadbar";
      /* role=status + aria-live=polite：读屏软件会把"加载较慢"念出来，但不会抢焦点；
         它**不是** dialog/alert，不抢键盘、不锁滚动。 */
      bar.setAttribute("role", "status");
      bar.setAttribute("aria-live", "polite");
      bar.innerHTML =
        '<div class="dsh-ma-loadbar-txt" data-role="loadbar-txt"></div>' +
        '<div class="dsh-ma-loadbar-actions">' +
          '<button type="button" class="dsh-ma-loadbar-btn" data-role="loadbar-retry">重试</button>' +
          '<button type="button" class="dsh-ma-loadbar-btn" data-role="loadbar-back">返回设备列表</button>' +
          '<button type="button" class="dsh-ma-loadbar-btn" data-role="loadbar-copy">复制诊断信息</button>' +
        '</div>' +
        '<button type="button" class="dsh-ma-loadbar-close" data-role="loadbar-close" aria-label="关闭提示">✕</button>';
      bar.hidden = true;
      maLoadWatch.barEl = bar;
      maLoadWatch.barTxt = bar.querySelector('[data-role="loadbar-txt"]');
      bar.addEventListener("click", function (ev) {
        // 事件委托：真实浏览器里目标可能是按钮内的文字节点；从 target 往上找到 [data-role]
        try {
          if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
        } catch (e0) { /* 忽略 */ }
        try {
          var t = ev && ev.target ? ev.target : null;
          var role = "";
          var guard = 0;
          while (t && t !== bar && guard < 16 && !role) {
            guard += 1;
            try {
              if (t.getAttribute) role = String(t.getAttribute("data-role") || "");
            } catch (e1) { role = ""; }
            t = t.parentNode || null;
          }
          if (role === "loadbar-retry") {
            maRetryNow();
          } else if (role === "loadbar-back") {
            maLoadGoto("/app/"); // 绝对路径：镜像页当前路径可能是 /remote/<deviceId>/…
          } else if (role === "loadbar-copy") {
            maLoadCopyDiag();
          } else if (role === "loadbar-close") {
            maLoadDismissBar();
          }
        } catch (e3) { /* 提示条失败绝不影响页面 */ }
      });
      body.appendChild(bar);
      return bar;
    } catch (e) { return null; }
  }
  /** 按当前状态渲染提示条（slow + 未关闭 → 显示；否则收起）。 */
  function maLoadRenderBar() {
    try {
      if (!maLoadWatch.slow || maLoadWatch.dismissed) { maLoadHideBar(); return; }
      var bar = maLoadWatch.barEl || maLoadMountBar();
      if (!bar) return;
      if (maLoadWatch.barTxt) maLoadWatch.barTxt.textContent = maLoadBarText();
      bar.hidden = false;
      if (!maLoadWatch.barTimer) {
        // 每秒刷新「已等待 N 秒」；同时复核"是不是其实早就好了"——好了就自动收起（不长期挂着）。
        maLoadWatch.barTimer = setInterval(function () {
          try {
            if (!maLoadWatch.slow || maLoadWatch.dismissed) { maLoadHideBar(); return; }
            if (maLoadReadyNow()) {
              maLoadWatch.slow = false;
              maLoadHideBar();
              maLoadRenderWarn(); // 菜单那一行也一起收起
              return;
            }
            if (maLoadWatch.barTxt) maLoadWatch.barTxt.textContent = maLoadBarText();
          } catch (e) { /* 忽略 */ }
        }, 1000);
        try { if (maLoadWatch.barTimer && maLoadWatch.barTimer.unref) maLoadWatch.barTimer.unref(); } catch (e2) { /* 忽略 */ }
      }
    } catch (e) { /* 提示条失败绝不影响页面 */ }
  }
  function maLoadRenderWarn() {
    try {
      if (!maLoadWatch.warnEl) return;
      // 用户点过 ✕ = 本页不想再被这事打扰：菜单里那一行也一起收起（"只提示一次"）
      if (!maLoadWatch.slow || maLoadWatch.dismissed) { maLoadWatch.warnEl.hidden = true; return; }
      if (maLoadWatch.warnTxt) {
        maLoadWatch.warnTxt.textContent = "本次页面可能没加载完整（已等 " + maLoadWaitedSec()
          + " 秒）。点这里复制一句话发给客服，或点下方「返回设备列表」重来。";
      }
      maLoadWatch.warnEl.hidden = false;
    } catch (e) { /* 提示失败绝不影响主功能 */ }
  }
  /** 把这一行接进已有的悬浮菜单（由菜单构建处调用；菜单不存在时什么都不做）。 */
  function maWireLoadWarn(menu) {
    try {
      maLoadWatch.warnEl = menu.querySelector('[data-role="load-warn"]');
      maLoadWatch.warnTxt = menu.querySelector('[data-role="load-warn-txt"]');
      maLoadWatch.wired = true;
      maLoadRenderWarn();
      if (maLoadWatch.warnEl && !maLoadWatch.bound) {
        maLoadWatch.bound = true;
        maLoadWatch.warnEl.addEventListener("click", function () {
          const line = maLoadCopyLine();
          const show = (t) => { try { if (maLoadWatch.warnTxt) maLoadWatch.warnTxt.textContent = t; } catch (e) { /* 忽略 */ } };
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(line).then(
                () => show("已复制。直接粘给客服即可（里面已带等待时长与机型信息）。"),
                () => show(line) // 剪贴板不可用 → 至少把这句话显示出来让用户截图
              );
              return;
            }
          } catch (e) { /* 落到下面 */ }
          show(line);
        });
      }
    } catch (e) { /* 忽略 */ }
  }
  // 12 秒后仍认不出官方界面 → 置慢标记 + 懒创建底部提示条（**只在这时才碰 DOM**）。
  // 同一处顺手把 mirror_load 的**兜底样本**发出去（outcome="slow"）：12 秒没就绪的页面上报的
  // 必然是"≥12 秒"，这是**删失下限**而不是真实耗时，后台只把它单列，不混进 P50/P90。
  setTimeout(function () {
    try {
      if (maLoadReadyNow()) return;
      maLoadWatch.slow = true;
      if (maLoadWatch.wired) maLoadRenderWarn();
      maLoadRenderBar(); // 底部可操作提示条（重试 / 返回设备列表 / 复制诊断 / 关闭）
      maReportMirrorLoad("slow");
    } catch (e) { /* 忽略 */ }
  }, MA_LOAD_WATCH_MS);

  /* ============================================================================
   * E2EE 死会话自动恢复 + 回到前台重连（2026-10-23，iOS 断线重连体验）
   *
   * 现场（iOS 用户反馈）：退出 Safari / 切到别的 App 一两分钟再回来，镜像页几乎必然重载；
   * 而桥端 E2EE 会话表是**进程内存**（24h TTL + CAP 32 LRU，电脑端重启即丢）—— 重载后
   * 常撞上「加密会话已失效，需要重新解锁」，旧行为只能回设备列表手动重新解锁。
   * 本段只做两件事，都**只读**状态（window.__dshE2eeBadge + dsh-e2ee-badge 事件），
   * 不碰任何加解密逻辑、不重建会话、不自己重连 WS：
   *
   *   ① 死会话 → 自动回 /app/?resume=<deviceId>&from=mirror，由 native.html 用
   *      「记住本机」的派生 MK 静默解锁再回镜像页（全程无手势、无密码输入）；
   *   ② 从后台恢复（pageshow persisted / visibilitychange）→ 一次轻量探针确认隧道还在；
   *      失败则唤醒官方客户端（online 事件）并再探一次，仍失败只给**可见**提示
   *      （复用底部提示条的「重试 / 返回设备列表 / 复制诊断」出口），绝不做静默无限重连。
   *
   * 触发条件极窄（业主验收口径：只有"确认 E2EE 不可用"才触发）：
   *   · 只认镜像页路径 /remote/<deviceId>/(不是镜像页直接什么都不做)；
   *   · 只认桥端明确答复的「加密会话已失效 / 需要重新解锁」；
   *   · 纯明文（「未加密」「未解锁」「明文」）默认**绝不**打扰 —— 用户可能主动选了「暂不加密」。
   *     唯一例外：本页是为了甩掉死会话才被 shim 重载过（sessionStorage 里有它的重载闸门），
   *     且本机还留着「记住本机」的派生 MK —— 那才是"本该加密、却被自动降级成明文"。
   * 闸门：本页最多一次 + 60 秒冷却 + 60 秒窗口内最多 2 次（sessionStorage，跨重载仍有效）。
   *
   * 注入体纪律：本段不得出现反引号；字符串里不得出现反斜杠转义（模板字符串会先吃一层）。
   * ========================================================================= */

  /* ===DSH-MA-RESUME-ENGINE-START=== */
  /* ===DSH-MA-RESUME-PURE-START=== */
  /** 镜像页设备 id：/remote/<deviceId>/… → deviceId（纯函数；不是镜像页返回空串）。
   *  设备 id 之后要拼进跳转地址，所以只接受 URL 安全字符，其它一律当没有。 */
  function maDeviceIdOfMirrorPath(pathname) {
    try {
      var parts = String(pathname || "").split("/").filter(Boolean);
      if (parts[0] !== "remote" || !parts[1]) return "";
      var id = "";
      try { id = decodeURIComponent(parts[1]); } catch (e) { id = ""; }
      return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : "";
    } catch (e) { return ""; }
  }

  /**
   * 是否该自动恢复（纯函数，便于单测）。输入 E2EE 徽标状态 + 本机上下文。
   * @param {{mode?:string,text?:string}|null} st  __dshE2eeBadge.state()
   * @param {{mk?:boolean,deadReloadAt?:number,now?:number}} ctx  mk=有派生 MK;deadReloadAt=死会话重载闸门时间戳
   * @returns {string} "" 不恢复；"dead_session" 桥端明确说不认这张票；"plaintext_after_dead" 抢修降级后的明文
   */
  function maE2eeResumeDecision(st, ctx) {
    try {
      if (!st || typeof st !== "object") return "";
      var mode = String(st.mode || "");
      var text = String(st.text || "");
      if (mode === "ok" || !text) return "";
      var c = ctx && typeof ctx === "object" ? ctx : {};
      /* ① 桥端明确答复：会话没了 / 需要重新解锁。这是**唯一**的确定信号。 */
      if (/加密会话已失效|会话已失效|需要重新解锁/.test(text)) return "dead_session";
      /* ② 明文/未解锁：默认绝不打扰。仅当"本页刚为甩掉死会话被重载过 + 本机有记住的 MK"才抢修 ——
            这两个条件同时成立时，用户本来应该是加密的，现在只是被自动降级成了明文。 */
      if (/未加密|未解锁|明文/.test(text)) {
        var reloadAt = Number(c.deadReloadAt) || 0;
        var now = Number(c.now) || 0;
        if (c.mk === true && reloadAt > 0 && now > reloadAt && now - reloadAt < 90 * 1000) {
          return "plaintext_after_dead";
        }
        return "";
      }
      return "";
    } catch (e) { return ""; }
  }
  /* ===DSH-MA-RESUME-PURE-END=== */

  var MA_RESUME_DELAY_MS = 400;          // 认出死会话后 400ms 才跳（让 shim 自己的收尾先跑完，避免两路导航抢）
  var MA_RESUME_COOLDOWN_MS = 60 * 1000; // 两次恢复之间的冷却
  var MA_RESUME_WINDOW_MS = 60 * 1000;   // 时间窗
  var MA_RESUME_MAX_IN_WINDOW = 2;       // 窗口内最多 2 次（与 native.html 闸门一致，双层兜底）
  var MA_RESUME_KEY = "dsh-ma-e2ee-resume";
  var MA_DEAD_RELOAD_KEY = "dsh-e2ee-dead-reload"; // e2ee-shim 的"每页只重载一次"闸门（只读）
  var MA_MK_KEY = "dsh-e2ee-mk-v1";                // native.html「记住本机」的派生 MK（只读）
  var MA_FG_MIN_BG_MS = 8000;            // 后台停留 <8s 不算"断线场景"，不打扰
  var MA_FG_COOLDOWN_MS = 60 * 1000;     // 回前台恢复的冷却
  var MA_FG_MAX_PER_PAGE = 3;            // 本页最多 3 次（防抖动/循环）
  var MA_PROBE_TIMEOUT_MS = 4000;        // 探针超时
  var MA_PROBE_RETRY_MS = 2500;          // 唤醒官方客户端后再探的间隔

  var maResumeState = { done: false, redirecting: false, lastAt: 0, reason: "", armed: false };
  var maFgState = { hiddenAt: 0, lastAt: 0, count: 0, probing: false, lastSrc: "" };

  /** 读 E2EE 徽标状态（shim 未注入 → null，全程不动作）。 */
  function maE2eeStateNow() {
    try {
      return window.__dshE2eeBadge && typeof window.__dshE2eeBadge.state === "function"
        ? window.__dshE2eeBadge.state() : null;
    } catch (e) { return null; }
  }

  /** 本机上下文：有没有「记住本机」的 MK、shim 是否刚为死会话重载过（都只读）。 */
  function maResumeContext() {
    var mk = false, reloadAt = 0;
    try { mk = !!(window.localStorage && window.localStorage.getItem(MA_MK_KEY)); } catch (e) { mk = false; }
    try { reloadAt = Number((window.sessionStorage && window.sessionStorage.getItem(MA_DEAD_RELOAD_KEY)) || 0) || 0; } catch (e2) { reloadAt = 0; }
    return { mk: mk, deadReloadAt: reloadAt, now: Date.now() };
  }

  /** 闸门：本页一次 + 冷却 + 时间窗内限次（sessionStorage 跨重载仍有效）。 */
  function maResumeGatePass(now) {
    try {
      if (maResumeState.done || maResumeState.redirecting) return false;
      if (maResumeState.lastAt && now - maResumeState.lastAt < MA_RESUME_COOLDOWN_MS) return false;
      var raw = null;
      try { raw = window.sessionStorage && window.sessionStorage.getItem(MA_RESUME_KEY); } catch (e0) { raw = null; }
      var hits = null;
      try { hits = JSON.parse(raw || "[]"); } catch (e1) { hits = []; }
      if (!Array.isArray(hits)) hits = [];
      var kept = [];
      for (var i = 0; i < hits.length; i++) {
        var t = Number(hits[i]);
        if (isFinite(t) && now - t >= 0 && now - t < MA_RESUME_WINDOW_MS) kept.push(t);
      }
      if (kept.length >= MA_RESUME_MAX_IN_WINDOW) return false;
      kept.push(now);
      try { window.sessionStorage && window.sessionStorage.setItem(MA_RESUME_KEY, JSON.stringify(kept.slice(-8))); } catch (e2) { /* 存不下不构成"永不恢复" */ }
      return true;
    } catch (e) { return true; }
  }

  /** 自动回设备列表入口（由 /app/ 用「记住本机」的 MK 静默解锁后回镜像页）。 */
  function maE2eeTryResume(reason) {
    try {
      var dev = maDeviceIdOfMirrorPath(window.location.pathname);
      if (!dev) return false;
      var now = Date.now();
      if (!maResumeGatePass(now)) { maPublishDiag(); return false; }
      maResumeState.done = true;
      maResumeState.redirecting = true;
      maResumeState.lastAt = now;
      maResumeState.reason = String(reason || "");
      maPublishDiag();
      var to = "/app/?resume=" + encodeURIComponent(dev) + "&from=mirror";
      setTimeout(function () {
        try { window.location.replace(to); return; } catch (e1) { /* 继续 */ }
        try { window.location.assign(to); } catch (e2) { /* 继续 */ }
        try { window.location.href = to; } catch (e3) { /* 放弃（例如沙箱里没有 location） */ }
      }, MA_RESUME_DELAY_MS);
      return true;
    } catch (e) { return false; }
  }

  function maDelay(ms) {
    return new Promise(function (resolve) {
      try { setTimeout(resolve, Number(ms) || 0); } catch (e) { resolve(); }
    });
  }

  /** 底部提示条的**临时**用途：回前台重连失败时给一条可见说明（复用既有重试/返回出口）。
   *  优先级让给首屏慢加载（那条有更高价值，别抢它的文案）；用户关过一次就不再打扰。 */
  function maShowFgHint(text) {
    try {
      if (maLoadWatch.dismissed || maLoadWatch.slow) return;
      var bar = maLoadWatch.barEl || maLoadMountBar();
      if (!bar) return;
      maLoadWatch.fgHint = true;
      if (maLoadWatch.barTxt) maLoadWatch.barTxt.textContent = String(text || "");
      bar.hidden = false;
    } catch (e) { /* 提示失败不影响恢复本身 */ }
  }
  function maHideFgHint() {
    try {
      if (!maLoadWatch.fgHint) return;
      maLoadWatch.fgHint = false;
      maLoadHideBar();
    } catch (e) { /* 忽略 */ }
  }

  /** 唤醒官方客户端：派发一次 online 事件（它自己按"网络恢复"重连）—— 只派发，不替它重连。 */
  function maNudgeOnline() {
    try {
      var ev = null;
      try { ev = new Event("online"); } catch (e0) { ev = null; }
      if (ev) window.dispatchEvent(ev);
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 轻量探针：**必须过桥**才算数（业主 2026-10-23 指正）。
   *
   * 为什么不能用 manifest：relay-router 的设备无关静态资源兜底（serveDeviceFreeAsset）会**本地直出**
   * manifest.webmanifest / favicon.svg —— 打这些路径只能证明"手机能连上中继"，证明不了
   * "这台电脑的隧道还活着"，而 iOS 回前台的真实故障恰恰是后者。
   *
   * 现在打 「HEAD /remote/<deviceId>/」：走 resolveRoute → authorizeRemote → bridge 的 http 帧 →
   * 电脑端 dsh 返回 200（HEAD 无 body，成本最低）。判定按业主口径：
   *   OK   = 拿到响应且 status 不是 502/504（502/504 = 隧道/上游不可达，这才是失败）
   *          401/403/404 都算"有回应"（cookie 过期或路径不存在不等于隧道断了，加密状态另判）
   *   FAIL = 网络错误 / 超时 / 502 / 504
   * 兜底：HEAD 被中间代理/旧环境拒绝时（第一次探针 reject），第二次退化为
   *   「GET /remote/<deviceId>/favicon.ico」（同样过桥；不在 DEVICE_FREE_ASSETS 白名单里）。
   *
   * @param {string} deviceId
   * @param {boolean} [useGet] true = 走 favicon.ico 的 GET 退化路径
   */
  function maProbeMirrorOnce(deviceId, useGet) {
    var tail = useGet ? "/favicon.ico" : "/";
    var url = "/remote/" + encodeURIComponent(deviceId) + tail + "?dshProbe=" + Date.now();
    var ctrl = null;
    try { ctrl = typeof AbortController === "function" ? new AbortController() : null; } catch (e0) { ctrl = null; }
    /* accept 用 json 而不是 html：router 的 isDocNavigation 在缺少 sec-fetch-* 的老浏览器上
       会回落到 accept 判定 —— 带上 html 会被当成"页面导航"，设备离线时改走 302 引导页，
       探针就永远看不到 502 了（这是这条探针最容易踩的坑）。 */
    var opts = { method: useGet ? "GET" : "HEAD", cache: "no-store", headers: { accept: "application/json" } };
    if (ctrl) opts.signal = ctrl.signal;
    return new Promise(function (resolve) {
      var settled = false;
      var timer = 0;
      var done = function (r) {
        if (settled) return;
        settled = true;
        try { if (timer) clearTimeout(timer); } catch (e1) { /* 忽略 */ }
        resolve(r);
      };
      try {
        timer = setTimeout(function () {
          try { if (ctrl) ctrl.abort(); } catch (e2) { /* 忽略 */ }
          done({ ok: false, why: "timeout" });
        }, MA_PROBE_TIMEOUT_MS);
      } catch (e3) { /* 忽略 */ }
      var p = null;
      try { p = typeof window.fetch === "function" ? window.fetch(url, opts) : null; } catch (e4) { p = null; }
      if (!p || typeof p.then !== "function") { done({ ok: false, why: "nocall" }); return; }
      p.then(function (res) {
        var status = 0;
        try { status = Number(res && res.status) || 0; } catch (e5) { status = 0; }
        // 502/504 = router 或上游明确"这台的隧道不可达"；其余状态码都说明"有回应"
        done({ ok: status > 0 && status !== 502 && status !== 504, status: status });
      }, function () { done({ ok: false, why: "reject" }); });
    });
  }

  /** 回到前台：确认加密状态 + 一次轻量探针 → 原地重连（online）→ 再探一次 → 可见提示。 */
  function maForegroundResume(src) {
    try {
      if (!maResumeState.armed) return;
      var dev = maDeviceIdOfMirrorPath(window.location.pathname);
      if (!dev) return;
      var now = Date.now();
      var gap = maFgState.hiddenAt ? now - maFgState.hiddenAt : 0;
      maFgState.hiddenAt = 0;
      if (gap < MA_FG_MIN_BG_MS) return;                 // 短切走不算断线
      if (maFgState.probing) return;                     // 不叠并发
      if (maFgState.count >= MA_FG_MAX_PER_PAGE) return;  // 本页额度用完就不再自动碰
      if (maFgState.lastAt && now - maFgState.lastAt < MA_FG_COOLDOWN_MS) return;
      var st = maE2eeStateNow();
      if (!st) return;   // shim 未注入（旧 bridge/关闭 E2EE）→ 加密与本次恢复无关，官方客户端自己处理
      var decision = maE2eeResumeDecision(st, maResumeContext());
      if (decision) { maE2eeTryResume(decision); return; }  // 确认不可用 → 直接自动恢复（无手势）
      maFgState.count += 1;
      maFgState.lastAt = now;
      maFgState.probing = true;
      maFgState.lastSrc = String(src || "");
      var settle = function () { try { maFgState.probing = false; } catch (e0) { /* 忽略 */ } };
      maProbeMirrorOnce(dev).then(function (r1) {
        if (r1 && r1.ok) { maHideFgHint(); settle(); return; }
        maShowFgHint("网络似乎断开了，正在重新连接…");
        maNudgeOnline();
        // 第二次探针换 GET favicon.ico：既验证"隧道是否真的断了"，也顺手覆盖 HEAD 不被支持的旧环境
        return maDelay(MA_PROBE_RETRY_MS).then(function () { return maProbeMirrorOnce(dev, true); }).then(function (r2) {
          if (r2 && r2.ok) { maHideFgHint(); settle(); return; }
          maShowFgHint("连接没有恢复。点「重试」重新加载本页，或点「返回设备列表」重新进入。");
          settle();
        });
      }).then(function () { settle(); }, function () { settle(); });
    } catch (e) { try { maFgState.probing = false; } catch (e2) { /* 忽略 */ } }
  }

  /** 徽标状态一变就看一眼（纯读，不做别的）。 */
  function maE2eeOnBadge() {
    try {
      var st = maE2eeStateNow();
      if (!st) return;
      var decision = maE2eeResumeDecision(st, maResumeContext());
      if (decision) maE2eeTryResume(decision);
    } catch (e) { /* 忽略 */ }
  }

  /** 安装监听（幂等）。**只**在镜像页 /remote/<deviceId>/ 上生效。 */
  function maArmE2eeResume() {
    try {
      if (maResumeState.armed) return;
      var dev = maDeviceIdOfMirrorPath(window.location.pathname);
      if (!dev) return;
      maResumeState.armed = true;
      var onBadge = function () { maE2eeOnBadge(); };
      try { document.addEventListener("dsh-e2ee-badge", onBadge); } catch (e1) { /* 忽略 */ }
      try { window.addEventListener("dsh-e2ee-badge", onBadge); } catch (e2) { /* 忽略 */ }
      // shim 可能在本层挂牌前就发布了状态（注入顺序：adapter 先、shim 后，通常不会；这里兜底两次）
      setTimeout(function () { try { maE2eeOnBadge(); } catch (e3) { /* 忽略 */ } }, 800);
      setTimeout(function () { try { maE2eeOnBadge(); } catch (e4) { /* 忽略 */ } }, 3000);
      // 回前台：bfcache 恢复走 pageshow(persisted)；普通切后台走 visibilitychange
      try {
        window.addEventListener("pageshow", function (ev) {
          try { if (ev && ev.persisted) maForegroundResume("pageshow"); } catch (e5) { /* 忽略 */ }
        });
      } catch (e6) { /* 忽略 */ }
      try {
        document.addEventListener("visibilitychange", function () {
          try {
            if (document.visibilityState === "hidden") { maFgState.hiddenAt = Date.now(); return; }
            maForegroundResume("visibilitychange");
          } catch (e7) { /* 忽略 */ }
        });
      } catch (e8) { /* 忽略 */ }
      maPublishDiag();
    } catch (e) { /* 恢复层装不上也不能影响页面 */ }
  }

  try { maArmE2eeResume(); } catch (eResumeArm) { /* 忽略 */ }

  /* ===DSH-MA-RESUME-ENGINE-END=== */

  /* ============================================================================
   * 上传失败「可读提示」（2026-10-23，文件上传反馈）
   *
   * 现场（生产反馈 fb_930b950aed94 + nginx 日志 22 次 502 / 12 次 413）：手机上传失败只看到
   *   「上传失败，点击重试」。根因在 dsh 上游客户端：dsh-client-file-upload/lib/client.js
   *   在 status !== 200 时直接抛错并**丢弃响应体**；而中继/桥端本轮已能给出可读原因
   *   （>64MB 的 413 JSON、上游不可达的分类 502 JSON），这些文字却到不了用户。
   *
   * 本层只做一件事：**旁听** dsh 上传 Worker 的完成消息（{kind:"complete",status,body}），
   * 非 200 时补一条人话提示。不改协议、不拦请求、不重试、不碰 E2EE（Worker 独立作用域，
   * 上传内容本来就不经 shim —— 那是另案）。
   * 触发面收窄：只接管 new Worker(..., { name: "dsh-file-upload" })，其它 Worker 原样返回；
   * 任何异常都退回原生 Worker（上传功能绝不受本层影响）。
   * ========================================================================= */
  /* ===DSH-MA-UPLOAD-HINT-PURE-START=== */
  /** 上传失败状态码 + 响应体 → 人话（纯函数）。空串 = 不提示（成功/交给 dsh 自己）。 */
  function maUploadFailureHint(status, body) {
    var s = Number(status) || 0;
    if (!s || s === 200 || s === 201) return "";
    var b = String(body == null ? "" : body);
    if (s === 413 || /payload_too_large|body_too_large|too large|exceeds? byte limit/i.test(b)) {
      return "上传失败：文件超过 64MB 上限，请压缩后重试，或改用电脑端上传。";
    }
    if (s === 502 || s === 504) return "上传失败：与电脑端的连接中断了。请重试；反复失败请确认电脑端 DSH 仍在运行。";
    if (s === 401 || s === 403) return "上传失败：登录状态已过期，请返回设备列表重新进入后再试。";
    var m = null;
    try { m = JSON.parse(b); } catch (e) { m = null; }
    var msg = "";
    try { if (m && m.error) msg = String(m.error.message || m.error.code || ""); } catch (e2) { msg = ""; }
    return "上传失败（HTTP " + s + "）" + (msg ? "：" + msg : "，请重试。");
  }
  /* ===DSH-MA-UPLOAD-HINT-PURE-END=== */

  /* ===DSH-MA-UPLOAD-HINT-ENGINE-START=== */
  var MA_UPLOAD_FAIL_KEY = "dsh-ma-upload-fail";
  /** 底部一次性提示（自绘、6 秒自动消失、不挡点击；同一批失败只提示一次）。 */
  function maUploadToast(text) {
    try {
      var now = Date.now();
      var last = 0;
      try { last = Number(sessionStorage.getItem(MA_UPLOAD_FAIL_KEY)) || 0; } catch (eLast) { last = 0; }
      if (last && now - last < 4000) return;
      try { sessionStorage.setItem(MA_UPLOAD_FAIL_KEY, String(now)); } catch (eSet) { /* 忽略 */ }
      var doc = document;
      var el = doc.getElementById("dsh-ma-upload-toast");
      if (el && el.parentNode) el.parentNode.removeChild(el);
      el = doc.createElement("div");
      el.id = "dsh-ma-upload-toast";
      el.setAttribute("role", "status");
      el.textContent = String(text || "");
      el.style.cssText = "position:fixed;left:12px;right:12px;bottom:calc(18px + env(safe-area-inset-bottom));z-index:2147483001;"
        + "padding:10px 14px;border-radius:12px;background:rgba(32,32,32,.94);color:#fff;"
        + "font:13px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI',Roboto,sans-serif;"
        + "box-shadow:0 6px 24px rgba(0,0,0,.35);pointer-events:none;opacity:0;transition:opacity .2s ease;";
      (doc.body || doc.documentElement).appendChild(el);
      setTimeout(function () { try { el.style.opacity = "1"; } catch (eF) { /* 忽略 */ } }, 16);
      setTimeout(function () {
        try { el.style.opacity = "0"; } catch (eO) { /* 忽略 */ }
        setTimeout(function () { try { if (el.parentNode) el.parentNode.removeChild(el); } catch (eR) { /* 忽略 */ } }, 260);
      }, 6000);
    } catch (e) { /* 提示失败不影响上传本身 */ }
  }
  /** 旁听上传 Worker：只包 onmessage/onerror，其余成员透传（方法绑定到原生对象）。 */
  function maTapUploadWorker(w) {
    var proxy = null;
    var userMsg = null;
    var userErr = null;
    var onMsg = function (ev) {
      try {
        var d = ev && ev.data;
        if (d && d.kind === "complete") {
          var hint = maUploadFailureHint(d.status, d.body);
          if (hint) maUploadToast(hint);
        }
      } catch (eObs) { /* 忽略 */ }
      if (typeof userMsg === "function") return userMsg.call(proxy, ev);
      return undefined;
    };
    var onErr = function (ev) {
      if (typeof userErr === "function") return userErr.call(proxy, ev);
      return undefined;
    };
    proxy = new Proxy(w, {
      get: function (t, k) {
        if (k === "onmessage") return userMsg || undefined;
        if (k === "onerror") return userErr || undefined;
        var v = t[k];
        return typeof v === "function" ? v.bind(t) : v;
      },
      set: function (t, k, v) {
        if (k === "onmessage") { userMsg = v; t.onmessage = onMsg; return true; }
        if (k === "onerror") { userErr = v; t.onerror = onErr; return true; }
        t[k] = v;
        return true;
      }
    });
    return proxy;
  }
  /** 安装（幂等、可在看门狗里重复调用）：只接管 name=dsh-file-upload 的 Worker。 */
  function maInstallUploadTap() {
    try {
      if (typeof window === "undefined" || typeof window.Worker !== "function") return false;
      var Native = window.Worker;
      if (Native && Native.__dshMaUploadTap) return true;
      var Wrapped = new Proxy(Native, {
        construct: function (Target, args) {
          var w = Reflect.construct(Target, args);
          try {
            var opts = args && args[1];
            var name = opts && typeof opts === "object" ? String(opts.name || "") : "";
            if (name !== "dsh-file-upload") return w;
            return maTapUploadWorker(w);
          } catch (eTap) { return w; }
        }
      });
      try { Wrapped.__dshMaUploadTap = true; } catch (eMark) { /* 忽略 */ }
      window.Worker = Wrapped;
      return true;
    } catch (e) { return false; }
  }
  /* ===DSH-MA-UPLOAD-HINT-ENGINE-END=== */

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

    /* ===== 设置面板:结构识别 + 稳定类(2026-10-13;根因见 CSS 里那段长注释)=====
       为什么不能只靠 [class~="VOzbGW_*"]:官方重新打包会换混淆前缀(0.1.5 = VOzbGW_,
       0.2.0-rc.2 = Dws9Sa_),改名后整段 CSS **静默失效** —— 页面照常打开,
       只是手机端布局坏掉,而且只有真机看得出。所以这里再按**结构 + 几何**认一遍:
         · 面板 = [role=dialog]/[aria-modal] 且**直接子元素里有 <nav>**、尺寸接近全屏
           (0.1.5 与 0.2 的面板都是 div[role=dialog] > nav + div 两栏,且都是固定像素宽);
         · 列表 = nav 里子元素最多的那个孩子(单元格 ≥3 个);
         · content = 面板里除 nav 之外的孩子;header/options = content 的首/末孩子。
       命中 → 打 .dsh-ma-settings-* 稳定类,由 CSS 接管(前缀改名后**仍然基本可用**);
       命中不到 → 原样放过(绝不破坏官方默认),只 warn 一次作为**可见的降级诊断**
       —— 护栏禁止适配层引入全屏覆盖层,所以诊断只能走 console / 既有上报通道。 */
    var MA_SETTINGS_PREFIX_RE = /(^|\s)(VOzbGW_|Dws9Sa_)/;
    var maSettingsPanelEl = null;   // 已识别的面板(靠 isConnected 判存活,官方重渲染后自动重认)
    var maSettingsCells = [];       // 已识别的 tab 单元格
    var maSettingsNextScan = 0;     // 未命中时的扫描节流(见 maSettingsMaybeTag)
    var maSettingsWarned = "";
    function maSettingsWarn(msg) {
      if (maSettingsWarned === msg) return;
      maSettingsWarned = msg;
      /* window.console 优先(镜像页里它就是页面控制台),拿不到再退到全局 console ——
         诊断**必须**能出得来,否则"静默失效"只是换了个地方静默。 */
      try {
        var c = (typeof window !== "undefined" && window && window.console) || (typeof console !== "undefined" ? console : null);
        if (c && c.warn) c.warn("[dsh-mobile-adapter]", msg);
      } catch (eW) {}
    }
    function maClsOf(el) { try { return (el && typeof el.className === "string") ? el.className : ""; } catch (eC) { return ""; } }
    function maKidsOf(el) { try { return (el && el.children) ? [].slice.call(el.children) : []; } catch (eK) { return []; } }
    /** 面板级几何门:排除小气泡/菜单/下拉,只认接近全屏的弹层。 */
    function maPanelSized(el) {
      try {
        var r = el.getBoundingClientRect();
        if (!r || !(r.width > 0) || !(r.height > 0)) return false;
        return r.width >= Math.max(240, window.innerWidth * 0.5) && r.height >= 160;
      } catch (eG) { return false; }
    }
    /** 结构识别:找到官方设置面板(flex 两栏 = 直接子 <nav> + 另一栏)。 */
    function maFindSettingsPanel() {
      var cands = [];
      try {
        cands = [].slice.call(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]'));
      } catch (eQ) { return null; }
      var best = null, bestArea = 0;
      for (var i = 0; i < cands.length; i++) {
        var el = cands[i];
        var kids = maKidsOf(el);
        if (kids.length < 2) continue;              // 两栏才有 content 可谈
        var nav = null;
        for (var j = 0; j < kids.length; j++) { if (kids[j] && kids[j].tagName === "NAV") { nav = kids[j]; break; } }
        if (!nav || maKidsOf(nav).length < 2) continue;  // 设置面板的 nav = 标题 + tab 列表
        if (!maPanelSized(el)) continue;
        var r = el.getBoundingClientRect();
        var area = r.width * r.height;
        if (area > bestArea) { bestArea = area; best = el; }
      }
      return best;
    }
    /** nav 里的 tab 列表 = 子元素最多的那个孩子(标题只有一个文本孩子)。 */
    function maNavListOf(nav) {
      var kids = maKidsOf(nav);
      if (!kids.length) return null;
      var best = null, bestN = 0;
      for (var i = 0; i < kids.length; i++) {
        var n = maKidsOf(kids[i]).length;
        if (n > bestN) { bestN = n; best = kids[i]; }
      }
      return bestN >= 2 ? best : (kids.length > 1 ? kids[kids.length - 1] : null);
    }
    /** 当前选中项:官方状态类(任意前缀 + _active)或 aria-current —— 两者都不依赖前缀。 */
    function maCellActive(cell) {
      try {
        if (cell.getAttribute && cell.getAttribute("aria-current") === "true") return true;
        /* 只认「整段 token 以 _active 结尾」或「token 就叫 active」——
           不能用 *active 这种宽松匹配:inactive 也会命中,会把没选中的 tab 当成当前项。
           ⚠️ 本文件是模板字符串,注释里**不得出现反引号**(会提前闭合注入体,见 AGENTS.md)。 */
        return /(^|\s)(?:[A-Za-z0-9_-]+_active|active)(\s|$)/.test(maClsOf(cell));
      } catch (eA) { return false; }
    }
    function maMarkActiveCells() {
      for (var i = 0; i < maSettingsCells.length; i++) {
        var c = maSettingsCells[i];
        try { if (c && c.isConnected && maCellActive(c)) c.classList.add("dsh-ma-settings-active"); } catch (eM) {}
      }
    }
    function maTagSettingsDialog() {
      var panel = maFindSettingsPanel();
      if (!panel) {
        /* 认不到面板时给一条**可见的**降级诊断:现场是"大弹层 + 首栏比次栏窄"的桌面两栏形态,
           说明官方又换了结构(或换成了我们不认识的前缀)—— 这条 warn 就是下次定位问题的起点。 */
        try {
          var any = document.querySelector('[role="dialog"], [aria-modal="true"]');
          if (any && maPanelSized(any)) {
            maSettingsWarn("检测到大弹层但未能识别为设置面板(官方结构/类名可能已变化):手机端可能仍是桌面两栏布局。");
          }
        } catch (eAny) {}
        maSettingsPanelEl = null; maSettingsCells = [];
        return;
      }
      var kids = maKidsOf(panel);
      var nav = null, content = null;
      for (var i = 0; i < kids.length; i++) {
        if (!nav && kids[i].tagName === "NAV") { nav = kids[i]; continue; }
        if (!content) content = kids[i];
      }
      var list = nav ? maNavListOf(nav) : null;
      var title = null;
      var navKids = maKidsOf(nav);
      for (var k = 0; k < navKids.length; k++) { if (navKids[k] !== list) { title = navKids[k]; break; } }
      var contentKids = maKidsOf(content);
      var header = contentKids[0] || null;
      var options = contentKids.length > 1 ? contentKids[contentKids.length - 1] : null;
      var overlay = null;
      try {
        var p = panel.parentElement || panel.parent || null;   // parentElement 是标准属性;parent 兜底给极简 DOM
        if (p && p.getBoundingClientRect) {
          var pr = p.getBoundingClientRect();
          if (pr && pr.width >= window.innerWidth * 0.9 && pr.height >= window.innerHeight * 0.9) overlay = p;
        }
      } catch (eP) {}
      try {
        panel.classList.add("dsh-ma-settings-panel");
        if (nav) nav.classList.add("dsh-ma-settings-nav");
        if (title) title.classList.add("dsh-ma-settings-navtitle");
        if (list) list.classList.add("dsh-ma-settings-navlist");
        if (content) content.classList.add("dsh-ma-settings-content");
        if (header) header.classList.add("dsh-ma-settings-header");
        if (options) options.classList.add("dsh-ma-settings-options");
        if (overlay) overlay.classList.add("dsh-ma-settings-overlay");
        maSettingsCells = list ? maKidsOf(list) : [];
        for (var c = 0; c < maSettingsCells.length; c++) maSettingsCells[c].classList.add("dsh-ma-settings-cell");
        maMarkActiveCells();
      } catch (eT) { /* 打类失败也要继续:已知前缀那条 CSS 仍可能命中 */ }
      maSettingsPanelEl = panel;
      /* 前缀认不出 = 官方改名的**直接信号** —— 这时布局靠结构类仍然可用,所以只警告不降级。 */
      if (!MA_SETTINGS_PREFIX_RE.test(maClsOf(panel) + " " + maClsOf(nav))) {
        maSettingsWarn("设置面板已按**结构**识别(官方混淆前缀已变化:既不是 VOzbGW_ 也不是 Dws9Sa_);布局仍可用,但请把新前缀补进适配层。");
      }
    }
    /**
     * 每拍调用(节流):已识别且面板还在文档里 → 只刷新选中态;否则限频重扫。
     * 为什么要节流:未命中时每拍都要 querySelectorAll 一遍全文档,流式输出时每帧一拍。
     */
    function maSettingsMaybeTag() {
      if (!NARROW()) return;
      try {
        if (maSettingsPanelEl && maSettingsPanelEl.isConnected) { maMarkActiveCells(); return; }
      } catch (eLive) { /* 掉进重扫 */ }
      var now = Date.now();
      if (now < maSettingsNextScan) return;
      maSettingsNextScan = now + 400;   // 未命中时最多 2.5 次/秒;命中后面板引用直接短路,不再全扫
      maTagSettingsDialog();
    }

    /* 设置面板打开时,把当前 tab 滚进横向可视区(顶部 tab 行手机横向滚动) */
    let settingsWatchOn = false;
    let settingsTick = 0;
    function scrollActiveSettingsTab() {
      /* 逐个尝试而不是写一条长选择器:结构类(前缀无关)优先,已知前缀退居兜底;
         任何一条在旧浏览器上解析失败都不影响其余。 */
      const SEL = [
        ".dsh-ma-settings-cell.dsh-ma-settings-active",
        '[class~="Dws9Sa_navCell"].Dws9Sa_active',
        '[class~="VOzbGW_navCell"].VOzbGW_active',
        '[class~="Dws9Sa_navCell"][aria-current="true"]',
        '[class~="VOzbGW_navCell"][aria-current="true"]'
      ];
      let act = null;
      for (const sel of SEL) {
        try { act = document.querySelector(sel); } catch (e13a) { act = null; }
        if (act) break;
      }
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
          settingsTick = setTimeout(function () {
            if (!NARROW()) return;
            maSettingsNextScan = 0;             // 官方刚挂上面板:别被节流挡在门外
            try { maSettingsMaybeTag(); } catch (e16) {}
            scrollActiveSettingsTab();
          }, 140);
        });
        ob.observe(document.body, { childList: true, subtree: true });
      } catch (e15) {}
    }

    /* 悬浮按钮/菜单：任何宽度都要有（电脑端访问镜像页同样需要「返回设备列表」的出口），
       与手机端布局改造分开守门；失败也不影响布局适配。 */
    /* ❌ 这里曾有 maOpenRightPane / maRightPaneExpandBtn / maRightPaneRequest 三件套 ——
   它们是「从 FAB 手动打开官方右栏」的入口。2026-09-27 根治时整条删除：
   官方右栏的 tab / 会话头按钮本来就会调 ctx.layout.openRightbar(track, fullscreen)，
   窄屏还会自动收起左栏（viewportWidth < 1024 → narrowExpanded = false）。
   我们插一脚只会把官方推到相反方向（这正是「点开变黑遮罩」那条链的起点）。 */
    let fabDone = false;

    /* ===== 📶 网络延迟采样器（2026-10-10 二修，与"某一代菜单 DOM"彻底解耦）=================
       一修（0.7.0-beta.3）改掉了"亚毫秒样本被丢弃"，但用户实测**仍然一直「测速中」**，
       而同一时段镜像页打了 69 次 /api/agentPresets/list 这类**完全合格**的请求 ——
       说明真根因不是样本被过滤，而是**采样根本没接上**（或渲染写进了已被替换的旧节点）。

       所以这次不再依赖"建菜单时顺手包装一次 fetch"：
         · 安装独立成 maInstallNetSampler()，幂等、**自愈**（发现 window.fetch 上不是我们的采样器
           就重新包一层）—— 谁在这之后把 fetch 换掉（我们自己注入的 E2EE shim 会在解锁时再包一次）
           都能兜住；
         · 样本挂 window（跨"菜单被 SPA 重建"共享）；
         · 渲染**每次现查实时 DOM**，不再抱着建菜单时的旧引用（旧引用可能已脱离文档，
           于是样本明明在涨、界面却永远停在初始文案）；
         · 空态**直接说明原因**，下次再出问题不用猜：一眼看出是"没接上"还是"接上了但没请求"。 */
    const maNetPatch = { ok: false, samples: 0, lastUrl: "", lastAt: 0 };
    try { window.__dshMaNet = maNetPatch; } catch (eNet0) { /* 忽略 */ }
    /** 当前这一代菜单注册的渲染器（可能为 null：菜单还没建）。 */
    let maNetRender = null;
    const maNoteRtt = (ms, url) => {
      try {
        if (typeof ms !== "number" || !isFinite(ms)) return;
        const r = Math.round(ms);
        // 只拒绝负数与超时；0（本机/回环的真实往返不足 1ms）照收，展示层再夹到 ≥1ms。
        if (r < 0 || r > 20000) return;
        const bag = (window.__dshMaRttSamples || (window.__dshMaRttSamples = []));
        bag.push(r);
        while (bag.length > 8) bag.shift();
        maNetPatch.samples = bag.length;
        maNetPatch.lastUrl = String(url || "").slice(0, 80);
        maNetPatch.lastAt = Date.now();
        if (maNetRender) { try { maNetRender(); } catch (eR) { /* 忽略 */ } }
      } catch (eN) { /* 忽略 */ }
    };
    /** 把采样器挂到 window.fetch 上（**只挂一次**）。返回是否已就绪。 */
    const maInstallNetSampler = () => {
      try {
        if (typeof window.fetch !== "function") return false;
        /* ⚠️ 幂等判据必须是**稳定标志**，不能拿 window.fetch.__dshMaNetSampler 当判据（2026-10-10 自测抓到）：
           "会话过期探测"那层包装会在本采样器**外面**再包一层（它建菜单时才装，晚于这里），
           于是最外层 window.fetch 上没有我们的标记 → 若用函数标记当判据，每一拍都会再包一层，
           秒级泄漏（请求穿过 N 层、同一趟被记 N 个样本）。 */
        if (maNetPatch.installed === true) { maNetPatch.ok = true; return true; }
        const orig = window.fetch;
        const wrapped = function (input, init) {
          let url = "";
          try { url = typeof input === "string" ? input : (input && input.url) || ""; } catch (eU) { url = ""; }
          const t0 = maNowMs();
          /* C4 第 3 条（2026-10-20）：给每个在途请求挂一个**我们自己的** AbortController，
             用户点「重试」时先 abort 再刷新 —— 旧实现直接 reload，浏览器在那一拍把在途请求
             全 abort 成 nginx 499（当天文档导航 22.3% 失败/中断的主要成因）。 */
          let ac = null;
          let args = [input, init];
          try {
            if (typeof AbortController === "function") {
              ac = new AbortController();
              let merged = ac.signal;
              try {
                const origSignal = init && init.signal;
                if (origSignal && typeof AbortSignal !== "undefined" && AbortSignal && typeof AbortSignal.any === "function") {
                  merged = AbortSignal.any([origSignal, ac.signal]); // 与调用方自己的取消语义合并
                } else if (origSignal) {
                  merged = origSignal;  // 老浏览器没有 AbortSignal.any：不自作主张，保留调用方语义
                }
              } catch (eM) { merged = ac.signal; }
              args = [input, Object.assign({}, init || {}, { signal: merged })];
              maInflight.push({ ac: ac, url: url, at: t0 });
              if (maInflight.length > 200) maInflight.shift(); // 有界：绝不因为跟踪而泄漏
            }
          } catch (eAC) { ac = null; }
          const p = orig.apply(this, args);
          const drop = () => {
            try {
              for (let i = maInflight.length - 1; i >= 0; i -= 1) {
                if (maInflight[i] && maInflight[i].ac === ac) { maInflight.splice(i, 1); break; }
              }
            } catch (eD) { /* 忽略 */ }
          };
          try {
            const abs = url.slice(0, 8).toLowerCase();
            const absolute = abs.indexOf("http://") === 0 || abs.indexOf("https://") === 0;
            const sameOrigin = !absolute || url.indexOf(window.location.origin) === 0;
            const apiish = url.indexOf("/api/") >= 0 || url.indexOf("/remote/") >= 0
              || url.indexOf("_devices") >= 0 || url.indexOf("_quota") >= 0;
            if (sameOrigin && apiish && p && typeof p.then === "function") {
              p.then((res) => {
                drop();
                try {
                  const st = res && typeof res.status === "number" ? res.status : 0;
                  /* 5xx 且**没有** x-dsh-e2ee-error = 电脑端/隧道不可达；
                     E2EE 死会话的 502 另带那个头，它属于"会话失效"（C3 修的就是它），
                     和"电脑端离线"是两回事 —— 混在一起就又变成文案归因错误。 */
                  if (st >= 500 && !maResHasE2eeError(res)) maNotePresenceFail(st);
                  else maNoteRtt(maNowMs() - t0, url);
                } catch (eS) { maNoteRtt(maNowMs() - t0, url); }
              }, (err) => {
                drop();
                try {
                  /* 自己/调用方主动取消的请求不是"不可达" —— 官方客户端在切会话时本来就会 abort，
                     把它算成离线会让文案长期钉在"电脑端可能未连接"（正是要修的那个误导）。 */
                  const selfAborted = !!(ac && ac.signal && ac.signal.aborted);
                  const callerAborted = !!(init && init.signal && init.signal.aborted);
                  const abortErr = !!(err && (err.name === "AbortError" || err.code === 20));
                  if (!selfAborted && !callerAborted && !abortErr) maNotePresenceFail(0);
                } catch (eF) { /* 忽略 */ }
              });
            } else if (p && typeof p.then === "function") {
              p.then(drop, drop);
            }
          } catch (eW) { drop(); }
          return p;
        };
        wrapped.__dshMaNetSampler = true;   // 只作记号便于人造排查（**不作**幂等判据）
        maNetPatch.installed = true;        // 稳定幂等判据
        window.fetch = wrapped;
        maNetPatch.ok = true;
        return true;
      } catch (eI) { return false; }
    };

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
        // 网络延迟（0.6.18）：样本来自**已有**的 fetch 包装，零新增请求；无样本时显示「测速中…」。
        // ⚠️ 单独一小节（不塞进「加密状态」）：两者是独立的可观测项，混在一起会让"加密好好的、
        //    但网很慢"这种情况读起来像加密出了问题。
        '<div class="dsh-ma-menu-sec">网络延迟</div>' +
        '<div class="dsh-ma-menu-net" data-role="net"><span class="ico">📶</span><span class="txt">测速中…</span></div>' +
        '<div class="dsh-ma-e2ee-sec" data-role="e2ee-sec">' +
          '<div class="dsh-ma-menu-sec">加密状态</div>' +
          '<div class="dsh-ma-menu-e2ee" data-role="e2ee"><span class="ico">🔒</span><span class="txt">正在读取…</span></div>' +
        '</div>' +
        // 「打开右侧栏」（0.6.18）：手机端第三列是离屏浮层，滑入闸门要求"用户 8 秒内在正文点过"，
        // 而把按钮注册进官方右栏的第三方插件（如 dsh-better-sidebar）只翻它自己的 store，
        // 官方 cols.rightbar 永远是 0 → 面板永远不滑进来。这里给用户一条明路（详见下方 click 处理）。
        // ❌ 这里曾有颗「📋 打开右侧栏」按钮（0.6.18-beta.1/2）。已删：
        //    它是「我们自绘浮层 → 浮层会挡屏 → 加闸门 → 闸门挡住第三方插件 → 再补个手动入口」
        //    这条错误链的最后一环。官方右栏自己就能开（窄屏还会自动收左栏），不需要这颗按钮。
        '<button type="button" class="dsh-ma-menu-back">← 返回设备列表</button>' +
        '<div class="dsh-ma-load-warn" data-role="load-warn" hidden>' +
          '<span class="ico">⚠</span>' +
          '<span class="txt" data-role="load-warn-txt"></span>' +
        '</div>' +
        /* C9（2026-10-20 诊断，03 报告 §2.4 D3「文案与实现不一致」）：旧文案说「密钥只在内存、刷新就没了」，
           已经**不成立** —— 实现会把派生 MK 写 localStorage、交接单同时写 sessionStorage +
           localStorage（native.html:5143-5160 / :5204，镜像页 _boot 从 localStorage 恢复）。
           照着旧文案，客服和用户会做出错误动作（以为刷新必丢密钥）。现在如实说清三件事：
           ① 已记住本机，刷新自动恢复加密；② 提示「加密会话已失效」才需要回列表重新解锁；
           ③ 明文模式功能可用、但不加密（避免用户以为"没加密=没得用"）。 */
        '<div class="dsh-ma-menu-note">返回后可重新选择设备。端到端加密已记住本机：刷新页面会自动恢复加密；'
        + '若提示「加密会话已失效」，需返回设备列表重新解锁；明文模式下功能可用，但数据不经端到端加密。</div>';
      document.body.appendChild(menu);
      maWireLoadWarn(menu); // 加载疑似失败时，在这一行里说明白（点一下可复制）

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
      fab.title = "远程控制：字号 / 网络延迟 / 加密状态 / 返回设备列表（可拖动移动位置）";
      /* 图标（0.6.18 起）:原来的「字」换成手机图标 —— 用户口述「要我们自己用的那个手机的图标」。
         锁 🔒 依旧在右上角（.dsh-ma-fab-lock），延迟角标在**正下方**（.dsh-ma-fab-rtt，见 CSS）。 */
      fab.innerHTML = '<span class="dsh-ma-fab-ico" aria-hidden="true">' + ${JSON.stringify(FAB_PHONE_SVG)} + '</span>'
        + '<span class="dsh-ma-fab-lock" data-role="lock">🔒</span>'
        + '<span class="dsh-ma-fab-rtt" data-role="rtt" hidden></span>';
      fab.style.left = Math.round(clampFabXY(fabXY(fabPos)).left) + "px";
      fab.style.top = Math.round(clampFabXY(fabXY(fabPos)).top) + "px";
      document.body.appendChild(fab);

      const fsRange = menu.querySelector('input[type="range"]');
      const fsVal = menu.querySelector(".dsh-ma-menu-fsval");
      /* 注:原来的「预览：手机远程控制，随手可用。」那一行（.dsh-ma-menu-preview）已按用户要求删除
         —— DOM / CSS / 这里的联动三处一起删。字号是否生效不需要一行示例文案：改滑块时
         官方正文（--dsh-content-font-size）与整页文本缩放是立刻可见的。 */
      const setLevel = (level, persist) => {
        const L = applyFsLevel(level);
        if (fsVal) fsVal.textContent = L.name;
        if (fsRange && Number(fsRange.value) !== level) fsRange.value = String(level);
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

      /* ---- 网络延迟（0.6.18）-------------------------------------------------------
         需求原话是「要能看见网络延迟」。这里**绝不主动测速**：任何 ping/定时打点都会给手机
         加流量、给中继加请求，而镜像页本来就有 HTTP 流量。样本全部取自下面那个**已经存在**的
         window.fetch 包装（0.6.17 起为「会话过期探测」而装，只读 res.status）。
         注入顺序保证了语义正确：bridge 先注入 adapter、后注入 e2ee shim
         （dsh-bridge.mjs:763 → :770），两者都 splice 到 </head> 前 → adapter 的 fetch 包装在
         **内层** → 它量到的是"去掉加解密后的真实网络往返"（这正是用户想要的"网速"）。

         统计约定：最近 RTT_KEEP(8) 次**成功**样本取中位数。
           · 用中位数而不是均值/EWMA：偶发的一次 GC/系统调度卡顿会把均值永久带偏，
             中位数对单次离群点免疫，同时比"最小值"更贴近体感（最小值永远偏乐观）；
           · 失败（reject）/超时（>20s）/亚毫秒（同一帧内的缓存命中）都不进样本：
             前者不是网络耗时，后者会算出 0ms 这种"谎言"；
           · **无样本时显示「测速中…」而不是 0ms** —— 0ms 会让人以为网络飞快。
         分档（2026-09-27 用户约定调整）：≤500ms 顺畅 / ≤1000ms 正常 / ≤2000ms 偏慢 / >2000ms 很慢。
         为什么放宽：这是个**文本窗口**的远程操作界面（看输出、敲字、点按钮），
         对往返延迟本来就宽容 —— 用户原话「500ms 以内的延迟都不叫事，1000ms 使用起来也是正常流畅的」。
         旧的 120/300 分档是照"网页首屏"的体感定的，会把大量正常可用的移动网络误报成"较慢"，
         反而让用户以为哪里坏了。 */
      const RTT_KEEP = 8, RTT_MAX_MS = 20000;
      /* 建菜单时的引用只作**兜底**：正常路径每次渲染都现查实时 DOM（见 liveNetEl/liveRttEl）。 */
      const rttEl = fab.querySelector('[data-role="rtt"]');
      const netEl = menu.querySelector('[data-role="net"]');
      /* 样本一律读 window 上那一份（由上面的 maNoteRtt 写入，跨"菜单被重建"共享）。 */
      const rttSamples = (window.__dshMaRttSamples || (window.__dshMaRttSamples = []));
      const rttValue = () => {
        if (!rttSamples.length) return null;
        const s = rttSamples.slice().sort((a, b) => a - b);
        const mid = s.length >> 1;
        return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
      };
      /* 分档（2026-09-27 按用户约定放宽）：文本窗口的远程操作，500ms 内都算顺畅、1000ms 内正常流畅。
         ok=顺畅 / mid=正常 / slow=偏慢 / bad=很慢 —— 颜色只用于区分，**不把"正常"渲染成告警色**。 */
      const rttGrade = (ms) => (ms <= 500 ? "ok" : ms <= 1000 ? "mid" : ms <= 2000 ? "slow" : "bad");
      const rttLabel = (g) => (g === "ok" ? "顺畅" : g === "mid" ? "正常" : g === "slow" ? "偏慢" : "很慢");
      const FAB_TITLE_BASE = "远程控制：字号 / 网络延迟 / 加密状态 / 返回设备列表（可拖动移动位置）";
      /* 🔴 每次渲染都**现查实时 DOM**（2026-10-10 二修）。
         抱着建菜单时的旧引用是"样本在涨、界面却永远停在初始文案"的经典成因：官方 SPA 换掉 body
         子树后旧引用脱离文档，更新写进了看不见的节点。现查则永远写用户真正看得见的那一个；
         查不到才退回旧引用（宽屏/菜单未开时本来就没有可写的节点）。 */
      const liveNetEl = () => { try { return document.querySelector(".dsh-ma-menu-net") || netEl; } catch (eQ) { return netEl; } };
      const liveRttEl = () => { try { return fab.querySelector('[data-role="rtt"]') || rttEl; } catch (eQ2) { return rttEl; } };
      const renderRtt = () => {
        try {
          const ms = rttValue();
          const g = ms === null ? "" : rttGrade(ms);
          // 0ms 是句谎话（不足 1ms 的真实往返会被四舍五入成 0）→ 展示层夹到 ≥1ms。
          const shown = ms === null ? null : Math.max(1, Math.round(ms));
          const rEl = liveRttEl();
          if (rEl) {
            if (shown === null) { rEl.hidden = true; rEl.textContent = ""; rEl.removeAttribute("data-rtt"); }
            else {
              rEl.hidden = false;
              rEl.textContent = shown + "ms";
              rEl.setAttribute("data-rtt", g);
            }
          }
          const nEl = liveNetEl();
          if (nEl) {
            nEl.setAttribute("data-rtt", g || "");
            const ico = nEl.querySelector(".ico");
            const txt = nEl.querySelector(".txt");
            if (ico) ico.textContent = shown === null ? "📶" : (g === "bad" ? "📵" : "📶");
            if (txt) {
              /* 空态**说清原因**（2026-10-10）：以前只有一句「等一次网络请求后显示」，
                 于是"采样器压根没接上"和"接上了但还没有请求"长得一模一样，用户两次反馈
                 我们都只能猜。现在一眼可分。 */
              txt.textContent = shown !== null ? (shown + " ms · " + rttLabel(g))
                : (maNetPatch.ok ? "测速中…（已接上，等一次请求）" : "测速中…（采样器未接上）");
            }
          }
          try { fab.title = shown === null ? FAB_TITLE_BASE : ("远程控制：网络延迟 " + shown + "ms（" + rttLabel(g) + "） / 字号 / 加密状态 / 返回设备列表（可拖动）"); } catch (e) { /* 忽略 */ }
        } catch (e) { /* 延迟显示失败绝不影响主功能 */ }
      };
      maNetRender = renderRtt;   // 注册给采样器（样品到达时回调它）
      renderRtt();

      /* ❌ 这里曾有「打开右侧栏」这一段与 maRightPane* 三件套 —— 2026-09-27 根治时整条删除。
         原因见 STYLE 段顶部：官方右栏在窄屏本来就是全屏浮层，我们把它劫持成自绘浮层
         （祖先 transform 会给 fixed 后代创建包含块）才导致「点开变整屏黑遮罩」。
         官方自己的 tab / 会话头按钮就会调 ctx.layout.openRightbar(track, fullscreen)。 */

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
      // 打开菜单时刷新一次延迟显示（与 renderE2ee 同理：被动展开的 UI 不需要定时器，
      // 打开的那一刻就是最新的）
      const openMenu = () => { renderE2ee(); renderRtt(); menu.hidden = false; placeMenu(); };
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
              /* ⚠️ 2026-10-10：这里**不再**做网络延迟采样 —— 采样已独立成 maInstallNetSampler()
                 （与菜单 DOM 解耦、幂等、自愈）。本包装只负责「会话过期探测」这一件事，
                 否则同一趟请求会被量两次。 */
              const p = origFetch.call(this, input, init);
              try {
                const abs = url.slice(0, 8).toLowerCase();
                const sameOrigin = !(abs.indexOf("http://") === 0 || abs.indexOf("https://") === 0) || url.indexOf(window.location.origin) === 0;
                const apiish = url.indexOf("/api/") >= 0 || url.indexOf("/remote/") >= 0 || url.indexOf("_devices") >= 0 || url.indexOf("_quota") >= 0;
                if (sameOrigin && apiish && p && typeof p.then === "function") {
                  p.then((res) => {
                    try { noteStatus(res && res.status); } catch (e6) { /* 忽略 */ }
                    /* 延迟采样已移到 maInstallNetSampler，这里只报会话过期 */
                  }, () => { /* 网络错误不算会话过期，也不算延迟样本 */ });
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
      /* 📶 **先**把延迟采样器挂上（2026-10-10）：它必须在"任何请求发生之前"就位。
         即便 buildRemoteMenu() 因为任何原因没能建出菜单（或抛错），采样器也照挂不误 ——
         旧实现把包装写在 buildRemoteMenu 内部的一次性分支里，那正是"请求明明在打、
         界面却永远测速中"的结构性原因。 */
      try { maInstallNetSampler(); } catch (eSampler0) { /* 忽略 */ }
      /* 上传失败可读提示（2026-10-23）：与采样器同样"越早越好"，且幂等 —— 看门狗每拍调用无副作用。 */
      try { maInstallUploadTap(); } catch (eUploadTap0) { /* 忽略 */ }
      /* 悬浮按钮/菜单：任何宽度都要有（电脑端访问镜像页时同样需要返回设备列表的出口）。
         失败也不影响手机端布局适配 —— 两条链路各自独立。 */
      if (!fabDone) { fabDone = true; try { buildRemoteMenu(); } catch (eFabDone) { /* 忽略 */ } }
      if (done || !NARROW()) return;
      const frame = document.querySelector(".pI_x6G_frame, [data-sidebar-collapsed], [data-details-collapsed], [data-rightbar-collapsed]");
      if (!frame || !frame.querySelector) return;
      /* ==== C6（2026-10-20 诊断）：先探测官方锚点，认不出就整段降级 ====
         为什么必须在**打标记/建节点之前**判：compat-official 模式下我们一个 class 都不给官方加
         （否则 CSS 会把三列轨道改成 0/1fr/0，等于用错的锚点把官方布局也一起改了）。
         认不出来时的正确退路是"没有手势"，不是"自绘抽屉 + scrim 盖住官方界面"。 */
      const anchors = maProbeOfficialAnchors(frame);
      /* 官方 frame 已挂载、但子列还没渲染出来 → 只是"还没长好"，不是锚点缺失：
         不降级、不置 done，交给 pump 下一拍再看（一次性降级只应该发生在"结构稳定但认不出"时）。 */
      if (anchors.pending) return;
      if (anchors.on) {
        maEnterCompatOfficial(anchors.reasons);
        done = true;   // 不再重试：官方锚点是一齐变的，反复探测只会反复误判（还会让 pump 每拍全量扫 DOM）
        return;
      }
      done = true;
      frame.classList.add("dsh-ma-frame");

      /* 给 frame 子列打稳定标记(dsh-ma-*),规避官方类名前缀随构建变化。
         ⚠️ 必须先把**不是列**的节点剔掉（2026-09-19 故障根因）：
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
              (精确匹配,绝不再用 *="sidebar" 这种包含匹配 —— 那正是故障来源);
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
        const t = toggleOf();
        /* C6：代替用户点官方 toggle 一律走 maClickOfficialToggle（失败即停手/可被开关关闭），
           绝不让"点官方入口"变成把官方状态点乱的来源。 */
        maClickOfficialToggle(t);
        /* 兜底 + 保险:无论官方 toggle 在不在,都确保"点空白处"能关掉/不再拦截 */
        document.documentElement.classList.remove("dsh-ma-sidebar-open", "dsh-ma-scrim-on");
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
        const desired = !nowOpen;
        userWantsOpen = desired;
        const t = toggleOf();
        /* ⚠️ 0.6.18 修（用户报的「点官方抽屉里的收起按钮 → 白柱 + 整屏被困，只有刷新能出去」）：
           旧实现无论官方当前是什么状态都无条件 t.click() —— 于是"适配层以为开着、官方其实已收起"时，
           这一点会把官方**推回展开**，而我们的 class 被摘掉 → 抽屉隐形；再点一次又反过来，
           两态互相打架、白柱反复重现。现在只在**官方当前态 ≠ 期望态**时才点官方 toggle：
           状态一致时点它只会把官方推到相反方向。 */
        if (t && expanded() !== desired) { maClickOfficialToggle(t); }
        sync();                                   // 立刻按意图生效(不依赖官方属性回调)
      });

      /* 侧栏是否**真的**滑进了视口。这是"遮罩能不能拦截点击"的最后一道保险：
         只要官方属性语义与我们理解的不一致，光看属性就可能误判；而遮罩一旦拦截整屏，
         用户看到的就是"整屏阴影 + 点哪都没反应"。以实测几何为准（isDrawer），误判也不会挡住用户。 */
      /* 抽屉必须"像抽屉"：不是全屏层（overlay 层/主内容区都被排除在外）、不是拖拽把手、
         **与视口真正相交**。任一不满足 → 它就不该让遮罩拦截点击（0.1.5 故障的结构性防线）。
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
      // ❌ 已随 2026-09-27 根治删除：detailsInView（第三列不再由我们判显隐）。
      /**
       * 抽屉列是不是**空壳**：官方已经把内容收起来了，只剩一个宽度还在的固定柱。
       *
       * 为什么需要（0.6.18 用户报的白柱）：用户点官方抽屉里的收起按钮后，userWantsOpen 仍为 true
       * → html.dsh-ma-sidebar-open 常亮 → CSS 把 sidebarCol 钉成 fixed + translateX(0) + z-index:310，
       * 而官方已把列宽压成 0、内容收起 → 剩下一个**没有内容的白色固定柱**盖住左半屏；
       * 它几何上"在视口里"（width≈340 < 0.98vw），连遮罩不变量都会误判成"抽屉还在"→ 整屏被困。
       * 这里让"空壳"不算可交互抽屉，遮罩就有机会被摘掉（不变量见 enforceScrimInvariant）。
       *
       * ⚠️ 判不出来时一律当作"不是空壳"（保守：宁可多留遮罩一帧，也绝不在正常抽屉上误摘）。
       * ⚠️ 只对**抽屉列**判：详情列在"还没挂内容"时是合法状态（官方按需挂载），
       *    对它用同一条判据会把"详情列展开"的正常路径一起判死。
       */
      const isShellColumn = (el) => {
        if (!el) return true;
        try {
          // ① 有实质子节点 → 不是空壳（折叠≠卸载：官方收起时面板仍挂载）
          const kids = el.children;
          if (!kids || typeof kids.length !== "number") return false;
          if (kids.length > 0) return false;
          // ② 真浏览器里还能再看一眼可视高度：高度为 0 = 内容确实没了
          if (typeof el.clientHeight === "number" && el.clientHeight === 0) return true;
          return true;   // 子节点为空 → 空壳（官方折叠后内容被卸载的情况）
        } catch (e) { return false; }
      };
      /* ❌ 已随 2026-09-27 根治删除：detailsCollapsed / detailsAttrKnown / detailsAttrLive 三件套 ——
         它们的前提是「由我们决定第三列显隐」，而决定权已交还官方。 */
      /* 状态来源（按优先级）：
         ① 用户意图 userWantsOpen —— 点菜单按钮打开 / 点遮罩关闭，期间**不被几何判定推翻**；
         ② 官方 frame 的 data 属性 —— 用户没表达意图时（初始、官方自己切换）以它为准。
         ⚠️ 上一版把"几何判定"直接作用在展开 class 上，等于「侧栏还没滑进来就不许展开」：
            点菜单按钮加 class → 动画未开始、rect 仍在屏外 → sync 立刻把 class 摘掉 → 抽屉永远打不开。
            现在只让几何判定决定**遮罩能否拦截点击**（最后一道保险），不再否决用户的展开意图。 */
      let userWantsOpen = null; // null=未表达意图（跟随官方）; true/false=用户已明确开/关
      /* 0.6.18 白柱修复的辅助状态（见 sync() 的长注释）：
         · lastOfficialCollapsed —— 上一次 sync 时官方说的折叠态；用它识别"官方**刚刚**收起"
           这个**边沿**（只有边沿才算"用户点了抽屉内的收起按钮"，才不会误杀用户刚表达的展开意图）；
         · officialExpandedSeen —— 是否**见过官方说"展开"**（与上一条共同构成边沿的合法性）。 */
      let officialExpandedSeen = false;
      let lastOfficialCollapsed = null;
      let scrimTimer = 0, scrimWatchdog = 0;
      /* ❌ 这里曾有「详情列(第三列)在手机端的显示条件」整段判据（白框故障后打的四层闸门）。
         2026-09-27 根治时删除：第三列的显隐**完全交还官方** —— 宽屏按 grid 列、窄屏全屏浮层。
         我们不再有"要不要显示它"的决定权，也就不需要任何判据。 */

      // ❌ 已随 2026-09-27 根治删除：detailsSeenCollapsed。
      // ❌ 同一批删除：centerTouchedAt / detailsSticky 的说明（自绘浮层时代的启发式）。

      /* ❌ 已随 2026-09-27 根治删除：CENTER_TOUCH_MS / centerTouchedAt / detailsSticky / rightPaneWanted ——
         这套「用户 8 秒内在正文点过 / 从 FAB 明确要求」的启发式闸门，是为自绘浮层打的补丁。 */
      /**
       * 官方右栏里到底有没有"宿主注册的内容"？—— 有内容才值得滑进来。
       * 判据只用**官方结构 + 几何**，绝不认 better-sidebar 的私有标记
       * （data-rightbar-col / data-dsh-center-col —— R2 明确记录那是 0.6.15/0.6.16 反复踩的坑：
       *  插件换版本/被卸载，标记就没了，适配层跟着失灵）。
       * 为什么重要：官方右栏收起时**面板仍然挂载**（只是平移出 frame 右缘），所以"有子节点"
       * 就足以说明"这颗按钮后面真有东西可看"，而不是一片空白。
       */
      // ❌ 已随 2026-09-27 根治删除：rightPaneHasContent（「右栏里有没有内容」也交给官方判断）。
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
      /* 遮罩的「视口里确实有一层可交互抽屉」判据 —— 现在**只认左抽屉**。
         第三列（官方右栏）不再是我们的浮层，也就绝不应该让我们的遮罩下闸。 */
      const anyDrawerInView = () =>
        (sidebarInView() && !isShellColumn(sidebar || document.querySelector(".dsh-ma-sidebar")));
      /* 遮罩闸门：**只有此刻真的看得见抽屉**才允许拦截点击。
         抽屉是滑入动画（.22s），所以同步判定必然"还看不见" —— 那一瞬间不下闸即可，
         真正的下闸交给下一帧与动画结束后的复核（applyScrim），既不误拦也不影响手感。
         另外 CSS 侧已收口成"只认 dsh-ma-scrim-on 一个闸"，不会再出现"某个 class 常亮 → 整屏被拦"。 */
      const scrimShouldBeOn = () => {
        // 只认**左抽屉**：第三列（官方右栏）交还官方之后，窄屏时官方自己做全屏浮层，
        // 不需要（也不该）由我们再盖一层遮罩 —— 那正是「点开变整屏黑」的直接成因。
        const html = document.documentElement;
        if (html.classList.contains("dsh-ma-sidebar-open") && sidebarInView()) return true;
        return false;
      };
      /* C6 诊断：scrim 的"实际下闸"与"不变量摘除"都计数（「window.__dshMaDiag」/ 复制诊断时带出）。
         为什么需要：用户报「又点不动了」时，只靠肉眼分不清"遮罩在拦"和"遮罩早被摘了"，
         这两类问题的修法完全不同 —— 计数就是现场的第一手证据。 */
      let maScrimWasOn = false;
      const applyScrim = () => {
        try {
          const want = scrimShouldBeOn();
          document.documentElement.classList.toggle("dsh-ma-scrim-on", want);
          if (want && !maScrimWasOn) { maScrimStats.activations += 1; maScrimStats.lastActivationAt = Date.now(); maPublishDiag(); }
          maScrimWasOn = want;
        } catch (e2) { /* 忽略 */ }
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
          maScrimWasOn = false;
          maScrimStats.invariantHits += 1;   // C6 诊断：不变量真的救过一次场
          maPublishDiag();
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
            if (!html.classList.contains("dsh-ma-scrim-on") && !html.classList.contains("dsh-ma-sidebar-open")) {
              clearInterval(scrimWatchdog); scrimWatchdog = 0;
            }
          }, 800);
        } catch (e2) { scrimWatchdog = 0; }
      };
      const sync = () => {
        /* ★ 0.6.18 修（用户报的「点官方抽屉里的收起按钮 → 左半边一片白色占位，只有刷新能出去」）：
           识别的关键是**边沿**而不是状态 —— 官方"刚刚从展开翻转成收起"（collapsedEdge）才是
           "用户点了抽屉内的收起按钮"这个动作。为什么不能只看"官方说收起"：用户点汉堡展开时
           官方属性往往还没跟上（toggle 点了 store 还没提交，或官方 toggle 压根不存在），
           只按状态复位会把用户的展开意图当场掐掉 → 抽屉永远打不开（0.6.6-beta.3 的回归点，
           护栏用例守着）；也不能只靠几何（白柱 width≈340，"在视口里"，几何判不出它是空壳）。 */
        const officialCollapsed = collapsed();
        const collapsedEdge = officialCollapsed && lastOfficialCollapsed === false;
        if (!officialCollapsed) officialExpandedSeen = true;
        lastOfficialCollapsed = officialCollapsed;
        if (userWantsOpen === true && collapsedEdge) userWantsOpen = null;   // 官方收起 → 放弃过期意图
        /* 把**官方**的折叠态与我们**当前的展开意图**一起镜像到 <html>：
           CSS 依据这两者做最后一道不依赖任何 JS 判定的硬保证（见 STYLE 里的
           html.dsh-ma-official-collapsed:not(.dsh-ma-user-wants-open) 那条）——
           "官方说收起、且我们已经没有活的展开意图"时，这一列一律留在屏外。
           为什么这样收窄：用户明确要开（意图为 true）时必须能开，哪怕官方 toggle 坏了、
           属性永远是"收起"（那是 0.6.9-beta.2 就定下的自救路径，护栏用例守着）。 */
        try {
          document.documentElement.classList.toggle("dsh-ma-official-collapsed", officialCollapsed);
          document.documentElement.classList.toggle("dsh-ma-user-wants-open", userWantsOpen === true);
        } catch (e0) { /* 忽略 */ }
        const open = userWantsOpen !== null ? userWantsOpen : expanded();
        document.documentElement.classList.toggle("dsh-ma-sidebar-open", open);
        /* 汉堡按钮**始终可见**：以前判定为"展开"时会把它 display:none 隐藏，
           于是判定一旦出错（或遮罩因异常常亮），用户既点不动内容、也没有任何入口 —— 死局。
           保持可见 + 点它可开可关（见其 click 处理），任何异常状态下都留一条出路。
           它的 z-index(320) 高于抽屉(310)/详情列(300)/遮罩(290) —— 判定怎么错都点得到。 */
        if (hamburger) hamburger.style.display = "";
        /* ❌ 2026-09-27 根治：这里曾用四层判据决定"第三列（官方右栏）要不要滑进来"，
           并 toggle dsh-ma-details-open。整段删除 —— 第三列的显隐**完全交还给官方**：
             · 宽屏：官方按 grid 列摆（computeColumns）；
             · 窄屏：官方把它做成全屏浮层（.P3OORG_panel[data-sidebar-right-panel=fullscreen]
               { position:fixed; inset:0 }），并且 openRightbar() 时自动收起左栏。
           我们插手的两个后果都已真机验证：① 祖先 transform 会给 fixed 后代创建包含块 →
           官方全屏面板被推到屏幕外；② 我们再开遮罩 → 只剩"整屏一层黑"。
           现在这里**刻意什么都不做**，护栏用例守着「不得出现 dsh-ma-details-open」。 */
        // 遮罩:同步先按当前几何下闸(抽屉已在视口内时无延迟),再在动画开始/结束后复核两次
        applyScrim();
        try {
          if (typeof requestAnimationFrame === "function") requestAnimationFrame(applyScrim);
          clearTimeout(scrimTimer);
          scrimTimer = setTimeout(() => { enforceScrimInvariant(); applyScrim(); }, 300);
        } catch (e2) { /* 忽略 */ }
        armScrimWatchdog();
      };
      /* ❌ 「打开右侧栏」的实现已整条删除（2026-09-27 根治，原因见 STYLE 段顶部的长注释）。 */
      /* ❌ 「在正文里点一下才允许详情列滑入」的 click 委托已删除（2026-09-27 根治）。
         那道启发式闸门存在的唯一理由，是我们把官方右栏改成了自绘浮层、怕它白框压屏；
         现在右栏完全交还给官方（官方自己 openRightbar / fullscreen），闸门没有存在意义了）。 */
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
            if (togg) setTimeout(() => { maClickOfficialToggle(togg); }, 0);
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
      /* 📶 采样器**自愈**（2026-10-10）：本函数每拍都跑（MutationObserver/1s 兜底），
         所以只要 window.fetch 被谁换掉（我们自己注入的 E2EE shim 会在"解锁"时再包一层、
         官方若在运行期替换 fetch 同理），下一拍就会把采样器重新挂回去 —— 幂等，已挂上时零开销。
         同时顺手重绘一次：官方 SPA 换掉菜单子树后，数字不必等下一次请求才回来。 */
      try { maInstallNetSampler(); } catch (eSampler) { /* 忽略 */ }
      try { maInstallUploadTap(); } catch (eUploadTap) { /* 忽略 */ }
      try { if (maNetRender) maNetRender(); } catch (eNetRender) { /* 忽略 */ }
      try { ensureDrawerChrome(); } catch (eChrome2) { /* 忽略 */ }
      /* 镜像页就绪探测（mirror_load 的量测终点）：pump 本来就被 MutationObserver(子树) + 1s 兜底表
         驱动，官方 frame/输入框一挂上就会在**这一拍或下一拍**（≤1s）命中 —— 这正是契约要求的
         "终点的时刻"，而且不需要再加任何定时器或观察者。只在还没上报过时判一次（reported 挡重复）。 */
      if (!maLoadWatch.reported) { try { if (maLoadReadyNow()) maReportMirrorLoad("ok"); } catch (eLoadOk) { /* 忽略 */ } }
      if (!whaleGuardsOn || !settingsWatchOn) {
        try { whaleHookInit(); watchSettings(); } catch (eHook) { /* 两者内部都自带一次性守卫 */ }
      }
      /* 设置面板结构识别(自带节流,幂等):官方每次重新打包都换混淆前缀,
         这一步保证"改名后仍然基本可用",而不是整段静默失效(2026-10-13 根因)。 */
      try { maSettingsMaybeTag(); } catch (eSetTag) { /* 忽略 */ }
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
    /* ===== 手机图片上传兼容（0.6.15）=====
       用户反馈：「手机端无法识别图片」——现象是选了照片发出去，模型看不到图 / 当成普通文件。

       根因（官方 dsh web 客户端逻辑,dsh-client-ui-conversation 的 createDrafts）:
         · 只有 file.type ∈ {image/png, image/jpeg, image/webp, image/gif} 才走**图片**通道
           （本地编码后随 prompt 发出，模型真的"能看"）；
         · 其余一律当**普通文件**：走 Web Worker 后台上传，模型只拿到一个文件引用。
       而手机恰恰最容易产出"非白名单"的图片：
         · iPhone 默认「高效」格式拍出来是 image/heic（不在白名单）；
         · 部分 Android 图库 / 文件提供器给出的是**空 type**（""）；
         · 从"文件"入口选的还可能是 heif / bmp / tiff / avif。

       做法（全在浏览器里完成，不动官方代码、不动 host）：
         1) 在**捕获阶段**监听 change（比 React 根容器的监听更早）:官方隐藏 input[type=file]
            被选中后,若里面有"是图片但不在白名单"的文件,就先拦下这次事件,
            用 canvas 把它转成 JPEG，再**替换 input.files 并重新派发一次 change** ——
            这样官方按图片通道收下，模型就能"看见"了；
         2) 任何一步失败（浏览器解不了 HEIC / canvas 不可用 / DataTransfer 不可用…）
            一律**把原始文件原样重新派发**，绝不比现状更差（宁可当普通文件，也不能丢文件）；
         3) 官方认得的类型一个字节都不碰（零行为）。 */
    var MA_IMG_OK = { "image/png": 1, "image/jpeg": 1, "image/webp": 1, "image/gif": 1 };
    var MA_IMG_EXT_RE = /\\.(png|jpe?g|webp|gif|heic|heif|bmp|tiff?|avif)$/i;
    var MA_MAX_DIM = 4096;              // 与官方 imageLimits.maxImageDimension 对齐，避免超限被拒
    var MA_CONVERT_TIMEOUT = 8000;      // 解码卡住就放弃（原样放行）
    var MA_REENTRY = "__dshMaImageDone"; // 标记"这次 change 是我们自己派发的"

    function maIsImageFile(f) {
      var t = String((f && f.type) || "").toLowerCase();
      if (t) return t.indexOf("image/") === 0;
      return MA_IMG_EXT_RE.test(String((f && f.name) || ""));
    }
    /** 需要转码吗：是图片、但不在官方白名单里。 */
    function maNeedsConvert(f) {
      var t = String((f && f.type) || "").toLowerCase();
      if (MA_IMG_OK[t]) return false;
      return maIsImageFile(f);
    }
    /** 扩展名 → 白名单里的 MIME（拿不到返回空）。 */
    function maMimeFromName(name) {
      var m = /\.([A-Za-z0-9]+)$/.exec(String(name || ""));
      if (!m) return "";
      var e = m[1].toLowerCase();
      if (e === "png") return "image/png";
      if (e === "jpg" || e === "jpeg") return "image/jpeg";
      if (e === "webp") return "image/webp";
      if (e === "gif") return "image/gif";
      return "";
    }
    /**
     * 只改 type、不重编码（**无损**）。
     * 为什么需要：Android 图库/文件提供器很常见地给出 type:""，而文件本身其实是标准 PNG/JPEG ——
     * 这时把字节丢进 canvas 重编码纯属浪费（还可能丢透明通道），改个 MIME 就够了。
     */
    function maRelabel(file, mime) {
      try {
        return new File([file], String(file.name || "image"), { type: mime, lastModified: file.lastModified || Date.now() });
      } catch (e) {
        try { var b = file.slice(0, file.size, mime); b.name = file.name; return b; } catch (e2) { return null; }
      }
    }
    /** 单个文件的归一化：优先无损改 MIME，实在不行才 canvas 转 JPEG。 */
    async function maNormalizeImage(file) {
      var mime = maMimeFromName(file && file.name);
      if (mime && String(file.type || "") !== mime) {
        var relabeled = maRelabel(file, mime);
        if (relabeled) return relabeled;
      }
      return await maToJpeg(file);
    }
    function maToJpeg(file) {
      return new Promise(function (resolve) {
        var url = "";
        try { url = URL.createObjectURL(file); } catch (e0) { resolve(null); return; }
        var settled = false;
        var finish = function (out) {
          if (settled) return;
          settled = true;
          try { URL.revokeObjectURL(url); } catch (e1) { /* 忽略 */ }
          resolve(out);
        };
        var timer = setTimeout(function () { finish(null); }, MA_CONVERT_TIMEOUT);
        var img;
        try { img = new Image(); } catch (e2) { clearTimeout(timer); finish(null); return; }
        img.onload = function () {
          clearTimeout(timer);
          try {
            var w = img.naturalWidth || img.width || 0;
            var h = img.naturalHeight || img.height || 0;
            if (!w || !h) return finish(null);
            var scale = Math.min(1, MA_MAX_DIM / Math.max(w, h));
            var cw = Math.max(1, Math.round(w * scale));
            var ch = Math.max(1, Math.round(h * scale));
            var cv = document.createElement("canvas");
            cv.width = cw; cv.height = ch;
            var ctx = cv.getContext("2d");
            if (!ctx) return finish(null);
            ctx.drawImage(img, 0, 0, cw, ch);
            cv.toBlob(function (blob) {
              if (!blob) return finish(null);
              var base = String(file.name || "photo").replace(/\\.[^./\\\\]+$/, "") || "photo";
              try {
                finish(new File([blob], base + ".jpg", { type: "image/jpeg", lastModified: Date.now() }));
              } catch (e3) {
                // 极老的浏览器没有 File 构造器 → 用 type 改写过的 Blob 兜底（官方只看 type/name）
                try { blob.name = base + ".jpg"; finish(blob); } catch (e4) { finish(null); }
              }
            }, "image/jpeg", 0.92);
          } catch (e5) { finish(null); }
        };
        img.onerror = function () { clearTimeout(timer); finish(null); };
        try { img.src = url; } catch (e6) { clearTimeout(timer); finish(null); }
      });
    }
    /** 把 files 塞回 input（DataTransfer 缺失/只读 → 返回 false，调用方走"原样重发"）。 */
    function maSetInputFiles(input, files) {
      try {
        var dt = new DataTransfer();
        for (var i = 0; i < files.length; i++) dt.items.add(files[i]);
        if (!dt.files || dt.files.length !== files.length) return false;
        input.files = dt.files;
        return true;
      } catch (e) { return false; }
    }
    /** 重新派发一次 change（带重入标记，避免我们自己的监听再拦一次）。 */
    function maRedispatch(input) {
      try {
        input[MA_REENTRY] = true;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (e) { /* 忽略 */ } finally {
        setTimeout(function () { try { input[MA_REENTRY] = false; } catch (e2) { /* 忽略 */ } }, 0);
      }
    }
    async function maOnFilePicked(input) {
      var list = input && input.files ? Array.prototype.slice.call(input.files) : [];
      if (!list.length) return;
      var need = list.filter(maNeedsConvert);
      if (!need.length) return; // 官方认得的类型 → 零行为
      var out = [];
      for (var i = 0; i < list.length; i++) {
        if (!maNeedsConvert(list[i])) { out.push(list[i]); continue; }
        var conv = await maNormalizeImage(list[i]);
        if (conv) out.push(conv);
        else out.push(list[i]); // 转不了就按原文件走（与现状一致，绝不丢）
      }
      if (maSetInputFiles(input, out)) maRedispatch(input);
      else maRedispatch(input); // 塞不回去 → 原样重发（文件不丢）
    }
    function maInstallImageCompat() {
      try {
        document.addEventListener("change", function (e) {
          var t = e.target;
          if (!t || String(t.tagName || "").toUpperCase() !== "INPUT") return;
          if (String(t.type || "").toLowerCase() !== "file") return;
          if (t[MA_REENTRY]) return; // 我们自己派发的那次 → 放行
          var files = t.files ? Array.prototype.slice.call(t.files) : [];
          if (!files.length) return;
          var any = false;
          for (var i = 0; i < files.length; i++) { if (maNeedsConvert(files[i])) { any = true; break; } }
          if (!any) return; // 无需转码 → 完全不拦（官方照旧处理）
          // 拦下这一次：官方若先看到原文件，会立刻按"普通文件"起后台上传（那就白改了）
          try { e.stopPropagation(); } catch (eS) { /* 忽略 */ }
          maOnFilePicked(t).catch(function () { maRedispatch(t); });
        }, true); // ★ 捕获阶段：必须早于 React 根容器的 change 监听
      } catch (e) { /* 适配层绝不把页面拖挂 */ }
    }

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
    maInstallImageCompat(); // 手机图片上传兼容（见上方长注释）：装了就一直有效，与 pump 无关
    /* 清理:页面卸载时断开观察者与兜底表(bfcache/长驻页面都不留悬挂回调)。
       pagehide 覆盖 bfcache 场景,unload 兜底更老的浏览器。 */
    const maTeardown = () => {
      maTorn = true;
      try { if (maObserver) maObserver.disconnect(); } catch (eD1) { /* 忽略 */ }
      maObserver = null;
      try { if (maInterval) clearInterval(maInterval); } catch (eD2) { /* 忽略 */ }
      maInterval = 0;
      // 加载提示条的秒数刷新也一起停掉（页面卸载/进 bfcache 后不留悬挂回调）
      try { if (maLoadWatch.barTimer) { clearInterval(maLoadWatch.barTimer); maLoadWatch.barTimer = 0; } } catch (eD3) { /* 忽略 */ }
    };
    try { window.addEventListener("pagehide", maTeardown); } catch (ePh) { /* 忽略 */ }
    try { window.addEventListener("unload", maTeardown); } catch (eUl) { /* 忽略 */ }
    /* 手机上"切到别的 App 再切回来"走的常是 bfcache:pagehide(persisted=true) → pageshow(persisted=true)。
       DOM 原样保留但计时器/观察者已断 —— 这里重新武装,否则回到页面后看门狗就永久失灵了。
       2026-10-17：加载提示条的秒数刷新也在 maTeardown 里停了，回到前台要按现状重新挂上
       （否则用户切回来看的是"冻结的已等待 N 秒"）。 */
    try {
      window.addEventListener("pageshow", (ev) => {
        try {
          if (ev && ev.persisted) {
            maArm();
            if (maLoadWatch.slow && !maLoadWatch.dismissed) maLoadRenderBar();
          }
        } catch (ePs) { /* 忽略 */ }
      });
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
