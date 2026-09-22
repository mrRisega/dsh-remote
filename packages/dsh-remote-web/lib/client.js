// dsh-remote-web — browser half（手写 bundle，无需构建）
//
// 格式遵循 dsh 浏览器插件约定（双半插件，bundle 手写无构建）：
//   window.__ModuleLoader__.load({ id: <包名>, factory: (require) => {...} })
// factory 内只能 require shell 种子模块（react / react/jsx-runtime 等）。
//
// 功能：
//   - 双入口（2026-09 恢复侧栏注入，与官方共存不遮挡）：
//       ① 官方「设置」→「远程访问」栏目（settings.section，位于「Agent 预设」下方，官方扩展点）；
//       ② 左侧官方「设置」按钮旁注入独立「📱 远程访问」快捷按钮（id=dru-nav-remote，非 clone，
//          插在其前方、同布局不覆盖官方按钮；点击直达该栏目，首次带引导红点）
//   - 栏目内联渲染配置面板（浅色高对比 UI，遵循主流登录体验）
//     · 登录态：已登录显示账号 + 退出登录；未登录显示 登录/注册 tabs
//     · 🔒 修改密码（账号卡）：已登录账号经 图形验证码+短信验证码 重置（/dsh-remote/password/reset 代理）；
//       成功后全部已授权设备/会话失效 → 本地登出并提示用新密码重新登录（覆盖本机 config 密码）
//     · 忘记密码（登录卡）：未登录时登录表单内「忘记密码？」→ 同一套
//       图形验证码+短信验证码 表单（手机号预填当前输入、可改），成功后本地登出并提示「请用新密码登录」
//     · 登录要求图形验证码；注册要求两次密码 + 图形验证码
//     · 📱 远程访问卡：一次性访问密钥（扫码/直接打开/复制 + 到期倒计时自动刷新）与已授权设备管理
//     · 🤖 微信机器人通道：与「☁️ 云端服务 / 🖥 自建服务」并列的**第三个 tab**（条形 tab 由 home 与
//       wechat 两个视图共用，所以切过去还能切回来）；不再是独立的 settings.section 栏目 ——
//       业主口径：「不要给它单独弄一个菜单，直接放到面板里面」（0.6.11）
//       🔒 登录门（业主口径）：微信通道要求**已注册并登录**，未登录不渲染这个 tab；若会话在
//          tab 开着的时候过期，view 复位回 home（兜底 effect + 分派条件），绝不留空面板。
//       🧭 首屏导览：内容体最上面三行讲清用途（推送 / 回数字拍板 / 微信里交代任务），
//          排在「连接微信机器人」按钮之前 —— 它是绑定的理由，又不把按钮挤出首屏。
//       ✨ 动效引导：未绑定时「连接」按钮做很慢的呼吸（.dru-wx-attn），
//          prefers-reduced-motion:reduce 下关闭；状态从不靠动效单独表达。
//     · bridge 状态与启停开关 + 关于 dsh-remote 说明卡片
//     · 🧰 账号卡「更多」：只收纳（用户关掉邀请引导之后的）「升级 / 带新用户」两个入口 ——
//       主界面只剩一个入口，减少营销露出；**档位规格数字（Mbps / GB / 价格）一律不展示**
//       （0.6.11 业主口径：「插件面板里面不要展示『更多』里的 PRO 版本流量带宽」）
//   - 首次安装引导：设置页「远程访问」栏目（官方导航 navCell）旁小红点（localStorage dsh-remote-seen-dot 控制）
//   - shell.overlay：满意度弹窗（安装体验至少 1 小时后弹出，只弹一次）
// 所有数据经同源 /dsh-remote/* 宿主路由读写（node 半提供）。
window.__ModuleLoader__.load({
  id: "dsh-remote-web",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useCallback = react.useCallback;
    var useSyncExternalStore = react.useSyncExternalStore;

    // ── 样式（浅色高对比，data-plugin 便于 HMR 清理） ───────────────────────
    // 面板主体内嵌于 DSH Web「设置」页的 settings.section 栏目（官方扩展点），
    // 不再使用侧边栏入口与全窗浮动层，故不再需要 .dru-entry/.dru-backdrop/.dru-panel。
    var styleEl = document.createElement("style");
    styleEl.setAttribute("data-plugin", "dsh-remote-web");
    styleEl.textContent = [
      // ═══════════════════════════════════════════════════════════════════════
      // 🎨 主题令牌层（--dru-*）—— 亮色 / 深色双套，**只作用于面板自己的根节点**
      // ───────────────────────────────────────────────────────────────────────
      // 宿主（DeepSeek Harness Web）表达「深色」的实测信号（2026-09 在本机 GUI 实读，见文末说明）：
      //   ① document.body 上的属性 `data-ds-dark-theme` —— **存在即深色**（值恒为空串；
      //      宿主写的是 body.toggleAttribute('data-ds-dark-theme', dark)，不是 data-theme="dark"）
      //   ② document.documentElement.style.colorScheme = 'dark' | 'light' —— **两种模式都会写**，
      //      所以它同时能表达「浅色」，是判断「宿主是否已表态」的可靠依据
      // 出处是宿主自己的实现：@deepseek-ai/dsh-client-ui-theme 的 boot 脚本 +
      // @deepseek-ai/dsh-client-ui-layout 的 ThemePresenter（`html{color-scheme}` + body 调色板属性）。
      //
      // ⚠️ `prefers-color-scheme` **不是**宿主的表达方式：宿主只在用户选「跟随系统」时才看它
      //    （偏好存在 ~/.dsh/settings.yaml 的 ui-theme.preference，本机实测为 "light"）。
      //    所以本插件把它只当**兜底**（宿主没表态时才用系统偏好）。
      //
      // 令牌**只**定义在 .dru-settings-section / .dru-popup / .dru-nav-remote 上，
      // 绝不写 :root / body —— 否则会污染整个 GUI。JS 解析出主题后往根节点写
      // data-dru-theme="dark|light"，下面按属性切换；末一条 `:not([data-dru-theme])`
      // 是 JS 尚未执行时的纯 CSS 兜底（一旦 JS 写过属性就不再参与，不会打架）。
      ".dru-settings-section,.dru-popup,.dru-nav-remote{",
      "  color-scheme:light;",
      "  --dru-surface:#f6f8fa;",          // 卡片底
      "  --dru-surface-2:#ffffff;",        // 抬升面（输入框/行/弹窗卡）
      "  --dru-surface-3:#eaeef2;",        // 再抬升 / 按下态 / 进度槽
      "  --dru-hover:#f6f8fa;",           // 悬浮底
      "  --dru-fg:#1f2328;",              // 正文
      "  --dru-fg-muted:#57606a;",        // 次级文字
      "  --dru-border:#d0d7de;",          // 面上描边（装饰）
      "  --dru-border-soft:#eaeef2;",     // 更淡的分隔线
      "  --dru-border-ctl:#d0d7de;",      // 控件描边（输入/按钮/页签）
      "  --dru-accent:#0969da;",
      "  --dru-accent-strong:#0860bd;",
      "  --dru-accent-active:#0757a8;",
      "  --dru-accent-fg:#0550ae;",
      "  --dru-accent-tint:#ddf4ff;",
      "  --dru-accent-tint-2:#f0f6ff;",
      "  --dru-accent-tint-border:#b6e3ff;",
      "  --dru-accent-fill:#0969da;",      // 主按钮填充
      "  --dru-on-accent:#ffffff;",        // 主按钮/头像上的文字
      "  --dru-tip-fg:#0a3069;",          // 气泡正文
      "  --dru-tip-fg-strong:#0550ae;",   // 气泡强调
      "  --dru-success:#1a7f37;",
      "  --dru-success-fg:#116329;",
      "  --dru-success-soft:#dafbe1;",
      "  --dru-success-border:#aceebb;",
      "  --dru-success-glow:rgba(26,127,55,.6);",
      "  --dru-warn:#9a6700;",
      "  --dru-warn-fg:#7d4e00;",
      "  --dru-warn-fg-2:#6b5900;",
      "  --dru-warn-soft:#fff8c5;",
      "  --dru-warn-border:#eed888;",
      "  --dru-warn-border-2:#d4a72c;",
      "  --dru-danger:#cf222e;",
      "  --dru-danger-soft:#fff0f1;",
      "  --dru-danger-soft-2:#ffdfe0;",
      "  --dru-danger-border:#ffb3b6;",
      "  --dru-dot-off:#6e7781;",
      "  --dru-reddot:#e5484d;",
      "  --dru-log-bg:#0d1117;",
      "  --dru-log-fg:#e6edf3;",
      "  --dru-overlay:rgba(0,0,0,.5);",
      "  --dru-shadow:rgba(0,0,0,.45);",
      "  --dru-focus:#0969da;",
      "  --dru-focus-halo:rgba(9,105,218,.28);",
      "  --dru-focus-halo-2:rgba(9,105,218,.18);",
      "  --dru-focus-halo-3:rgba(9,105,218,.15);",
      "}",
      // 深色：JS 写的 data-dru-theme 优先；宿主属性作 JS 未执行时的兜底。
      // 取值跟着宿主的深色基色走（body 实测 #151517 / 层 1 #232324 / 层 2 #2c2c2e / 层 3 #353638），
      // 语义色**在深底上重新取值**，不是沿用亮色值（亮色的 #1a7f37 / #cf222e 在深底对比度不足）。
      ".dru-settings-section[data-dru-theme=\"dark\"],.dru-popup[data-dru-theme=\"dark\"],.dru-nav-remote[data-dru-theme=\"dark\"],",
      "body[data-ds-dark-theme] .dru-settings-section:not([data-dru-theme]),",
      "body[data-ds-dark-theme] .dru-popup:not([data-dru-theme]),",
      "body[data-ds-dark-theme] .dru-nav-remote:not([data-dru-theme]){",
      "  color-scheme:dark;",
      "  --dru-surface:#232324;",
      "  --dru-surface-2:#2c2c2e;",
      "  --dru-surface-3:#353638;",
      "  --dru-hover:#303236;",
      "  --dru-fg:#f0f2f5;",
      "  --dru-fg-muted:#b9bec6;",
      "  --dru-border:#52565c;",
      "  --dru-border-soft:#2f3237;",
      "  --dru-border-ctl:#6b7280;",     // 对卡片 3.25:1 —— 控件轮廓在深底上认得出（WCAG 1.4.11）
      "  --dru-accent:#6ba4ff;",
      "  --dru-accent-strong:#8ab8ff;",
      "  --dru-accent-active:#a6c9ff;",
      "  --dru-accent-fg:#9cc4ff;",
      "  --dru-accent-tint:#16324d;",
      "  --dru-accent-tint-2:#1d3c5c;",
      "  --dru-accent-tint-border:#2a5580;",
      "  --dru-accent-fill:#2f6fd0;",
      "  --dru-on-accent:#ffffff;",
      "  --dru-tip-fg:#bcd8ff;",
      "  --dru-tip-fg-strong:#dbe9ff;",
      "  --dru-success:#56d364;",
      "  --dru-success-fg:#7ee787;",
      "  --dru-success-soft:#12351f;",
      "  --dru-success-border:#2b5c39;",
      "  --dru-success-glow:rgba(86,211,100,.45);",
      "  --dru-warn:#e3b341;",
      "  --dru-warn-fg:#f0c674;",
      "  --dru-warn-fg-2:#e8cd94;",
      "  --dru-warn-soft:#3a2d0c;",
      "  --dru-warn-border:#6b5417;",
      "  --dru-warn-border-2:#8a6d1f;",
      "  --dru-danger:#ff7b72;",
      "  --dru-danger-soft:#4a1d1f;",
      "  --dru-danger-soft-2:#5c2426;",
      "  --dru-danger-border:#7a383c;",
      "  --dru-dot-off:#8b9199;",
      "  --dru-reddot:#ff6b6b;",
      "  --dru-log-bg:#0b0d11;",
      "  --dru-log-fg:#e6edf3;",
      "  --dru-overlay:rgba(0,0,0,.66);",
      "  --dru-shadow:rgba(0,0,0,.66);",
      "  --dru-focus:#8ab8ff;",
      "  --dru-focus-halo:rgba(138,184,255,.30);",
      "  --dru-focus-halo-2:rgba(138,184,255,.22);",
      "  --dru-focus-halo-3:rgba(138,184,255,.20);",
      "}",
      // 设置页栏目容器（nav 选中后渲染在 settings.section 内容区）
      ".dru-settings-section{max-width:720px;display:flex;flex-direction:column;gap:14px;padding-top:2px;color:var(--dru-fg)}",
      ".dru-settings-head{display:flex;align-items:center;gap:10px;padding:6px 2px 2px}",
      ".dru-settings-icon{font-size:24px;line-height:1;flex:none}",
      // 标题/副标题优先沿用宿主语义令牌（自带深浅两套），取不到再退回本插件令牌
      ".dru-settings-title{margin:0;font-size:17px;font-weight:600;color:var(--dsw-alias-label-primary,var(--dru-fg))}",
      ".dru-settings-sub{font-size:12.5px;color:var(--dsw-alias-label-tertiary,var(--dru-fg-muted));margin-top:3px;line-height:1.6}",
      ".dru-settings-body{display:flex;flex-direction:column;gap:14px}",
      // 首次安装引导小红点（挂在设置页「远程访问」导航栏目右上角）
      ".dru-reddot{position:absolute;top:9px;right:12px;width:7px;height:7px;border-radius:50%;background:var(--dru-reddot);box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-2,var(--dru-surface-2));pointer-events:none;z-index:1}",
      ".dru-card{background:var(--dru-surface);border:1px solid var(--dru-border-soft);border-radius:10px;padding:14px 16px;color:var(--dru-fg)}",
      ".dru-card h3{margin:0 0 8px;font-size:13px;font-weight:700;color:var(--dru-fg)}",
      ".dru-url{background:var(--dru-surface-2);border:1px solid var(--dru-border);border-radius:8px;padding:9px 11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;word-break:break-all;display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--dru-fg)}",
      ".dru-url button{flex:none;min-height:44px;padding:10px 14px;border:1px solid var(--dru-border-ctl);background:var(--dru-surface-2);color:var(--dru-accent);border-radius:6px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .12s ease,border-color .12s ease}",
      ".dru-url button:hover{background:var(--dru-hover);border-color:var(--dru-accent)}",
      ".dru-url button:active{background:var(--dru-surface-3)}",
      ".dru-field{margin-bottom:11px}",
      ".dru-field > label{display:block;font-size:12.5px;font-weight:600;color:var(--dru-fg);margin-bottom:5px}",
      ".dru-input{width:100%;box-sizing:border-box;min-height:44px;padding:10px 11px;border-radius:8px;border:1px solid var(--dru-border-ctl);background:var(--dru-surface-2);color:var(--dru-fg);font-size:13.5px;font-family:inherit}",
      ".dru-input:focus{border-color:var(--dru-accent);box-shadow:0 0 0 3px var(--dru-focus-halo)}",
      ".dru-actions{display:flex;gap:8px;flex-wrap:wrap}",
      // 触控目标 ≥44px（相邻 8px，见 .dru-actions/.dru-tabs gap）：按钮统一 min-height + hover/active 反馈
      ".dru-btn{min-height:44px;padding:10px 15px;border-radius:8px;border:1px solid transparent;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .12s ease,border-color .12s ease,box-shadow .12s ease}",
      ".dru-btn:disabled{opacity:.55;cursor:default}",
      ".dru-btn-primary{background:var(--dru-accent-fill);color:var(--dru-on-accent);border-color:var(--dru-accent-fill)}",
      ".dru-btn-primary:hover:not(:disabled){background:var(--dru-accent-strong);border-color:var(--dru-accent-strong)}",
      ".dru-btn-primary:active:not(:disabled){background:var(--dru-accent-active);border-color:var(--dru-accent-active)}",
      ".dru-btn-ghost{background:var(--dru-surface-2);color:var(--dru-fg);border-color:var(--dru-border-ctl)}",
      ".dru-btn-ghost:hover:not(:disabled){background:var(--dru-hover);border-color:var(--dru-accent)}",
      ".dru-btn-ghost:active:not(:disabled){background:var(--dru-surface-3)}",
      ".dru-btn-danger{background:var(--dru-surface-2);color:var(--dru-danger);border-color:var(--dru-danger)}",
      ".dru-btn-danger:hover:not(:disabled){background:var(--dru-danger-soft)}",
      ".dru-btn-danger:active:not(:disabled){background:var(--dru-danger-soft-2)}",
      // 行内文字按钮：视觉高度不变（不破坏排版），用 ::after 把命中区扩到 ≥44px
      ".dru-linkbtn{display:inline-block;position:relative;padding:0;border:none;background:none;color:var(--dru-accent);font-size:12.5px;line-height:1.7;cursor:pointer;font-family:inherit;text-decoration:none}",
      ".dru-linkbtn::after{content:\"\";position:absolute;left:-8px;right:-8px;top:-12px;bottom:-12px}",
      ".dru-linkbtn:hover{text-decoration:underline}",
      ".dru-linkbtn:active{color:var(--dru-accent-fg)}",
      ".dru-tabs{display:flex;gap:8px;margin-bottom:12px}",
      ".dru-tab{flex:1;min-height:44px;display:flex;align-items:center;justify-content:center;padding:8px 0;text-align:center;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;color:var(--dru-fg-muted);background:var(--dru-surface);border:1px solid var(--dru-border-ctl);user-select:none;transition:background .12s ease,border-color .12s ease}",
      ".dru-tab:hover{background:var(--dru-surface-2);border-color:var(--dru-accent);color:var(--dru-accent)}",
      ".dru-tab.active{color:var(--dru-accent);background:var(--dru-surface-2);border-color:var(--dru-accent)}",
      ".dru-captcha{display:flex;align-items:stretch;gap:8px}",
      ".dru-captcha .dru-input{flex:1;min-width:0}",
      ".dru-captcha-box{width:118px;height:44px;flex:none;border-radius:8px;border:1px solid var(--dru-border-ctl);cursor:pointer;background:var(--dru-surface);display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--dru-fg-muted);overflow:hidden}",
      ".dru-captcha-box svg{display:block;width:100%;height:100%}",
      ".dru-user{display:flex;align-items:center;gap:10px;margin-bottom:12px}",
      ".dru-avatar{width:40px;height:40px;border-radius:50%;background:var(--dru-accent-fill);color:var(--dru-on-accent);display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:700;flex-shrink:0}",
      ".dru-user .mail{font-size:14px;font-weight:600;color:var(--dru-fg);word-break:break-all}",
      ".dru-user .plan{font-size:12px;color:var(--dru-fg-muted);margin-top:2px}",
      ".dru-status-line{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dru-fg)}",
      ".dru-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}",
      ".dru-dot-on{background:var(--dru-success);box-shadow:0 0 6px var(--dru-success-glow)}",
      ".dru-dot-off{background:var(--dru-dot-off)}",
      ".dru-meta{font-size:12px;color:var(--dru-fg-muted);margin-top:6px;word-break:break-all}",
      ".dru-msg{font-size:12.5px;min-height:18px;margin-top:8px}",
      ".dru-msg-ok{color:var(--dru-success)}",
      ".dru-msg-err{color:var(--dru-danger)}",
      ".dru-msg-warn{color:var(--dru-warn)}",
      ".dru-hint{font-size:12px;color:var(--dru-fg-muted);line-height:1.6}",
      // ── 重启 DeepSeek harness（首次安装/更新后置顶提醒 + 底部常驻按钮） ──
      ".dru-restart-alert{display:flex;gap:10px;align-items:flex-start;background:var(--dru-warn-soft);border:1px solid var(--dru-warn-border-2);border-radius:10px;padding:12px 14px;margin-bottom:12px}",
      ".dru-restart-alert-icon{font-size:18px;line-height:1.2}",
      ".dru-restart-alert-title{font-size:13px;font-weight:700;color:var(--dru-warn-fg)}",
      ".dru-restart-alert-sub{font-size:12px;color:var(--dru-warn-fg-2);margin-top:4px;line-height:1.6}",
      ".dru-restart-foot{margin-top:14px;padding-top:12px;border-top:1px solid var(--dru-border-soft);display:flex;gap:10px;align-items:center;flex-wrap:wrap}",
      ".dru-restart-foot .dru-hint{flex:1;min-width:180px;margin:0}",
      // ── 🤖 微信机器人（「📱 远程访问」面板里的第三个 tab：微信机器人通道） ──
      // 主 tab 上的微信绿泡泡（#07c160 = 微信品牌绿）。纯装饰 → 节点上带 aria-hidden，
      // 可访问名字来自同一 tab 里的文字标签（不靠颜色/图标单独表意）。
      // font-variant-emoji:text：让 💬 走文字字形，color 才吃得进去（系统彩色 emoji 忽略 color）；
      // 老浏览器不认这条 CSS → 退化成系统彩色 emoji，图标仍在、可用性不受影响。
      // 内嵌态的内容体只多一个 class 钩子（不再套一层 .dru-settings-section，见 WeChatBotSection）。
      ".dru-wx-ico{flex:none;font-size:15px;line-height:1;color:#07c160;font-variant-emoji:text}",
      ".dru-wx-embed{display:flex;flex-direction:column;gap:14px}",
      // 首屏「这功能是干什么用的」三行导览：未绑定时就摆在最上面（它正是绑定的理由），
      // 但必须**不把「连接」按钮挤出首屏** —— 所以是紧凑小字卡片（12px / 行高 1.5 / 无大内边距），
      // 不是宣传大横幅。所有颜色只引用既有 --dru-* 令牌。
      ".dru-wx-intro{display:flex;flex-direction:column;gap:4px;background:var(--dru-surface-2);border:1px solid var(--dru-border-soft);border-radius:10px;padding:10px 12px;margin:0}",
      ".dru-wx-intro-title{font-size:12.5px;font-weight:700;color:var(--dru-fg)}",
      ".dru-wx-intro-row{font-size:12px;line-height:1.5;color:var(--dru-fg-muted)}",
      // 未绑定时的**动效引导**（业主口径「动效引导」）：主按钮走很慢的呼吸光晕（2.8s/次，
      // 不闪烁、不改布局、不位移），旁边那颗装饰小圆点同步呼吸。
      // 无障碍铁律：① prefers-reduced-motion:reduce 直接关掉动画（见下面媒体查询）；
      // ② 状态**绝不靠动效单独表达** —— 按钮文字「连接微信机器人」与同一卡片里的文字提示
      //    本身就说明了要做什么，动效只是多余的强调；③ 纯装饰小圆点带 aria-hidden。
      ".dru-wx-attn{animation:dru-wx-breathe 2.8s ease-in-out infinite}",
      "@keyframes dru-wx-breathe{0%,100%{box-shadow:0 0 0 0 var(--dru-accent-tint)}50%{box-shadow:0 0 0 6px var(--dru-accent-tint-border)}}",
      ".dru-wx-cta{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;line-height:1.6;color:var(--dru-fg);margin-top:8px}",
      ".dru-wx-attn-dot{flex:none;width:8px;height:8px;margin-top:6px;border-radius:50%;background:var(--dru-accent);animation:dru-wx-pulse 2.8s ease-in-out infinite}",
      "@keyframes dru-wx-pulse{0%,100%{opacity:.35}50%{opacity:1}}",
      // 动效一律可关：系统开了「减弱动态效果」就不再有任何动画（状态仍由文字完整表达）。
      "@media (prefers-reduced-motion: reduce){.dru-wx-attn,.dru-wx-attn-dot{animation:none}}",
      // 二维码是 bridge 下发的 data: URL（qrcode_svg），**不是**外部资源、也不引任何 QR 库；
      // 白底是必须的：微信扫码对深色底上的低对比码识别率差。
      ".dru-wx-qr{display:block;width:200px;height:200px;margin:10px auto 0;background:#fff;border:1px solid var(--dru-border);border-radius:10px;padding:10px;box-sizing:content-box}",
      // 配对码输入行：输入框吃满剩余宽度，提交按钮不换行（窄屏下 input 的 min-width:0 很关键）
      ".dru-wx-code{display:flex;gap:8px;align-items:stretch;margin-top:8px}",
      ".dru-wx-code .dru-input{flex:1;min-width:0;letter-spacing:2px;font-size:16px}",
      ".dru-wx-code .dru-btn{flex:none}",
      // 绑定进行中的阶段行（扫码/等待确认）：小圆点 + 文案，不靠颜色单独表意
      ".dru-wx-phase{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dru-fg);margin-top:10px}",
      // ── 用户反馈模块 ──
      ".dru-fb-tabs{display:flex;gap:8px;margin-bottom:10px}",
      ".dru-fb-tab{flex:1;min-height:44px;display:flex;align-items:center;justify-content:center;padding:8px 0;text-align:center;border-radius:8px;cursor:pointer;font-size:12.5px;font-weight:600;color:var(--dru-fg-muted);background:var(--dru-surface-3);border:1px solid var(--dru-border-ctl);user-select:none}",
      ".dru-fb-tab.active{color:var(--dru-accent);background:var(--dru-surface-2);border-color:var(--dru-accent)}",
      ".dru-fb-select{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid var(--dru-border-ctl);background:var(--dru-surface-2);color:var(--dru-fg);font-size:13.5px;font-family:inherit}",
      ".dru-fb-textarea{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid var(--dru-border-ctl);background:var(--dru-surface-2);color:var(--dru-fg);font-size:13.5px;font-family:inherit;resize:vertical;min-height:64px}",
      ".dru-fb-textarea:focus{border-color:var(--dru-accent);box-shadow:0 0 0 3px var(--dru-focus-halo)}",
      ".dru-fb-select:focus{border-color:var(--dru-accent);box-shadow:0 0 0 3px var(--dru-focus-halo)}",
      ".dru-fb-item{border:1px solid var(--dru-border-soft);border-radius:8px;background:var(--dru-surface-2);padding:10px 12px;margin-bottom:8px;color:var(--dru-fg)}",
      ".dru-fb-item-head{display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap}",
      ".dru-fb-badge{font-size:11px;border-radius:999px;padding:1px 8px;flex:none}",
      ".dru-fb-badge-open{color:var(--dru-warn);background:var(--dru-warn-soft);border:1px solid var(--dru-warn-border)}",
      ".dru-fb-badge-processing{color:var(--dru-tip-fg-strong);background:var(--dru-accent-tint);border:1px solid var(--dru-accent-tint-border)}",
      ".dru-fb-badge-done{color:var(--dru-success-fg);background:var(--dru-success-soft);border:1px solid var(--dru-success-border)}",
      ".dru-fb-cat{font-size:11px;border-radius:999px;padding:1px 8px;flex:none;color:var(--dru-fg-muted);background:var(--dru-surface);border:1px solid var(--dru-border)}",
      ".dru-fb-item-title{font-size:13px;font-weight:600;color:var(--dru-fg);flex:1;min-width:120px}",
      ".dru-fb-item-content{font-size:12.5px;color:var(--dru-fg-muted);white-space:pre-wrap;word-break:break-word;margin:4px 0}",
      ".dru-fb-item-time{font-size:11.5px;color:var(--dru-fg-muted)}",
      ".dru-fb-reply{border-top:1px dashed var(--dru-border-soft);margin-top:8px;padding-top:8px}",
      ".dru-fb-reply-row{display:flex;gap:6px;align-items:flex-start;margin-bottom:6px}",
      ".dru-fb-reply-who{font-size:12px;font-weight:600;color:var(--dru-accent);flex:none;width:76px}",
      ".dru-fb-reply-who.user{color:var(--dru-fg-muted)}",
      ".dru-fb-reply-text{font-size:12.5px;color:var(--dru-fg);white-space:pre-wrap;word-break:break-word;flex:1}",
      ".dru-fb-reply-input{width:100%;box-sizing:border-box;padding:7px 10px;border-radius:8px;border:1px solid var(--dru-border-ctl);background:var(--dru-surface-2);color:var(--dru-fg);font-size:12.5px;font-family:inherit;resize:vertical;min-height:44px}",
      ".dru-fb-empty{font-size:12.5px;color:var(--dru-fg-muted);text-align:center;padding:14px 0}",
      // ── 满意度弹窗（1 小时体验后，只弹一次） ──
      ".dru-popup{position:fixed;inset:0;background:var(--dru-overlay);z-index:2147482000;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}",
      ".dru-popup-card{width:min(400px,calc(100vw - 48px));background:var(--dru-surface-2);color:var(--dru-fg);border:1px solid var(--dru-border);border-radius:12px;box-shadow:0 24px 64px var(--dru-shadow);font-size:14px;line-height:1.5;font-family:var(--dsw-font-family,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif);overflow:hidden}",
      ".dru-popup-body{padding:22px 22px 16px;text-align:center}",
      ".dru-popup-icon{font-size:34px;margin-bottom:8px}",
      ".dru-popup-title{font-size:16px;font-weight:700;color:var(--dru-fg);margin-bottom:6px}",
      ".dru-popup-sub{font-size:12.5px;color:var(--dru-fg-muted);margin-bottom:16px}",
      ".dru-popup-rate{display:flex;gap:10px;justify-content:center;margin-bottom:14px}",
      ".dru-popup-rate button{flex:1;max-width:96px;border:1px solid var(--dru-border-ctl);background:var(--dru-surface);border-radius:10px;padding:12px 6px;font-size:20px;cursor:pointer;font-family:inherit}",
      ".dru-popup-rate button:hover{border-color:var(--dru-accent);background:var(--dru-accent-tint)}",
      ".dru-popup-rate button.sel{border-color:var(--dru-accent);background:var(--dru-accent-tint);box-shadow:0 0 0 3px var(--dru-focus-halo-3)}",
      ".dru-popup-rate button .lbl{display:block;font-size:11px;color:var(--dru-fg-muted);margin-top:4px;font-weight:600}",
      ".dru-popup-textarea{width:100%;box-sizing:border-box;padding:9px 11px;border-radius:8px;border:1px solid var(--dru-border-ctl);background:var(--dru-surface-2);color:var(--dru-fg);font-size:13px;font-family:inherit;resize:vertical;min-height:56px;text-align:left}",
      ".dru-popup-invite{background:var(--dru-surface);border:1px dashed var(--dru-border);border-radius:8px;padding:12px;font-size:13px;color:var(--dru-fg-muted);text-align:center;margin-bottom:12px}",
      ".dru-popup-actions{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:14px}",
      ".dru-popup-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 16px;border-top:1px solid var(--dru-border-soft);font-size:12px;color:var(--dru-fg-muted)}",
      ".dru-popup-foot button{min-height:44px;border:none;background:none;color:var(--dru-fg-muted);cursor:pointer;font-size:12.5px;font-family:inherit;padding:10px 8px;border-radius:6px}",
      ".dru-popup-foot button:hover{color:var(--dru-accent);background:var(--dru-hover)}",
      ".dru-popup .dru-msg{text-align:left}",
      ".dru-community-qr{display:block;width:220px;max-width:62vw;margin:0 auto;background:var(--dru-surface-2);padding:10px;border-radius:10px;border:1px solid var(--dru-border);box-sizing:content-box}",
      ".dru-restart-auto{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12.5px;color:var(--dru-success);background:var(--dru-success-soft);border-radius:8px;padding:8px 10px}",
      ".dru-restart-auto.muted{color:var(--dru-fg-muted);background:var(--dru-surface)}",
      ".dru-fb-community{margin-top:16px;padding-top:14px;border-top:1px dashed var(--dru-border);text-align:center}",
      ".dru-fb-community .dru-community-qr{width:180px;max-width:56vw}",
      // ── 自管理：版本与更新（插件面板内提供在线更新/彻底卸载，市场无更新按钮） ──
      ".dru-ver-badge{display:inline-block;font-size:11px;border-radius:999px;padding:1px 8px;margin-left:6px;vertical-align:1px}",
      ".dru-ver-badge-new{color:var(--dru-warn);background:var(--dru-warn-soft);border:1px solid var(--dru-warn-border)}",
      ".dru-ver-badge-ok{color:var(--dru-success-fg);background:var(--dru-success-soft);border:1px solid var(--dru-success-border)}",
      ".dru-up-log{margin-top:8px;background:var(--dru-log-bg);color:var(--dru-log-fg);border-radius:8px;padding:8px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:150px;overflow:auto}",
      // 版本卡信息层级（0.6.9）：版本号大字 + 通道 chip + 指标行（已用时/无输出）+ 卡住告警
      ".dru-ver-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dru-ver-num{font-size:15px;font-weight:700;color:var(--dru-fg)}",
      ".dru-ver-chip{font-size:11.5px;border-radius:999px;padding:2px 9px;color:var(--dru-tip-fg);background:var(--dru-accent-tint);border:1px solid var(--dru-accent-tint-border);white-space:nowrap}",
      ".dru-ver-metrics{margin-top:9px;background:var(--dru-surface-2);border:1px solid var(--dru-border);border-radius:8px;padding:9px 11px}",
      ".dru-ver-metric{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12.5px;line-height:1.9;color:var(--dru-fg)}",
      ".dru-ver-metric > span:first-child{color:var(--dru-fg-muted)}",
      ".dru-stall{margin-top:9px;background:var(--dru-warn-soft);border:1px solid var(--dru-warn-border-2);border-radius:8px;padding:10px 12px;font-size:12.5px;line-height:1.65;color:var(--dru-warn-fg-2)}",
      ".dru-stall b{color:var(--dru-warn-fg)}",
      ".dru-spin{width:13px;height:13px;border-radius:50%;border:2px solid var(--dru-border);border-top-color:var(--dru-accent);display:inline-block;vertical-align:-2px;animation:dru-spin .9s linear infinite}",
      "@keyframes dru-spin{to{transform:rotate(360deg)}}",
      // ── 🎁 带新用户换会员（0.6.9）：交换句式奖励大字 → 三步走 → 进度 → 邀请码/链接（一键复制）→ 折叠规则 → 记录 ──
      ".dru-invite-hero{font-size:20px;line-height:1.4;font-weight:700;color:var(--dru-fg);margin:2px 0 8px}",
      ".dru-invite-hero em{font-style:normal;color:var(--dru-accent-fg)}",
      ".dru-invite-sub{font-size:13px;line-height:1.65;color:var(--dru-fg-muted)}",
      ".dru-invite-sub b{color:var(--dru-fg)}",
      ".dru-invite-prog{margin-top:12px;background:var(--dru-surface-2);border:1px solid var(--dru-border);border-radius:8px;padding:10px 12px}",
      ".dru-invite-prog-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:13px;font-weight:600;color:var(--dru-fg)}",
      ".dru-invite-prog-top .n{font-size:15px;font-weight:700;color:var(--dru-accent-fg)}",
      ".dru-invite-bar{height:8px;border-radius:999px;background:var(--dru-surface-3);overflow:hidden;margin:9px 0 7px}",
      ".dru-invite-bar-fill{height:100%;border-radius:999px;background:var(--dru-accent-fill);transition:width .3s ease}",
      ".dru-invite-next{font-size:12.5px;line-height:1.65;color:var(--dru-fg-muted)}",
      ".dru-copy-row{margin-top:12px}",
      ".dru-copy-row:first-child{margin-top:4px}",
      ".dru-copy-label{font-size:12.5px;font-weight:600;color:var(--dru-fg);margin-bottom:6px}",
      ".dru-copy-box{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--dru-surface-2);border:1px solid var(--dru-border);border-radius:8px;padding:9px 11px}",
      ".dru-code-val{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:19px;font-weight:700;letter-spacing:2.5px;color:var(--dru-fg);flex:1;min-width:140px;word-break:break-all}",
      ".dru-link-val{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;line-height:1.55;color:var(--dru-fg);flex:1;min-width:180px;word-break:break-all;overflow-wrap:anywhere}",
      ".dru-copy-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:none;min-height:44px;padding:10px 16px;border-radius:8px;border:1px solid var(--dru-accent-fill);background:var(--dru-accent-fill);color:var(--dru-on-accent);font:600 13px/1.2 inherit;cursor:pointer;transition:background .12s ease,border-color .12s ease}",
      ".dru-copy-btn:hover:not(:disabled){background:var(--dru-accent-strong);border-color:var(--dru-accent-strong)}",
      ".dru-copy-btn:active:not(:disabled){background:var(--dru-accent-active);border-color:var(--dru-accent-active)}",
      ".dru-copy-btn:disabled{opacity:.55;cursor:default}",
      ".dru-copy-btn.copied{background:var(--dru-success);border-color:var(--dru-success)}",
      ".dru-empty{text-align:center;padding:20px 14px;background:var(--dru-surface-2);border:1px dashed var(--dru-border);border-radius:10px}",
      ".dru-empty-icon{font-size:26px;line-height:1;margin-bottom:8px}",
      ".dru-empty-title{font-size:13.5px;font-weight:600;color:var(--dru-fg);margin-bottom:5px}",
      ".dru-empty-sub{font-size:12.5px;line-height:1.7;color:var(--dru-fg-muted);max-width:380px;margin:0 auto}",
      ".dru-empty-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:14px}",
      ".dru-disclose{width:100%;box-sizing:border-box;min-height:44px;display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--dru-surface-2);border:1px solid var(--dru-border-ctl);border-radius:8px;padding:10px 12px;font:600 13px/1.3 inherit;color:var(--dru-fg);cursor:pointer;text-align:left}",
      ".dru-disclose:hover{background:var(--dru-hover);border-color:var(--dru-accent)}",
      ".dru-disclose-caret{font-size:12px;font-weight:600;color:var(--dru-fg-muted);flex:none}",
      // ── 🧰 「更多」收纳体（0.6.10）：账号卡把档位明细与营销入口收在这一层里 ──
      // 折叠时只有一个 .dru-disclose 入口（见账号卡）；展开才出现内容 —— 主界面默认干净。
      // 内容体始终在 DOM 里（收起时用 hidden 隐藏），这样触发按钮的 aria-controls 永远指向真实元素。
      ".dru-more-body{margin-top:8px;background:var(--dru-surface-2);border:1px solid var(--dru-border-soft);border-radius:8px;padding:10px 12px}",
      ".dru-more-head{font-size:12px;font-weight:700;color:var(--dru-fg);margin:0 0 5px}",
      ".dru-more-row{font-size:12.5px;line-height:1.75;color:var(--dru-fg-muted)}",
      ".dru-more-row + .dru-more-row{margin-top:4px}",
      ".dru-more-row b{color:var(--dru-fg)}",
      ".dru-more-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}",
      ".dru-more-actions .dru-btn{flex:1 1 190px}",
      ".dru-rules{margin:10px 0 0;padding-left:20px;font-size:12.5px;line-height:1.8;color:var(--dru-fg-muted)}",
      ".dru-rules li{margin-bottom:6px}",
      ".dru-rules b{color:var(--dru-fg)}",
      ".dru-rec{background:var(--dru-surface-2);border:1px solid var(--dru-border-soft);border-radius:8px;padding:10px 12px;margin-bottom:8px}",
      ".dru-rec-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dru-rec-who{font-size:13px;font-weight:600;color:var(--dru-fg);flex:1;min-width:120px;word-break:break-all}",
      ".dru-rec-when{font-size:12px;color:var(--dru-fg-muted)}",
      ".dru-rec-tag{font-size:11.5px;border-radius:999px;padding:1px 9px;flex:none;white-space:nowrap}",
      ".dru-rec-tag-ok{color:var(--dru-success-fg);background:var(--dru-success-soft);border:1px solid var(--dru-success-border)}",
      ".dru-rec-tag-wait{color:var(--dru-warn);background:var(--dru-warn-soft);border:1px solid var(--dru-warn-border)}",
      ".dru-rec-sub{font-size:12px;color:var(--dru-fg-muted);margin-top:5px;line-height:1.6}",
      ".dru-rec-head{display:flex;gap:8px;font-size:11.5px;font-weight:600;color:var(--dru-fg-muted);padding:0 4px 7px;border-bottom:1px solid var(--dru-border-soft);margin-bottom:9px}",
      // ── 🔀 转化 or 拉新：痛点时刻的并列二选一（两条都是真按钮：命中区 ≥44px、可键盘聚焦） ──
      // 蓝色左边框把它从周边灰字里提出来 —— 用户「正在疼」的时刻不再被一行 12px 灰字糊过去。
      ".dru-dual{margin-top:10px;background:var(--dru-surface-2);border:1px solid var(--dru-border);border-left:3px solid var(--dru-accent);border-radius:8px;padding:11px 12px}",
      ".dru-dual-title{font-size:13px;font-weight:700;color:var(--dru-fg);line-height:1.5}",
      ".dru-dual-sub{font-size:12.5px;line-height:1.65;color:var(--dru-fg-muted);margin-top:3px}",
      // 窄屏（手机）自动上下堆叠；每个按钮都独占一行，绝不缩到点不中
      ".dru-dual-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}",
      ".dru-dual-actions .dru-btn{flex:1 1 210px}",
      ".dru-dual-note{font-size:12px;line-height:1.65;color:var(--dru-fg-muted);margin-top:8px}",
      ".dru-dual-note b{color:var(--dru-fg)}",
      // 三步走（① 复制专属链接 → ② 发给还没注册过的新用户 → ③ 对方上线即到账）
      ".dru-steps{margin:10px 0 0;padding:0;list-style:none;counter-reset:dru-step}",
      ".dru-steps li{position:relative;padding-left:26px;font-size:12.5px;line-height:1.7;color:var(--dru-fg-muted);margin-bottom:7px}",
      ".dru-steps li:last-child{margin-bottom:0}",
      ".dru-steps li::before{counter-increment:dru-step;content:counter(dru-step);position:absolute;left:0;top:2px;width:18px;height:18px;border-radius:50%;background:var(--dru-accent-fill);color:var(--dru-on-accent);font-size:11px;font-weight:700;line-height:18px;text-align:center}",
      ".dru-steps b{color:var(--dru-fg)}",
      // ── 🎁 邀请收益引导气泡（0.6.9）：把「带 N 位新用户 → 得 M 天 PRO」摆到按钮旁 ──
      // 数字来自 public-config 的 invite_rule（见 inviteRuleOf），关闭态/取不到时不渲染。
      // 交互克制：进入时一次 320ms 弹入（power1.out），之后每 4.5s 一次轻微呼吸（占空比 ~28%，不是持续闪烁）。
      ".dru-tip-wrap{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:10px;max-width:100%;min-width:0}",
      ".dru-tip{position:relative;display:flex;align-items:center;gap:9px;flex:1 1 260px;min-width:0;box-sizing:border-box;background:var(--dru-accent-tint);border:1px solid var(--dru-accent-tint-border);border-radius:10px;padding:9px 42px 9px 11px;font-size:12.5px;line-height:1.6;color:var(--dru-tip-fg);animation:dru-tip-in .32s cubic-bezier(.215,.61,.355,1) both}",
      ".dru-tip b{color:var(--dru-tip-fg-strong);font-weight:700}",
      ".dru-tip-ic{flex:none;font-size:16px;line-height:1;display:inline-block;transform-origin:50% 50%;animation:dru-tip-breathe 4.5s ease-in-out 1.2s infinite}",
      ".dru-tip-close{position:absolute;top:4px;right:4px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;padding:0;border:none;background:none;color:var(--dru-tip-fg);font-size:14px;line-height:1;cursor:pointer;border-radius:6px;font-family:inherit}",
      // 视觉 30px，命中区补到 ≥44px（与 .dru-linkbtn 同一手法）
      ".dru-tip-close::after{content:\"\";position:absolute;left:-7px;right:-7px;top:-7px;bottom:-7px}",
      ".dru-tip-close:hover{background:var(--dru-accent-tint-2);color:var(--dru-tip-fg-strong)}",
      "@keyframes dru-tip-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}",
      "@keyframes dru-tip-breathe{0%,72%,100%{transform:scale(1)}82%{transform:scale(1.09)}}",
      // ── 📱 远程访问（一次性访问密钥 + 已授权设备管理） ──
      ".dru-access-flex{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start;margin-top:10px}",
      ".dru-access-col{flex:1;min-width:230px;display:flex;flex-direction:column;gap:8px}",
      ".dru-qr-img{width:180px;height:180px;flex:none;border-radius:8px;border:1px solid var(--dru-border);background:var(--dru-surface-2);object-fit:contain}",
      ".dru-qr-ph{width:180px;height:180px;flex:none;border-radius:8px;border:1px dashed var(--dru-border);background:var(--dru-surface);color:var(--dru-fg-muted);font-size:12px;display:flex;align-items:center;justify-content:center;text-align:center;padding:10px;box-sizing:border-box}",
      ".dru-url.big{font-size:13.5px;font-weight:600}",
      ".dru-cd{font-size:12px;color:var(--dru-warn);margin-top:2px}",
      ".dru-cd-ok{color:var(--dru-success)}",
      ".dru-key-note{font-size:12px;color:var(--dru-fg-muted);line-height:1.6}",
      ".dru-dev{border:1px solid var(--dru-border-soft);border-radius:8px;background:var(--dru-surface-2);padding:9px 11px;margin-bottom:8px}",
      ".dru-dev-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dru-dev-name{font-size:13px;font-weight:600;color:var(--dru-fg);flex:1;min-width:130px}",
      ".dru-dev-meta{font-size:11.5px;color:var(--dru-fg-muted)}",
      ".dru-dev-sub{font-size:11.5px;color:var(--dru-fg-muted);margin-top:4px}",
      ".dru-dev-tag{font-size:11.5px;color:var(--dru-fg-muted);border:1px solid var(--dru-border);border-radius:999px;padding:0 7px;flex:none;white-space:nowrap}",
      ".dru-dev-tag-off{color:var(--dru-danger);border-color:var(--dru-danger-border);background:var(--dru-danger-soft)}",
      // Phase-5:端到端加密(E2EE)状态行 —— 启用=绿字绿点,未启用=灰字(纯文字状态行,不打扰)
      ".dru-e2ee-line{display:flex;align-items:center;gap:7px;margin-top:6px;font-size:12px;line-height:1.5;color:var(--dru-fg-muted)}",
      ".dru-e2ee-line.ok{color:var(--dru-success)}",
      // 侧栏「远程访问」快捷按钮(2026-09 恢复注入,与官方「设置」按钮共存不遮挡):
      // 独立 button(非 clone),插在官方「设置」按钮之前,同源同布局不覆盖官方热区。
      ".dru-nav-remote{display:inline-flex;align-items:center;gap:6px;height:30px;margin:0 0 2px;padding:0 10px;border:1px solid var(--dru-border-ctl);border-radius:8px;background:var(--dru-surface-2);color:var(--dru-accent);font:500 12.5px/1 inherit;cursor:pointer;white-space:nowrap;user-select:none}",
      ".dru-nav-remote:hover:not(:disabled){background:var(--dru-accent-tint-2);border-color:var(--dru-accent)}",
      ".dru-nav-remote-dot{position:absolute;top:-2px;right:-2px;width:8px;height:8px;border-radius:50%;background:var(--dru-reddot);box-shadow:0 0 0 2px var(--dru-surface-2);pointer-events:none}",
      // 侧栏入口与官方按钮同高（30px）；用 ::after 把命中区补到 ≥44px，不破坏与原按钮的对齐
      ".dru-nav-remote::after{content:\"\";position:absolute;left:0;right:0;top:-7px;bottom:-7px}",
      // ── 无障碍基线（0.6.9）────────────────────────────────────────────────
      // 键盘焦点必须可见：放在样式表末尾，覆盖上面任何 outline:none（同特异性后者胜）
      ".dru-settings-section :focus-visible,.dru-popup :focus-visible{outline:2px solid var(--dru-focus);outline-offset:2px}",
      ".dru-settings-section [role=\"region\"]:focus-visible{outline-offset:-2px}",
      ".dru-btn:focus-visible,.dru-copy-btn:focus-visible,.dru-tab:focus-visible,.dru-disclose:focus-visible{outline:2px solid var(--dru-focus);outline-offset:2px;box-shadow:0 0 0 4px var(--dru-focus-halo-2)}",
      ".dru-tip-close:focus-visible{outline:2px solid var(--dru-focus);outline-offset:1px}",
      ".dru-nav-remote:focus-visible{outline:2px solid var(--dru-focus);outline-offset:2px}",
      // 尊重系统「减少动态效果」：关掉过渡与旋转动画（状态文字照常更新）。
      // 🎁 引导气泡在这条下**完全不动**（静态显示），符合「reduce 时没有动效」的要求。
      "@media (prefers-reduced-motion: reduce){",
      "  .dru-btn,.dru-copy-btn,.dru-tab,.dru-disclose,.dru-invite-bar-fill,.dru-nav-remote,.dru-input,.dru-fb-tab,.dru-popup-rate button{transition:none !important}",
      "  .dru-spin{animation:none !important;border-top-color:var(--dru-accent)}",
      "  .dru-tip{animation:none !important}",
      "  .dru-tip-ic{animation:none !important}",
      "}",
      // 窄屏（手机竖屏打开本机面板）：卡片内边距收紧、代码/链接不溢出
      "@media (max-width:520px){",
      "  .dru-card{padding:12px 12px}",
      "  .dru-invite-hero{font-size:18px}",
      "  .dru-copy-box{flex-direction:column;align-items:stretch}",
      "  .dru-copy-btn{width:100%}",
      // 气泡独占一行，绝不把按钮挤到屏幕外（320px 下也不横向滚动）
      "  .dru-tip{flex:1 1 100%;padding:9px 40px 9px 10px;font-size:12px}",
      "}",
    ].join("\n");
    document.head.appendChild(styleEl);

    // ══════════════════════════════════════════════════════════════════════
    // 🎨 主题跟随（深色 / 亮色）—— 解析宿主信号，实时跟随，不污染宿主
    // ──────────────────────────────────────────────────────────────────────
    /**
     * 宿主表达「深色」的**实测信号**（2026-09 在本机 GUI http://127.0.0.1:3080 用 headless
     * Chromium + CDP 实读，不是猜的）：
     *
     *   ① `document.body` 上的属性 **`data-ds-dark-theme`** —— **存在即深色**，值恒为空串。
     *      宿主写的是 `document.body.toggleAttribute('data-ds-dark-theme', dark)`，
     *      **不是** `data-theme="dark"`、也不是 `class="dark"`。
     *   ② `document.documentElement.style.colorScheme` = `'dark' | 'light'` —— **两种模式都会写**，
     *      所以它同时能表达「浅色」，是判断「宿主是否已经表态」的可靠依据。
     *
     * 实测证据：在真实 GUI 里把 ① 翻成存在、并把 ② 写成 'dark' 之后（这正是宿主 ThemePresenter
     * 的两行原文），`getComputedStyle(document.body).backgroundColor` 由 `rgb(255,255,255)`
     * 变成 `rgb(21,21,23)`，`--dsw-alias-bg-base` 由 `#fff` 变成 `#151517`，
     * `--dsw-alias-label-primary` 由 `#0f1115` 变成 `#f9fafb` —— 整套宿主题跟着切。还原后回到亮色。
     *
     * 出处（宿主自己的代码，非第三方猜测）：
     *   · `@deepseek-ai/dsh-client-ui-theme/lib/index.js` 的 bootThemeScript()：
     *       `document.documentElement.style.colorScheme = dark ? 'dark' : 'light'`
     *       `document.body.toggleAttribute('data-ds-dark-theme', dark)`
     *   · `@deepseek-ai/dsh-client-ui-layout` 的 ThemePresenter（运行期同两处 DOM 写入，
     *     `DARK_ATTRIBUTE = "data-ds-dark-theme"`）
     *
     * ⚠️ `prefers-color-scheme` **不是**宿主的表达方式 —— 宿主只在用户选「跟随系统」时才看它
     *    （偏好存 `~/.dsh/settings.yaml` 的 `ui-theme.preference`，本机实测 `light`；
     *     实测该环境下 `matchMedia('(prefers-color-scheme: dark)').matches === false`，
     *     而用户在 GUI 里切换主题**根本不会**改变它）。所以这里把它**只当兜底**：
     *     宿主没表态（非 DSH 宿主、boot 脚本未执行）时才退回系统偏好。
     */
    var DARK_ATTR = "data-ds-dark-theme";
    var THEME_MQ = "(prefers-color-scheme: dark)";
    /** 读宿主当前主题：'dark' | 'light'。任何异常都退回 'light'（绝不把面板打挂）。 */
    function resolveTheme() {
      try {
        var body = document && document.body;
        if (body && typeof body.hasAttribute === "function" && body.hasAttribute(DARK_ATTR)) return "dark";
        var de = document && document.documentElement;
        var cs = de && de.style ? String(de.style.colorScheme || "").trim().toLowerCase() : "";
        if (cs === "dark") return "dark";
        if (cs === "light") return "light";
        // 宿主没表态 → 系统偏好兜底（`matchMedia` 在 node 测试沙箱里不存在，故双重探测）
        var mq = typeof matchMedia === "function" ? matchMedia(THEME_MQ) : null;
        if (!mq && typeof window !== "undefined" && window && typeof window.matchMedia === "function") mq = window.matchMedia(THEME_MQ);
        if (mq && typeof mq.matches === "boolean") return mq.matches ? "dark" : "light";
      } catch (e) { /* 忽略：判定失败一律按亮色 */ }
      return "light";
    }
    /**
     * 主题外部存储：面板根/弹窗用 useSyncExternalStore 订阅，侧栏按钮用 themeApplyToNav 直改。
     * 用「存储 + 订阅」而不是 useState，是因为侧栏入口挂在面板之外、生命周期也更长。
     */
    var themeState = { value: null, subs: [], obs: null, mq: null, watching: false, navEl: null };
    function themeGet() {
      if (themeState.value === null) themeState.value = resolveTheme();
      return themeState.value;
    }
    function themeApplyToNav() {
      try {
        var el = themeState.navEl || document.getElementById(NAV_ENTRY_ID);
        if (el && el.setAttribute) el.setAttribute("data-dru-theme", themeGet());
      } catch (e) { /* 忽略 */ }
    }
    function themeSubscribe(fn) {
      if (typeof fn !== "function") return function () {};
      themeState.subs.push(fn);
      themeStartWatch();
      return function () {
        var i = themeState.subs.indexOf(fn);
        if (i >= 0) themeState.subs.splice(i, 1); // 组件卸载即退订，不泄漏
      };
    }
    /** 重算主题；变了才通知订阅者（避免无谓重渲染）。 */
    function themeRecompute() {
      var next = resolveTheme();
      if (next === themeState.value) return;
      themeState.value = next;
      themeApplyToNav();
      var subs = themeState.subs.slice();
      for (var i = 0; i < subs.length; i++) { try { subs[i](); } catch (e) { /* 单个订阅者异常不影响其它 */ } }
    }
    /**
     * 开始监听主题变化（幂等）。两个信号源：
     *   · MutationObserver：观察 `<body>` 的属性（data-ds-dark-theme 是属性）+ `<html>` 的
     *     style（color-scheme 写在 html 的内联 style 上）—— 宿主切换时两者都会变；
     *   · matchMedia 的 change 事件：兜底路径（跟随系统）时才会用上。
     * 用户可能在面板开着的时候切主题，所以**必须**实时重算，不能只在加载时判一次。
     */
    function themeStartWatch() {
      if (themeState.watching) return;
      themeState.watching = true;
      try {
        var obs = new MutationObserver(function () { themeRecompute(); });
        if (document.body) obs.observe(document.body, { attributes: true, attributeFilter: [DARK_ATTR, "class", "style"] });
        if (document.documentElement) obs.observe(document.documentElement, { attributes: true, attributeFilter: [DARK_ATTR, "class", "style"] });
        themeState.obs = obs;
      } catch (e) { /* 忽略：没有 MutationObserver 时仍靠 matchMedia 与首帧判定 */ }
      try {
        var mq = typeof matchMedia === "function" ? matchMedia(THEME_MQ) : null;
        if (!mq && typeof window !== "undefined" && window && typeof window.matchMedia === "function") mq = window.matchMedia(THEME_MQ);
        if (mq) {
          if (typeof mq.addEventListener === "function") mq.addEventListener("change", themeRecompute);
          else if (typeof mq.addListener === "function") mq.addListener(themeRecompute);
          themeState.mq = mq;
        }
      } catch (e) { /* 忽略 */ }
      try { if (window && window.addEventListener) window.addEventListener("pagehide", themeStopWatch); } catch (e) {}
      themeRecompute();
    }
    /** 停止监听并释放资源（页面卸载时调用；订阅者仍在时下次 subscribe 会自动重启）。 */
    function themeStopWatch() {
      try { if (themeState.obs) themeState.obs.disconnect(); } catch (e) {}
      themeState.obs = null;
      try {
        if (themeState.mq) {
          if (typeof themeState.mq.removeEventListener === "function") themeState.mq.removeEventListener("change", themeRecompute);
          else if (typeof themeState.mq.removeListener === "function") themeState.mq.removeListener(themeRecompute);
        }
      } catch (e) {}
      themeState.mq = null;
      try { if (window && window.removeEventListener) window.removeEventListener("pagehide", themeStopWatch); } catch (e) {}
      themeState.watching = false;
    }

    // ── 首次安装引导小红点（设置页「远程访问」栏目，localStorage 控制） ────
    // 无 dsh-remote-seen-dot key 视为首次：在设置页导航栏目右上角显示 CSS 圆点；
    // 点击栏目/红点后写入 key（之后不再显示），重启 DSH Web 不复发。
    // 设置页由官方 shell 渲染（class 含 navCell 的导航按钮 + 栏目 label），
    // 注入采用 DOM 兜底：MutationObserver 监听设置页打开，把红点挂到栏目按钮右上角。
    var DOT_SEEN_KEY = "dsh-remote-seen-dot";
    function dotSeen() {
      try { return localStorage.getItem(DOT_SEEN_KEY) === "1"; } catch (e) { return true; }
    }
    function dotMarkSeen() {
      try { localStorage.setItem(DOT_SEEN_KEY, "1"); } catch (e) {}
      try {
        var dot = document.querySelector(".dru-reddot");
        if (dot && dot.parentNode) dot.parentNode.removeChild(dot);
      } catch (e) {}
      if (window.__dshRemoteDotObs) {
        try { window.__dshRemoteDotObs.disconnect(); } catch (e) {}
        window.__dshRemoteDotObs = null;
      }
      window.__dshRemoteDotWatch = false;
    }

    // ── 🎁 邀请收益引导气泡的「已关闭」记忆 ─────────────────────────────────
    // 键名沿用本插件的统一前缀 dsh-remote-（与 dsh-remote-seen-dot 一致）。
    // 用户关过一次就永久记住，不再每次进面板都骚扰；localStorage 不可用（隐私模式/被禁）
    // 时 read 返回 false 但不会抛 —— 读不到就当作「没关过」，宁可多显示一次也不报错。
    var INVITE_TIP_KEY = "dsh-remote-invite-tip-dismissed-v1";
    // 气泡的 DOM id：触发按钮用 aria-describedby 指向它（同一屏只此一处）
    var INVITE_TIP_ID = "dru-invite-tip";
    // ⚠️ 命名注意：这两个函数名**不能**叫 inviteTipDismissed —— 组件里有一个同名的 `var`
    //    （useState 值）。`var` 会提升并遮蔽整个函数体，连 `useState(inviteTipWasDismissed())`
    //    的参数都会被解析成那个尚未赋值的局部 var（undefined），导致「已关闭」记忆失效。
    function inviteTipWasDismissed() {
      try { return localStorage.getItem(INVITE_TIP_KEY) === "1"; } catch (e) { return false; }
    }
    function inviteTipDismiss() {
      try { localStorage.setItem(INVITE_TIP_KEY, "1"); } catch (e) { /* 忽略 */ }
    }

    // ── 🧰 营销入口「收纳进更多」的记忆（0.6.10）────────────────────────────
    // 产品口径（用户原话）：新用户第一次进面板**必须**看得见「升级 PRO / 带新用户换会员」
    // 两个入口，否则不知道有这两个功能；用户把它们**关掉之后**，再收进账号卡的「更多」里，
    // 「让整个功能使用界面更加清爽，将商业化的逻辑稍微隐藏到深一层」。
    //
    // 触发信号**复用已有的那一个**：邀请引导气泡右上角的 ✕（见 renderInviteTip）。它天然就是
    // 「用户看到了、并且关掉了」的表达，不再另造一个竞争状态（两个开关会互相打架）。
    //
    // 🔒 键名与 INVITE_TIP_KEY **并列、不复用**：老键一个字节都不改，含义仍然是「气泡已关」；
    //    这里另外记一笔「营销入口已收纳」。两者是同一次点击触发的**两个概念**（气泡 ≠ 收纳），
    //    分开存才能在日后单独调整其中一个而不会互相污染。
    // localStorage 不可用（隐私模式/被禁）时与老键同款降级：读不到 = 没收纳（宁可多显示一次，
    // 也不报错、更不把功能藏起来 —— 藏了用户就找不到升级入口了）。
    var MKT_MORE_KEY = "dsh-remote-marketing-more-v1";
    // 「更多」的 DOM id：触发按钮用 aria-controls 指向内容体（内容体始终在 DOM 里，收起时 hidden）。
    var MKT_MORE_TOGGLE_ID = "dru-account-more";
    var MKT_MORE_BODY_ID = "dru-account-more-body";
    function mktMoreWasFolded() {
      try { return localStorage.getItem(MKT_MORE_KEY) === "1"; } catch (e) { return false; }
    }
    function mktMoreFold() {
      try { localStorage.setItem(MKT_MORE_KEY, "1"); } catch (e) { /* 忽略 */ }
    }
    /** 给单个设置页导航栏目按钮挂红点（幂等）。 */
    function dotInject(cell) {
      try {
        if (cell.querySelector(".dru-reddot")) return;
        cell.style.position = "relative";
        var dot = document.createElement("span");
        dot.className = "dru-reddot";
        dot.setAttribute("aria-hidden", "true");
        cell.appendChild(dot);
        cell.addEventListener("click", function onDotCellClick() {
          dotMarkSeen();
          cell.removeEventListener("click", onDotCellClick);
        });
      } catch (e) {}
    }
    /** 扫描设置页导航，找到「远程访问」栏目按钮后注入红点。 */
    function dotScan() {
      if (dotSeen()) return;
      var cells = document.querySelectorAll("button");
      for (var i = 0; i < cells.length; i++) {
        var c = cells[i];
        // 语义化匹配：设置页导航按钮（navCell）+ 栏目名「远程访问」。
        // class 为 shell 的 hashed 类名，取子串匹配避免依赖具体 hash；
        // 若未来 hash 变化导致匹配失败，仅红点不显示，栏目本身不受影响。
        if (String(c.className || "").indexOf("navCell") === -1) continue;
        if ((c.textContent || "").indexOf("远程访问") === -1) continue;
        dotInject(c);
      }
    }
    /** 开始监听设置页打开（首次安装期间有效；点击后自动停止）。 */
    function dotWatch() {
      if (dotSeen()) return;
      if (window.__dshRemoteDotWatch) return;
      window.__dshRemoteDotWatch = true;
      try {
        var obs = new MutationObserver(function () { dotScan(); });
        obs.observe(document.body, { childList: true, subtree: true });
        window.__dshRemoteDotObs = obs;
      } catch (e) {}
      dotScan();
    }

    // ── 侧栏「远程访问」快捷按钮（2026-09 恢复注入：与官方「设置」按钮共存、不遮挡） ──
    // 用户要求：左侧官方「设置」按钮旁保留「远程访问」入口。实现为独立 <button id=dru-nav-remote>
    // （绝不 clone 官方按钮 → 不继承官方事件委托/点击热区），插在官方「设置」按钮之前；
    // 点击 → 打开官方设置页「远程访问」栏目。全程不点工作区会话内容：
    //   - 候选一律限定为官方导航（class 含 navCell / 位于导航容器内）+ 短文本/aria 精确匹配；
    //   - 命中排除自身与“菜单/更多”语义节点；
    //   - 栏目未开时先点官方「设置」，再轮询(≤3s)补点「远程访问」栏目项。
    var NAV_ENTRY_ID = "dru-nav-remote";
    var NAV_TEXT_MAX = 10;
    var NAV_POLL_MAX = 20;
    var NAV_BAD_RE = /(^|[^a-z0-9])(menu|context|more|kebab|dropdown|popover|toolbar)($|[^a-z0-9])/i;
    function navCleanText(el) { try { return (el.textContent || "").replace(/\s+/g, " ").trim(); } catch (e) { return ""; } }
    function navAttrOf(el) {
      try { return String(el.getAttribute("aria-label") || el.getAttribute("title") || "").trim(); } catch (e) { return ""; }
    }
    function navCellLike(el) {
      try {
        var cls = String(el.className || "");
        if (cls.indexOf("navCell") !== -1) return true;
        return !!el.closest('[role="navigation"], nav, [class*="sidebar" i], [class*="sidenav" i], [class*="appnav" i], [class*="navRail" i]');
      } catch (e) { return false; }
    }
    function pickNavByToken(token) {
      try {
        var els = document.querySelectorAll("button, [role='tab'], [role='menuitem'], [role='button'], a, [aria-label]");
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          if (!el || el.id === NAV_ENTRY_ID) continue; // 排除注入按钮自身(防递归)
          if (!navCellLike(el)) continue;
          if (NAV_BAD_RE.test(String(el.className || ""))) continue;
          var t = navCleanText(el);
          if (t && !/\r|\n/.test(t) && t.length <= NAV_TEXT_MAX &&
              (t === token || t.indexOf(token) === 0 || t.indexOf(token) !== -1)) return el;
          var at = navAttrOf(el);
          if (at && (at === token || at.indexOf(token) === 0)) return el;
        }
      } catch (e) { /* 忽略 */ }
      return null;
    }
    /** 打开「远程访问」设置栏目：栏目已渲染直接点；否则先点官方「设置」再 ≤3s 轮询补点。 */
    function openRemoteSettings() {
      try {
        var cell = pickNavByToken("远程访问");
        if (cell) { cell.click(); return; }
        var st = pickNavByToken("设置");
        if (!st) return;
        st.click();
        var tries = 0;
        var iv = setInterval(function () {
          tries++;
          var c2 = pickNavByToken("远程访问");
          if (c2) { clearInterval(iv); c2.click(); }
          else if (tries >= NAV_POLL_MAX) clearInterval(iv);
        }, 150);
      } catch (e) { /* 忽略 */ }
    }
    /** 注入侧栏按钮到官方「设置」按钮之前（独立 button；首次未见过引导红点）。 */
    function mountNavEntry(host) {
      try {
        if (document.getElementById(NAV_ENTRY_ID)) return;
        var wrap = host && host.parentNode;
        if (!wrap || !wrap.insertBefore || !wrap.contains) return;
        var btn = document.createElement("button");
        btn.type = "button";
        btn.id = NAV_ENTRY_ID;
        btn.className = "dru-nav-remote";
        btn.setAttribute("data-dru-remote", "1");
        // 🎨 侧栏入口在面板之外，拿不到面板根上的令牌 → 自己也挂一份主题属性
        btn.setAttribute("data-dru-theme", themeGet());
        themeState.navEl = btn;
        // 入口常驻，所以它自己就是主题观察器的一个订阅者：
        // 用户切深色时（哪怕面板没开着）这里也要立刻跟上。
        themeStartWatch();
        btn.title = "打开「远程访问」设置(快捷入口)";
        btn.style.position = "relative";
        btn.textContent = "📱 远程访问";
        btn.addEventListener("click", function (e) {
          try { e.stopPropagation(); e.preventDefault(); } catch (err) {}
          dotMarkSeen(); // 用过快捷入口=已了解入口位置 → 关闭首次红点(含官方栏目红点)
          openRemoteSettings();
        });
        wrap.insertBefore(btn, host);
        if (!dotSeen()) {
          var d = document.createElement("span");
          d.className = "dru-nav-remote-dot";
          btn.appendChild(d);
        }
      } catch (e) { /* 忽略 */ }
    }
    /** 常驻确保：官方「设置」按钮出现后在它前面挂一次入口(去重；2s 心跳，成本极低)。 */
    function navEnsureStart() {
      if (window.__dshRemoteNavStarted) return;
      window.__dshRemoteNavStarted = true;
      try { window.__dshRemoteNav = { open: openRemoteSettings }; } catch (e) {}
      var iv = setInterval(function () {
        try {
          if (document.getElementById(NAV_ENTRY_ID)) return; // 已注入
          var host = pickNavByToken("设置");
          if (host) mountNavEntry(host);
        } catch (e) { /* 忽略 */ }
      }, 2000);
      try { if (iv && typeof iv.unref === "function") iv.unref(); } catch (e) {} // node 测试环境不阻塞退出
    }

    // ── 宿主 API ────────────────────────────────────────────────────────────
    /**
     * 默认请求超时（0.6.7-beta.3 新增）。
     * 背景（用户实测）：node 半一旦被同步子进程调用钉死（卸载时 spawnSync 卡在 schtasks 上），
     * 请求**永远不会返回**，面板就对着一个永不结束的 spinner —— 用户只能猜。
     * 现在超时后给出明确报错（并提示"这一步可能已经在后台完成了"），而不是无限转圈。
     * 30s 足够覆盖最慢的正常路径（relay 6s + Windows 进程扫描 8s）。
     */
    var API_TIMEOUT_MS = 30000;
    function api(path, options, timeoutMs) {
      var opts = options || {};
      var timer = null;
      try {
        if (typeof AbortController === "function") {
          var ctrl = new AbortController();
          var ms = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : API_TIMEOUT_MS;
          timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* 忽略 */ } }, ms);
          opts = Object.assign({}, opts, { signal: ctrl.signal });
        }
      } catch (e) { /* 无 AbortController 的旧环境：退化为无超时（不阻断使用） */ }
      var done = function () { if (timer) { clearTimeout(timer); timer = null; } };
      return fetch(path, opts).catch(function (e) {
        // AbortError → 换成用户能看懂的话（并说明服务端可能已经做完了）
        if (e && (e.name === "AbortError" || /abort/i.test(String(e.message || "")))) {
          var te = new Error("请求超时（面板等不到本机响应）。这一步可能已经在后台完成了 —— 请刷新页面查看；若 dsh web 无响应，重启一次 dsh web 即可。");
          te.timeout = true;
          throw te;
        }
        throw e;
      }).finally(done).then(function (res) {
        return res.text().then(function (text) {
          var body = null;
          try { body = JSON.parse(text); } catch (e) { body = null; }
          if (!res.ok) {
            var err = (body && (body.error || (body.body && body.body.error && (body.body.error.message || body.body.error)))) || ("HTTP " + res.status);
            var e = new Error(typeof err === "string" ? err : JSON.stringify(err));
            e.status = res.status; e.body = body;
            throw e;
          }
          return body;
        });
      });
    }
    var post = function (path, data) {
      return api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data || {}) });
    };
    /** 带自定义超时的 POST（用于卸载这类"可能拖住"的操作）。 */
    var postWithTimeout = function (path, data, timeoutMs) {
      return api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data || {}) }, timeoutMs);
    };

    // ── 交流群（二维码由图层面板上传统一配置,node 半经公开配置下发） ─────────
    // 设置面板「加入交流群」按钮与用户反馈页都展示同一张码;未配置(qrcode 为空)→ 不展示任何入口。
    var COMMUNITY_TTL_MS = 5 * 60 * 1000; // 面板/反馈卡共用缓存:5 分钟内不重复请求
    var communityCache = { at: 0, data: null };
    /** 取交流群信息(模块级缓存;失败视为未配置,不打扰用户)。 */
    function loadCommunity(force) {
      if (!force && communityCache.data && Date.now() - communityCache.at < COMMUNITY_TTL_MS) {
        return Promise.resolve(communityCache.data);
      }
      return api("/dsh-remote/community").then(function (b) {
        communityCache = { at: Date.now(), data: { qrcode: (b && b.qrcode) || "", wechat: (b && b.wechat) || "" } };
        return communityCache.data;
      }).catch(function () {
        communityCache = { at: Date.now(), data: { qrcode: "", wechat: "" } };
        return communityCache.data;
      });
    }

    // ── 登录后首次加载的自愈（0.6.1） ───────────────────────────────
    // 现象（首次安装后立即登录）：面板在 loggedIn 翻真的瞬间就请求 /dsh-remote/access-key 与
    // /dsh-remote/mobile-sessions；此时中继握手可能尚未就绪（bridge 刚被重启、device-login 共享密钥
    // 刚补齐或正在轮换、中继冷启动/网络抖动），旧版只报一次红字且不重试——必须手动刷新页面才行。
    // 现在：可重试类失败按退避自动重试（成功即自动清除红字），并给红字配「重试」按钮。
    var LOGIN_LOAD_RETRY_MS = [1200, 3000, 6000];

    /** node 半标记 retryable（中继未就绪）或网络/5xx → 值得自动重试；未登录/密码失效不重试。 */
    function retryableFail(e) {
      var body = e && e.body;
      if (body && body.retryable === true) return true;
      if (body && typeof body.hint === "string" && /^relay_/.test(body.hint)) return true;
      var st = e && e.status;
      if (typeof st !== "number") return true;       // fetch 本身失败（网络中断/被中止）
      return st === 0 || st === 408 || st === 429 || st >= 500;
    }

    /** 定时器节流：tests/SSR 环境没有 setTimeout 时静默降级（不抛错、不阻塞面板）。 */
    function later(fn, ms) {
      try { return setTimeout(fn, ms); } catch (e) { return null; }
    }
    function clearLater(t) {
      if (t == null) return;
      try { clearTimeout(t); } catch (e) { /* 忽略 */ }
    }

    // ── 剪贴板（0.6.9 邀请区「一键复制」）────────────────────────────────────
    /**
     * 复制文本到剪贴板，返回 Promise<boolean>。
     * 优先 Clipboard API；http 非安全上下文 / 旧浏览器里 navigator.clipboard 不存在
     * → 退回隐藏 textarea + document.execCommand("copy")；两种都失败返回 false，
     * 调用方**必须**在按钮旁给出可见提示（不能让用户以为"点了没反应"）。
     */
    function copyText(text) {
      var s = text == null ? "" : String(text);
      if (!s) return Promise.resolve(false);
      var fallback = function () { return Promise.resolve(copyTextLegacy(s)); };
      try {
        if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          return navigator.clipboard.writeText(s).then(function () { return true; }).catch(fallback);
        }
      } catch (e) { /* 落入兜底 */ }
      return fallback();
    }
    /** 兜底复制：隐藏 textarea + execCommand（同步；不可用/被拒绝时返回 false）。 */
    function copyTextLegacy(s) {
      var ta = null;
      try {
        ta = document.createElement("textarea");
        ta.value = s;
        ta.setAttribute("readonly", "readonly");
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        ta.style.left = "-1000px";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        try { ta.select(); } catch (e) { /* 某些环境无 select */ }
        return !!(document.execCommand && document.execCommand("copy"));
      } catch (e) {
        return false;
      } finally {
        try { if (ta && ta.parentNode && ta.parentNode.removeChild) ta.parentNode.removeChild(ta); } catch (e) { /* 忽略 */ }
      }
    }
    /** 毫秒 → 人话时长（"12 秒" / "1 分 05 秒" / "1 小时 02 分"）；用于更新「已用时」。 */
    function fmtDuration(ms) {
      var n = Number(ms);
      var s = Math.max(0, Math.round((isFinite(n) ? n : 0) / 1000));
      if (s < 60) return s + " 秒";
      var m = Math.floor(s / 60);
      if (m < 60) return m + " 分 " + (s % 60 < 10 ? "0" : "") + (s % 60) + " 秒";
      return Math.floor(m / 60) + " 小时 " + (m % 60 < 10 ? "0" : "") + (m % 60) + " 分";
    }
    /** 手机号掩码（邀请记录里的新用户手机号：面板只展示掩码，完整号码留在服务端）。 */
    function maskPhoneLike(v) {
      var s = String(v == null ? "" : v).trim();
      if (!s) return "";
      if (/^\d{11}$/.test(s)) return s.slice(0, 3) + "****" + s.slice(7);
      if (/^\d{7,}$/.test(s)) return s.slice(0, 3) + "****" + s.slice(-2);
      return s;
    }

    /** 一次性访问密钥 / 已授权设备列表的自动重试状态（放在组件外：不随渲染重建）。 */
    var akeyRetry = { timer: null, attempt: 0 };
    var devRetry = { timer: null, attempt: 0 };
    // 请求在途标记同样放组件外：组件内 state 闭包会在定时器/轮询回调里过期，
    // 导致 busy 护栏失效（重复请求）或误拦（该重试却跳过）。
    var akeyInFlight = { v: false };
    var devInFlight = { v: false };
    /** 连接阶段轮询的在途标记（同上：必须放组件外，否则闭包过期会重复请求）。 */
    var connInFlight = { v: false };
    /** 最近一次连接阶段（供自调度定时器决定快/慢轮询节奏，避免依赖渲染闭包）。 */
    var connPhaseRef = { v: "" };
    /**
     * 连接阶段轮询的**连续失败**计数（0.6.7 新增）。
     * 背景（用户实测）：轮询失败原来被 `.catch` 静默吞掉，而 node 半一旦 500
     * （Windows 上 `process.getuid is not a function`），面板就永久停在「查询中…」转圈，
     * 用户完全看不出发生了什么。现在连续失败到阈值就把失败原因摆到连接卡上。
     */
    var connFailRef = { v: 0 };
    var CONN_FAIL_VISIBLE = 3; // ≈ 2.5s × 3：既要够快让用户看见，又要避免一次抖动就报红
    /**
     * 「连接偏慢」的本地观察起点（0 = 不慢）——用于在用户干等时给出「转化 or 拉新」双路块。
     * 只用既有 /dsh-remote/bridge-status 下发字段 + 本地计时，**不新增也不假设后端字段**；
     * 观察不到就永远不显示（宁可不出现，也不误报）。
     */
    var slowConnTrack = { since: 0 };
    var SLOW_CONNECT_HINT_MS = 90000; // 非 online 阶段持续 90s 才认为「明显偏慢」
    // ── 事实口径常量（🔒 只写线上真值，一个字都不编）─────────────────────────────
    // 邀请奖励：线上 public-config 下发 invite_rule { n: 1, days: 3 }。
    //   此处只在 public-config 取不到时（旧 node 半 / 请求失败）兜底，
    //   用「与线上一致」的值，避免面板显示 3 位/15 天这种和线上对不上的旧口径。
    //   注意：被邀请人**没有任何额外奖励**（trial_days = 0），所以禁止任何「双方都得」的写法。
    var INVITE_RULE_FALLBACK = { n: 1, days: 3 };
    // ── 套餐口径：**先读线上真形状** ─────────────────────────────────────────
    // 线上实测（GET https://n.risegao.cn:13443/relay-api/api/public-config）：
    //   plans.free    = { max_mbps: 1,  monthly_gb: 1 }
    //   plans.pro     = { max_mbps: 5,  monthly_gb: 20, devices: 1,  monthly_resets: 5 }
    //   plans.pro_max = { max_mbps: 10, monthly_gb: 60, devices: 10, online: 3 }
    //   prices        = { pro: 20, pro_max: 30, ... }   ← 价格在**另一个**顶层字段；plans 里没有价格
    // 所以：带宽读 plans[k].max_mbps、流量读 plans[k].monthly_gb、价格读 prices[k]。
    // ⚠️ 早期版本检测的是 { mbps, gb, price } —— 线上这三个键**都不存在**，
    //    于是特性检测永远不命中、面板一直用常量。现在真形状优先，旧形状只作兼容兜底。
    // PLAN_FACTS 仅在**字段缺失或非法**时兜底（值仍与线上一致：PRO ¥20/月 5 Mbps 20 GB）。
    var PLAN_FACTS = {
      pro: { mbps: 5, gb: 20, price: 20, name: "PRO" },
      pro_max: { mbps: 10, gb: 60, price: 30, name: "Pro Max" }
    };
    /**
     * 取第一个**合法数值**：未定义 / null / 空串 / 非数字 → 跳到下一个候选。
     * 全都没命中 → null（由调用方决定兜底）。
     *
     * 🔒 刻意**不用** `Number(x) > 0 ? x : 兜底`：`monthly_gb: 0`（可能表示「不限流量」）
     *    与 `prices.pro: 0`（免费档）都是**合法值**，`> 0` 会把它们吃掉 ——
     *    这与后端 `|| 3 / || 15` 是同一类 bug（0 被当成「没配」）。
     *    这里只判「缺没缺」，不判「大不大」。
     */
    function firstNum(candidates) {
      for (var i = 0; i < candidates.length; i++) {
        var raw = candidates[i];
        if (raw === undefined || raw === null || raw === "") continue;
        var n = Number(raw);
        if (isFinite(n)) return n;
      }
      return null;
    }
    /**
     * 拉新是否被**显式关闭**：public-config.invite_rule 的 n / days 配成 0（或负数）= 关闭拉新
     * （与 `trial_days = 0 = 关闭` 同一约定）。关闭后所有拉新入口与卡片整体隐藏 ——
     * 既不显示「每 0 位新用户 → 0 天」，也不留一个点进去没内容的入口。
     *
     * 🔒 这里必须**只看原始值**：不能先过 `Number(x) > 0 ? x : 兜底` 那一层，
     * 否则 0 会被兜底值吃掉（后端那个 `|| 3 / || 15` 的 bug 就是这么把关闭态吃成「每 3 人送 15 天」的）。
     *
     * 返回 false（＝按显示处理）的情况：public-config 取不到、invite_rule 缺失、字段缺失或非数字
     * —— 判断不了就别把功能藏掉（向后兼容旧 node 半）。
     */
    function inviteOffFrom(rule) {
      if (!rule || typeof rule !== "object") return false;
      var nRaw = rule.n, dRaw = rule.days;
      var nNum = Number(nRaw), dNum = Number(dRaw);
      var present = function (raw) { return raw !== undefined && raw !== null && raw !== ""; };
      var nOff = present(nRaw) && isFinite(nNum) && nNum <= 0;
      var dOff = present(dRaw) && isFinite(dNum) && dNum <= 0;
      return !!(nOff || dOff);
    }
    /** 连接阶段轮询节奏：未连通时 2.5s（自动推进），已连接后退避到 15s；页面隐藏时完全停下。 */
    var CONN_POLL_FAST_MS = 2500;
    var CONN_POLL_SLOW_MS = 15000;
    function cancelAkeyRetry() { clearLater(akeyRetry.timer); akeyRetry.timer = null; }
    function cancelDevRetry() { clearLater(devRetry.timer); devRetry.timer = null; }

    /** 一次性访问 url → 升级/续费页 url（带同一 auth，进入后即登录态到 /app/promo）。 */
    function promoUrlOf(u) {
      var s = String(u || "");
      if (/\/app\/\?auth=/i.test(s)) return s.replace(/\/app\/\?auth=/i, "/app/promo?auth=");
      try {
        var m = /auth=([^&#]+)/.exec(s);
        var origin = s.split("/app")[0];
        if (m && origin) return origin + "/app/promo?auth=" + m[1];
      } catch (e) { /* fallthrough */ }
      return s;
    }

    // ── 用户反馈模块：本地状态（thread 令牌 / 弹窗节流） ───────────────────
    // 「我的反馈」双数据源：本地 dsh-feedback-threads(thread_token 凭据,匿名/本机未同步行)
    // + 服务端 /api/feedback/mine(登录态账号历史,见 FeedbackCard loadMine/fbRows,合并去重展示)。
    var FB_THREADS_KEY = "dsh-feedback-threads";
    var FB_POPUP_KEY = "dsh-feedback-popup";
    var FB_POPUP_DELAY_MS = 60 * 60 * 1000;   // 安装/体验后至少 1 小时才弹窗(只弹一次)
    // 评价去重(2026-09):弹窗状态按「账号(掩码手机号)或设备」分作用域 —— 换账号/换机不重复打扰;
    // 服务端另有 user_id/device_id 409 already_rated 兜底(同一账号/设备只收集一次 rating)。
    var fbPopScope = "anon";
    function setFbPopScope(scope) { fbPopScope = String(scope || "anon"); }
    var FB_CATEGORIES = [
      { value: "feature", label: "功能类" },
      { value: "bug", label: "Bug 类" },
      { value: "requirement", label: "需求类" },
      { value: "other", label: "其他" },
    ];
    var FB_STATUS_LABEL = { open: "待处理", processing: "处理中", done: "已解决" };

    function fbLoadThreads() {
      try { return JSON.parse(localStorage.getItem(FB_THREADS_KEY) || "[]"); } catch (e) { return []; }
    }
    function fbSaveThreads(list) {
      try { localStorage.setItem(FB_THREADS_KEY, JSON.stringify(list.slice(-20))); } catch (e) {}
    }
    function fbRememberThread(id, token) {
      var list = fbLoadThreads().filter(function (t) { return t.id !== id; });
      list.push({ id: id, token: token, at: Date.now() });
      fbSaveThreads(list);
    }
    /** 清除本地保存的用户反馈线程凭据（thread_token 只存于此，见 FB_THREADS_KEY）。
     * 退出登录 / 切换连接账号时调用：反馈历史保留在服务端（按账号校验），
     * 账号身份变化后本机不再持有旧线程的访问凭据。 */
    function fbClearThreads() {
      try { localStorage.removeItem(FB_THREADS_KEY); } catch (e) {}
    }
    function fbPopState() {
      try { return JSON.parse(localStorage.getItem(FB_POPUP_KEY + ":" + fbPopScope) || "null"); } catch (e) { return null; }
    }
    function fbSavePopState(s) {
      try { localStorage.setItem(FB_POPUP_KEY + ":" + fbPopScope, JSON.stringify(s)); } catch (e) {}
    }
    /** 作用域清理:旧版无作用域键也一并视为已完成,避免老用户再次被打扰。 */
    function fbClearPopScope(scopes) {
      try {
        localStorage.removeItem(FB_POPUP_KEY); // 兼容旧键(无后缀)
        if (Array.isArray(scopes)) scopes.forEach(function (sc) { localStorage.removeItem(FB_POPUP_KEY + ":" + sc); });
      } catch (e) {}
    }

    /** 同源反馈代理调用（浏览器 → /dsh-remote/feedback/* → 独立反馈服务）。 */
    function fbApi(path, options) {
      var opts = Object.assign({}, options || {});
      var headers = Object.assign({}, opts.headers || {});
      if (opts.token) headers.authorization = "Bearer " + opts.token;
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      return api("/dsh-remote/feedback/api" + path, Object.assign({}, opts, { headers: headers }));
    }

    function fbStatusBadge(status) {
      return h("span", { className: "dru-fb-badge dru-fb-badge-" + (status || "open") },
        FB_STATUS_LABEL[status] || status || "待处理");
    }

    /** 面板内的“用户反馈”卡片（提交 + 我的反馈 双 tab）。
     * 匿名（自建/未登录）不要求任何验证码：仅填写内容即可提交，
     * 服务端只记录 IP / 浏览器标识，防刷由服务端限流兜底。 */
    function FeedbackCard(props) {
      var cfgArr = useState(null); var cfg = cfgArr[0]; var setCfg = cfgArr[1];
      var fbAuthArr = useState("anonymous"); var fbAuth = fbAuthArr[0]; var setFbAuth = fbAuthArr[1];
      var tabArr = useState("submit"); var tab = tabArr[0]; var setTab = tabArr[1];
      var catArr = useState("bug"); var cat = catArr[0]; var setCat = catArr[1];
      var titleArr = useState(""); var fbTitle = titleArr[0]; var setFbTitle = titleArr[1];
      var contentArr = useState(""); var fbContent = contentArr[0]; var setFbContent = contentArr[1];
      var contactArr = useState(""); var contact = contactArr[0]; var setContact = contactArr[1];
      var threadsArr = useState(fbLoadThreads()); var threads = threadsArr[0]; var setThreads = threadsArr[1];
      var openIdArr = useState(""); var openId = openIdArr[0]; var setOpenId = openIdArr[1];
      var threadDataArr = useState(null); var threadData = threadDataArr[0]; var setThreadData = threadDataArr[1];
      var busyArr = useState(""); var busy = busyArr[0]; var setBusy = busyArr[1];
      var msgArr = useState(null); var fbMsg = msgArr[0]; var setFbMsg = msgArr[1];
      // 账号历史（服务端 /feedback/mine 聚合列表）：null=未加载；登录态(SaaS 账号已配)打开「我的反馈」时拉取
      var mineListArr = useState(null); var mineList = mineListArr[0]; var setMineList = mineListArr[1];
      var mineErrArr = useState(false); var mineErr = mineErrArr[0]; var setMineErr = mineErrArr[1];
      var mineBusyArr = useState(false); var mineBusy = mineBusyArr[0]; var setMineBusy = mineBusyArr[1];
      // 💬 交流群:反馈页底部展示「加入交流群」二维码(与设置面板共用同一份缓存)
      var commArr = useState(communityCache.data); var comm = commArr[0]; var setComm = commArr[1];

      function setMsg(kind, text) { setFbMsg({ kind: kind, text: text }); }

      // 登录态(SaaS 且账号已配)→ 打开「我的反馈」拉账号历史(/mine 需要 JWT,节点半在登录态自动附加);
      // 自建/未登录(cfg.phone 为空)→ 仍走本地 thread_token,不发 /mine。
      var fbAccount = !!(cfg && cfg.phone && fbAuth === "account");

      useEffect(function () {
        var alive = true;
        loadCommunity().then(function (d) { if (alive) setComm(d); });
        return function () { alive = false; };
      }, []);

      var loadCfg = useCallback(function () {
        api("/dsh-remote/feedback-config").then(function (b) {
          setCfg(b);
          // 登录态（节点半自动附加 JWT）→ 提交自动带上账号身份；
          // 匿名（自建/未登录）→ 不要求任何验证码，服务端只记录 IP / 浏览器标识。
          setFbAuth(b.auth === "account" ? "account" : "anonymous");
          if (!b.reachable) setMsg("warn", "反馈服务未连接，请检查网络或 feedback_url 配置");
        }).catch(function (e) { setCfg({ reachable: false }); setMsg("warn", "反馈服务未连接：" + e.message); });
      }, []);

      /** 服务端账号历史行（mine 列表含该 id）→ 单条打开/回复走服务端(节点半自动附 JWT),无需本地 thread_token。 */
      function fbRowIsAccount(id) {
        return !!(mineList && mineList.some(function (x) { return x.id === id; }));
      }

      function loadThread(id) {
        var t = threads.filter(function (x) { return x.id === id; })[0];
        // 账号历史行:不带 thread_token(登录态由节点半自动附账号 JWT,服务端按账号归属放行);
        // 匿名/纯本地行:仍按原 thread_token 逻辑(带本地凭据访问)。
        var accountRow = fbRowIsAccount(id);
        if (!accountRow && !t) return;
        setBusy("thread:" + id);
        fbApi("/feedback/" + id, accountRow ? {} : { token: t.token }).then(function (b) {
          setThreadData(b.feedback);
        }).catch(function (e) {
          if (e && e.status === 401) setMsg("err", "登录已过期，请退出后重新登录后再查看该反馈");
          else setMsg("err", "加载反馈详情失败：" + (e && e.message));
        }).finally(function () { setBusy(""); });
      }

      /** 登录态拉取账号历史(/feedback/mine,翻页参数可用;节点半在登录态自动附 JWT)。 */
      function loadMine() {
        if (!fbAccount) return;
        setMineBusy(true); setMineErr(false);
        fbApi("/feedback/mine?page=1&page_size=20").then(function (b) {
          setMineList((b && b.items) || []);
        }).catch(function (e) {
          setMineErr(true);
          var eb = e && e.body && e.body.error;
          setMsg("err", e && e.status === 401
            ? "账号登录已过期，请退出后重新登录，再查看账号全部历史"
            : "账号历史拉取失败：" + ((eb && eb.message) || (e && e.message)) + "（本机记录仍可查看）");
        }).finally(function () { setMineBusy(false); });
      }

      /** 合并展示列表：账号历史(服务端 mine,新→旧)在前；本机 thread_token 行去重后保留
       *  （匿名/本机新增但服务端未聚合的行仍可见,打开继续走本地凭据）。 */
      function fbRows() {
        var out = [];
        var seen = {};
        (mineList || []).forEach(function (it) {
          seen[it.id] = true;
          out.push({
            id: it.id, acct: true,
            status: it.status || "", category: it.category || "", title: it.title || "",
            created_at: it.created_at || 0, reply_count: it.reply_count || 0,
          });
        });
        threads.slice().reverse().forEach(function (t) {
          if (seen[t.id]) return;
          seen[t.id] = true;
          out.push({ id: t.id, acct: false, status: "", category: "", title: "", created_at: 0, reply_count: 0 });
        });
        return out;
      }

      useEffect(function () { loadCfg(); }, [loadCfg]);
      // 登录态打开「我的反馈」→ 拉账号历史;仅在未加载且非错误态自动触发(失败后点 tab 重试,不无限重试)
      useEffect(function () {
        if (tab === "mine" && fbAccount && mineList === null && !mineErr && !mineBusy) loadMine();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [tab, fbAccount, mineList === null, mineErr, mineBusy]);

      var doSubmit = function () {
        if (!fbContent.trim()) { setMsg("err", "请填写反馈内容"); return; }
        if (fbContent.length > 2000) { setMsg("err", "内容不能超过 2000 字"); return; }
        setBusy("submit");
        var payload = {
          kind: "feedback",
          category: cat,
          title: fbTitle.trim(),
          content: fbContent.trim(),
          contact: contact.trim() || ((cfg && cfg.phone && cfg.phone.indexOf("*") === -1) ? cfg.phone : ""),
        };
        fbApi("/feedback", { method: "POST", body: JSON.stringify(payload) })
          .then(function (b) {
            fbRememberThread(b.feedback.id, b.thread_token);
            setThreads(fbLoadThreads());
            if (fbAccount) setMineList(null); // 账号态提交成功 → 回「我的反馈」时重新拉取(含本条)
            setFbTitle(""); setFbContent(""); setContact("");
            setMsg("ok", "✅ 反馈已提交，可在「我的反馈」查看回复");
            setTab("mine");
          })
          .catch(function (e) {
            var errBody = e.body && e.body.error;
            if (errBody && errBody.code === "rate_limited") setMsg("err", "今天提交次数已达上限，请明天再试");
            else setMsg("err", "提交失败：" + (errBody && errBody.message ? errBody.message : e.message));
          })
          .finally(function () { setBusy(""); });
      };

      var doReply = function (id) {
        var input = document.getElementById("dru-fb-reply-" + id);
        var text = input ? input.value.trim() : "";
        if (!text) { setMsg("err", "请填写回复内容"); return; }
        var t = threads.filter(function (x) { return x.id === id; })[0];
        var accountRow = fbRowIsAccount(id);
        // 账号历史行:服务端回复(节点半自动附 JWT,无需本地 thread_token);本地/匿名行:带 thread_token 回复
        var replyOpts = { method: "POST", body: JSON.stringify({ content: text }) };
        if (!accountRow) {
          if (!t) return;
          replyOpts.token = t.token;
        }
        setBusy("reply:" + id);
        fbApi("/feedback/" + id + "/replies", replyOpts)
          .then(function () {
            if (input) input.value = "";
            loadThread(id);
            setMsg("ok", "✅ 已回复");
          })
          .catch(function (e) {
            var errBody = e.body && e.body.error;
            if (e && e.status === 401) setMsg("err", "登录已过期，请重新登录后再回复");
            else if (errBody && errBody.code === "rate_limited") setMsg("err", "今天回复次数已达上限，请明天再试");
            else setMsg("err", "回复失败：" + (errBody && errBody.message ? errBody.message : e.message));
          })
          .finally(function () { setBusy(""); });
      };

      var openThread = function (id) {
        setOpenId(id === openId ? "" : id);
        setThreadData(null);
        if (id !== openId) loadThread(id);
      };

      /** 「我的反馈」tab 内容：账号历史行直接用服务端字段渲染(状态/类别/标题/时间/回复数)，
       *  并保留本机未同步的 thread_token 行；单条展开/回复由 loadThread/doReply 分流。 */
      function renderMine() {
        var rows = fbRows();
        if (rows.length === 0) {
          var emptyText = fbAccount
            ? (mineBusy ? "正在加载账号历史…" : (mineErr ? "账号历史加载失败，点上方「我的反馈」tab 重试" : "暂无反馈，提交第一条？"))
            : "还没有提交过反馈。" + (cfg && cfg.reachable === false ? "（反馈服务未连接）" : "登录手机号账号后，可在任意设备查看账号全部历史。");
          return h("div", null,
            h("div", { className: "dru-fb-empty" }, emptyText),
            fbMsg && h("div", { className: "dru-msg dru-msg-" + fbMsg.kind }, fbMsg.text)
          );
        }
        return h("div", null,
          rows.map(function (r) {
            var open = openId === r.id;
            var td = open ? threadData : null;
            var st = td ? td.status : r.status;
            var cat = td ? td.category : r.category;
            var titleTxt = td ? (td.title || "") : r.title;
            var ts = td ? td.created_at : r.created_at;
            var catLbl = (function () {
              var c = FB_CATEGORIES.filter(function (x) { return x.value === cat; })[0];
              return c ? c.label : (cat || "反馈");
            })();
            return h("div", { key: r.id, className: "dru-fb-item" },
              h("div", { className: "dru-fb-item-head" },
                fbStatusBadge(st || "open"),
                h("span", { className: "dru-fb-cat" }, catLbl),
                h("span", { className: "dru-fb-item-title" }, titleTxt || ("反馈 #" + r.id.slice(-6))),
                h("span", { className: "dru-fb-item-time" },
                  (ts ? new Date(ts).toLocaleString() : "") +
                  (r.acct && !open && r.reply_count > 0 ? " · " + r.reply_count + " 条回复" : ""))
              ),
              open && td
                ? h("div", null,
                    h("div", { className: "dru-fb-item-content" }, td.content),
                    td.replies.map(function (reply) {
                      return h("div", { key: reply.id, className: "dru-fb-reply" },
                        h("div", { className: "dru-fb-reply-row" },
                          h("span", { className: "dru-fb-reply-who" + (reply.author === "user" ? " user" : "") }, reply.author === "admin" ? "管理员回复" : "我"),
                          h("span", { className: "dru-fb-reply-text" }, reply.content)
                        ),
                        h("div", { className: "dru-fb-item-time" }, new Date(reply.created_at).toLocaleString())
                      );
                    }),
                    h("div", { className: "dru-fb-reply" },
                      h("textarea", { id: "dru-fb-reply-" + r.id, className: "dru-fb-reply-input", placeholder: "回复管理员…", maxLength: 2000 }),
                      h("div", { style: { textAlign: "right", marginTop: 6 } },
                        h("button", { type: "button", className: "dru-btn dru-btn-ghost", disabled: busy !== "", onClick: function () { doReply(r.id); } }, busy === "reply:" + r.id ? "发送中…" : "回复")
                      )
                    ),
                    h("div", { className: "dru-fb-item-time", style: { textAlign: "right", marginTop: 8 } },
                      h("button", { type: "button", className: "dru-btn dru-btn-ghost", style: { padding: "2px 10px", fontSize: 12 }, disabled: busy !== "", onClick: function () { loadThread(r.id); } }, "↻ 刷新"),
                      " ",
                      h("button", { type: "button", className: "dru-btn dru-btn-ghost", style: { padding: "2px 10px", fontSize: 12 }, onClick: function () { setOpenId(""); setThreadData(null); } }, "收起")
                    )
                  )
                : h("div", { className: "dru-fb-item-time", style: { textAlign: "right" } },
                    h("button", { type: "button", className: "dru-btn dru-btn-ghost", style: { padding: "2px 10px", fontSize: 12 }, disabled: busy !== "", onClick: function () { openThread(r.id); } }, open ? "收起" : "查看 / 回复"))
            );
          }),
          mineBusy ? h("div", { className: "dru-hint", style: { marginTop: 6 } }, "账号历史同步中…") : null,
          fbMsg && h("div", { className: "dru-msg dru-msg-" + fbMsg.kind }, fbMsg.text)
        );
      }

      var mineRows = fbRows(); // 「我的反馈」展示行数：账号历史 + 本机未同步线程（合并去重后）
      return h("div", { className: "dru-card" },
        h("h3", null, "💬 用户反馈"),
        h("div", { className: "dru-fb-tabs" },
          h("div", { className: "dru-fb-tab" + (tab === "submit" ? " active" : ""), onClick: function () { setTab("submit"); setFbMsg(null); } }, "提交反馈"),
          h("div", { className: "dru-fb-tab" + (tab === "mine" ? " active" : ""), onClick: function () {
            setTab("mine"); setFbMsg(null); setThreads(fbLoadThreads());
            // 登录态(账号已配)打开「我的反馈」→ 拉取账号历史(合并展示,换设备/重装也能看到)
            if (fbAccount && mineList === null) loadMine();
          } }, "我的反馈" + (mineRows.length ? "(" + mineRows.length + ")" : ""))
        ),
        tab === "submit"
          ? h("div", null,
              h("div", { className: "dru-field" },
                h("label", null, "类别"),
                h("select", { className: "dru-fb-select", value: cat, onChange: function (e) { setCat(e.target.value); } },
                  FB_CATEGORIES.map(function (c) { return h("option", { key: c.value, value: c.value }, c.label); }))
              ),
              h("div", { className: "dru-field" },
                h("label", null, "标题（可选）"),
                h("input", { className: "dru-input", type: "text", value: fbTitle, maxLength: 120, placeholder: "一句话描述", onChange: function (e) { setFbTitle(e.target.value); } })
              ),
              h("div", { className: "dru-field" },
                h("label", null, "内容"),
                h("textarea", { className: "dru-fb-textarea", value: fbContent, maxLength: 2000, placeholder: "请描述遇到的问题或功能想法…", onChange: function (e) { setFbContent(e.target.value); } })
              ),
              h("div", { className: "dru-field" },
                h("label", null, "联系方式（可选）"),
                h("input", { className: "dru-input", type: "text", value: contact, maxLength: 120, placeholder: cfg && cfg.phone ? "已登录手机号：" + cfg.phone : "邮箱/手机号，便于我们跟进", onChange: function (e) { setContact(e.target.value); } })
              ),
              h("div", { className: "dru-hint", style: { marginBottom: 10 } },
                fbAuth === "account"
                  ? "已登录账号，提交反馈会带上你的身份信息。"
                  : "匿名反馈：无需输入任何验证码，上报仅记录 IP 与浏览器标识。"),
              h("button", { type: "button", className: "dru-btn dru-btn-primary", style: { width: "100%" }, disabled: busy !== "", onClick: doSubmit }, busy === "submit" ? "提交中…" : "提交反馈"),
              fbMsg && h("div", { className: "dru-msg dru-msg-" + fbMsg.kind }, fbMsg.text)
            )
          : renderMine(),
        // 反馈页底部:企微交流群二维码(后台上传后出现;未配置不展示)
        comm && comm.qrcode
          ? h("div", { className: "dru-fb-community" },
              h("div", { className: "dru-fb-community-title" }, "💬 加入企微交流群"),
              h("div", { className: "dru-hint", style: { marginBottom: 8 } }, "扫码入群：安装答疑 / 使用技巧 / 版本更新 / 问题反馈"),
              h("img", { className: "dru-community-qr", src: comm.qrcode, alt: "企微交流群二维码" }),
              comm.wechat ? h("div", { className: "dru-hint", style: { marginTop: 8 } }, "二维码失效或群满，可加客服微信：" + comm.wechat) : null)
          : null
      );
    }

    // ── 满意度弹窗（安装体验约 10 分钟后弹出） ──────────────────────────────

    /** 模块级弹窗开关（与面板独立）。 */
    var popupOpen = false;
    var popupListeners = new Set();
    function setPopupOpen(v) { popupOpen = !!v; popupListeners.forEach(function (l) { l(); }); }
    function subscribePopup(cb) { popupListeners.add(cb); return function () { popupListeners.delete(cb); }; }
    function usePopupOpen() { return useSyncExternalStore(subscribePopup, function () { return popupOpen; }); }

    /** 首次安装时间戳（首次观察到 bridge 运行时记下，便于“先用满 1 小时再评价”）。 */
    var fbFirstSeenAt = null;
    function fbEnsureFirstSeen() {
      var s = fbPopState();
      if (s && s.state === "pending" && s.firstSeen) { fbFirstSeenAt = s.firstSeen; return; }
      if (fbFirstSeenAt) return;
      fbFirstSeenAt = Date.now();
      fbSavePopState({ state: "pending", firstSeen: fbFirstSeenAt, nextAt: s && s.nextAt ? s.nextAt : 0 });
    }
    /** 弹窗触发检查：到点且未完成/未推迟。 */
    function fbMaybeOpenPopup() {
      var s = fbPopState();
      if (!s || s.state !== "pending" || popupOpen) return;
      if (!fbFirstSeenAt) return;
      if (Date.now() - fbFirstSeenAt < FB_POPUP_DELAY_MS) return;
      if (s.nextAt && Date.now() < s.nextAt) return;
      setPopupOpen(true);
    }
    function fbPopupLater() {
      // 只弹一次：关闭即视为本轮安装的评价流程结束，不再自动重复弹出
      fbSavePopState({ state: "done", firstSeen: fbFirstSeenAt || Date.now(), nextAt: 0 });
      setPopupOpen(false);
    }
    function fbPopupDone() {
      fbSavePopState({ state: "done", firstSeen: fbFirstSeenAt || Date.now(), nextAt: 0 });
      setPopupOpen(false);
    }

    function FeedbackPopup() {
      // 🎨 主题：弹窗是 shell.overlay 下的独立根（不在 .dru-settings-section 里），
      // 同样要拿一份 data-dru-theme 才有深色令牌；放在 useState 之前不扰动 hook 序号。
      var theme = useSyncExternalStore(themeSubscribe, themeGet);
      var open = usePopupOpen();
      var stepArr = useState("rate"); var step = stepArr[0]; var setStep = stepArr[1];
      var ratingArr = useState(null); var rating = ratingArr[0]; var setRating = ratingArr[1];
      var noteArr = useState(""); var note = noteArr[0]; var setNote = noteArr[1];
      var recommendArr = useState(null); var recommend = recommendArr[0]; var setRecommend = recommendArr[1];
      var busyArr = useState(""); var busy = busyArr[0]; var setBusy = busyArr[1];
      var msgArr = useState(null); var message = msgArr[0]; var setMessage = msgArr[1];
      var fbAuthArr = useState("anonymous"); var fbAuth = fbAuthArr[0]; var setFbAuth = fbAuthArr[1];
      // 邀请链接（已登录用户推荐成功后展示）
      var inviteArr = useState(null); var popupInvite = inviteArr[0]; var setPopupInvite = inviteArr[1];
      var inviteCopiedArr = useState(false); var inviteCopied = inviteCopiedArr[0]; var setInviteCopied = inviteCopiedArr[1];

      /** 预取邀请信息（已登录且有邀请码时生成专属链接）。 */
      function loadPopupInvite() {
        if (popupInvite) return;
        api("/dsh-remote/account").then(function (b) {
          var acct = (b && b.ok && b.account) ? b.account : null;
          if (!acct || !acct.invite_code) { setPopupInvite({ code: "" }); return; }
          api("/dsh-remote/remote-url").then(function (u) {
            var base = (u && u.remoteUrl) || "https://n.risegao.cn:13443/app/";
            // 特性检测：public-config 里带了 invite_rule 就用服务端数值；没带 → 0 = 不显示具体数字。
            // 🔒 用 firstNum 只判「缺没缺」：`n/days` 配成 0 是合法的「活动关闭」态，
            //    不能被 `> 0` 这样写吃掉再回落成 1/3（后端 `|| 3 / || 15` 的同款坑）。
            var pc = (u && u.publicConfig) || null;
            var raw = (pc && pc.invite_rule) || null;
            var nNum = firstNum([raw && raw.n]);
            var dNum = firstNum([raw && raw.days]);
            setPopupInvite({
              code: acct.invite_code,
              link: base.replace(/\/+$/, "") + "/?invite=" + encodeURIComponent(acct.invite_code),
              n: nNum === null ? 0 : nNum,
              days: dNum === null ? 0 : dNum
            });
          }).catch(function () { setPopupInvite({ code: acct.invite_code }); });
        }).catch(function () { setPopupInvite({ code: "" }); });
      }

      useEffect(function () {
        if (!open) return;
        // 登录态（节点半自动附加 JWT）→ 提交自动带上账号身份；
        // 匿名（自建/未登录）→ 不要求任何验证码，服务端只记录 IP / 浏览器标识。
        api("/dsh-remote/feedback-config").then(function (b) {
          setFbAuth(b.auth === "account" ? "account" : "anonymous");
        }).catch(function () { setFbAuth("anonymous"); });
        // 拉新关闭态探测（public-config 的 invite_rule.n / days = 0 = 关闭）：
        // 只有明确读到「关闭」才记下来 —— 读不到/字段缺失一律不记（判断不了 → 按显示处理）。
        // 命中关闭时复用 popupInvite 这个既有 state 触发重渲染，同时挡住后面的取码/取链接请求。
        api("/dsh-remote/remote-url").then(function (u) {
          var pc = (u && u.publicConfig) || null;
          if (inviteOffFrom(pc && pc.invite_rule)) setPopupInvite({ code: "", link: "", inviteOff: true });
        }).catch(function () {});
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [open]);

      if (!open) return null;

      var doSubmit = function () {
        if (rating === null) { setMessage({ kind: "err", text: "请先选择满意度" }); return; }
        if (step === "rate") { setStep("recommend"); return; }
        setBusy("submit");
        var payload = {
          kind: "rating",
          category: "satisfaction",
          content: note.trim() || (rating >= 4 ? "对远程访问功能满意" : "对远程访问功能不太满意"),
          rating: rating,
          recommend: recommend === true ? 1 : 0,
        };
        fbApi("/feedback", { method: "POST", body: JSON.stringify(payload) })
          .then(function (b) {
            fbRememberThread(b.feedback.id, b.thread_token);
            fbPopupDone();
          })
          .catch(function (e) {
            var errBody = e.body && e.body.error;
            if (errBody && errBody.code === "rate_limited") { fbPopupLater(); setMessage({ kind: "err", text: "今日提交已达上限，明天再来吧" }); }
            else if (errBody && errBody.code === "already_rated") { fbPopupDone(); setMessage({ kind: "ok", text: "你已评价过，感谢支持（同一账号/设备只收集一次）" }); }
            else setMessage({ kind: "err", text: "提交失败：" + ((errBody && errBody.message) || e.message) + "（可稍后再试）" });
          })
          .finally(function () { setBusy(""); });
      };

      return h("div", { className: "dru-popup", "data-dru-theme": theme, onMouseDown: function (e) { if (e.target === e.currentTarget) fbPopupLater(); } },
        h("div", { className: "dru-popup-card", role: "dialog", "aria-label": "用户反馈" },
          h("div", { className: "dru-popup-body" },
            step === "rate"
              ? h("div", null,
                  h("div", { className: "dru-popup-icon" }, "😊"),
                  h("div", { className: "dru-popup-title" }, "您对远程访问功能满意吗？"),
                  h("div", { className: "dru-popup-sub" }, "使用体验已满 1 小时，说说真实感受吧（1 分钟搞定）"),
                  h("div", { className: "dru-popup-rate" },
                    [ [5, "😄", "很满意"], [3, "😐", "一般"], [1, "😞", "不满意"] ].map(function (r) {
                      return h("button", { key: r[0], type: "button", className: rating === r[0] ? "sel" : "", onClick: function () { setRating(r[0]); setMessage(null); } },
                        h("span", null, r[1]), h("span", { className: "lbl" }, r[2]));
                    })
                  ),
                  h("textarea", { className: "dru-popup-textarea", value: note, maxLength: 2000, placeholder: "说说想法或遇到的问题（可选）…", onChange: function (e) { setNote(e.target.value); } }),
                  h("div", { className: "dru-hint", style: { marginTop: 10 } },
                    fbAuth === "account"
                      ? "已登录账号，本次评价会带上你的身份信息。"
                      : "匿名评价：只需填上面内容，无需任何验证码；上报会记录 IP 与浏览器标识。"),
                  message && h("div", { className: "dru-msg dru-msg-" + message.kind }, message.text),
                  h("div", { className: "dru-popup-actions" },
                    h("button", { type: "button", className: "dru-btn dru-btn-primary", disabled: busy !== "", onClick: doSubmit }, "下一步")
                  )
                )
              : h("div", null,
                  h("div", { className: "dru-popup-icon" }, "🤝"),
                  h("div", { className: "dru-popup-title" }, "愿意推荐给朋友吗？"),
                  // 拉新关闭态：不承诺任何奖励、不指路邀请页（入口与卡片也一并隐藏）。
                  // 但这一步**整块保留**（否则 recommend 永远为 null，「完成」按钮不出现＝死胡同）。
                  popupInvite && popupInvite.inviteOff
                    ? h("div", { className: "dru-popup-sub" },
                        "（当前没有推荐奖励活动：带新用户换会员时长已暂时关闭，把 App 分享给朋友就好。）")
                    // 交换句式（不能说「双方都得」：被邀请人没有任何额外奖励，trial_days = 0）
                    : h("div", { className: "dru-popup-sub" },
                        popupInvite && popupInvite.n && popupInvite.days
                          ? "带 " + popupInvite.n + " 位新用户 → 你得 " + popupInvite.days + " 天 PRO 会员：对方用你的邀请链接注册新账号 + 在电脑上装好并上线后自动到账。"
                          : "带新用户 → 你得会员时长：对方用你的邀请链接注册新账号 + 在电脑上装好 dsh-remote-web 并上线后自动到账（奖励只发给邀请人）。"),
                  recommend === true
                    ? h("div", { className: "dru-popup-invite" },
                        h("div", null, "🎉 感谢推荐！"),
                        popupInvite && popupInvite.inviteOff
                          ? h("div", { style: { marginTop: 6, fontSize: 12 } }, "当前未开放带新用户换会员时长的活动，暂时不需要邀请链接。")
                          : popupInvite && popupInvite.code && popupInvite.link
                          ? h("div", null,
                              h("div", { className: "dru-url", style: { marginTop: 10, textAlign: "left" } },
                                h("span", null, popupInvite.link),
                                h("button", { type: "button", onClick: function () {
                                  copyText(popupInvite.link).then(function (done) {
                                    setInviteCopied(done);
                                    if (done) later(function () { setInviteCopied(false); }, 2000);
                                  });
                                } }, inviteCopied ? "已复制" : "复制邀请链接")
                              ),
                              h("div", { style: { marginTop: 8, fontSize: 12 } }, "把链接发给一位还没注册过的新用户，对方注册时会自动带上你的邀请码。")
                            )
                          : h("div", { style: { marginTop: 6, fontSize: 12 } },
                              popupInvite && popupInvite.code
                                ? "邀请码 " + popupInvite.code + " 已生成：在设置面板 →「🎁 带新用户，换会员时长」里复制邀请链接。"
                                : "登录手机号账号后，在设置面板 →「🎁 带新用户，换会员时长」里获取专属邀请链接。")
                      )
                    : h("div", null,
                        h("div", { className: "dru-popup-actions" },
                          h("button", { type: "button", className: "dru-btn dru-btn-primary", onClick: function () { setRecommend(true); loadPopupInvite(); } }, "愿意推荐"),
                          h("button", { type: "button", className: "dru-btn dru-btn-ghost", onClick: function () { setRecommend(false); } }, "暂时不了")
                        ),
                        popupInvite && popupInvite.inviteOff
                          ? null
                          : h("div", { className: "dru-hint", style: { marginTop: 10 } }, "推荐成功可获得你的专属邀请链接（带新用户换会员时长）")
                      ),
                  message && h("div", { className: "dru-msg dru-msg-" + message.kind }, message.text),
                  recommend !== null && h("div", { className: "dru-popup-actions" },
                    h("button", { type: "button", className: "dru-btn dru-btn-primary", disabled: busy !== "", onClick: doSubmit }, busy === "submit" ? "提交中…" : "完成")
                  )
                )
          ),
          h("div", { className: "dru-popup-foot" },
            h("button", { type: "button", title: "关闭本轮评价，之后不再自动弹出", onClick: fbPopupLater }, "暂不评价"),
            h("button", { type: "button", onClick: fbPopupDone }, "不再提示")
          )
        )
      );
    }

    // ── 图标 ────────────────────────────────────────────────────────────────
    // 「远程访问」栏目图标沿用面板 emoji 图标体系：📱 更贴合“手机/另一台电脑远程访问”语义
    // （原 🖥 已随入口迁移调整）；栏目导航 label 与栏目头部均使用它。

    // ── 版本与更新卡片（自管理：市场没有更新按钮，这里提供在线一键更新/彻底卸载） ──
    // 数据来自 node 半的 /dsh-remote/self* 路由；逻辑均在插件 node 半实现，
    // 因此无论插件从「插件市场」还是 npx 安装，界面与行为完全一致。
    //
    // 【0.6.9 冻结契约】——**每个新字段都必须特性检测**，缺字段要优雅降级
    // （否则面板会在旧 node 半上白屏/报错）：
    //   GET  /dsh-remote/self               → { version, runtimeReady, channel? }
    //   GET  /dsh-remote/self/update-log    → { running, log, failure?, channel?,
    //                                           startedAt?, elapsedMs?, idleMs?, idleThresholdMs?, stalled? }
    //   POST /dsh-remote/self/update         → { ok, channel? }
    //   POST /dsh-remote/self/update/cancel  → { ok, killed, cleared }（旧 node 半无此路由 → 404 → 隐藏按钮并给一句人话）
    //   failure.failCode 可能是 update_stalled（看门狗判定无输出）/ user_cancelled（用户主动取消）等
    // 「已用时 / 无输出时长」在字段缺失时用本地观测兜底（startedAt/日志变化时间），保证旧宿主也看得见。
    var UPDATE_IDLE_HINT_MS = 20000;   // 无新日志超过 20s → 灰字提示（不惊动用户）
    var UPDATE_CANCEL_IDLE_MS = 90000; // 超过 90s 无变化 → 出现「取消并重试」（旧宿主无 idleThresholdMs 时的兜底）
    /** 更新通道 → 人话（channel 也可能是具体版本号）。 */
    var UPDATE_CHANNEL_COPY = { latest: "稳定版", beta: "预览版", next: "预览版", rc: "候选版" };
    function updateChannelText(ch) {
      var c = String(ch || "").trim();
      if (!c) return "";
      var friendly = UPDATE_CHANNEL_COPY[c];
      if (friendly) return friendly + "（" + c + "）";
      if (/^\d/.test(c)) return "指定版本（" + c + "）";
      return c;
    }
    /**
     * fail_code → 人话补一句。**只映射能确定的码**；未知码返回空串（不编造原因，
     * 由服务端 detail 说明）。update_stalled 是 0.6.9 看门狗新增：更新进程长时间无输出。
     */
    var UPDATE_FAIL_COPY = {
      update_stalled: "更新进程长时间没有响应，已自动换源重试；若长时间没有变化，可点「取消并重试」。",
      user_cancelled: "更新已被取消，可以重新点「一键更新」再试一次。",
      npx_cmd_unavailable: "本机找不到可用的安装命令（npx）：请先安装 Node.js，或重启一次 dsh web 后重试。",
      node_missing: "本机没有找到 Node.js：请先安装 Node.js 后重试。",
      node_too_old: "本机 Node.js 版本过低（需要 20 以上）：升级 Node.js 后重试。",
      npm_unreachable: "连不上软件源：请检查网络后重试（面板会自动换源）。",
      registry_timeout: "软件源响应超时：稍后重试即可（面板会自动换源）。",
      platform_unsupported: "当前系统不支持自动更新：请按 README 手动安装。",
      runtime_install_timeout: "运行环境安装超时：已自动重试，仍失败可点「取消并重试」。",
    };
    /** 更新进度的本地兜底（旧 node 半不下发进度字段时用）——放组件外，跨渲染保留。 */
    var updTrack = { startedAt: 0, lastChangeAt: 0, lastLog: "" };

    function SelfManageCard() {
      var verArr = useState(null); var ver = verArr[0]; var setVer = verArr[1];       // {version, channel?, runtimeReady}
      var chkArr = useState(null); var chk = chkArr[0]; var setChk = chkArr[1];       // {current, latest, outdated}
      var chkBusyArr = useState(false); var chkBusy = chkBusyArr[0]; var setChkBusy = chkBusyArr[1];
      var upBusyArr = useState(false); var upBusy = upBusyArr[0]; var setUpBusy = upBusyArr[1];
      var unBusyArr = useState(false); var unBusy = unBusyArr[0]; var setUnBusy = unBusyArr[1];
      var logArr = useState(""); var log = logArr[0]; var setLog = logArr[1];         // 更新日志尾部
      var updArr = useState(false); var updating = updArr[0]; var setUpdating = updArr[1]; // 更新任务是否仍在跑
      var doneArr = useState(false); var updated = doneArr[0]; var setUpdated = doneArr[1]; // 本轮已更新完成（提示重启）
      var armArr = useState(false); var armed = armArr[0]; var setArmed = armArr[1];   // 彻底卸载二次确认
      var msgArr = useState(null); var selfMsg = msgArr[0]; var setSelfMsg = msgArr[1]; // {kind, text}
      // 【0.6.9】更新可见性：进度快照（已用时/无输出/是否卡住）+ 取消按钮状态
      var progArr = useState(null); var prog = progArr[0]; var setProg = progArr[1];
      var tickArr = useState(0); var updTick = tickArr[0]; var setTick = tickArr[1];   // 1s 心跳：让「已用时」平滑走字
      var cxBusyArr = useState(false); var cxBusy = cxBusyArr[0]; var setCxBusy = cxBusyArr[1];
      var cxOkArr = useState(null); var cancelOk = cxOkArr[0]; var setCancelOk = cxOkArr[1]; // null=未知 true=可用 false=旧宿主无此接口
      var cxMsgArr = useState(null); var cxMsg = cxMsgArr[0]; var setCxMsg = cxMsgArr[1];    // {kind, text}

      var loadVer = useCallback(function () {
        api("/dsh-remote/self").then(function (b) {
          if (b && b.ok) setVer(b);
        }).catch(function () {});
      }, []);

      var doCheck = useCallback(function () {
        setChkBusy(true);
        api("/dsh-remote/self/update-check").then(function (b) {
          if (b && b.ok) setChk(b);
          else setSelfMsg({ kind: "err", text: "检查更新失败：" + ((b && (b.error || b.detail)) || "未知错误") });
        }).catch(function (e) {
          setSelfMsg({ kind: "err", text: "无法连接更新服务：" + e.message });
        }).finally(function () { setChkBusy(false); });
      }, []);

      /**
       * 处理一次 /self/update-log 响应：刷新日志、进度指标、失败原因与版本；
       * running=true → 继续跟踪；running=false → 收尾（进程结束 ≠ 更新成功）。
       */
      var applyUpdLog = useCallback(function (b) {
        if (!b || !b.ok) return;
        var now = Date.now();
        var nextLog = typeof b.log === "string" ? b.log : "";
        if (nextLog !== updTrack.lastLog) { updTrack.lastLog = nextLog; updTrack.lastChangeAt = now; }
        setLog(nextLog);
        var running = !!b.running;
        var startedAt = Number(b.startedAt) > 0 ? Number(b.startedAt) : 0;
        if (running && !updTrack.startedAt) updTrack.startedAt = startedAt || now;
        if (!running) updTrack.startedAt = 0;
        var hasIdle = isFinite(Number(b.idleMs));
        setProg({
          running: running,
          at: now,
          startedAt: startedAt || updTrack.startedAt || 0,
          elapsedMs: isFinite(Number(b.elapsedMs)) ? Number(b.elapsedMs) : 0,
          // 旧宿主没有 idleMs → 用「日志最后一次变化的本地时间」兜底
          idleMs: hasIdle ? Number(b.idleMs) : (running && updTrack.lastChangeAt ? now - updTrack.lastChangeAt : 0),
          idleThresholdMs: isFinite(Number(b.idleThresholdMs)) ? Number(b.idleThresholdMs) : 0,
          stalled: b.stalled === true,
          channel: typeof b.channel === "string" ? b.channel : ""
        });
        if (running) { setUpdating(true); return; }
        setUpdating(false);
        // 关键:进程结束 ≠ 更新成功。以前这里无条件显示"已更新完成"，
        // 于是 spawn 失败（例如 npx 不可用）时界面只报成功、真实原因躺在日志里 ——
        // 用户看到的就是"点了一键修复没反应"。现在按失败信息与版本是否变化如实反馈。
        if (b.failure && b.failure.failCode === "user_cancelled") {
          // 用户自己点的取消：不是错误，用中性提示，不刷红字
          setUpdated(false);
          setSelfMsg({ kind: "warn", text: UPDATE_FAIL_COPY.user_cancelled });
        } else if (b.failure && b.failure.detail) {
          setUpdated(false);
          setSelfMsg({
            kind: "err",
            text: "更新失败：" + b.failure.detail + failCodeHint(b.failure.failCode, b.failure.detail) + "（可查看下方日志，或点「一键更新」重试）"
          });
        } else {
          setUpdated(true);
        }
        loadVer();
        doCheck();
      }, [loadVer, doCheck]);

      /**
       * fail_code → 人话（未知码返回空串：不编造原因，交给服务端 detail）。
       * detail 已经说了同一件事时不重复刷一遍（0.6.9 的 update_stalled 就属于这种情况）。
       */
      function failCodeHint(code, detail) {
        var txt = UPDATE_FAIL_COPY[String(code || "")];
        if (!txt) return "";
        var key = txt.split(/[，；。]/)[0];
        if (detail && key && String(detail).indexOf(key) !== -1) return "";
        return " ｜ " + txt;
      }

      // 一次性拉取更新状态：点击更新后立刻同步一次；面板打开时也探一次（更新可能是在别处点起的）
      var logTimer = useCallback(function () {
        return api("/dsh-remote/self/update-log").then(function (b) {
          applyUpdLog(b);
        }).catch(function () { /* 探针失败不影响面板 */ });
      }, [applyUpdLog]);

      useEffect(function () { loadVer(); doCheck(); logTimer(); }, [loadVer, doCheck, logTimer]);
      // 更新进行中：每 2s 拉日志+进度；结束（running=false）时由 applyUpdLog 收尾并清掉定时器
      useEffect(function () {
        if (!updating) return undefined;
        var iv = setInterval(function () { logTimer(); }, 2000);
        return function () { clearInterval(iv); };
      }, [updating, logTimer]);
      // 「已用时」走字：只在更新中开 1s 心跳（尊重 reduced-motion 也不影响，纯文本更新）
      useEffect(function () {
        if (!updating) return undefined;
        var iv = setInterval(function () { setTick(function (v) { return v + 1; }); }, 1000);
        return function () { clearInterval(iv); };
      }, [updating]);
      // 注：updTick 只用于触发重渲染（setTick 的引用是稳定的），不进依赖列表

      var doUpdate = function () {
        setUpBusy(true);
        setUpdated(false);
        setSelfMsg(null);
        setCxMsg(null);
        post("/dsh-remote/self/update", {}).then(function (b) {
          if (b && b.ok) {
            setSelfMsg({ kind: "ok", text: "更新已在后台开始，正在下载安装…（本页会实时显示进度日志、已用时与通道）" });
            setUpdating(true);
            logTimer();
          } else {
            var detail = String((b && (b.detail || b.error)) || "更新启动失败");
            // 另一种常见情况：node 半返回 ok:false + “已有更新在进行中” → 转为跟踪进度而非报错
            api("/dsh-remote/self/update-log").then(function (lb) {
              if (lb && lb.ok && lb.running) {
                setSelfMsg({ kind: "ok", text: "检测到已有一次更新正在进行，正在跟踪进度…" });
                setUpdating(true);
                logTimer();
              } else {
                setSelfMsg({ kind: "err", text: detail });
              }
            }).catch(function () { setSelfMsg({ kind: "err", text: detail }); });
          }
        }).catch(function (e) {
          setSelfMsg({ kind: "err", text: "更新失败：" + e.message });
        }).finally(function () { setUpBusy(false); });
      };

      /**
       * 取消更新：POST /dsh-remote/self/update/cancel（结束挂死的更新进程 + 清标记）。
       * retry=true → 取消成功后立刻重新点一次「一键更新」（即按钮上的「取消并重试」）。
       * 旧 node 半没有这个路由 → 404 → 隐藏按钮并给一句能照做的话（不把用户留在死胡同）。
       */
      var doCancelUpdate = function (retry) {
        setCxBusy(true);
        setCxMsg(null);
        post("/dsh-remote/self/update/cancel", {}).then(function (b) {
          if (!b || !b.ok) throw new Error((b && (b.detail || b.error)) || "取消失败");
          setCancelOk(true);
          setUpdating(false);
          setUpdated(false);
          setProg(null);
          updTrack.startedAt = 0;
          setCxMsg({
            kind: b.cleared === false ? "warn" : "ok",
            text: b.cleared === false
              ? "取消请求已发出，但更新标记没能清掉：请刷新页面；若仍显示「正在更新」，重启一次 dsh web 即可。"
              : ("已取消本次更新" + (b.killed === true ? "（更新进程已结束）" : "") + (retry ? "，正在重新开始…" : "，可以重新点「一键更新」再试一次。"))
          });
          loadVer();
          if (retry && b.cleared !== false) doUpdate();
        }).catch(function (e) {
          if (e && e.status === 404) {
            // 旧宿主：没有取消接口 → 永久隐藏该按钮，只留人话提示
            setCancelOk(false);
            setCxMsg({ kind: "warn", text: "当前插件版本还不支持一键取消更新：请刷新页面；若仍卡在「正在更新」，重启一次 dsh web 后重新点「一键更新」即可。" });
          } else {
            setCxMsg({ kind: "err", text: "取消失败：" + ((e && e.message) || "未知错误") + "（更新进程可能仍在运行；可稍后重试，或重启一次 dsh web）" });
          }
        }).finally(function () { setCxBusy(false); });
      };

      var doUninstall = function () {
        if (!armed) { setArmed(true); return; }
        setUnBusy(true);
        setSelfMsg(null);
        // 卸载：服务端现在"先卸插件、先回响应、慢活交子进程"，正常应在 1 秒内返回；
        // 给 20s 上界，超时也要给用户一句能照做的话（而不是永久转圈）。
        postWithTimeout("/dsh-remote/self/uninstall", {}, 20000).then(function (b) {
          if (b && b.ok) {
            setArmed(false);
            // 优先展示服务端 detail（含 bridge 自启动/配置目录的逐项清理结果与重启提示）；
            // 兜底文案同样说明 bridge 自启动服务与本地配置目录会一并移除/清空
            var detail = b && b.detail ? String(b.detail) : "";
            setSelfMsg({ kind: "ok", text: detail || "已彻底卸载：插件引用、bridge 自启动服务与本地配置目录（账号/密钥/运行时等）已一并移除并清空。请重启 dsh web 后完全生效（本栏目将消失）；如需再次使用，在插件市场搜索「dsh-remote-web」重新安装，或执行 npx @mrrisega/dsh-remote。" });
          } else {
            setArmed(false);
            setSelfMsg({ kind: "err", text: "卸载失败：" + ((b && (b.error || b.detail)) || "未知错误") });
          }
        }).catch(function (e) {
          setArmed(false);
          setSelfMsg({ kind: e && e.timeout ? "warn" : "err", text: (e && e.timeout ? "" : "卸载失败：") + e.message });
        }).finally(function () { setUnBusy(false); });
      };

      var outdated = !!(chk && chk.outdated && chk.latest && chk.latest !== chk.current);
      var currentV = (ver && ver.version) || (chk && chk.current) || "…";
      var runtimeReady = ver ? !!ver.runtimeReady : null;
      // 通道：GET /self 的 channel 优先（字段可能不存在 → 不渲染任何通道 chip，旧宿主照常工作）
      var channel = (ver && typeof ver.channel === "string" && ver.channel) || (prog && prog.channel) || "";
      // 进度指标（字段缺失时用本地观测兜底）：已用时 / 无输出时长 / 是否卡住
      var progRunning = !!(prog && prog.running);
      var elapsedBase = prog && prog.elapsedMs > 0 ? prog.elapsedMs
        : (prog && prog.startedAt ? Math.max(0, Date.now() - prog.startedAt) : 0);
      var elapsedShown = prog && prog.at ? elapsedBase + Math.max(0, Date.now() - prog.at) : elapsedBase;
      var idleShown = prog ? prog.idleMs + (prog.at ? Math.max(0, Date.now() - prog.at) : 0) : 0;
      var cancelAfterMs = prog && prog.idleThresholdMs > 0 ? prog.idleThresholdMs : UPDATE_CANCEL_IDLE_MS;
      // 「卡住」只采信服务端判定（stalled=true）；旧宿主没有该字段时退化为下面的「无输出」灰字提示，
      // 不自己编一个「卡住」结论（避免误报）。
      var stalled = !!(prog && prog.stalled);
      var canCancel = updating && cancelOk !== false && ((prog && prog.stalled) || idleShown >= cancelAfterMs);
      var idleHint = progRunning && !stalled && idleShown >= UPDATE_IDLE_HINT_MS;

      return h("div", { className: "dru-card", style: { marginTop: 2 } },
        h("h3", null, "🔄 版本与更新"),
        // ① 版本行：版本号（大字）+ 通道 chip + 新旧状态
        h("div", { className: "dru-ver-head" },
          h("span", { className: "dru-ver-num" }, "插件 v" + currentV),
          channel ? h("span", { className: "dru-ver-chip", title: "当前更新通道：" + channel }, "通道 " + updateChannelText(channel)) : null,
          chk === null && chkBusy ? h("span", { className: "dru-meta", style: { margin: 0 } }, "（检查新版本中…）") : null,
          chk && outdated
            ? h("span", { className: "dru-ver-badge dru-ver-badge-new" }, "发现新版本 v" + chk.latest)
            : chk && !outdated ? h("span", { className: "dru-ver-badge dru-ver-badge-ok" }, "已是最新版本") : null
        ),
        h("div", { className: "dru-meta" },
          runtimeReady === false
            ? "⚠ 后台服务运行环境缺失（点下方「一键更新」会自动补齐并启动，不用手动装）"
            : runtimeReady === true ? "后台服务运行环境正常" : "正在读取运行环境…"
        ),
        // ② 更新进行中：进度指标（已用时 / 距上次输出）+ 卡住告警（0.6.9 看门狗冻结契约）
        updating || progRunning
          ? h("div", { className: "dru-ver-metrics", role: "status" },
              h("div", { className: "dru-ver-metric" },
                h("span", null, "更新状态"),
                h("span", null, h("span", { className: "dru-spin", "aria-hidden": "true" }), " 正在进行")
              ),
              h("div", { className: "dru-ver-metric" }, h("span", null, "已用时"), h("span", null, fmtDuration(elapsedShown))),
              h("div", { className: "dru-ver-metric" },
                h("span", null, "距上次输出"),
                h("span", null, idleShown < 1500 ? "刚刚" : fmtDuration(idleShown))
              ),
              channel ? h("div", { className: "dru-ver-metric" }, h("span", null, "更新通道"), h("span", null, channel)) : null
            )
          : null,
        stalled
          ? h("div", { className: "dru-stall", role: "alert" },
              h("b", null, "疑似卡住"),
              "（已 " + Math.round(idleShown / 1000) + " 秒无输出），正在自动换源重试…",
              "已经等了 " + fmtDuration(elapsedShown) + "；若长时间没有变化，可点下方「取消并重试」。",
              cancelOk === false
                ? h("div", { style: { marginTop: 6 } },
                    "当前插件版本还不支持一键取消：可刷新页面；若仍卡在「正在更新」，重启一次 dsh web 后重新点「一键更新」即可。")
                : null
            )
          : idleHint
            ? h("div", { className: "dru-hint", style: { marginTop: 8 } },
                "已 " + Math.round(idleShown / 1000) + " 秒没有新输出（总计 " + fmtDuration(elapsedShown) + "）：安装过程偶尔会安静一会儿，超过 " + Math.round(cancelAfterMs / 1000) + " 秒没变化会出现「取消并重试」。")
            : null,
        // ③ 操作区（主操作 / 检查 / 取消并重试 / 彻底卸载）
        h("div", { className: "dru-actions", style: { marginTop: 10 } },
          outdated
            ? h("button", { type: "button", className: "dru-btn dru-btn-primary", disabled: upBusy || unBusy || chkBusy || updating, onClick: doUpdate },
                upBusy ? "更新启动中…" : updating ? "正在更新…" : "一键更新到 v" + chk.latest)
            : h("button", { type: "button", className: "dru-btn dru-btn-ghost", disabled: upBusy || unBusy || chkBusy || updating, onClick: doUpdate },
                updating ? "正在更新…" : (ver && !ver.runtimeReady) ? "安装并启动（一键修复）" : "重新检查 / 修复"),
          h("button", { type: "button", className: "dru-btn dru-btn-ghost", disabled: chkBusy || updating || upBusy, onClick: doCheck }, chkBusy ? "检查中…" : "检查更新"),
          canCancel
            ? h("button", {
                type: "button",
                className: "dru-btn dru-btn-danger",
                disabled: cxBusy || upBusy,
                title: "结束卡住的更新进程并清除更新标记，然后重新开始一次",
                onClick: function () { doCancelUpdate(true); }
              }, cxBusy ? "取消中…" : "取消并重试")
            : null,
          h("button", {
            type: "button",
            className: "dru-btn dru-btn-danger",
            style: { marginLeft: "auto" },
            disabled: unBusy || updating || upBusy,
            onClick: doUninstall
          }, unBusy ? "卸载中…" : armed ? "⚠ 再点一次确认彻底卸载" : "彻底卸载")
        ),
        cxMsg ? h("div", { className: "dru-msg dru-msg-" + cxMsg.kind }, cxMsg.text) : null,
        updated
          ? h("div", { className: "dru-msg dru-msg-ok" },
              "✅ 更新已完成，最新代码已就位。请", h("strong", null, "重启 dsh web"), "后生效；后台服务会随系统自启自动运行新版本。")
          : null,
        // ④ 更新日志（失败时同样靠近上面的错误提示）
        log ? h("div", { className: "dru-up-log", title: "更新日志（尾部）" }, log) : null,
        selfMsg ? h("div", { className: "dru-msg dru-msg-" + selfMsg.kind }, selfMsg.text) : null,
        h("div", { className: "dru-hint", style: { marginTop: 8 } },
          armed ? "⚠ 再次点击后即开始彻底卸载：① 移除 dsh web 配置中的插件引用与本地文件；② 停止并移除 bridge 自启动服务（即让「后台服务」不再开机自启：macOS com.dshremote.bridge / Linux dsh-bridge / Windows 任务计划程序 dsh-remote-bridge）并结束残留进程；③ 清空本地配置目录（~/.dsh-remote：账号、设备密钥、固化运行时等）。此操作不可撤销，如需再次使用：在插件市场搜索「dsh-remote-web」重新安装，或执行 npx @mrrisega/dsh-remote。" :
            "检测新版、一键在线更新、彻底卸载都在本卡片完成；更新卡住时会出现「取消并重试」。")
      );
    }

    // ── 端到端加密（E2EE，Phase-5）：bridge 状态 → 可读文案映射 ─────────────
    // bridge 启停时把开关结果写入 <relayDir>/.e2ee-state.json（{enabled,reason,profile,epoch,caps}，
    // 见 clients/dsh-remote/e2ee-client.mjs），node 半随 /dsh-remote/status 以 service.e2ee 下发；
    // 此处只做“可读文案”映射（协议 docs/e2ee-protocol.md §2.3/§7.3）。
    var E2EE_DISABLED_COPY = {
      server_disabled: "端到端加密暂不可用（当前为普通安全连接 HTTPS）",
      params_unreachable: "当前为普通安全连接（HTTPS）",
      disabled_by_config: "当前为普通安全连接（HTTPS）",
      derive_failed: "账号密码已变更，需在「🔑 账号」重新登录后恢复端到端加密（当前为普通安全连接（HTTPS））",
    };
    var E2EE_DISABLED_FALLBACK = "当前为普通安全连接（HTTPS）";
    /** 把 service.e2ee 归一化为可读状态行；e2ee 缺失/旧 host 未下发 → null（不打扰）。 */
    function describeE2ee(e2ee) {
      if (!e2ee || typeof e2ee !== "object") return null;
      if (e2ee.enabled === true) return { kind: "ok", text: "🔒 端到端加密已启用（手机解锁后生效）" };
      var reason = typeof e2ee.reason === "string" && e2ee.reason ? e2ee.reason : "";
      var text = E2EE_DISABLED_COPY[reason] || E2EE_DISABLED_FALLBACK; // reason 未知 → 兜底
      return { kind: "off", text: text };
    }

    // ── 面板主体（渲染于设置页 settings.section 栏目内） ─────────────────────
    // 匿名装机统计的「面板打开」只上报一次/每页（node 半还会每进程去重）。
    var panelOpenedSent = false;
    function RemoteControlSection(props) {
      // 🎨 主题（宿主深色/亮色）：订阅外部存储 → 宿主切换时本组件自动重渲染，
      // 根节点上的 data-dru-theme 随之更新，整套 --dru-* 令牌实时切换。
      // 放在全部 useState 之前：不改变既有 hook 序号（useSyncExternalStore 与 useState 各自计数）。
      var theme = useSyncExternalStore(themeSubscribe, themeGet);

      var statusArr = useState(null); var st = statusArr[0]; var setSt = statusArr[1];
      var modeArr = useState("saas"); var mode = modeArr[0]; var setMode = modeArr[1];   // saas | local
      var viewArr = useState("home"); var view = viewArr[0]; var setView = viewArr[1];   // home | feedback | invite | wechat
      var busyArr = useState(""); var busy = busyArr[0]; var setBusy = busyArr[1];
      var msgArr = useState(null); var message = msgArr[0]; var setMessage = msgArr[1];
      // 注：邀请区复制反馈已迁到 viewstate 末端的 inviteCopied（0.6.9）；这个 hook 保留占位，
      // 避免后续所有 hook 序号前移（本组件大量 useCallback/useEffect 依赖稳定序号）。
      var copiedArr = useState(false); var copied = copiedArr[0]; var setCopied = copiedArr[1];

      // 我的信息(个人中心)数据
      var acctArr = useState(null); var account = acctArr[0]; var setAccount = acctArr[1];
      var quotaArr = useState(null); var quota = quotaArr[0]; var setQuota = quotaArr[1];
      var inviteArr = useState(null); var inviteData = inviteArr[0]; var setInviteData = inviteArr[1];
      var pubArr = useState(null); var pub = pubArr[0]; var setPub = pubArr[1];

      // 登录表单字段
      var phoneArr = useState(""); var phone = phoneArr[0]; var setPhone = phoneArr[1];
      var passArr = useState(""); var pass = passArr[0]; var setPass = passArr[1];
      var lcapArr = useState(null); var lcap = lcapArr[0]; var setLcap = lcapArr[1]; // {id, svg}
      var lcapTxtArr = useState(""); var lcapTxt = lcapTxtArr[0]; var setLcapTxt = lcapTxtArr[1];
      // 注册表单字段
      var rphoneArr = useState(""); var rphone = rphoneArr[0]; var setRphone = rphoneArr[1];
      var rpassArr = useState(""); var rpass = rpassArr[0]; var setRpass = rpassArr[1];
      var rpass2Arr = useState(""); var rpass2 = rpass2Arr[0]; var setRpass2 = rpass2Arr[1];
      var rsmsArr = useState(""); var rsms = rsmsArr[0]; var setRsms = rsmsArr[1];
      var rsmsBtnArr = useState("获取验证码"); var rsmsBtn = rsmsBtnArr[0]; var setRsmsBtn = rsmsBtnArr[1];
      var rcapArr = useState(null); var rcap = rcapArr[0]; var setRcap = rcapArr[1];
      var rcapTxtArr = useState(""); var rcapTxt = rcapTxtArr[0]; var setRcapTxt = rcapTxtArr[1];
      var rInviteArr = useState(""); var rInvite = rInviteArr[0]; var setRInvite = rInviteArr[1];
      // 注册 tab(登录/注册)
      var authTabArr = useState("login"); var authTab = authTabArr[0]; var setAuthTab = authTabArr[1];

      // 自建服务表单字段
      var shArr = useState(""); var selfHost = shArr[0]; var setSelfHost = shArr[1];
      var lkArr = useState(""); var localKey = lkArr[0]; var setLocalKey = lkArr[1];

      // ── 📱 远程访问卡（一次性访问密钥 + 已授权设备管理）——放在全部既有字段之后，保持既有 hook 序号 ──
      var akeyArr = useState(null); var akey = akeyArr[0]; var setAkey = akeyArr[1];             // {url,key,expires_at,ttl_ms,qr_data_url}
      var akeyBusyArr = useState(false); var akeyBusy = akeyBusyArr[0]; var setAkeyBusy = akeyBusyArr[1];
      var akeyMsgArr = useState(null); var akeyMsg = akeyMsgArr[0]; var setAkeyMsg = akeyMsgArr[1]; // {kind,text}
      var nowTickArr = useState(function () { return Date.now(); }); var nowTick = nowTickArr[0]; var setNowTick = nowTickArr[1];
      var copiedKeyArr = useState(false); var copiedKey = copiedKeyArr[0]; var setCopiedKey = copiedKeyArr[1];
      var devSessArr = useState(null); var devSessions = devSessArr[0]; var setDevSessions = devSessArr[1]; // null=未加载
      var devOpenArr = useState(false); var devOpen = devOpenArr[0]; var setDevOpen = devOpenArr[1];
      var devBusyArr = useState(""); var devBusy = devBusyArr[0]; var setDevBusy = devBusyArr[1];
      var devMsgArr = useState(null); var devMsg = devMsgArr[0]; var setDevMsg = devMsgArr[1];
      var armedDevArr = useState(null); var armedDev = armedDevArr[0]; var setArmedDev = armedDevArr[1]; // 待二次确认的 session id（取消配对）
      var armedDelArr = useState(null); var armedDel = armedDelArr[0]; var setArmedDel = armedDelArr[1]; // 待二次确认的 session id（删除记录）
      var purgeArmedArr = useState(false); var purgeArmed = purgeArmedArr[0]; var setPurgeArmed = purgeArmedArr[1]; // 清理已解绑二次确认
      // ── 🔒 修改密码（已登录 SaaS，短信重置）状态：放在全部既有字段之后，保持既有 hook 序号 ──
      // 成功后企业端使该账号全部授权设备/会话失效（含 E2EE 派生口令）→ 本地登出、用新密码重新登录。
      var pwdOpenArr = useState(false); var pwdOpen = pwdOpenArr[0]; var setPwdOpen = pwdOpenArr[1];   // 小表单展开
      var pwdCapArr = useState(null); var pwdCap = pwdCapArr[0]; var setPwdCap = pwdCapArr[1];          // {id,svg} 图形验证码
      var pwdCapTxtArr = useState(""); var pwdCapTxt = pwdCapTxtArr[0]; var setPwdCapTxt = pwdCapTxtArr[1];
      var pwdSmsArr = useState(""); var pwdSms = pwdSmsArr[0]; var setPwdSms = pwdSmsArr[1];
      var pwdSmsBtnArr = useState("获取验证码"); var pwdSmsBtn = pwdSmsBtnArr[0]; var setPwdSmsBtn = pwdSmsBtnArr[1];
      var pwdNewArr = useState(""); var pwdNew = pwdNewArr[0]; var setPwdNew = pwdNewArr[1];            // 新密码（≥8）
      // ── 💬 交流群（「加入交流群」按钮 + 弹窗）：同样放在全部既有字段之后 ──
      var communityArr = useState(null); var community = communityArr[0]; var setCommunity = communityArr[1]; // {qrcode,wechat}；null=未加载
      var commOpenArr = useState(false); var commOpen = commOpenArr[0]; var setCommOpen = commOpenArr[1];
      // 【自动化】重启倒计时 / 是否已被用户取消(初值按本次 pending 事件的持久化标记,跨刷新生效)
      var restartCancelArr = useState(function () { return autoRestartCancelled((st && st.restart && st.restart.at) || 0); });
      var restartCancelled = restartCancelArr[0]; var setRestartCancelled = restartCancelArr[1];
      var restartCountArr = useState(null); var restartCountdown = restartCountArr[0]; var setRestartCountdown = restartCountArr[1];
      // ── 🔗 登录后自动闭环：连接阶段（运行环境 → bridge 进程 → 设备已在中继注册=online） ──
      // conn 来自 GET /dsh-remote/bridge-status（node 半在返回前会自动补装/拉起/退避重试），
      // 面板据它显示「正在准备运行环境…/正在启动 Bridge…/正在连接中继…/已连接 ✅」，
      // 并用短轮询自动推进到 online —— 用户不需要点按钮、也不需要刷新页面。
      var connArr = useState(null); var conn = connArr[0]; var setConn = connArr[1];
      var copiedDiagArr = useState(false); var copiedDiag = copiedDiagArr[0]; var setCopiedDiag = copiedDiagArr[1];

      // ── 🎁 邀请视图（带新用户换会员）状态：放在全部既有字段之后，保持既有 hook 序号不变 ──
      var invLoadArr = useState(false); var inviteLoading = invLoadArr[0]; var setInviteLoading = invLoadArr[1]; // 记录/规则读取中
      var invErrArr = useState(null); var inviteErr = invErrArr[0]; var setInviteErr = invErrArr[1];             // 记录读取失败原因（≠空记录）
      var invRulesArr = useState(false); var inviteRulesOpen = invRulesArr[0]; var setInviteRulesOpen = invRulesArr[1]; // 活动规则默认折叠
      var invCopyArr = useState(""); var inviteCopied = invCopyArr[0]; var setInviteCopied = invCopyArr[1];      // "" | "code" | "link"（复制成功反馈）
      var invCopyErrArr = useState(null); var inviteCopyErr = invCopyErrArr[0]; var setInviteCopyErr = invCopyErrArr[1]; // 复制失败原因（就近提示）
      // 🎁 邀请收益引导气泡的「已关闭」态（同样追加在末尾，不动既有 hook 序号）。
      // 初值直接读 localStorage：已关闭过就不再出现，不闪一下再消失。
      var tipDismissedArr = useState(inviteTipWasDismissed()); var inviteTipDismissed = tipDismissedArr[0]; var setInviteTipDismissed = tipDismissedArr[1];
      // 🧰 营销入口的「已收纳」态（同样追加在末尾，不动既有 hook 序号）：
      //   初值 = 新键已记住 **或** 老用户早就关过邀请气泡 —— 老键含义不变（仍是「气泡已关」），
      //   只是它同样表达了「用户已经看到并关掉了」，据此把两个营销入口收进「更多」；
      //   老用户不会因为这次改版又被打扰一遍，新用户（没关过）照旧看得见两个入口。
      var mktFoldArr = useState(mktMoreWasFolded() || inviteTipWasDismissed()); var mktFolded = mktFoldArr[0]; var setMktFolded = mktFoldArr[1];
      // 「更多」这一层当前是否展开：纯界面态，不持久化（下次进面板回到收起，主界面保持干净）。
      var moreOpenArr = useState(false); var moreOpen = moreOpenArr[0]; var setMoreOpen = moreOpenArr[1];

      var refresh = useCallback(function () {
        setBusy("status");
        api("/dsh-remote/status").then(function (body) {
          setSt(body);
          setMode(body && body.config && body.config.mode === "local" ? "local" : "saas");
          setMessage(null);
        }).catch(function (e) { setMessage({ kind: "err", text: "读取状态失败: " + e.message }); })
          .finally(function () { setBusy(""); });
      }, []);

      function loadCaptcha(kind) {
        var setCap = kind === "login" ? setLcap : setRcap;
        setCap({ id: null, svg: '<span class="dru-hint">加载中</span>' });
        fetch("/dsh-remote/captcha").then(function (r) {
          return r.text().then(function (text) {
            if (!r.ok) throw new Error("http " + r.status);
            var body = null; try { body = JSON.parse(text); } catch (e) { body = null; }
            if (body && body.captcha_id) setCap({ id: body.captcha_id, svg: body.svg || "" });
            else if (body && body.svg) setCap({ id: null, svg: body.svg });
            else setCap({ id: null, svg: null });
          });
        }).catch(function () { setCap({ id: null, svg: null }); });
      }

      var loggedIn = !!(st && st.config && (st.config.phone || st.config.hasLocalKey));
      var serviceRunning = !!(st && st.service && st.service.running);
      // 0.6.2：运行环境是否就绪 + launchd 是否处于崩溃循环（入口脚本缺失导致的 KeepAlive 重拉）。
      // 旧版把「作业在 launchd 里但进程秒退」显示成「运行中」，用户完全看不出问题在哪。
      var serviceRuntimeReady = !(st && st.service && st.service.runtimeReady === false);
      var serviceLaunchd = (st && st.service && st.service.launchd) || {};
      var serviceCrashing = !!serviceLaunchd.crashing;
      var serviceStateText = !st ? "查询中…"
        : serviceRunning ? "运行中"
        : serviceCrashing ? "启动失败（已自动转入修复）"
        : !serviceRuntimeReady ? "运行环境安装中…"
        : "已停止";
      // 是否需要重启 DeepSeek harness（首次安装/在线更新后置顶提醒 + 底部常驻按钮）
      var restartInfo = (st && st.restart) || {};
      var restartPending = !!restartInfo.pending;
      // kind === "refresh" = 插件文件在运行中被改写(装完/更新完),只需刷新页面;
      // 其余情况(极为罕见)才提重启 dsh web。
      var isRefreshOnly = restartPending && restartInfo.kind === "refresh";
      // 连接阶段（node 半下发）：轮询拿到的新鲜结果优先，其次用 /status 里带的那一份；
      // 旧版 host（响应里没有 connect 字段）→ 回退到原来的 service.running 文案（行为不变）。
      var connInfo = conn || (st && st.connect) || null;
      var connPhase = (connInfo && connInfo.phase) || "";
      var connOnline = connPhase === "online";
      var connText = (connInfo && connInfo.text) || "";
      var connError = connInfo && connInfo.error ? connInfo.error : null;
      // 账号标识（掩码手机号）：登录成功/换账号时变化 → 触发上方的重取 effect（比布尔 loggedIn 更敏感）
      var phoneKey = (st && st.config && st.config.phone) || "";
      var launchdPid = st && st.service && st.service.launchd && st.service.launchd.pid;

      // 已登录(SaaS)→ 拉我的信息/配额/公共配置
      useEffect(function () {
        if (!(st && st.config && st.config.phone)) return;
        api("/dsh-remote/account").then(function (b) { if (b && b.ok) setAccount(b.account); }).catch(function () {});
        api("/dsh-remote/quota").then(function (b) { if (b && b.ok) setQuota(b.quota); }).catch(function () {});
        api("/dsh-remote/remote-url").then(function (b) { if (b && b.ok && b.publicConfig) setPub(b.publicConfig); }).catch(function () {});
      }, [st && st.config && st.config.phone]);

      useEffect(function () { refresh(); }, [refresh]);

      // 交流群二维码(后台上传即可展示;未配置 → community.qrcode 为空,入口不出现)
      useEffect(function () {
        var alive = true;
        loadCommunity().then(function (d) { if (alive) setCommunity(d); });
        return function () { alive = false; };
      }, []);
      useEffect(function () {
        // 展开「忘记密码」重置表单时不用预载登录表单验证码（收起的 reset 表单用独立 pwdCap）
        if (st !== null && !loggedIn && mode === "saas" && authTab === "login" && !pwdOpen && !lcap) loadCaptcha("login");
      }, [st, loggedIn, mode, authTab, pwdOpen, lcap]);

      // ── 📱 远程访问卡：常量 / 轮询 / 一次性访问密钥 / 已授权设备 ─────────────────
      var KEY_AUTO_REFRESH_MS = 25000;  // 停留栏目时约每 25s 自动轮换一把新的一次性密钥（防已用/过期）
      var STATUS_POLL_MS = 30000;       // 连接状态行轮询间隔(审计降频:原 5s→30s;页面隐藏时暂停)

      /** 轻量状态轮询：只更新 st，不改 mode（mode 由用户 Tab 选择决定，避免轮询把自建/云端来回切）。 */
      function pollStatus() {
        if (document.hidden) return; // 页面隐藏时不空转(审计:降低请求频率)
        api("/dsh-remote/status").then(function (body) {
          if (!body || !body.ok) return;
          setSt(body);
        }).catch(function () {});
      }

      // 时间工具（兼容 epoch 毫秒 / ISO 字符串 / 数字字符串）
      function toMs(ts) {
        if (ts === null || ts === undefined || ts === "") return 0;
        var n = Number(ts);
        if (String(ts).trim() !== "" && isFinite(n)) return n;
        var d = new Date(ts);
        return isNaN(d.getTime()) ? 0 : d.getTime();
      }
      function pad2(n) { return String(n).padStart(2, "0"); }
      function fmtClock(ts) {
        var ms = toMs(ts);
        if (!ms) return "--:--:--";
        var d = new Date(ms);
        if (isNaN(d.getTime())) return "--:--:--";
        return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
      }
      function fmtRemain(ms) {
        var s = Math.max(0, Math.floor((ms || 0) / 1000));
        var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        return (h > 0 ? pad2(h) + ":" : "") + pad2(m) + ":" + pad2(sec);
      }
      function fmtDT(ts) {
        var ms = toMs(ts);
        if (!ms) return "—";
        var d = new Date(ms);
        if (isNaN(d.getTime())) return "—";
        return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
      }

      /**
       * 创建（或刷新）一次性访问密钥：GET /dsh-remote/access-key（node 半转发企业端 /api/auth-key）。
       * 失败自愈：中继未就绪类失败（node 半 retryable / 网络 / 5xx）按退避自动重试，
       * 见「登录后首次加载自愈」——首次安装立即登录时不再需要手动刷新页面。
       */
      function loadAccessKey() {
        if (akeyInFlight.v) return;
        // 登录前不请求企业端（避免 401/404 噪音）；由账号登录成功后触发
        if (!(st && st.config && st.config.phone)) {
          setAkeyMsg(null);
          cancelAkeyRetry();
          return;
        }
        akeyInFlight.v = true;
        setAkeyBusy(true);
        api("/dsh-remote/access-key").then(function (b) {
          if (!b || !b.ok) {
            var why = (b && (b.error || (b.body && b.body.error))) || "未知错误";
            var e = new Error(why); e.body = b || null;
            throw e;
          }
          // 契约容错：url 必须有；qr_data_url 取不到时仍展示链接/复制/直接打开
          if (!b.url) {
            setAkeyMsg({ kind: "err", text: "获取一次性访问地址失败：企业端未返回可用链接" });
            return;
          }
          setAkey({
            url: b.url || "",
            key: b.key != null ? b.key : null,
            expires_at: b.expires_at != null ? b.expires_at : null,
            ttl_ms: b.ttl_ms != null ? b.ttl_ms : null,
            qr_data_url: b.qr_data_url != null ? b.qr_data_url : null
          });
          setAkeyMsg(null);
          akeyRetry.attempt = 0;
        }).catch(function (e) {
          var text = "获取一次性访问地址失败：" + e.message;
          if (retryableFail(e) && akeyRetry.attempt < LOGIN_LOAD_RETRY_MS.length) {
            scheduleAkeyRetry(text);
            return;
          }
          // 自动重试额度用尽（或不该重试）→ 红字 + 「立即重试」入口，不让用户只能刷新页面
          setAkeyMsg({ kind: "err", text: text, retry: retryAkeyManually });
        }).finally(function () { akeyInFlight.v = false; setAkeyBusy(false); });
      }

      var copyKeyUrl = function () {
        if (!(akey && akey.url)) return;
        // 统一走 copyText：剪贴板不可用（http 非安全上下文）时退回 execCommand；都失败就给一句人话
        copyText(akey.url).then(function (done) {
          if (!done) {
            setAkeyMsg({ kind: "err", text: "复制失败：浏览器可能限制了剪贴板权限，请手动选中上面的链接复制。" });
            return;
          }
          setCopiedKey(true);
          later(function () { setCopiedKey(false); }, 2000);
        });
      };
      /** 「直接打开」：浏览器新标签打开一次性访问地址（打开即扫码/点击进入）。 */
      var openKeyUrl = function () {
        if (!(akey && akey.url)) return;
        try { window.open(akey.url, "_blank", "noopener"); } catch (e) {}
      };

      /** 加载已授权设备列表：GET /dsh-remote/mobile-sessions（失败同上：可重试类自动重试）。 */
      function loadDevices() {
        if (devInFlight.v || devBusy !== "") return;
        devInFlight.v = true;
        setDevBusy("list");
        api("/dsh-remote/mobile-sessions").then(function (b) {
          if (!b || !b.ok) throw new Error((b && b.error) || "加载已授权设备失败");
          setDevSessions(Array.isArray(b.sessions) ? b.sessions : []);
          setDevMsg(null);
          devRetry.attempt = 0;
        }).catch(function (e) {
          var text = "加载已授权设备失败：" + e.message;
          if (retryableFail(e) && devRetry.attempt < LOGIN_LOAD_RETRY_MS.length) {
            scheduleDevRetry(text);
            return;
          }
          setDevMsg({ kind: "err", text: text, retry: retryDevicesManually });
        }).finally(function () { devInFlight.v = false; setDevBusy(""); });
      }
      /** 手动重试（红字旁的「重试」按钮）：重置退避计数后立即重新拉取。 */
      var retryAkeyManually = function () {
        cancelAkeyRetry();
        akeyRetry.attempt = 0;
        setAkeyMsg(null);
        loadAccessKey();
      };
      var retryDevicesManually = function () {
        cancelDevRetry();
        devRetry.attempt = 0;
        setDevMsg(null);
        loadDevices();
      };
      /** 定时重试一次性访问密钥（黄字提示 + 退避；成功时由 loadAccessKey 清掉提示）。 */
      function scheduleAkeyRetry(why) {
        cancelAkeyRetry();
        var wait = LOGIN_LOAD_RETRY_MS[akeyRetry.attempt] || LOGIN_LOAD_RETRY_MS[LOGIN_LOAD_RETRY_MS.length - 1];
        akeyRetry.attempt += 1;
        setAkeyMsg({
          kind: "warn",
          text: "中继连接尚未就绪，" + Math.round(wait / 1000) + " 秒后自动重试（第 " + akeyRetry.attempt + "/" + LOGIN_LOAD_RETRY_MS.length + " 次）：" + why,
          retry: retryAkeyManually
        });
        akeyRetry.timer = later(function () {
          akeyRetry.timer = null;
          loadAccessKey(); // 在途标记由上一个请求的 finally 释放，退避窗口内用户也可手动刷新
        }, wait);
      }
      /** 定时重试已授权设备列表（同上）。 */
      function scheduleDevRetry(why) {
        cancelDevRetry();
        var wait = LOGIN_LOAD_RETRY_MS[devRetry.attempt] || LOGIN_LOAD_RETRY_MS[LOGIN_LOAD_RETRY_MS.length - 1];
        devRetry.attempt += 1;
        setDevMsg({
          kind: "warn",
          text: "中继连接尚未就绪，" + Math.round(wait / 1000) + " 秒后自动重试（第 " + devRetry.attempt + "/" + LOGIN_LOAD_RETRY_MS.length + " 次）：" + why,
          retry: retryDevicesManually
        });
        devRetry.timer = later(function () {
          devRetry.timer = null;
          loadDevices();
        }, wait);
      }
      /** 操作（取消配对/删除记录/清理已解绑）成功后静默重拉列表，覆盖行内状态。 */
      function refreshDeviceList() {
        api("/dsh-remote/mobile-sessions").then(function (b) {
          if (b && b.ok) setDevSessions(Array.isArray(b.sessions) ? b.sessions : []);
        }).catch(function () {});
      }

      var toggleDevices = function () {
        var next = !devOpen;
        setDevOpen(next);
        if (next && devSessions === null && devBusy === "") loadDevices();
        if (!next) { setArmedDev(null); setArmedDel(null); setPurgeArmed(false); }
      };

      /** 取消配对：先点一次进入确认态，再点一次才 POST revoke（同 SelfManageCard 二次确认风格）。 */
      var doRevokeDevice = function (id) {
        if (!id) return;
        if (armedDev !== id) { setArmedDev(id); setArmedDel(null); setPurgeArmed(false); return; }
        setDevBusy("revoke:" + id);
        post("/dsh-remote/mobile-sessions/revoke", { id: id }).then(function (b) {
          if (!b || !b.ok) throw new Error((b && (b.error || (b.body && b.body.error))) || "取消失败");
          setArmedDev(null);
          setDevMsg({ kind: "ok", text: "已取消，对方需重新扫码/登录" });
          refreshDeviceList();
        }).catch(function (e) {
          setArmedDev(null);
          setDevMsg({ kind: "err", text: "取消配对失败：" + e.message });
        }).finally(function () { setDevBusy(""); });
      };

      /**
       * 删除设备记录：任意行（含已取消/历史）都可用，整行删除并拉黑 jti——
       * DELETE /dsh-remote/mobile-sessions/delete（body {id} → 企业端 DELETE /api/mobile-sessions/:id）。
       * 先点一次进入确认态，再点一次才发请求。
       */
      var doDeleteDevice = function (id) {
        if (!id) return;
        if (armedDel !== id) { setArmedDel(id); setArmedDev(null); setPurgeArmed(false); return; }
        setDevBusy("delete:" + id);
        api("/dsh-remote/mobile-sessions/delete", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: id })
        }).then(function (b) {
          if (!b || !b.ok) throw new Error((b && (b.error || (b.body && b.body.error))) || "删除失败");
          setArmedDel(null);
          setDevMsg({ kind: "ok", text: "已删除该设备的记录" });
          refreshDeviceList();
        }).catch(function (e) {
          setArmedDel(null);
          setDevMsg({ kind: "err", text: "删除记录失败：" + e.message });
        }).finally(function () { setDevBusy(""); });
      };

      /**
       * 清理已解绑：删除本人全部 revoked 行——POST /dsh-remote/mobile-sessions/purge（企业端 purge）。
       * 先点一次进入确认态，再点一次才发请求；成功后刷新列表并提示清理条数。
       */
      var doPurgeDevices = function () {
        if (!purgeArmed) { setPurgeArmed(true); setArmedDev(null); setArmedDel(null); return; }
        setDevBusy("purge");
        post("/dsh-remote/mobile-sessions/purge", {}).then(function (b) {
          if (!b || !b.ok) throw new Error((b && (b.error || (b.body && b.body.error))) || "清理失败");
          setPurgeArmed(false);
          var n = b.removed != null ? Number(b.removed) : 0;
          setDevMsg({ kind: "ok", text: n > 0 ? ("已清理 " + n + " 条已解绑记录") : "已清理全部已解绑记录" });
          refreshDeviceList();
        }).catch(function (e) {
          setPurgeArmed(false);
          setDevMsg({ kind: "err", text: "清理失败：" + e.message });
        }).finally(function () { setDevBusy(""); });
      };

      /** 升级/续费带登录态打开：取一次性访问 url，改写为 /app/promo?auth=… 后在手机端进入续费页。 */
      var openUpgradeAuth = function () {
        setBusy("upgrade");
        api("/dsh-remote/access-key").then(function (b) {
          if (!b || !b.ok || !b.url) throw new Error((b && b.error) || "生成访问链接失败");
          var promo = promoUrlOf(b.url);
          try { window.open(promo, "_blank", "noopener"); } catch (e2) {}
          setMsg("ok", "✅ 升级/续费页已在新标签页打开（带登录态）");
        }).catch(function (e) {
          setMsg("err", "打开升级/续费页失败：" + e.message);
        }).finally(function () { setBusy(""); });
      };

      // 停留主视图（home）时：轮询连接状态(15s,审计降频) + 每秒刷新倒计时;隐藏暂停、回前台立即刷新
      useEffect(function () {
        if (view !== "home") return;
        var pollIv = setInterval(function () { pollStatus(); }, STATUS_POLL_MS);
        var tickIv = setInterval(function () { setNowTick(Date.now()); }, 1000);
        var visFn = function () { if (!document.hidden) pollStatus(); };
        document.addEventListener("visibilitychange", visFn);
        return function () {
          clearInterval(pollIv);
          clearInterval(tickIv);
          document.removeEventListener("visibilitychange", visFn);
        };
      }, [view]);

      // 已登录云端主视图停留期间：打开即取一把新 key + 已授权设备；之后每 ~25s 自动轮换
      // （未登录不轮询，避免 401 空转；离开栏目/切视图/退出登录即清理定时器）
      //
      // 依赖里带上「账号」与「bridge 运行态」：登录成功（含换账号）与 bridge 拉起/重启后立即重取，
      // 首次安装后立即登录不再需要手动刷新页面；失败重试由 loadAccessKey/loadDevices 内部退避处理。
      useEffect(function () {
        if (view !== "home" || mode !== "saas" || !loggedIn) return undefined;
        cancelAkeyRetry(); cancelDevRetry();
        akeyRetry.attempt = 0; devRetry.attempt = 0;
        loadAccessKey();
        loadDevices();
        var rotateIv = setInterval(function () { loadAccessKey(); }, KEY_AUTO_REFRESH_MS);
        return function () {
          clearInterval(rotateIv);
          cancelAkeyRetry();
          cancelDevRetry();
        };
      }, [view, mode, loggedIn, phoneKey, serviceRunning]);

      // ── 匿名装机统计（面板打开） ──────────────────────────────────────────────
      // 只上报「面板被打开过」这一个事件名（node 半每进程去重、DSH_REMOTE_TELEMETRY=0 直接丢弃）；
      // 不含任何账号、手机号、设备指纹、会话内容或文件内容——隐私边界见 docs/telemetry.md。
      useEffect(function () {
        if (panelOpenedSent) return undefined;
        panelOpenedSent = true;
        post("/dsh-remote/telemetry/panel-opened", {}).catch(function () { /* 静默：统计失败绝不影响面板 */ });
        return undefined;
      }, []);

      // ── 登录后自动闭环（0.6.4）：连接阶段短轮询 ──────────────────────────────
      // 登录成功（含从别处已登录、被面板读到）后立刻开始推进连接，之后自调度：
      //   非 online → 2.5s 一次（阶段自动前进，用户零操作）；online → 15s 一次（退避，只做保活/新设备发现）。
      // 页面隐藏时 pollConnect 直接返回（不空转），回前台由 visibilitychange 立即补一次。
      // 依赖里只有「视图/模式/登录态」：阶段变化不重建定时器，避免每次推进都多发一次请求。
      useEffect(function () {
        if (view !== "home" || mode !== "saas" || !loggedIn) return undefined;
        var stopped = false;
        var timer = null;
        var tick = function () {
          if (stopped) return;
          clearLater(timer);
          timer = later(function () {
            timer = null;
            tick();
          }, connPhaseRef.v === "online" ? CONN_POLL_SLOW_MS : CONN_POLL_FAST_MS);
          pollConnect();
        };
        var onVisible = function () { if (!document.hidden && !stopped) pollConnect(); };
        try { document.addEventListener("visibilitychange", onVisible); } catch (e) { /* 环境无 document */ }
        if (!document.hidden) { pollConnect(); tick(); }
        return function () {
          stopped = true;
          clearLater(timer);
          try { document.removeEventListener("visibilitychange", onVisible); } catch (e) { /* 忽略 */ }
        };
      }, [view, mode, loggedIn]);

      // 🔒 微信机器人通道的登录门**兜底**（防御式）：第三个 tab 只在已登录时渲染，正常路径下
      // view 不可能停在 "wechat" 而人已登出。但会话可能**在微信 tab 开着的时候过期**（换账号/
      // 被踢下线/退出登录）—— 此时既不能继续渲染微信内容，更不能把用户丢在一个空面板上：
      // 立刻把 view 复位回 home（登录/账号卡就在那里）。
      // ⚠️ 必须是无条件调用的 hook（hook 序号稳定），所以判断写在回调里，不能围着它加 if。
      // 同一帧的兜底还有底部的 view 分派：signed-out 时它**直接渲染 home**，不会先闪一帧空白。
      useEffect(function () {
        if (view === "wechat" && !loggedIn) setView("home");
      }, [view, loggedIn]);

      /**
       * 连接阶段轮询：GET /dsh-remote/bridge-status（node 半在返回前自动补装运行环境 / 拉起 bridge /
       * 清理卡死标记，并自带退避），面板据此自动推进「准备运行环境 → 启动 Bridge → 连接中继 → 已连接」。
       * 关键点：
       *   - document.hidden 时完全不发请求（后台标签页不空转）；回前台由 visibilitychange 立即补一次；
       *   - 阶段推进到 online 时自动重取二维码与已授权设备列表 —— 用户不用刷新页面就能扫码。
       */
      function pollConnect() {
        if (document.hidden) return;
        if (connInFlight.v) return;
        connInFlight.v = true;
        api("/dsh-remote/bridge-status").then(function (b) {
          if (!b || !b.ok || !b.connect) return;
          connFailRef.v = 0; // 成功即清零：一次抖动不该把面板染红
          var prev = connPhaseRef.v;
          connPhaseRef.v = b.connect.phase || "";
          setConn(b.connect);
          if (b.connect.phase === "online") {
            // 已连接：立刻补一次二维码/设备列表（首次连上时 prev 不是 online → 无条件重取）
            if (prev !== "online") {
              akeyRetry.attempt = 0; devRetry.attempt = 0;
              loadAccessKey();
              loadDevices();
            } else if (devSessions !== null) {
              refreshDeviceList(); // 手机扫码后设备列表自动出现，无需刷新页面
            }
          }
        }).catch(function (e) {
          // 【0.6.7】原来这里是空 catch（"轮询失败静默：下一轮自动重试"）。在 Windows 上
          // node 半因 process.getuid 崩溃返回 500 时，这段静默让面板**永久**停在
          // 「查询中…」，用户完全无从判断（正是收到的那份诊断报告里的现象）。
          // 现在：连续失败到阈值就把原因摆到连接卡上，并提示可以直接重试。
          connFailRef.v += 1;
          if (connFailRef.v >= CONN_FAIL_VISIBLE) {
            setConn({
              phase: "error",
              online: false,
              text: "状态读取失败",
              detail: "本机状态接口连续 " + connFailRef.v + " 次请求失败："
                + ((e && e.message) ? e.message : String(e))
                + "（面板读不到后台服务状态，扫码/远程访问都不会推进）。可点「重试」，或刷新页面；若持续失败请把诊断信息发给客服。",
              error: { code: "status_unreachable", message: "无法读取本机后台服务状态（/dsh-remote/bridge-status 请求失败）" },
              retryable: true,
              attempts: connFailRef.v,
            });
          }
        })
          .finally(function () { connInFlight.v = false; });
      }

      /** 「重试」按钮：POST /dsh-remote/connect/retry（清退避 + 立刻再走一遍闭环），随后刷新阶段。 */
      var retryConnect = function () {
        setBusy("connect-retry");
        post("/dsh-remote/connect/retry").then(function (b) {
          if (b && b.connect) { connPhaseRef.v = b.connect.phase || ""; setConn(b.connect); }
          setMsg("ok", "已重新开始连接，正在自动重试…");
        }).catch(function (e) {
          setMsg("err", "重试失败：" + e.message);
        }).finally(function () { setBusy(""); });
      };

      /** 「复制诊断信息」：版本 / 配置目录 / 阶段 / 最近错误 / 进程状态 / 日志路径（node 半已拼好）。 */
      var copyDiagnostics = function () {
        var text = (connInfo && connInfo.diagnostics) || "";
        if (!text) return;
        copyText(text).then(function (done) {
          if (!done) {
            // 剪贴板不可用：文案里已给出日志路径，用户可自行查看
            setMsg("warn", "复制失败：浏览器可能限制了剪贴板权限；可展开下方日志路径自行查看。");
            return;
          }
          setCopiedDiag(true);
          later(function () { setCopiedDiag(false); }, 2000);
        });
      };

      function setMsg(kind, text) { setMessage({ kind: kind, text: text }); }

      // ---------- 登录(密码/短信) ----------
      var doLogin = function () {
        if (!phone.trim() || !pass) { setMsg("err", "请填写手机号与密码"); return; }
      /**
       * 账号落盘（POST /dsh-remote/config）后的统一提示。
       *
       * 为什么单独抽出来：这次"换账号后设备不出现"的事故就是**静默失败**造成的 ——
       * /config 会顺带重启 bridge（让新账号生效），但其返回的 bridgeRestart 前端从来不看，
       * 于是"服务没重启成功"和"一切正常"在界面上长得一模一样。
       */
      function applyAccountSaved(cfg, okText) {
        setSt(cfg);
        var br = cfg && cfg.bridgeRestart;
        if (br && br.ok === false && br.status !== "running" && br.status !== "provisioning" && br.status !== "skipped") {
          setMsg("warn", okText + "；但后台服务未能自动重启："
            + ((br.detail || br.status) || "未知原因")
            + " —— 新账号可能收不到这台设备，请点下方「重启服务」或重启一次 dsh web。");
          return;
        }
        setMsg("ok", okText);
      }

        if (!lcap || !lcap.id || !lcapTxt.trim()) { setMsg("err", "请输入图中验证码（点击图片可刷新）"); if (!lcap) loadCaptcha("login"); return; }
        var prevPhone = (st && st.config && st.config.phone) || "";
        setBusy("login");
        post("/dsh-remote/login", { phone: phone.trim(), password: pass, captcha_id: lcap.id, captcha_answer: lcapTxt.trim() })
          .then(function (body) {
            if (body.ok || body.status === 200) {
              return post("/dsh-remote/config", { phone: phone.trim(), password: pass }).then(function (cfg) {
                // 切换连接账号（手机号与之前不同）：清除旧账号留下的反馈线程凭据
                if (prevPhone !== phone.trim()) fbClearThreads();
                setPwdOpen(false); // 登录成功（可能从「忘记密码」返回）→ 收起重置表单
                setPass(""); setLcapTxt(""); setLcap(null);
                applyAccountSaved(cfg, "✅ 登录成功，账号已保存");
              });
            }
            var relayBody = body.body || {};
            var errText = (relayBody.error && relayBody.error.message) || body.error || ("登录失败(" + (body.status || "?") + ")");
            setMsg("err", String(errText));
            setLcapTxt(""); setLcap(null); loadCaptcha("login");
          })
          .catch(function (e) { setMsg("err", "登录失败: " + e.message); })
          .finally(function () { setBusy(""); });
      };

      var sendRegSms = function () {
        if (!/^1\d{10}$/.test(rphone.trim())) { setMsg("err", "请输入正确的手机号"); return; }
        if (rcap && (!rcap.id || !rcapTxt.trim())) { setMsg("err", "请输入图中验证码（点击图片可刷新）"); return; }
        setBusy("sms");
        post("/dsh-remote/sms-code", { phone: rphone.trim(), ...(rcap ? { captcha_id: rcap.id, captcha_answer: rcapTxt.trim() } : {}) })
          .then(function (body) {
            var testCode = body && (body.test_code || (body.body && body.body.test_code));
            setRcap(null); setRcapTxt("");
            if (testCode) setMsg("ok", "验证码已发送(测试码: " + testCode + ")");
            else setMsg("ok", "验证码已发送");
            var s = 60; setRsmsBtn(s + "s");
            var t = setInterval(function () { s--; if (s <= 0) { clearInterval(t); setRsmsBtn("获取验证码"); } else setRsmsBtn(s + "s"); }, 1000);
          })
          .catch(function (e) {
            var relayError = e.body && e.body.body && e.body.body.error;
            if (relayError && relayError.code === "captcha_invalid") {
              setRcapTxt(""); loadCaptcha("register");
              setMsg("err", "发送次数较多，请输入图中验证码后重试");
            } else setMsg("err", "发送失败: " + e.message);
          })
          .finally(function () { setBusy(""); });
      };

      var doRegister = function () {
        if (!/^1\d{10}$/.test(rphone.trim())) { setMsg("err", "请输入正确的手机号"); return; }
        if (!rsms.trim()) { setMsg("err", "请填写短信验证码"); return; }
        if (rpass.length < 8) { setMsg("err", "密码至少 8 位"); return; }
        if (rpass !== rpass2) { setMsg("err", "两次输入的密码不一致"); return; }
        setBusy("register");
        // reg_source：注册来源（增长口径）——面板内注册 = panel_register；
        // 手机端网页注册走 clients/dsh-web/native.html（= remoteweb_register）。
        // 节点半 /dsh-remote/register 全量透传 body，企业端白名单外的值会归一成 api_unknown。
        var regPayload = { phone: rphone.trim(), sms_code: rsms.trim(), password: rpass, reg_source: "panel_register" };
        var invite = rInvite.trim().toUpperCase();
        if (invite) regPayload.invite_code = invite;
        if (rcap) { regPayload.captcha_id = rcap.id; regPayload.captcha_answer = rcapTxt.trim(); }
        post("/dsh-remote/register", regPayload)
          .then(function (body) {
            if (body.ok || body.status === 201 || (body.body && body.body.token)) {
              return post("/dsh-remote/config", { phone: rphone.trim(), password: rpass }).then(function (cfg) {
                setPwdOpen(false);
                setRphone(""); setRpass(""); setRpass2(""); setRsms(""); setRcap(null); setRcapTxt(""); setRInvite("");
                applyAccountSaved(cfg, "✅ 注册成功，已自动登录");
              });
            }
            var b = body.body || {};
            setMsg("err", (b.error && b.error.message) || "注册失败(" + (body.status || "?") + ")");
          })
          .catch(function (e) { setMsg("err", "注册失败: " + e.message); })
          .finally(function () { setBusy(""); });
      };

      var doLogout = function (clearForm) {
        setBusy("logout");
        post("/dsh-remote/logout").then(function (body) {
          setSt(body); setAccount(null); setQuota(null);
          // 清空一次性访问密钥/二维码/授权设备等本地状态（退出后不得残留可见）
          setAkey(null); setAkeyMsg(null);
          // 退出登录：清除本机保存的用户反馈线程凭据（thread_token 见 FB_THREADS_KEY），
          // 反馈历史保留在服务端（按账号校验），账号身份变化后本机不再可见旧线程。
          fbClearThreads();
          setPwdOpen(false); // 退出登录后回到登录卡，收起重置/修改密码表单
          if (clearForm) { setPhone(""); setPass(""); setLcapTxt(""); setLcap(null); setRphone(""); setRpass(""); setRpass2(""); setRsms(""); setRsmsBtn("获取验证码"); setRcapTxt(""); setRcap(null); }
          setMessage(null);
        }).catch(function (e) { setMsg("err", "退出失败: " + e.message); })
          .finally(function () { setBusy(""); });
      };

      // ---------- 🔒 修改密码 / 忘记密码（共用：短信验证码重置；企业端公开 POST /api/password/reset） ----------
      // 图形验证码 + 短信验证码复用既有 /dsh-remote/captcha、/dsh-remote/sms-code 防刷路径；
      // 新密码 ≥8 位。成功后企业端使全部授权设备/会话失效（含 E2EE 派生口令）→ 本地登出，
      // 提示用新密码重新登录（登录成功会把新密码写回本地 config，覆盖旧口令并重建 E2EE 派生）。
      // 两处入口共用同一组字段/函数（pwdOpen/pwdCap/pwdCapTxt/pwdSms/pwdSmsBtn/pwdNew 与
      // togglePwdForm/sendPwdSms/doResetPwd/renderResetPwdForm，避免重复实现）：
      //   - 账号卡「🔒 修改密码」：fromLogin=false，手机号以当前登录账号为准（只读）；
      //   - 登录卡「忘记密码？」：fromLogin=true，手机号预填登录输入、可改；成功后请用新密码登录。
      var PWD_RESET_WARN = "修改后所有已授权设备/会话将失效，需重新登录与解锁";

      function pwdLoadCaptcha() {
        setPwdCap({ id: null, svg: '<span class="dru-hint">加载中</span>' });
        fetch("/dsh-remote/captcha").then(function (r) {
          return r.text().then(function (text) {
            if (!r.ok) throw new Error("http " + r.status);
            var body = null; try { body = JSON.parse(text); } catch (e) { body = null; }
            if (body && body.captcha_id) setPwdCap({ id: body.captcha_id, svg: body.svg || "" });
            else if (body && body.svg) setPwdCap({ id: null, svg: body.svg });
            else setPwdCap({ id: null, svg: null });
          });
        }).catch(function () { setPwdCap({ id: null, svg: null }); });
      }
      /** 展开/收起重置密码表单（账号卡「修改密码」与登录卡「忘记密码」共用开关）。 */
      var togglePwdForm = function () {
        var next = !pwdOpen;
        setPwdOpen(next);
        setMessage(null);
        if (next && !pwdCap) pwdLoadCaptcha();
      };
      /** 发送短信验证码（图形验证码防刷；captcha_invalid → 重载验证码提示重试）。ph 由调用方给出：
       * 账号卡=当前登录手机号；登录卡「忘记密码」=表单输入手机号。 */
      var sendPwdSms = function (ph) {
        ph = String(ph || "").trim();
        // 账号卡改密(隐私契约):phone 为空 = 由服务端取本机账号真号发码;仅当显式填了非法号才报错
        if (ph && !/^1\d{10}$/.test(ph)) { setMsg("err", "请输入正确的手机号"); return; }
        if (!pwdCap || !pwdCap.id || !pwdCapTxt.trim()) { setMsg("err", "请输入图中验证码（点击图片可刷新）"); return; }
        setBusy("pwd-sms");
        post("/dsh-remote/sms-code", { phone: ph, captcha_id: pwdCap.id, captcha_answer: pwdCapTxt.trim() })
          .then(function (body) {
            var testCode = body && (body.test_code || (body.body && body.body.test_code));
            setPwdCap(null); setPwdCapTxt(""); // 验证码一次性：发送后失效
            if (testCode) setMsg("ok", "验证码已发送(测试码: " + testCode + ")");
            else setMsg("ok", "验证码已发送");
            var s = 60; setPwdSmsBtn(s + "s");
            var t = setInterval(function () { s--; if (s <= 0) { clearInterval(t); setPwdSmsBtn("获取验证码"); } else setPwdSmsBtn(s + "s"); }, 1000);
          })
          .catch(function (e) {
            var relayError = e.body && e.body.body && e.body.body.error;
            if (relayError && relayError.code === "captcha_invalid") {
              setPwdCapTxt(""); pwdLoadCaptcha();
              setMsg("err", "发送次数较多，请输入图中验证码后重试");
            } else setMsg("err", "发送失败: " + e.message);
          })
          .finally(function () { setBusy(""); });
      };
      /**
       * 确认重置密码：POST /dsh-remote/password/reset → 成功后本地登出，提示用新密码登录。
       * @param {string} ph - 手机号（账号卡=当前登录账号；登录卡「忘记密码」=表单输入）。
       * @param {boolean} fromLogin - true=登录卡「忘记密码」；false=账号卡「修改密码」。
       */
      var doResetPwd = function (ph, fromLogin) {
        ph = String(ph || "").trim();
        if (ph && !/^1\d{10}$/.test(ph)) { setMsg("err", "请输入正确的手机号"); return; }
        if (!ph && fromLogin) { setMsg("err", "请输入正确的手机号"); return; } // 登录卡忘记密码必须显式填号
        if (!pwdSms.trim()) { setMsg("err", "请填写短信验证码"); return; }
        if (pwdNew.length < 8) { setMsg("err", "新密码至少 8 位"); return; }
        setBusy("pwd-reset");
        post("/dsh-remote/password/reset", { phone: ph, sms_code: pwdSms.trim(), new_password: pwdNew })
          .then(function (body) {
            var ok = !!(body && (body.ok === true || (body.body && body.body.ok === true)));
            if (!ok) {
              var relayBody = (body && body.body) || body || {};
              var errText = (relayBody.error && (relayBody.error.message || relayBody.error))
                || relayBody.detail || ("修改失败(" + ((body && body.status) || "?") + ")");
              setMsg("err", (fromLogin ? "重置失败：" : "修改失败：") + String(errText));
              setPwdSms(""); // 短信验证码一次性：失败后需重新获取
              return undefined;
            }
            // 成功：全部授权设备/会话已失效（含 E2EE）→ 本地登出清掉 config 旧口令与本地凭据，
            // 提示用新密码重新登录（登录会把新口令写入 config 并重启 bridge / 重建 E2EE）。
            setBusy("pwd-logout");
            return post("/dsh-remote/logout").then(function (lb) {
              setSt(lb); setAccount(null); setQuota(null);
              setAkey(null); setAkeyMsg(null);
              fbClearThreads();
              setPwdOpen(false); setPwdSms(""); setPwdNew(""); setPwdCap(null); setPwdCapTxt(""); setPwdSmsBtn("获取验证码");
              if (fromLogin) {
                // 「忘记密码」成功：本机登出完成 → 回到登录表单提示用新密码登录（手机号保留，便于直接重登）
                setPass(""); setLcapTxt(""); setLcap(null); loadCaptcha("login");
                setMsg("ok", "✅ 密码已重置成功：" + PWD_RESET_WARN + "，本机已退出登录。请用新密码登录。");
              } else {
                setMsg("ok", "✅ 密码已修改成功：所有已授权设备与会话已失效，本机已退出登录。" +
                  "请在下方账号卡用「新密码」重新登录——登录会更新本机保存的密码并重新启用端到端加密（E2EE）。");
              }
            }).catch(function (e) {
              setMsg("err", "密码已" + (fromLogin ? "重置" : "修改") + "成功，但本机退出登录失败：" + e.message + "（建议手动「退出登录」后用新密码重新登录，以更新本机配置密码）");
            });
          })
          .catch(function (e) { setMsg("err", (fromLogin ? "重置失败: " : "修改失败: ") + e.message); })
          .finally(function () { setBusy(""); });
      };

      var toggleBridge = function (start) {
        setBusy(start ? "start" : "stop");
        post(start ? "/dsh-remote/start" : "/dsh-remote/stop")
          .then(function (body) {
            setSt(body);
            setMsg(body.ok ? "ok" : "err", body.ok ? (start ? "✅ 后台服务已启动" + (body.pid ? " (pid=" + body.pid + ")" : "") : "后台服务已停止") : (body.detail || body.status || "操作失败"));
          })
          .catch(function (e) { setMsg("err", (start ? "启动" : "停止") + "失败: " + e.message); })
          .finally(function () { setBusy(""); });
      };

      /**
       * 重启 DeepSeek harness：插件本体与浏览器半在进程启动时装载，首次安装/在线更新后
       * 必须重启才生效。重启会短暂断开本页面 —— 这里轮询等它回来，然后自动刷新。
       */
      var restartHarness = function () {
        setBusy("restart");
        post("/dsh-remote/harness/restart")
          .then(function (body) {
            setSt(body);
            setMsg("ok", "🔄 正在重启 DeepSeek harness" + (body && body.mode ? "（" + body.mode + "）" : "") +
              "…约 2~10 秒，页面会自动刷新，无需手动操作。");
            waitHarnessBack(0, false);
          })
          .catch(function (e) {
            setMsg("err", "重启失败: " + e.message + " —— 请手动重启 DeepSeek harness（退出 dsh web 后重新启动）。");
            setBusy("");
          });
      };

      /**
       * 【自动化】首次安装/在线更新后自动重启 DeepSeek harness —— 用户不需要点任何按钮。
       *
       * 为什么能自动:① 重启只是重启 dsh web(bridge 与手机端连接不受影响);② 重启后
       * waitHarnessBack 会轮询到它回来并**自动刷新页面**,面板与「连接中→已连接」流程继续跑完。
       * 安全阀:① 面板不可见(用户没在看)→ 不计时,回来再继续;② 15 秒倒计时内可一键取消,
       * 取消标记按本次 pending 事件(at 时间戳)持久化,同一事件不再自动重启(下次安装/更新会重新触发);
       * ③ 面板上有其他操作在跑(busy≠"")→ 暂停计时,避免打断用户正在做的事。
       */
      var AUTO_RESTART_DELAY_MS = 15000;
      var RESTART_CANCEL_KEY = "dsh-remote-auto-restart-cancelled";

      function autoRestartCancelled(at) {
        try { return localStorage.getItem(RESTART_CANCEL_KEY) === String(at || ""); } catch (e) { return false; }
      }
      function markAutoRestartCancelled(at) {
        try { localStorage.setItem(RESTART_CANCEL_KEY, String(at || "")); } catch (e) { /* 忽略 */ }
      }

      /** 轮询等待 harness 回来；观察到「断过又恢复」或等待足够久后自动刷新页面。 */
      var waitHarnessBack = function (tries, sawDown) {
        if (tries > 40) { setMsg("err", "重启后仍未就绪，请手动刷新页面或重启 DeepSeek harness。"); setBusy(""); return; }
        setTimeout(function () {
          fetch("/dsh-remote/status", { cache: "no-store" })
            .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
            .then(function () {
              if (sawDown || tries >= 8) { location.reload(); return; }
              waitHarnessBack(tries + 1, sawDown);
            })
            .catch(function () { waitHarnessBack(tries + 1, true); });
        }, 1500);
      };

      var saveLocal = function () {
        if (!selfHost.trim() || !localKey.trim()) { setMsg("err", "请填写服务器地址与访问密钥"); return; }
        setBusy("local");
        post("/dsh-remote/config", { mode: "local", selfHostUrl: selfHost.trim(), localKey: localKey.trim() })
          .then(function (body) {
            // 切换到自建服务（连接账号上下文变为本地无账号）：清除 SaaS 账号的反馈线程凭据
            fbClearThreads();
            setPwdOpen(false);
            setSt(body); setSelfHost(""); setLocalKey("");
            setMsg(body.ok ? "ok" : "err", body.ok ? "✅ 已切换到自建服务，后台服务已重启" : (body.error || (body.body && body.body.error) || "保存失败"));
          })
          .catch(function (e) { setMsg("err", "保存失败: " + e.message); })
          .finally(function () { setBusy(""); });
      };

      /**
       * 拉取邀请视图数据：公共配置（邀请规则/试用天数）+ 我的邀请记录。
       * 【0.6.9 修正】记录拉取失败**不再静默当成"没有记录"**：否则用户会以为
       * "新用户明明装好了却没记上"。失败时记下原因，由列表位置给出「重试」。
       */
      var loadInvite = function () {
        setInviteLoading(true);
        setInviteErr(null);
        setInviteCopyErr(null);
        api("/dsh-remote/remote-url").then(function (b) {
          var pubBody = (b && b.publicConfig) || {};
          setPub(pubBody);
        }).catch(function () { /* 规则取不到 → 用默认 n=3/days=15 兜底，不打扰 */ });
        api("/dsh-remote/invite-records").then(function (b) {
          if (b && b.ok) {
            setInviteData({ records: Array.isArray(b.records) ? b.records : [], rewards: Array.isArray(b.rewards) ? b.rewards : [] });
          } else {
            setInviteData({ records: [], rewards: [] });
            setInviteErr(String((b && (b.error || b.detail)) || "服务端未返回邀请记录"));
          }
        }).catch(function (e) {
          setInviteData({ records: [], rewards: [] });
          setInviteErr((e && e.message) ? String(e.message) : "网络错误");
        }).finally(function () { setInviteLoading(false); });
      };

      var field = function (label, inputEl) {
        return h("div", { className: "dru-field" }, h("label", null, label), inputEl);
      };
      var input = function (attrs) { return h("input", Object.assign({ className: "dru-input", type: "text" }, attrs)); };
      var card = function (title, children) { return h("div", { className: "dru-card" }, title ? h("h3", null, title) : null, children); };
      /**
       * 邀请奖励口径：优先 public-config 下发的 invite_rule，取不到才用与线上一致的兜底常量。
       * off=true（n / days 被显式配成 0）表示拉新已关闭 → 所有拉新入口/卡片整体隐藏。
       */
      function inviteRuleOf() {
        var raw = (pub && pub.invite_rule) || null;
        var r = raw || {};
        // 与 planFactsOf 同一套取值规则：**只判「缺没缺」，不判「大不大」**。
        // n / days 配成 0 是「关闭」这一合法状态（下面 off 会置 true 并隐藏所有拉新入口），
        // 绝不能用 `> 0` 把 0 吃掉再回落成 1/3 —— 那正是后端 `|| 3 / || 15` 的同款 bug。
        var n = firstNum([r.n]);
        var days = firstNum([r.days]);
        return {
          n: n === null ? INVITE_RULE_FALLBACK.n : n,
          days: days === null ? INVITE_RULE_FALLBACK.days : days,
          off: inviteOffFrom(raw)
        };
      }
      /**
       * 🎁 邀请收益引导气泡（0.6.9）。
       *
       * 要解决的问题（用户原话）：按钮只写了「带新用户换会员」四个字，**没有说清能拿到什么**
       * —— 用户看不出点进去是「带 1 位新用户 → 得 3 天 PRO」。所以把收益摆到按钮旁边。
       *
       * 数字**全部来自后台** public-config 的 invite_rule（走 inviteRuleOf）：
       *   · 关闭态（n / days 被配成 0）→ **不渲染**（活动都关了，再引导就是骗点击）；
       *   · 取不到配置 → inviteRuleOf 已回落成与线上一致的 {n:1, days:3}；
       *   · `0` 是合法值，绝不会被当成「取不到」再回落（见 inviteOffFrom 的注释）。
       * 同一屏只在这里出现一次 —— 账号卡是邀请的唯一入口，别处不再重复放。
       *
       * 交互克制：进入时一次 320ms 弹入，之后每 4.5s 一次轻微呼吸（占空比 ~28%，不是持续闪烁）；
       * 可关闭且关闭后永久记住（localStorage）；`prefers-reduced-motion: reduce` 下完全不动。
       * 无障碍：整条是 role=status + aria-live=polite + aria-atomic 的**完整句子**
       * （不播报裸数字）；触发按钮用 aria-describedby 指过来，聚焦即能听到收益。
       */
      function renderInviteTip() {
        if (inviteTipDismissed) return null;
        var r = inviteRuleOf();
        if (r.off) return null; // 活动关闭 → 不引导
        return h("div", { className: "dru-tip-wrap" },
          h("div", {
            className: "dru-tip",
            id: INVITE_TIP_ID,
            role: "status",
            "aria-live": "polite",
            "aria-atomic": "true"
          },
            h("span", { className: "dru-tip-ic", "aria-hidden": "true" }, "🎁"),
            h("span", null,
              "带 ", h("b", null, r.n + " 位新用户"), " → 你得 ", h("b", null, r.days + " 天 PRO")),
            h("button", {
              type: "button",
              className: "dru-tip-close",
              // 这一次点击现在有两层效果（0.6.10）：不再提示 + 把两个营销入口收进账号卡「更多」。
              // 名称/提示里把后果说清楚 —— 用户按下去的是一件事，界面变的是两处，别让他莫名其妙。
              "aria-label": "关闭邀请奖励提示（「升级」与「带新用户」入口将收进「更多」）",
              title: "不再提示：「升级」与「带新用户」入口收进「更多」",
              onClick: function () {
                inviteTipDismiss();          // 老键：气泡已关（含义不变）
                setInviteTipDismissed(true);
                mktMoreFold();               // 新键：营销入口已收纳
                setMktFolded(true);
              }
            }, "✕")
          )
        );
      }
      /**
       * 把 public-config 的套餐配置收敛成一份事实对象（**线上真形状优先**）。
       *
       * 取值顺序（每个字段各自独立回落，绝不因为一个字段缺失就把整份配置丢掉）：
       *   mbps  ← plans[key].max_mbps → plans[key].mbps(旧形状) → PLAN_FACTS[key].mbps
       *   gb    ← plans[key].monthly_gb → plans[key].gb(旧形状) → PLAN_FACTS[key].gb
       *   price ← prices[key] → plans[key].price(旧形状) → PLAN_FACTS[key].price
       * `fromServer` = 服务端确实下发了本档的套餐对象（→ 数字已权威，不再写相对说法）。
       * name 只取本地常量：服务端不下发展示名，且它是 UI 文案不是配置。
       */
      function planFactsOf(key) {
        var base = PLAN_FACTS[key] || PLAN_FACTS.pro;
        var srvPlan = pub && pub.plans ? pub.plans[key] : null;
        var srvPrices = pub && pub.prices ? pub.prices[key] : null;
        var obj = srvPlan && typeof srvPlan === "object" ? srvPlan : null;
        return {
          name: base.name,
          mbps: firstNum([obj && obj.max_mbps, obj && obj.mbps, base.mbps]),
          gb: firstNum([obj && obj.monthly_gb, obj && obj.gb, base.gb]),
          price: firstNum([srvPrices, obj && obj.price, base.price]),
          fromServer: !!obj
        };
      }
      // 【0.6.11 删除】`planSpecText()` / `freeMbpsOf()` 已随「更多」里的档位明细（renderPlanDetail）
      // 一起删掉：面板从此**不再渲染任何 Mbps / GB / 价格数字**（业主口径：「插件面板里面不要展示
      // 『更多』里的 PRO 版本流量带宽，我看你把数字都展示出来了」）。
      // 特意**保留** planFactsOf() / PLAN_FACTS / firstNum()：planFactsOf 仍被 upgradePath() 用来取
      // 档位**展示名**（PRO / Pro Max，服务端不下发名字），它们仍然可达，不是死代码。
      /**
       * 转化那条路的套餐键与文案（dimension = "size" 额度维度 | "bandwidth" 带宽维度，
       * 后者用于「连接偏慢」场景）。免费 → 升 PRO；PRO → 升 Pro Max；Pro Max 无更高档 → null（只剩拉新路）。
       *
       * 【0.6.10】这里只给**定性**措辞（更快 / 额度更多），不再把「5 Mbps · 20 GB/月，¥20/月」写在
       * 按钮和 title 上 —— 主界面不摆具体数值（业主口径：外面写死带宽数字与设计语言冲突）。
       * 【0.6.11】面板里已经**没有**任何地方摆精确规格了（renderPlanDetail 按业主口径删除，
       * 见下）；所以 title 里也不再指路「档位规格见账号卡『更多』」——那块已经不存在。
       * label / title 仍然同源（同一句 gain），服务端下发了 pub.plans 也不会自相矛盾。
       */
      function upgradePath(dimension) {
        var plan = account ? account.plan : "free";
        var isMemberNow = plan === "pro" || plan === "pro_max";
        var key = !isMemberNow ? "pro" : plan === "pro" ? "pro_max" : "";
        if (!key) return null; // 已是 Pro Max：没有更高档，不显示「升级」这条
        var name = planFactsOf(key).name; // 展示名只来自本地常量（服务端不下发）
        // 定性收益按维度分：慢 → 讲带宽更高、连接更快；额度将尽 → 讲额度更多、不再被限速。
        var gain = dimension === "bandwidth" ? "带宽更高、连接更快" : "额度更多、不再被限速";
        return {
          key: key,
          gain: gain,
          label: "🚀 升级 " + name + "：" + gain,
          title: "升级到 " + name + "：" + gain + "（带登录态打开套餐页，会员额度按自然月计量，档位规格与价格以套餐页为准）"
        };
      }
      /**
       * 🔀 转化 or 拉新（0.6.9）：在用户**正在疼**的时刻（免费额度将尽 / 已被限速 / 连接偏慢）
       * 给一个明确二选一 —— 要么升级套餐（转化），要么带新用户换会员时长（拉新）。
       *
       * 与上一版的区别：两条路都是**真按钮**（.dru-btn，命中区 ≥44px、有 :focus-visible 焦点环），
       * 不再是一行 12px 灰字文字链；拉新那条必须说清是**交换**（带 N 位新用户 → 得 M 天 PRO），
       * 不能只说「邀请好友」。
       *
       * 事实口径（线上 public-config / 运营公布值，见文件顶部 PLAN_FACTS 注释）：
       *   · 邀请：每 n 位**新用户** → 邀请人得 days 天 PRO（invite_rule {n:1, days:3}）
       *   · 被邀请人**没有任何额外奖励**（trial_days = 0）→ 绝不写「双方都得」
       *   · 计入条件：对方用你的链接**注册新账号** + 在电脑上**装好 dsh-remote-web 并上线**
       *   · 会员按自然月计量：3 天是**会员时长**、不是额度（不写「3 天能拿 20GB」）
       *   · 【0.6.10】这块只给**定性**措辞（更快 / 额度更多）
       *   · 【0.6.11】具体 Mbps / GB / 价格**全面板都不再出现**（原「更多」里的档位明细已按业主口径删除）
       * kind = "quota"（额度将尽/已限速）| "slow"（连接偏慢，带宽维度措辞）
       *
       * 关闭态（invite_rule.n / days 配成 0）与单路收敛：
       *   · 拉新关闭 → 不渲染拉新按钮，也不留空位；文案改成单路（标题/副句/说明同步收口）。
       *   · 已是 Pro Max（没有更高档）→ 只剩拉新那一路，此时它接主 CTA 样式。
       *   · 两路都没了（Pro Max + 拉新关闭）→ **整块返回 null**，不留一个空壳块。
       */
      function renderDualPath(kind) {
        var r = inviteRuleOf();
        var isSlow = kind === "slow";
        // 慢 → 带宽维度措辞（带宽更高、连接更快）；额度将尽 → 额度维度措辞（额度更多）。
        // 【0.6.10】两路都只给**定性**说法，具体数值（5 Mbps / 20 GB/月 / ¥20）不出现。
        // 【0.6.11】这些数字现在**面板里哪儿都没有**了（原「更多」里的档位明细已删，见 renderAccount 上方注释）。
        var up = upgradePath(isSlow ? "bandwidth" : "size");
        var inviteOk = !r.off;
        if (!up && !inviteOk) return null; // 两路都没有 → 整块不显示（会员 + 拉新关闭）
        // 【0.6.10】用户已经关掉过引导（＝营销入口已收纳进账号卡「更多」）→ 这块整体不渲染。
        // 它存在的唯一目的就是「在用户正在疼的时刻当场给出这两条营销路」；既然用户已经明确
        // 关掉过营销提示，就不该在这里再摆一遍（否则「收纳」名不副实）。留一个没有按钮的空壳
        // 更不行 —— 与上面「两路都没有」同款处理：要么给得出路，要么整块不出现。
        // 出路没有断：账号卡「更多」入口始终在，里面的两条入口原样可用。
        if (mktFolded) return null;
        var twoWay = !!up && inviteOk;
        var inviteLabel = "🎁 带 " + r.n + " 位新用户：换 " + r.days + " 天 PRO";
        var inviteTitle = "带 " + r.n + " 位还没注册过的新用户（用你的链接注册 + 装好电脑端并上线）→ 你得 " + r.days + " 天 PRO";
        var title = twoWay
          ? (isSlow ? "⚡ 连接偏慢，两条路提升带宽" : "⚡ 免费额度将尽 / 已被限速，两条路接着用")
          : up
            ? (isSlow ? "⚡ 连接偏慢：升级带宽可以更快" : "⚡ 免费额度将尽 / 已被限速：升级套餐继续用")
            : (isSlow ? "⚡ 连接偏慢：带新用户可换会员时长" : "⚡ 免费额度将尽 / 已被限速：带新用户可换会员时长");
        var sub = twoWay
          ? (isSlow
              ? "免费档带宽有限：排队、跨网、高峰期会被限速，这是慢的主因。要么升级带宽，要么带新用户换会员时长。"
              : "免费额度用完会被限速，继续用只有两条路：要么升级套餐，要么带一位新用户换会员时长。")
          : up
            ? (isSlow
                ? "免费档带宽有限：排队、跨网、高峰期会被限速，这是慢的主因；升级带宽可直接改善。"
                : "免费额度用完会被限速；升级套餐即可继续用（会员额度按自然月计量）。")
            : "带一位还没注册过的新用户，换 " + r.days + " 天 PRO：对方用你的邀请链接注册新账号 + 在电脑上装好 dsh-remote-web 并上线后自动到账。";
        return h("div", { className: "dru-dual" },
          h("div", { className: "dru-dual-title" }, title),
          h("div", { className: "dru-dual-sub" }, sub),
          h("div", { className: "dru-dual-actions" },
            // 转化路：带登录态打开套餐页，复用既有 openUpgradeAuth，不凭空造 URL
            up
              ? h("button", {
                  type: "button",
                  className: "dru-btn dru-btn-primary",
                  disabled: busy !== "",
                  title: up.title,
                  onClick: openUpgradeAuth
                }, busy === "upgrade" ? "生成链接中…" : up.label)
              : null,
            // 拉新路（关闭态整体不渲染）：必须能点，且必须是交换句式；只剩它一路时接主 CTA 样式
            inviteOk
              ? h("button", {
                  type: "button",
                  className: "dru-btn " + (up ? "dru-btn-ghost" : "dru-btn-primary"),
                  disabled: busy !== "",
                  title: inviteTitle,
                  onClick: function () { setView("invite"); loadInvite(); }
                }, inviteLabel)
              : null),
          // 交换说明只在拉新可用时出现（关闭态或纯升级态不该再讲拉新）
          inviteOk
            ? h("div", { className: "dru-dual-note" },
                "拉新这条路是", h("b", null, "交换"), "：对方", h("b", null, "用你的邀请链接注册新账号"), "，并在电脑上",
                h("b", null, "装好 dsh-remote-web 并上线"), "后，", h("b", null, r.days + " 天 PRO 自动到账"),
                "；只有你得奖，对方没有额外奖励（对方必须是还没注册过的新用户才计入）。",
                isSlow ? "会员按自然月计量，" + r.days + " 天是会员时长、不是额度。" : "")
            : null
        );
      }

      // ---------- 我的信息(个人中心) ----------
      function fmtDate(ts) {
        if (!ts) return "—";
        try { var d = new Date(Number(ts)); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); } catch (e) { return "—"; }
      }
      // 【0.6.11 删除】上面这里原本是 renderPlanDetail()：账号卡「更多」里的档位明细
      // （「PRO：5 Mbps · 20 GB/月，¥20/月」那一行 + 「当前：带宽 ≈N Mbps」）。
      // 业主口径：「插件面板里面不要展示『更多』里的 PRO 版本流量带宽，我看你把数字都展示出来了。
      // 在本地的设置面板里面，把这个功能删掉。」→ 整块连标题「套餐与额度」一起删掉。
      // 「更多」里只留下面那两个**折叠的营销入口**（升级 PRO / 带新用户换会员），业主仍要它们收在这里。
      // 🔒 顺带更强的一条不变量：整个面板从此不渲染任何 Mbps / GB / 价格数字
      //    （「已限速 / 不限速」仍由服务端 quota.limit_enabled / quota.max_mbps 驱动，但只给定性措辞）。
      function renderAccount() {
        var a = account;
        var plan = a ? a.plan : "free";
        var source = a ? (a.plan_source || "plan") : "plan";
        var isMember = plan === "pro" || plan === "pro_max";
        var endsAt = a && (a.plan_ends_at || a.trial_expires_at) ? Number(a.plan_ends_at || a.trial_expires_at) : 0;
        var quotaPct = quota && quota.limit_enabled ? quota.percent : null;
        var quotaPctNum = Number(quotaPct);
        var planText;
        // 【0.6.10】首屏额度行：**不提档位、不提带宽数值**，只给一句中性的「还剩多少额度」。
        // 业主口径：「外面关于流量的说明，不要叫『流量剩余』，就说『剩余额度』；咱也别说它是『流量』，
        // 就说是『额度』」「那个地方也不要展示『Pro会员什么什么额度』、『普通用户什么什么额度』，
        // 首页面都不展示会员相关的信息」。
        // 数值仍然**只来自服务端下发**（quota-absent.test.mjs 的硬约束：服务端没说的限制一个字都不许编）：
        //   · 中继压根不提供额度（自建）→ 不编造任何限制，只说「未获取到额度信息」
        //   · 中继报告不限量         → 如实说明
        //   · 中继报告限量           → 显示剩余百分比（percent 是「已用」，剩余 = 100 - 已用）
        //   · 服务端只说限量、没给用量 → 不猜数字，只给状态句
        if (!isMember) {
          if (quota && quota.limit_enabled) {
            var remainText = (quotaPct !== null && isFinite(quotaPctNum))
              ? "剩余额度 " + Math.max(0, Math.round(100 - quotaPctNum)) + "%"
              : "额度用量未下发";
            // max_mbps 没下发而 limit_enabled 为真 → 服务端口径就是「正在限速」，如实说（定性，不带数值）
            planText = quota.max_mbps ? remainText : "已限速 · " + remainText;
          } else if (quota) {
            planText = "当前不限速、不限额度";
          } else {
            planText = "未获取到额度信息";
          }
        }
        else if (source === "trial") planText = "试用 PRO 会员 · 到期 " + fmtDate(a.trial_expires_at);
        else if (endsAt) planText = plan === "pro_max" ? "Pro Max 会员 · 到期 " + fmtDate(endsAt) : "PRO 会员 · 到期 " + fmtDate(endsAt);
        else planText = plan === "pro_max" ? "Pro Max 长期会员" : "PRO 长期会员";
        // 【0.6.9】「额度将尽 / 已被限速」判定：只依据服务端已下发的额度字段
        //   · limit_enabled 且 percent ≥ 80（接近用尽）
        //   · limit_enabled 但没下发 max_mbps（文案已显示「已限速」＝正在被限速）
        // 判断不了（quota 缺失、不限量、会员）→ 不显示，绝不误报。
        // 注意：会员（PRO / Pro Max）的额度不吃这条免费档判断，所以「升级」永远不会弹给付费用户，
        // 但连接偏慢那条（renderConnectBlock）对会员同样成立 —— 会员也会遇到慢，那时只剩拉新路。
        // （quotaPctNum 在上面额度文案处已算好，这里直接复用。）
        var quotaTight = !!(quota && quota.limit_enabled && !isMember &&
          ((isFinite(quotaPctNum) && quotaPctNum >= 80) || !quota.max_mbps));
        // 拉新关闭态（invite_rule.n / days = 0）→ 账号卡入口整体隐藏，不留点进去没内容的入口
        var invOff = inviteRuleOf().off;
        // 🎁 引导气泡是否在屏：活动没关 + 用户没关掉过。
        // 计算一次给按钮的 aria-describedby 用（气泡没渲染时不能指向不存在的 id）。
        var invTipOn = !invOff && !inviteTipDismissed;
        var invTipRule = invTipOn ? inviteRuleOf() : null;
        // 【0.6.10】营销入口「在哪一层」的四个开关（口径：新用户第一次看得见，用户关掉后收进「更多」）：
        //   · 没关过（mktFolded=false）→ 「升级 PRO」与「带新用户换会员」摆在账号卡正面（与今天一致）
        //   · 关过（mktFolded=true）   → 正面只留一个「更多」，两条入口搬进「更多」里
        // 两个边界：
        //   · invOff（运营关掉拉新）→ 拉新入口**整体不渲染**，收纳前后都不出现
        //     （老注释：否则会点进一个没有内容的邀请页）
        //   · 付费用户的按钮是「续费 / 转正式 PRO」—— 那是账号维护、不是营销露出，收纳后仍留在正面：
        //     把付费用户的续费入口藏进「更多」是真实风险（续费靠它，:3096-3098 的到期日也靠它提醒）
        var showUpsellOnFace = !mktFolded || isMember;
        var showInviteOnFace = !invOff && !mktFolded;
        var showUpsellInMore = mktFolded && !isMember;
        var showInviteInMore = mktFolded && !invOff;
        return h("div", null,
          h("div", { className: "dru-user" },
            h("div", { className: "dru-avatar" }, (st.config.phone || "D").charAt(0).toUpperCase()),
            h("div", null,
              h("div", { className: "mail" }, st.config.phone),
              // 【0.6.10】首屏不再挂档位标签（业主口径：「首页面都不展示会员相关的信息」）。
              // 只给**已付费**用户留一个最小、非促销的状态字样（PRO / Pro Max —— 没有「会员」二字、
              // 没有额度、没有升级引导）：付费用户需要一眼看出自己是付费档，而下面那条状态行
              // （「PRO 会员 · 到期 …」）讲的是**功能性**的到期时间，不是营销。
              // 免费用户这里什么都不显示 —— 把「免费档」当标签挂在脸上，正是要减少的营销露出。
              isMember ? h("div", { className: "plan" }, plan === "pro_max" ? "Pro Max" : "PRO") : null
            )
          ),
          // 额度状态：不限量说明 / 剩余额度百分比 / 会员到期日。
          // 首屏只说「还剩多少」，不提档位名、不写带宽数值（数值在下面「更多」里）。
          h("div", { className: "dru-status-line", style: { marginTop: 10 } },
            h("span", { className: "dru-dot " + (isMember ? "dru-dot-on" : "dru-dot-off") }),
            h("span", null, planText)
          ),
          h("div", { className: "dru-actions", style: { marginTop: 10 } },
            // 升级/续费：免费用户这条是**营销入口**，用户关掉引导后搬进「更多」；
            // 付费用户的续费/转正入口始终留在正面（账号维护，不是营销露出）。
            showUpsellOnFace
              ? h("button", { type: "button", className: "dru-btn dru-btn-primary", style: { display: "inline-flex", alignItems: "center" }, disabled: busy !== "", title: "升级/续费（带登录态打开）", onClick: openUpgradeAuth },
                  busy === "upgrade" ? "生成链接中…" : (!isMember ? "🚀 升级 PRO" : source === "trial" ? "🚀 转正式 PRO" : "🔄 续费会员"))
              : null,
            // 拉新入口：invOff（运营关掉拉新）整体隐藏，收纳前后都不出现（否则会点进一个没有内容的邀请页）；
            // 用户收纳过后搬进「更多」。
            // 按钮文字自带可访问名称；气泡在屏时用 aria-describedby 把「能得多少」也读出来。
            showInviteOnFace ? h("button", {
              type: "button",
              className: "dru-btn dru-btn-ghost",
              disabled: busy !== "",
              title: invTipRule ? "带 " + invTipRule.n + " 位新用户可得 " + invTipRule.days + " 天 PRO 会员" : "带新用户换会员",
              "aria-describedby": invTipOn ? INVITE_TIP_ID : undefined,
              onClick: function () { setView("invite"); loadInvite(); }
            }, "🎁 带新用户换会员") : null,
            h("button", { type: "button", className: "dru-btn dru-btn-ghost", disabled: busy !== "", onClick: function () { setView("feedback"); } }, "💬 用户反馈"),
            h("button", { type: "button", className: "dru-btn dru-btn-ghost", disabled: busy !== "", onClick: togglePwdForm }, pwdOpen ? "收起修改密码" : "🔒 修改密码"),
            h("button", { type: "button", className: "dru-btn dru-btn-danger", disabled: busy !== "", onClick: function () { doLogout(false); } }, "退出登录")
          ),
          // 🎁 邀请收益引导气泡：紧贴上面那排按钮（不遮挡按钮、窄屏独占一行）。
          // 它的 ✕ 同时是「营销入口收纳」的触发信号（0.6.10）：点过之后两个入口搬进下面的「更多」。
          renderInviteTip(),
          h("div", { className: "dru-hint", style: { marginTop: 8 } },
            "升级/续费以带登录态方式打开：点击后生成一次性访问链接并直接跳转，无需重新登录。" +
            (endsAt && isMember ? "到期后如需继续使用会员权益，请在到期前续费。" : "")),
          // 🧰 「更多」：主界面上唯一常驻的那一个营销入口（0.6.10）—— 收纳态下正面不再摆按钮行的一部分。
          // 折叠时它就是一个 .dru-disclose 按钮：命中区 ≥44px、键盘可聚焦（焦点环见样式表末尾的
          // :focus-visible 基线），开合状态用「展开 ▼ / 收起 ▲」**文字**加箭头表达，不靠颜色区分。
          // 无障碍：aria-expanded 表达开合，aria-controls 指向下面的内容体（内容体始终在 DOM 里、
          // 收起时 hidden，所以 aria-controls 永远指向一个真实存在的元素，不指向空气）。
          h("button", {
            type: "button",
            id: MKT_MORE_TOGGLE_ID,
            className: "dru-disclose",
            style: { marginTop: 10 },
            "aria-expanded": moreOpen ? "true" : "false",
            "aria-controls": MKT_MORE_BODY_ID,
            onClick: function () { setMoreOpen(!moreOpen); }
          },
            h("span", null, "更多"),
            h("span", { className: "dru-disclose-caret", "aria-hidden": "true" }, moreOpen ? "收起 ▲" : "展开 ▼")
          ),
          h("div", {
            id: MKT_MORE_BODY_ID,
            className: "dru-more-body",
            hidden: !moreOpen
          },
            // 【0.6.11】这里**不再**有「套餐与额度」标题与档位明细（renderPlanDetail 已删）：
            // 业主口径 —— 本地面板不展示 PRO 的带宽/流量/价格数字。「更多」只剩下面两个折叠入口。
            // 用户收纳过之后，两条营销入口就住在这里（正面不再摆它们）
            (showUpsellInMore || showInviteInMore)
              ? h("div", { className: "dru-more-actions" },
                  showUpsellInMore
                    ? h("button", { type: "button", className: "dru-btn dru-btn-primary", disabled: busy !== "", title: "升级/续费（带登录态打开）", onClick: openUpgradeAuth },
                        busy === "upgrade" ? "生成链接中…" : "🚀 升级 PRO")
                    : null,
                  showInviteInMore
                    ? h("button", { type: "button", className: "dru-btn dru-btn-ghost", disabled: busy !== "", title: "带新用户换会员", onClick: function () { setView("invite"); loadInvite(); } }, "🎁 带新用户换会员")
                    : null)
              : null
          ),
          // 额度将尽 / 已被限速 → 🔀 双路块：升级套餐（转化）or 带新用户换会员时长（拉新）。
          // 用户收纳过（mktFolded）时 renderDualPath 自己返回 null —— 那两条路这时都在「更多」里，
          // 这里不再重复摆一遍（也不留一个没有按钮的空壳块）。
          quotaTight ? renderDualPath("quota") : null,
          pwdOpen ? renderResetPwdForm(false) : null
        );
      }

      // ---------- 🔒 修改密码 / 忘记密码 共用重置表单（图形验证码 + 短信验证码 + 新密码≥8） ----------
      // fromLogin=false：账号卡「修改密码」手机号以当前登录账号为准（只读）；
      // fromLogin=true：登录卡「忘记密码」手机号预填登录输入、可改（成功后返回登录表单请用新密码登录）。
      function renderResetPwdForm(fromLogin) {
        // 隐私审计(2026-09):账号卡「修改密码」手机号只展示掩码;发送/重置时由服务端取本机账号真实号,
        // 浏览器端不再出现明文手机号。登录卡「忘记密码」为用户自行输入,原样使用。
        var curPhone = ((st && st.config && st.config.phone) || "");
        var ph = fromLogin ? phone : "";
        return h("div", { className: "dru-card", style: { marginTop: 10, border: "1px dashed var(--dru-border)" } },
          h("h3", null, fromLogin ? "忘记密码（短信重置）" : "🔒 修改密码（短信验证）"),
          h("div", { className: "dru-hint", style: { marginBottom: 8 } },
            fromLogin
              ? "手机号预填当前输入，可改为其它账号；" + PWD_RESET_WARN + "。"
              : PWD_RESET_WARN + "（E2EE 用新密码重新派生）。"),
          field("手机号", fromLogin
            ? input({ type: "tel", value: ph, placeholder: "11 位手机号", autoComplete: "tel", onChange: function (e) { setPhone(e.target.value); } })
            : h("input", { className: "dru-input", type: "tel", value: curPhone, disabled: true, readOnly: true, title: "以当前登录账号为准" })),
          field("图形验证码", h("div", { className: "dru-captcha" },
            input({ value: pwdCapTxt, placeholder: "图中数字", autoComplete: "off", inputMode: "numeric", maxLength: 6, onChange: function (e) { setPwdCapTxt(e.target.value); } }),
            h("div", { className: "dru-captcha-box", title: "看不清？点击刷新", onClick: function () { pwdLoadCaptcha(); }, dangerouslySetInnerHTML: pwdCap && pwdCap.svg && pwdCap.svg.indexOf("<svg") === 0 ? { __html: pwdCap.svg } : void 0 },
              pwdCap && pwdCap.svg && pwdCap.svg.indexOf("<svg") !== 0 ? pwdCap.svg : null)
          )),
          field("短信验证码", h("div", { className: "dru-captcha" },
            input({ value: pwdSms, placeholder: "6 位验证码", autoComplete: "off", inputMode: "numeric", maxLength: 6, onChange: function (e) { setPwdSms(e.target.value); } }),
            h("button", { type: "button", className: "dru-btn dru-btn-ghost", style: { flex: "none", padding: "0 14px" }, disabled: busy !== "", onClick: function () { sendPwdSms(ph); } }, pwdSmsBtn)
          )),
          field("新密码（至少 8 位）", input({ type: "password", value: pwdNew, minLength: 8, autoComplete: "new-password", placeholder: "至少 8 位", onChange: function (e) { setPwdNew(e.target.value); } })),
          h("div", { className: "dru-hint", style: { marginBottom: 8 } },
            fromLogin
              ? "重置成功后本机会退出登录（如有已保存的旧账号），请用新密码登录。"
              : "修改成功后，本机保存的旧密码会被清除并退出登录；请用新密码重新登录（登录会更新本机配置密码并重新启用远程访问与端到端加密）。"),
          h("button", { type: "button", className: "dru-btn dru-btn-danger", style: { width: "100%" }, disabled: busy !== "", onClick: function () { doResetPwd(ph, fromLogin); } },
            busy === "pwd-reset" ? "提交中…" : busy === "pwd-logout" ? "已重置，正在退出本地登录…" : (fromLogin ? "确认重置密码" : "确认修改密码")),
          fromLogin
            ? h("div", { style: { textAlign: "right", marginTop: 6 } },
                h("button", { type: "button", className: "dru-linkbtn", onClick: function () { togglePwdForm(); } }, "← 返回登录"))
            : null
        );
      }

      // ---------- 🎁 邀请视图（0.6.9 重排：交换大字 → 三步走 → 进度 → 邀请码/链接一键复制 → 折叠规则 → 记录） ----------
      /** 体面空态：图标 + 标题 + 说明 + 可选操作（替代过去"一行灰字了事"）。 */
      function emptyState(icon, title, sub, actions) {
        return h("div", { className: "dru-empty" },
          h("div", { className: "dru-empty-icon", "aria-hidden": "true" }, icon),
          h("div", { className: "dru-empty-title" }, title),
          sub ? h("div", { className: "dru-empty-sub" }, sub) : null,
          actions && actions.length ? h("div", { className: "dru-empty-actions" }, actions) : null
        );
      }
      /**
       * 一键复制按钮：成功后按钮自身变绿并显示「已复制」2 秒；失败则在按钮旁（同一个 .dru-copy-row）
       * 给出红字提示 —— 错误靠近出错位置，不让用户以为"点了没反应"。
       */
      function copyButton(key, text, label) {
        var ok = inviteCopied === key;
        return h("button", {
          type: "button",
          className: "dru-copy-btn" + (ok ? " copied" : ""),
          disabled: !text,
          "aria-label": label,
          onClick: function () {
            copyText(text).then(function (done) {
              if (!done) {
                setInviteCopied("");
                setInviteCopyErr({ kind: key, text: "复制失败：请手动选中上面的文字复制（浏览器可能限制了剪贴板权限）" });
                return;
              }
              setInviteCopyErr(null);
              setInviteCopied(key);
              later(function () { setInviteCopied(function (cur) { return cur === key ? "" : cur; }); }, 2000);
            });
          }
        }, ok ? "✅ 已复制" : label);
      }
      /** 邀请码 / 邀请链接的一行（标签 + 值 + 复制按钮 + 就近错误提示）。 */
      function copyRow(label, value, kind, hint) {
        var isCode = kind === "code";
        return h("div", { className: "dru-copy-row" },
          h("div", { className: "dru-copy-label" }, label),
          h("div", { className: "dru-copy-box" },
            h("span", { className: isCode ? "dru-code-val" : "dru-link-val" }, value),
            copyButton(kind, value, isCode ? "复制邀请码" : "复制邀请链接")
          ),
          hint ? h("div", { className: "dru-invite-sub", style: { marginTop: 6 } }, hint) : null,
          // 复制失败提示紧贴这一次操作的行（错误靠近出错位置）
          inviteCopyErr && inviteCopyErr.kind === kind
            ? h("div", { className: "dru-msg dru-msg-err", style: { marginTop: 6 } }, inviteCopyErr.text)
            : null
        );
      }
      /** 邀请记录里的新用户展示名：只用接口给的 invitee_phone（掩码），缺字段时降级，不编造。 */
      function inviteeName(r) {
        var phone = maskPhoneLike(r && r.invitee_phone);
        if (phone) return phone;
        var dev = r && r.device_id ? String(r.device_id) : "";
        if (dev) return "新用户（设备 " + (dev.length > 6 ? dev.slice(-6) : dev) + "）";
        return "新用户";
      }
      /** 一条邀请记录：谁 / 什么时候 / 是否已生效（时间或状态字段缺失时如实标注，不编造）。 */
      function renderInviteRecords(records, ruleN) {
        return h("div", null, records.map(function (r, i) {
          var ts = r && (r.created_at || r.bound_at || r.at);
          // 记录来自「有效邀请」接口：默认即已生效；若服务端给了 reward_granted:false → 标"待发放"
          var pending = r && r.reward_granted === false;
          return h("div", { key: (r && r.id != null ? String(r.id) : "rec-" + i), className: "dru-rec" },
            h("div", { className: "dru-rec-top" },
              h("span", { className: "dru-rec-who" }, inviteeName(r)),
              h("span", { className: "dru-rec-tag " + (pending ? "dru-rec-tag-wait" : "dru-rec-tag-ok") },
                pending ? "待发放奖励" : "已生效"),
              h("span", { className: "dru-rec-when" }, ts ? fmtDate(ts) : "时间未知")
            ),
            h("div", { className: "dru-rec-sub" },
              pending
                ? (ruleN > 0
                    ? "这位新用户已完成设备绑定，奖励按规则结算（每满 " + ruleN + " 位发放一次）。"
                    // 拉新关闭态：不引用具体结算规则（不能显示「每满 0 位」这种假承诺）
                    : "这位新用户已完成设备绑定；奖励结算以运营规则为准（活动当前未开放）。")
                : "这位新用户已完成电脑端安装并上线，已计入你的有效邀请。")
          );
        }));
      }
      /** 已到账奖励：每次奖励 = rule_days 天 PRO（时间字段缺失时只显示天数）。 */
      function renderInviteRewards(rewards, ruleDays) {
        if (!rewards.length) return null;
        return h("div", { className: "dru-copy-row" },
          h("div", { className: "dru-copy-label" }, "已到账奖励（" + rewards.length + " 次）"),
          h("div", null, rewards.map(function (r, i) {
            var days = r && (r.rule_days != null ? r.rule_days : ruleDays);
            var ts = r && (r.created_at || r.at);
            return h("div", { key: (r && r.id != null ? String(r.id) : "rw-" + i), className: "dru-rec" },
              h("div", { className: "dru-rec-top" },
                h("span", { className: "dru-rec-who" }, "+" + (days != null ? days : ruleDays) + " 天 PRO 会员"),
                h("span", { className: "dru-rec-tag dru-rec-tag-ok" }, "已到账"),
                h("span", { className: "dru-rec-when" }, ts ? fmtDate(ts) : "时间未提供")
              )
            );
          }))
        );
      }
      /**
       * 「我的邀请记录」卡：邀请视图与**拉新关闭态**共用。
       * 关闭态下这是唯一保留的卡片 —— 记录是历史事实（不承诺任何未来奖励），
       * 关上活动不该让用户看不到自己已经计入的有效邀请与已到账奖励。
       */
      function renderInviteRecordCard(records, rewards, validCount, ruleN, ruleDays, inviteErr, inviteLoading) {
        return card("我的邀请记录" + (inviteErr ? "" : "（" + validCount + "）"), [
          inviteLoading
            ? h("div", { className: "dru-invite-sub" }, "正在读取邀请记录…")
            : inviteErr
              ? h("div", null,
                  h("div", { className: "dru-msg dru-msg-err", style: { marginTop: 0 } }, "读取邀请记录失败：" + inviteErr),
                  h("div", { className: "dru-actions", style: { marginTop: 8 } },
                    h("button", { type: "button", className: "dru-btn dru-btn-ghost", disabled: inviteLoading, onClick: loadInvite }, "重试")))
              : validCount === 0
                ? emptyState("📨", "还没有新用户通过你的链接进来",
                    "把上面的邀请链接发给一位还没注册过的新用户：对方注册 + 在电脑上装好 dsh-remote-web 并上线后，会自动出现在这里。")
                : h("div", null, [
                    h("div", { className: "dru-rec-head" },
                      h("span", { style: { flex: "1" } }, "新用户"),
                      h("span", null, "状态"),
                      h("span", null, "时间")),
                    renderInviteRecords(records, ruleN),
                    renderInviteRewards(rewards, ruleDays),
                    h("div", { className: "dru-invite-sub", style: { marginTop: 6 } },
                      "名单里的新用户都已完成电脑端安装并上线，所以都算有效邀请。")
                  ])
        ]);
      }
      /** 活动规则：默认折叠，点开才显示（层级清晰，不再和奖励说明挤在一堆小字里）。 */
      function renderInviteRules(n, days) {
        return h("div", { className: "dru-card" },
          h("button", {
            type: "button",
            className: "dru-disclose",
            "aria-expanded": inviteRulesOpen ? "true" : "false",
            onClick: function () { setInviteRulesOpen(!inviteRulesOpen); }
          },
            h("span", null, "活动规则"),
            h("span", { className: "dru-disclose-caret" }, inviteRulesOpen ? "收起 ▲" : "展开 ▼")
          ),
          inviteRulesOpen
            ? h("ol", { className: "dru-rules" }, [
                h("li", null, "这是", h("b", null, "交换"), "：你带新用户，平台给你会员时长 —— 每带 ", h("b", null, n + " 位新用户"), "，你得 ", h("b", null, days + " 天 PRO"), "。"),
                h("li", null, h("b", null, "只有新注册账号才计入"), "：对方必须是还没注册过的新用户，且通过你的邀请链接注册（或在注册时填写你的邀请码），才与你绑定邀请关系。"),
                h("li", null, "对方还要在这台电脑上", h("b", null, "装好 dsh-remote-web 并成功上线"), "，才计入 1 位", h("b", null, "有效邀请"), "；同一位新用户只计一次。"),
                h("li", null, h("b", null, "奖励只发给邀请人"), "：你得 ", h("b", null, days + " 天 PRO"), "，被邀请的新用户没有额外的邀请奖励（注册送礼与邀请无关）。"),
                h("li", null, "奖励自动到账，无需申请：可在「我的邀请记录」下方看到「已到账奖励」，在原到期时间上顺延（已是长期会员则保持长期）。"),
                h("li", null, h("b", null, days + " 天是会员时长、不是额度"), "：会员额度按自然月计量，天数是按天顺延的会员有效期。"),
                h("li", null, "邀请码与邀请链接长期有效，随时可在本页复制；新用户解绑或重装设备不会撤回已计入的邀请。"),
                h("li", null, "规则与数值以本页面显示的为准（运营可能调整活动力度）。")
              ])
            : null
        );
      }

      function renderInvite() {
        var inv = inviteRuleOf();
        var ruleN = inv.n;
        var ruleDays = inv.days;
        var trialDays = Number(pub && pub.trial_days) > 0 ? Number(pub.trial_days) : 0; // 注册送礼（关闭时不下发/为 0）
        var code = (account && account.invite_code) || "";
        var base = (st && st.remoteUrl) || (pub && pub.app_url) || "https://n.risegao.cn:13443/app/";
        var link = code ? base.replace(/\/+$/, "") + "/?invite=" + encodeURIComponent(code) : "";
        var loggedInSaaS = !!(st && st.config && st.config.phone);
        var records = (inviteData && inviteData.records) || [];
        var rewards = (inviteData && inviteData.rewards) || [];
        var validCount = records.length;
        // 进度：每 ruleN 位结算一次（与后端 onDeviceBound 的 floor(total/n) 语义一致）
        var toward = ruleN > 0 ? validCount % ruleN : 0;
        var nextGap = toward === 0 ? ruleN : ruleN - toward;
        var pct = ruleN > 0 ? Math.round((toward / ruleN) * 100) : 0;
        var copyLink = function () {
          copyText(link).then(function (done) {
            if (!done) { setInviteCopied(""); setInviteCopyErr("复制失败：请长按/手动选中上面的链接复制"); return; }
            setInviteCopyErr(null);
            setInviteCopied("link");
            later(function () { setInviteCopied(""); }, 2000);
          });
        };

        // ── 拉新关闭态（invite_rule.n / days 配成 0）──────────────────────────────
        // 邀请卡**整卡不渲染**：不显示「带 0 位新用户 → 0 天 PRO」，也不留只有一个复制按钮的空壳；
        // 邀请码/邀请链接（拉新的工具）与活动规则（引用 n/days）一并收起。
        // 只保留「我的邀请记录」——那是**历史事实**，不是承诺，且关闭活动不该让用户看不到自己已计入的记录。
        // 这一页在关闭态下正常也进不来（所有入口都隐藏了），此处是防御性渲染（例如停留在本页时配置刷成关闭）。
        if (inv.off) {
          return h("div", null,
            h("button", { type: "button", className: "dru-btn dru-btn-ghost", style: { width: "100%" }, onClick: function () { setView("home"); } }, "← 返回账号"),
            card("🎁 带新用户换会员时长 · 当前未开放", [
              h("div", { className: "dru-invite-sub" },
                "运营已暂时关闭「带新用户换会员时长」活动，所以这里不再显示邀请链接与奖励进度。"),
              h("div", { className: "dru-invite-sub", style: { marginTop: 8 } },
                "你已有的历史记录不受影响（下方「我的邀请记录」仍可查看）；重新开放后本页会自动恢复。")
            ]),
            loggedInSaaS
              ? renderInviteRecordCard(records, rewards, validCount, 0, ruleDays, inviteErr, inviteLoading)
              : null,
            message ? h("div", { className: "dru-msg dru-msg-" + message.kind }, message.text) : null
          );
        }

        return h("div", null,
          h("button", { type: "button", className: "dru-btn dru-btn-ghost", style: { width: "100%" }, onClick: function () { setView("home"); } }, "← 返回账号"),

          // ① 交换是什么（大字：带 N 位新用户 → 得 M 天 PRO；一句人话说清条件与「只有你得奖」）
          card("🎁 带新用户，换会员时长", [
            h("div", { className: "dru-invite-hero" },
              "带 ", h("em", null, ruleN + " 位"), "新用户 → 得 ", h("em", null, ruleDays + " 天 PRO")),
            h("div", { className: "dru-invite-sub" },
              "这是一次交换：新用户", h("b", null, "用你的邀请链接注册新账号"), "，并在电脑上",
              h("b", null, "装好 dsh-remote-web 并上线"), "后，", ruleDays + " 天 PRO ",
              "自动到账（每满 " + ruleN + " 位结算一次，会员天数可累加）；",
              h("b", null, "只有你得奖"),
              trialDays > 0
                ? "，新用户自己注册即得 " + trialDays + " 天 PRO 试用，不用邀请也一样。"
                : "，新用户没有额外的邀请奖励（必须是还没注册过的新用户才计入）。"),
            // 三步走：把「怎么带」讲到不需要思考（① 复制 → ② 发给没注册过的新用户 → ③ 对方上线即到账）
            h("ol", { className: "dru-steps" }, [
              h("li", null, "复制", h("b", null, "你的专属邀请链接"), "（下方「我的邀请链接」，点一下就复制）。"),
              h("li", null, "发给一位", h("b", null, "还没注册过的新用户"), "（对方注册时自动带上你的邀请码）。"),
              h("li", null, "他注册新账号 + 在电脑上装好 dsh-remote-web 并上线 → ", h("b", null, ruleDays + " 天 PRO 自动到账"), "。")
            ]),
            // 进度：已带来 / 已到账 / 还差几位（数据全部来自接口，未登录或未加载时不编造数字）
            loggedInSaaS
              ? h("div", { className: "dru-invite-prog" },
                  h("div", { className: "dru-invite-prog-top" },
                    h("span", null, "已带来 ", h("span", { className: "n" }, String(validCount)), " 位新用户"),
                    inviteErr ? null : h("span", null, "已到账 " + rewards.length + " 次（每次 " + ruleDays + " 天）")
                  ),
                  h("div", { className: "dru-invite-bar", role: "img", "aria-label": "距离下一次奖励的进度" },
                    h("div", { className: "dru-invite-bar-fill", style: { width: pct + "%" } })),
                  h("div", { className: "dru-invite-next" },
                    inviteLoading
                      ? "正在读取你的邀请记录…"
                      : "本轮已累计 " + toward + "/" + ruleN + " 位，再带 " + nextGap + " 位新用户即可获得下一次 " + ruleDays + " 天 PRO。")
                )
              : null,
            // ② 我的邀请码 / 邀请链接（一键复制）
            code
              ? h("div", null,
                  copyRow("我的邀请码", code, "code", "新用户注册时填这个码，或直接用下面的邀请链接（自动带上）。"),
                  copyRow("我的邀请链接", link, "link", "链接较长，可一键复制后发给还没注册过的新用户；对方打开即进入注册页。")
                )
              : loggedInSaaS
                ? h("div", { style: { marginTop: 10 } },
                    emptyState("🎫", "正在为你生成专属邀请码",
                      "邀请码绑定你的手机号账号：新用户通过它注册后，奖励会自动记到这个账号上。（偶尔需要手动获取一次）",
                      [h("button", {
                        type: "button",
                        className: "dru-btn dru-btn-primary",
                        disabled: busy !== "",
                        onClick: function () {
                          setBusy("invite-refresh");
                          api("/dsh-remote/account").then(function (b) {
                            if (b && b.ok && b.account && b.account.invite_code) { setAccount(b.account); setMsg("ok", "邀请码已生成，可一键复制"); }
                            else setMsg("err", "获取邀请码失败：请稍后重试（若仍未登录，请先在「🔑 账号」登录）");
                          }).catch(function (e) { setMsg("err", "获取邀请码失败：" + e.message); })
                            .finally(function () { setBusy(""); });
                        }
                      }, busy === "invite-refresh" ? "生成中…" : "获取我的邀请码")])
                  )
                : h("div", { style: { marginTop: 10 } },
                    emptyState("🔑", "登录后即可获得你的专属邀请码",
                      "邀请码绑定你的手机号账号：新用户通过它注册后，奖励会自动记到这个账号上。登录后回到本页即可复制分享。",
                      [h("button", { type: "button", className: "dru-btn dru-btn-primary", onClick: function () { setView("home"); } }, "去登录")])
                  )
          ]),

          // ③ 邀请记录（谁 / 什么时候 / 是否已生效）
          loggedInSaaS
            ? renderInviteRecordCard(records, rewards, validCount, ruleN, ruleDays, inviteErr, inviteLoading)
            : null,

          // ④ 活动规则（默认折叠）
          renderInviteRules(ruleN, ruleDays),

          // 复制失败等就地提示见各 copyRow（错误靠近出错位置）
          message ? h("div", { className: "dru-msg dru-msg-" + message.kind }, message.text) : null
        );
      }

      // ---------- 反馈视图(独立页,带返回) ----------
      function renderFeedback() {
        return h("div", null,
          h("button", { type: "button", className: "dru-btn dru-btn-ghost", style: { width: "100%" }, onClick: function () { setView("home"); } }, "← 返回"),
          h(FeedbackCard, null)
        );
      }

      // ---------- 📱 远程访问卡：一次性访问地址 / 二维码 / 状态行 ----------
      function renderAccessCard() {
        var hasKey = !!(akey && akey.url);
        var expMs = akey ? toMs(akey.expires_at) : 0;
        var remainMs = expMs ? expMs - nowTick : 0;
        var loggedInSaaS = !!(st && st.config && st.config.phone);
        // 状态行优先用连接阶段文案（node 半下发的 user-facing 文案）：
        // 「正在准备运行环境（首次约 1~2 分钟）… / 正在启动 Bridge… / 正在连接中继… / 已连接 ✅ …」；
        // 旧版 host 没有 connect 字段 → 完全回退到原来的 running 文案（既有行为不变）。
        var statusTxt = st === null
          ? "查询中…"
          : !loggedInSaaS
            ? "请先登录（下方账号卡片）后启用远程访问"
            : connInfo ? connText : serviceRunning ? "已连接（可远程访问）" : "等待设备连接";
        var dotOn = loggedInSaaS ? (connInfo ? connOnline : serviceRunning) : false;
        var dotCls = "dru-dot " + (dotOn ? "dru-dot-on" : "dru-dot-off");

        // 【0.6.9】「连接偏慢」判定（只用既有字段 + 本地计时，不新增/不假设后端字段）：
        //   ① 服务端下发 attempts ≥ 3（已经自动重试多次）；② 阶段文案里出现限速/带宽/较慢类提示；
        //   ③ 本地观察到「非 online 阶段持续 ≥ SLOW_CONNECT_HINT_MS」。
        // 连上（online）或未登录即清零；三者都不成立 → 不显示任何邀请入口（宁可不显示，也不误报）。
        if (!loggedInSaaS || connPhase === "online") slowConnTrack.since = 0;
        else if (!slowConnTrack.since) slowConnTrack.since = Date.now();
        var connSlowText = String(connText || "") + " " + String((connInfo && connInfo.detail) || "");
        var connSlow = loggedInSaaS && !!connInfo && connPhase !== "online" &&
          (Number(connInfo.attempts) >= 3 ||
            /限速|带宽|较慢|拥堵|拥塞/.test(connSlowText) ||
            (slowConnTrack.since > 0 && Date.now() - slowConnTrack.since >= SLOW_CONNECT_HINT_MS));

        /**
         * 连接阶段区块：把「环境 → bridge 进程 → 中继注册」的自动推进过程如实展示出来，
         * 面向非技术用户——非 online 阶段一律说明「正在自动进行，无需操作」；
         * 只有失败（error）才给可操作项：重试 / 复制诊断信息 / 日志路径，绝不出现死胡同。
         */
        function renderConnectBlock() {
          if (!loggedInSaaS || !connInfo) return null;
          var phase = connInfo.phase || "";
          if (phase === "online") {
            return h("div", { className: "dru-meta", style: { marginTop: 6 } },
              connInfo.registerSource === "account_api" || connInfo.registerSource === "account" || connInfo.registerSource === "state_account"
                ? "设备已登记到你的账号：手机端「设备列表」可以看到这台电脑。"
                : "设备已注册到中继：手机端扫码或打开链接即可进入这台电脑。");
          }
          var rows = [];
          if (phase === "error") {
            rows.push(h("div", { className: "dru-msg dru-msg-err", style: { marginTop: 6 } },
              "⚠️ " + ((connError && connError.message) || connText)));
            if (connInfo.detail) rows.push(h("div", { className: "dru-hint", style: { marginTop: 4 } }, connInfo.detail));
            if (connInfo.nextRetryInMs > 0) {
              rows.push(h("div", { className: "dru-hint", style: { marginTop: 4 } },
                "已自动重试 " + (connInfo.attempts || 0) + " 次，约 " + Math.ceil(connInfo.nextRetryInMs / 1000) + " 秒后自动再试（也可以点下面按钮立刻重试）"));
            }
            rows.push(h("div", { className: "dru-actions", style: { marginTop: 8 } },
              h("button", { type: "button", className: "dru-btn dru-btn-primary", disabled: busy !== "", onClick: retryConnect }, busy === "connect-retry" ? "重试中…" : "重试"),
              h("button", { type: "button", className: "dru-btn dru-btn-ghost", onClick: copyDiagnostics }, copiedDiag ? "已复制" : "复制诊断信息")));
            rows.push(h("div", { className: "dru-hint", style: { marginTop: 6 } },
              "查看日志：后台服务 " + (connInfo.logPath || "") + " ，安装 " + (connInfo.installLogPath || "") + "（把「复制诊断信息」的内容发给客服可加速定位）"));
            return h("div", null, rows);
          }
          // 非错误阶段：只解释「正在自动做什么」，并说明不需要任何操作
          if (connInfo.detail) rows.push(h("div", { className: "dru-hint", style: { marginTop: 6 } }, connInfo.detail));
          if (connInfo.installing || phase === "no_runtime") {
            rows.push(h("div", { className: "dru-hint", style: { marginTop: 4 } },
              "首次安装会自动下载并配置，期间请不要关闭 DeepSeek；装完会自动启动后台服务，无需任何操作。"));
          }
          if (connInfo.deviceId) rows.push(h("div", { className: "dru-meta" }, "设备 ID：" + connInfo.deviceId));
          // 【0.6.9】连接明显偏慢时的 🔀 双路块（不打断、不弹窗）：把「等」变成一次选择 ——
          // 升级带宽（转化）or 带新用户换会员时长（拉新，会员同样走这条）。
          // 判定只用既有字段 —— 服务端重试次数 attempts≥3、或阶段文案里出现限速/带宽/较慢类提示、
          // 或本地观察「非 online 阶段持续 ≥90s」。判断不了就不显示（宁可不出现，也不误报）。
          // 放在「立即重试 / 复制诊断信息」之上：先给选择，再给重试（重试仍在，不是死胡同）。
          // 拉新关闭 + 已是 Pro Max 时 renderDualPath 返回 null → 这块自然不出现（不会留空壳）。
          if (connSlow) {
            var dualSlow = renderDualPath("slow");
            if (dualSlow) rows.push(dualSlow);
          }
          rows.push(h("div", { className: "dru-actions", style: { marginTop: 8 } },
            h("button", { type: "button", className: "dru-btn dru-btn-ghost", disabled: busy !== "", onClick: retryConnect }, busy === "connect-retry" ? "立即重试中…" : "立即重试"),
            h("button", { type: "button", className: "dru-btn dru-btn-ghost", onClick: copyDiagnostics }, copiedDiag ? "已复制" : "复制诊断信息")));
          return h("div", null, rows);
        }
        // Phase-5:端到端加密(E2EE)状态行 —— 未登录/旧 host 未下发 e2ee 一律不渲染
        // （桌面宽屏与手机镜像共用同一面板：纯文字状态行、不弹层不打扰）；启用=绿点绿字（🔒已启用），
        // 未启用=灰字 + 中性原因文案（回退普通 HTTPS 连接，不宣称“灰度等待”）。
        function renderE2eeBadge() {
          if (!loggedInSaaS) return null;
          var e = describeE2ee(st && st.service && st.service.e2ee);
          if (!e) return null;
          return h("div", { className: "dru-e2ee-line" + (e.kind === "ok" ? " ok" : "") },
            h("span", { className: "dru-dot " + (e.kind === "ok" ? "dru-dot-on" : "dru-dot-off") }),
            h("span", null, e.text));
        }
        return card("📱 远程访问", [
          h("div", { className: "dru-status-line" },
            h("span", { className: dotCls }),
            h("span", null, statusTxt)
          ),
          renderConnectBlock(),
          renderE2eeBadge(),
          akeyMsg
            ? h("div", { className: "dru-msg dru-msg-" + akeyMsg.kind, style: { marginTop: 8 } },
                akeyMsg.text,
                akeyMsg.retry
                  ? h("button", { type: "button", className: "dru-linkbtn", style: { marginLeft: 8 }, disabled: akeyBusy, onClick: akeyMsg.retry }, akeyBusy ? "重试中…" : "立即重试")
                  : null)
            : null,
          hasKey ? h("div", null, [
            h("div", { className: "dru-url big", style: { marginTop: 8 } },
              h("span", null, akey.url),
              h("button", { type: "button", onClick: copyKeyUrl }, copiedKey ? "已复制" : "复制")
            ),
            h("div", { className: "dru-access-flex" },
              h("div", { className: "dru-access-col", style: { alignItems: "center" } },
                akey.qr_data_url
                  ? h("img", { className: "dru-qr-img", src: akey.qr_data_url, alt: "远程访问二维码" })
                  : h("div", { className: "dru-qr-ph" }, "二维码生成中 / 暂不可用\n链接仍可复制或直接打开"),
                h("div", { className: "dru-cd" + (remainMs > 0 ? " dru-cd-ok" : "") },
                  "有效至 " + fmtClock(akey.expires_at) + " · 剩余 " + fmtRemain(remainMs))
              ),
              h("div", { className: "dru-access-col" },
                h("div", { className: "dru-key-note" },
                  "扫码即进入，30 分钟有效、用一次即失效。"),
                h("div", { className: "dru-actions", style: { marginTop: 2 } },
                  h("button", { type: "button", className: "dru-btn dru-btn-primary", disabled: akeyBusy, onClick: openKeyUrl }, "直接打开"),
                  h("button", { type: "button", className: "dru-btn dru-btn-ghost", disabled: akeyBusy, onClick: loadAccessKey }, akeyBusy ? "生成中…" : "刷新二维码/访问链接")
                ),
                h("div", { className: "dru-hint", style: { marginTop: 4 } },
                  !serviceRunning
                    ? (connInfo && connPhase !== "online"
                        ? "本机后台服务正在自动准备中（" + connText + "）：连上后这个链接/二维码即可使用，无需其他操作。"
                        : "本机后台服务未运行：先在下方「🖥 后台服务」卡启动。")
                    : "打开链接/扫码进入即登录态；同设备重复扫码只更新授权，不新增设备。")
              )
            )
          ]) : h("div", null, [
            h("div", { className: "dru-hint", style: { marginTop: 6 } },
              loggedInSaaS
                ? "正在生成一次性访问链接…（手机或另一台电脑扫码/打开即可进入）"
                : "登录下方「🔑 账号」卡片中的手机号账号后，即可生成一次性访问链接，让手机或另一台电脑远程使用同一份 dsh web。"),
            h("div", { className: "dru-actions", style: { marginTop: 8 } },
              h("button", { type: "button", className: "dru-btn dru-btn-primary", disabled: akeyBusy, onClick: loadAccessKey },
                akeyBusy ? "生成中…" : "生成访问链接")
            )
          ])
        ]);
      }

      // ---------- 📲 已授权设备卡（展开列表 + 行内 取消配对/删除记录 + 底部 清理已解绑） ----------
      function deviceLabel(s) {
        if (s && s.label) return String(s.label);
        var parts = [];
        if (s && s.os) parts.push(String(s.os));
        if (s && s.browser) parts.push(String(s.browser));
        return parts.length ? parts.join(" ") : "未知设备";
      }
      function deviceMeta(s) {
        var parts = [];
        if (s && s.os) parts.push(String(s.os));
        if (s && s.browser) parts.push(String(s.browser));
        return parts.join(" · ");
      }
      function renderDeviceList() {
        if (devSessions === null) {
          return h("div", { className: "dru-hint" }, devBusy === "list" ? "正在加载已授权设备…" : "加载已授权设备中，请稍候或点上方按钮重试");
        }
        if (devSessions.length === 0) {
          return h("div", { className: "dru-fb-empty" }, "暂无已授权设备（手机扫码后出现）");
        }
        var revokedCount = devSessions.filter(function (s) { return !!(s && s.revoked_at); }).length;
        return h("div", null, [
          devSessions.map(function (s) {
            var id = s && s.id;
            var revoked = !!(s && s.revoked_at);
            return h("div", { key: id, className: "dru-dev" },
              h("div", { className: "dru-dev-top" },
                h("span", { className: "dru-dev-name" }, deviceLabel(s)),
                deviceMeta(s) ? h("span", { className: "dru-dev-meta" }, deviceMeta(s)) : null,
                revoked ? h("span", { className: "dru-dev-tag dru-dev-tag-off" }, "已取消配对") : null
              ),
              h("div", { className: "dru-dev-sub" },
                "首次配对 " + fmtDT(s && s.created_at) +
                (s && s.last_seen_at ? " · 最近活跃 " + fmtDT(s.last_seen_at) : "") +
                (revoked ? " · 取消于 " + fmtDT(s.revoked_at) : "")
              ),
              h("div", { className: "dru-actions", style: { marginTop: 8 } },
                revoked ? null : h("button", {
                  type: "button",
                  className: "dru-btn dru-btn-danger",
                  disabled: devBusy !== "",
                  onClick: function () { doRevokeDevice(id); }
                }, devBusy === "revoke:" + id ? "取消中…" : armedDev === id ? "⚠ 再点一次确认取消配对" : "取消配对"),
                h("button", {
                  type: "button",
                  className: "dru-btn dru-btn-ghost",
                  style: { color: "var(--dru-danger)", borderColor: "var(--dru-danger)" },
                  disabled: devBusy !== "",
                  onClick: function () { doDeleteDevice(id); }
                }, devBusy === "delete:" + id ? "删除中…" : armedDel === id ? "⚠ 再点一次确认删除记录" : "删除记录")
              )
            );
          }),
          h("div", { className: "dru-hint", style: { marginTop: 4 } },
            "取消配对后，对方需重新扫码/登录才能再次远程访问本机。"),
          h("div", { className: "dru-actions", style: { marginTop: 8, borderTop: "1px dashed var(--dru-border-soft)", paddingTop: 8 } },
            h("button", {
              type: "button",
              className: "dru-btn dru-btn-ghost",
              disabled: devBusy !== "" || revokedCount === 0,
              onClick: doPurgeDevices,
              title: revokedCount > 0 ? ("清理 " + revokedCount + " 条已解绑记录") : "没有已解绑记录"
            }, devBusy === "purge" ? "清理中…" : purgeArmed ? "⚠ 再点一次确认清理已解绑" : "清理已解绑" + (revokedCount > 0 ? "（" + revokedCount + "）" : ""))
          )
        ]);
      }
      function renderDevicesCard() {
        var count = devSessions === null ? null : devSessions.length;
        var btnLabel = devOpen
          ? "收起已授权设备列表"
          : "已授权设备 " + (count === null ? "…" : count) + "（点击展开管理）";
        return card("📲 已授权设备", [
          h("div", { className: "dru-actions", style: { marginTop: 2 } },
            h("button", {
              type: "button",
              className: "dru-btn dru-btn-ghost",
              style: { width: "100%" },
              disabled: devBusy !== "",
              onClick: toggleDevices
            }, devBusy === "list" ? "加载中…" : btnLabel)
          ),
          devOpen ? renderDeviceList() : null,
          devMsg
            ? h("div", { className: "dru-msg dru-msg-" + devMsg.kind, style: { marginTop: 6 } },
                devMsg.text,
                devMsg.retry
                  ? h("button", { type: "button", className: "dru-linkbtn", style: { marginLeft: 8 }, disabled: devBusy !== "", onClick: devMsg.retry }, devBusy === "list" ? "重试中…" : "立即重试")
                  : null)
            : null
        ]);
      }

      // ---------- 主视图 ----------
      /**
       * 主 Tab 的公共属性：视觉态（.active）与语义态（aria-selected）**同源**，不会说一套做一套；
       * tabIndex=0 + Enter/Space → 键盘可操作（主 Tab 是面板的导航，不能只能点鼠标）。
       * ⚠️ 与既有 tab 条（登录/注册、反馈 tab）保持同一形态：可点的 <div>，不改成 <button>
       *    （那些 tab 已经是这样；换形态会让同一种控件在面板里出现两种外观与焦点行为）。
       * 无障碍：文字标签**始终在**（选中态另有 border + 底色），不靠颜色单独表意。
       */
      function mainTabProps(active, onPick) {
        return {
          className: "dru-tab" + (active ? " active" : ""),
          role: "tab",
          "aria-selected": active ? "true" : "false",
          tabIndex: 0,
          onClick: onPick,
          onKeyDown: function (e) {
            var k = e && e.key;
            if (k === "Enter" || k === " " || k === "Spacebar") { e.preventDefault(); onPick(); }
          }
        };
      }
      /**
       * 主 Tab 条（☁️ 云端服务 / 🖥 自建服务 / 💬 微信机器人通道）。
       *
       * ⚠️ 必须抽成函数、由 **home 与 wechat 两个视图共用**：这条 strip 原来长在 renderHome() 里，
       *    而切到微信 tab 后 renderHome() 不再渲染 —— 只长在 renderHome() 里就等于「进了微信页
       *    就再也回不去」（面板只有一个 settings.section 栏目，没有别的返回入口）。
       *
       * 选中态：模式两个 tab 只在 view !== "wechat" 时选中；微信 tab 只在 view === "wechat" 时选中。
       * 点模式 tab 时一并把 view **复位成 home**（否则从微信页点「自建服务」会切了 mode 却留在微信页）。
       *
       * 🔒 登录门（业主口径：微信通道**要求已注册并登录**）：未登录时**不渲染**这第三个 tab。
       *    登录态来自 st.config（phone / hasLocalKey），登录成功后 st 更新即重新渲染 ——
       *    tab 当场出现，**不需要刷新页面**；登出/会话过期则当场消失（view 的兜底见 RemoteControlSection
       *    里那条复位 effect 与底部的 view 分派）。除登录态外，不为任何其它理由隐藏它。
       */
      function renderMainTabs() {
        var isLocal = mode === "local";
        var onWeChat = view === "wechat";
        return h("div", { className: "dru-tabs", style: { marginTop: 4 }, role: "tablist", "aria-label": "远程访问功能切换" },
          h("div", mainTabProps(!onWeChat && !isLocal, function () { setMode("saas"); setView("home"); setMessage(null); }), "☁️ 云端服务"),
          h("div", mainTabProps(!onWeChat && isLocal, function () { setMode("local"); setView("home"); setMessage(null); }), "🖥 自建服务"),
          // 微信绿泡泡：纯装饰（可读名字来自同 tab 的文字标签），所以 aria-hidden；
          // U+FE0E（变体选择符-15）强迫 💬 走**文字字形**，否则系统彩色 emoji 会忽略 color（见 .dru-wx-ico）。
          // 🔒 只有已登录才渲染这个 tab（见上面的登录门说明）。
          loggedIn
            ? h("div", mainTabProps(onWeChat, function () { setView("wechat"); setMessage(null); }),
                h("span", { className: "dru-wx-ico", "aria-hidden": "true" }, "💬\uFE0E"),
                "微信机器人通道")
            : null
        );
      }
      /** 微信机器人 tab 的内容：直接复用 WeChatBotSection（embedded=省掉外层 settings-section 壳）。 */
      function renderWeChat() {
        return h("div", null,
          renderMainTabs(),
          h(WeChatBotSection, { embedded: true })
        );
      }
      function renderHome() {
        var isLocal = mode === "local";
        return h("div", null,
          // 连接模式主 Tab(云端服务 / 自建服务 / 微信机器人通道；最后一个是 0.6.11 从独立栏目搬进来的)
          renderMainTabs(),
          // 云端 tab：📱 远程访问（一次性扫码访问 + 已授权设备）+ 账号（手机号登录，官方托管）
          !isLocal ? h("div", null,
            renderAccessCard(),
            // 已授权设备：仅登录后展示（登录前不显示，避免空列表/误导）
            loggedIn && st.config.phone ? renderDevicesCard() : null,
            card("🔑 账号",
              st === null
                ? h("div", { className: "dru-hint" }, "正在读取远控状态…")
                : loggedIn && st.config.phone
                  ? renderAccount()
                  : h("div", null,
                      h("div", { className: "dru-tabs" },
                        h("div", { className: "dru-tab" + (authTab === "login" ? " active" : ""), onClick: function () { setAuthTab("login"); setPwdOpen(false); setMessage(null); } }, "登录"),
                        h("div", { className: "dru-tab" + (authTab === "register" ? " active" : ""), onClick: function () { setAuthTab("register"); setPwdOpen(false); setMessage(null); } }, "注册")
                      ),
                      authTab === "login"
                        ? (pwdOpen
                            // 「忘记密码」展开：与账号卡「修改密码」共用同一重置表单（手机号可编辑、预填登录输入）
                            ? renderResetPwdForm(true)
                            : h("div", null,
                                field("手机号", input({ type: "tel", value: phone, placeholder: "11 位手机号", autoComplete: "tel", onChange: function (e) { setPhone(e.target.value); } })),
                                field("密码", input({ type: "password", value: pass, placeholder: "密码", autoComplete: "current-password", onChange: function (e) { setPass(e.target.value); } })),
                                field("验证码", h("div", { className: "dru-captcha" },
                                  input({ value: lcapTxt, placeholder: "图中数字", autoComplete: "off", inputMode: "numeric", maxLength: 6, onChange: function (e) { setLcapTxt(e.target.value); } }),
                                  h("div", { className: "dru-captcha-box", title: "看不清？点击刷新", onClick: function () { loadCaptcha("login"); }, dangerouslySetInnerHTML: lcap && lcap.svg && lcap.svg.indexOf("<svg") === 0 ? { __html: lcap.svg } : void 0 },
                                    lcap && lcap.svg && lcap.svg.indexOf("<svg") !== 0 ? lcap.svg : null)
                                )),
                                h("button", { type: "button", className: "dru-btn dru-btn-primary", style: { width: "100%" }, disabled: busy !== "", onClick: doLogin }, busy === "login" ? "登录中…" : "登录"),
                                // 忘记密码：小字入口，点击展开短信验证码重置表单（不抢占任何官方按钮）
                                h("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: 8 } },
                                  h("button", { type: "button", className: "dru-linkbtn", disabled: busy !== "", onClick: togglePwdForm }, "忘记密码？"))
                              )
                          )
                        : h("div", null,
                            field("手机号", input({ type: "tel", value: rphone, placeholder: "11 位手机号", autoComplete: "tel", onChange: function (e) { setRphone(e.target.value); } })),
                            field("密码", input({ type: "password", value: rpass, placeholder: "至少 8 位", autoComplete: "new-password", onChange: function (e) { setRpass(e.target.value); } })),
                            field("确认密码", input({ type: "password", value: rpass2, placeholder: "再次输入密码", autoComplete: "new-password", onChange: function (e) { setRpass2(e.target.value); } })),
                            field("邀请码（选填）", input({ value: rInvite, placeholder: "邀请你的人的邀请码，如 A8K2M4XQ", autoComplete: "off", onChange: function (e) { setRInvite(e.target.value); } })),
                            rcap && field("图形验证码", h("div", { className: "dru-captcha" },
                              input({ value: rcapTxt, placeholder: "图中数字", autoComplete: "off", inputMode: "numeric", maxLength: 6, onChange: function (e) { setRcapTxt(e.target.value); } }),
                              h("div", { className: "dru-captcha-box", title: "看不清？点击刷新", onClick: function () { loadCaptcha("register"); }, dangerouslySetInnerHTML: rcap.svg && rcap.svg.indexOf("<svg") === 0 ? { __html: rcap.svg } : void 0 },
                                rcap.svg && rcap.svg.indexOf("<svg") !== 0 ? rcap.svg : null)
                            )),
                            field("短信验证码", h("div", { className: "dru-captcha" },
                              input({ value: rsms, placeholder: "6 位验证码", autoComplete: "off", inputMode: "numeric", maxLength: 6, onChange: function (e) { setRsms(e.target.value); } }),
                              h("button", { type: "button", className: "dru-btn dru-btn-ghost", style: { flex: "none", padding: "0 14px" }, disabled: busy !== "", onClick: sendRegSms }, rsmsBtn)
                            )),
                            h("button", { type: "button", className: "dru-btn dru-btn-primary", style: { width: "100%" }, disabled: busy !== "", onClick: doRegister }, busy === "register" ? "注册中…" : "注册")
                          ),
                      message && h("div", { className: "dru-msg dru-msg-" + message.kind }, message.text)
                    )
            )
          ) : card("🔌 自建服务",
            st && st.config && st.config.mode === "local"
              ? h("div", null,
                  h("div", { className: "dru-status-line" },
                    h("span", { className: "dru-dot dru-dot-on" }),
                    h("span", null, "已连接 " + (st.config.selfHostUrl || "自建服务"))
                  ),
                  h("div", { className: "dru-hint", style: { marginTop: 6 } },
                    "当前使用自建服务（本地认证，无需手机号账号）。切换到云端：在上方「云端服务」标签用手机号账号登录即可。")
                )
              : h("div", null,
                  field("服务器地址", input({ value: selfHost, placeholder: "my.example.com:13443", onChange: function (e) { setSelfHost(e.target.value); } })),
                  field("访问密钥", input({ type: "password", value: localKey, placeholder: "自建服务的访问密钥", autoComplete: "off", onChange: function (e) { setLocalKey(e.target.value); } })),
                  h("button", { type: "button", className: "dru-btn dru-btn-primary", style: { width: "100%" }, disabled: busy !== "", onClick: saveLocal }, busy === "local" ? "保存中…" : "切换到自建服务"),
                  h("div", { className: "dru-hint", style: { marginTop: 6 } },
                    "服务器地址由你自行部署决定：填写你自建的 dsh-remote 服务地址与访问密钥即可（不是上面的云端地址）。部署方法见 README「自建部署」一节；切回云端随时可登录恢复。")
                )
          ),
          // 后台服务（原「Bridge 服务」：面向非技术用户统一叫「后台服务」，卡内配一句人话解释）
          card("🖥 后台服务",
            h("div", { className: "dru-status-line" },
              h("span", { className: "dru-dot " + (serviceRunning ? "dru-dot-on" : "dru-dot-off") }),
              h("span", null, st ? serviceStateText : "查询中…"),
              launchdPid ? h("span", { className: "dru-meta", style: { marginTop: 0 } }, "(pid=" + launchdPid + ")") : null
            ),
            h("div", { className: "dru-hint", style: { marginTop: 6 } },
              "「后台服务」＝装在这台电脑上、负责把手机和电脑连起来的小程序（内部名 bridge）。面板会自动安装、自动启动，一般不需要你手动操作；只有状态一直停在「已停止」时才需要点下面的按钮。"),
            // 自动连接进度（登录后由面板 2.5s 短轮询自动推进）：让用户在 bridge 卡也能一眼看到
            // 「到底走到哪一步了」——进程在跑≠能用，注册到中继才算。
            connInfo && connPhase && connPhase !== "no_account"
              ? h("div", { className: "dru-hint", style: { marginTop: 6 } }, "自动连接进度：" + connText)
              : null,
            h("div", { className: "dru-actions", style: { marginTop: 10 } },
              !serviceRunning
                ? h("button", { type: "button", className: "dru-btn dru-btn-primary", disabled: busy !== "", onClick: function () { toggleBridge(true); } }, busy === "start" ? "启动中…" : "启动后台服务")
                : h("button", { type: "button", className: "dru-btn dru-btn-danger", disabled: busy !== "", onClick: function () { toggleBridge(false); } }, busy === "stop" ? "停止中…" : "停止后台服务")
            ),
            h("div", { className: "dru-meta" }, st && st.config && st.config.deviceId ? "设备 ID：" + st.config.deviceId : "设备 ID：生成中"),
            h("div", { className: "dru-meta" }, st ? (st.service && (st.service.plistExists || st.service.serviceManager === "detached")
              ? (st.service.serviceManager === "detached"
                ? (st.service.autostartTask
                    ? "自启动：已注册登录任务（任务计划程序 dsh-remote-bridge）"
                    : "自启动：未注册登录任务（由面板在 dsh web 启动时自动拉起后台服务）")
                : "自启动服务已安装")
              : "自启动服务未安装（启动时自动创建）") : ""),
            // 0.6.2：把「运行环境缺失 / launchd 崩溃循环」如实告诉用户，而不是显示「运行中」
            st && !serviceRuntimeReady
              ? h("div", { className: "dru-hint", style: { marginTop: 8 } },
                  "🛠 在插件市场搜索「dsh-remote-web」装上的只是「面板插件」，这台电脑上的后台服务需要额外补装——已自动在后台安装，装完会自动启动，不用做任何操作。若超过几分钟仍未变成「运行中」，点上方版本卡的「一键更新」手动补全即可。")
              : serviceCrashing
                ? h("div", { className: "dru-hint", style: { marginTop: 8 } },
                    "⚠️ 上一次启动失败（自启动入口失效），已自动清理失效自启动项并重新补装运行环境。稍候会自动恢复；仍失败请点「一键更新」。")
                : null,
            st && st.service && st.service.bindError
              ? h("div", { className: "dru-msg dru-msg-err", style: { marginTop: 8 } },
                  "⚠️ 设备注册失败：" + (st.service.bindError.message || "未说明原因"),
                  h("div", { className: "dru-hint", style: { marginTop: 4 } },
                    st.service.bindError.code === "device_limit_exceeded"
                      ? "已达本套餐设备数上限。若是同一台电脑重装，稍等片刻会自动顶替旧设备；仍未恢复请在手机端「设备管理」解绑旧设备（免费用户每月可解绑 3 次）后，回到这里点「启动后台服务」。"
                      : "请确认网络与账号状态后重试；仍未解决可点下方「彻底卸载」后重新安装。")
                )
              : null
          ),
          // 关于 dsh-remote（v0.5+ 远程访问价值说明卡片）
          card("📖 关于 dsh-remote", [
            // 一句话定位（面向非技术用户先讲清楚"这是什么"），下面 4 条为既有技术说明（文案受源码契约锁定）
            h("div", { className: "dru-hint", style: { marginBottom: 6 } }, "📱 一句话：用手机随时接管这台电脑上的 DeepSeek Harness——装上即得专属加密地址，人在外面也能全功能操作（免内网穿透、免公网 IP、全程加密）。"),
            h("div", { className: "dru-hint", style: { marginBottom: 6 } }, "📱 远程访问：用手机或另一台电脑的浏览器，随时随地使用同一份 dsh web——人在哪都能用（免公网 IP、免内网穿透）；官方托管中继，4G/5G 即用，也可自建服务。"),
            h("div", { className: "dru-hint", style: { marginBottom: 6 } }, "🛠 电脑端一键安装：bridge 与「远程访问」面板一次到位——云端/自建切换、账号登录、bridge 启停、一次性扫码访问、已授权设备管理、意见反馈都在这里。"),
            h("div", { className: "dru-hint", style: { marginBottom: 6 } }, "🔒 安全与通道：HTTP / WebSocket 全量透传，一次性访问密钥认证，面板实时显示设备与已授权设备列表。"),
            h("div", { className: "dru-hint" }, "🛡 端到端加密：手机↔电脑之间的消息内容用「你的账号密码派生密钥」端到端加密——密钥与密码不落服务端（仅存校验值），中继只可见路径/大小/时间（详见 README「安全与隐私」）。"),
            // 匿名装机统计（隐私披露）：开源项目必须把「采什么 / 不采什么 / 怎么关」写在用户看得到的地方。
            // 只保留结论式的说明句:不再单列「隐私说明: README… · docs/telemetry.md」那一行文档链接
            // (面板里堆文档链接既占地方又不像产品文案;完整字段清单在仓库 docs/telemetry.md)。
            h("div", { className: "dru-hint", style: { marginTop: 6 } },
              "📊 匿名装机统计：只上报「装机/连接是否成功」这类事件（安装开始与失败原因、后台服务是否注册成功、是否首次远程打通）——"
              + "不含任何账号、手机号、会话或文件内容、主机名、路径、设备指纹与 IP；标识是本机随机 ID（重装即变）。"
              + "用环境变量 DSH_REMOTE_TELEMETRY=0 可完全关闭（不生成 ID、不发任何请求）。"),
            // 加入交流群（后台上传二维码后出现；点击弹出二维码大图便于扫码）
            community && community.qrcode
              ? h("div", { className: "dru-actions", style: { marginTop: 10 } },
                  h("button", {
                    type: "button",
                    className: "dru-btn dru-btn-ghost",
                    style: { width: "100%" },
                    onClick: function () { setCommOpen(true); }
                  }, "💬 加入交流群"))
              : null
          ]),
          // 版本与更新（自管理：检测新版 / 一键在线更新 / 彻底卸载）
          h(SelfManageCard, null),
          message && h("div", { className: "dru-msg dru-msg-" + message.kind }, message.text)
        );
      }

      // 【自动化】待重启时自动倒计时重启(见 autoRestartCancelled 说明);倒计时只在面板可见且无其他操作时推进。
      // ⚠️ isRefreshOnly(插件更新后只需刷新)时**不**自动重启:刷新是零风险动作,重启 dsh web 会打断
      // 用户正在进行的会话,不能替他做这个决定 —— 让他点「刷新页面」即可。
      useEffect(function () {
        if (!restartPending || isRefreshOnly || busy !== "" || restartCancelled) { setRestartCountdown(null); return undefined; }
        var at = restartInfo.at || 0;
        if (autoRestartCancelled(at)) { setRestartCountdown(null); return undefined; }
        var left = Math.round(AUTO_RESTART_DELAY_MS / 1000);
        setRestartCountdown(left);
        var iv = setInterval(function () {
          if (document.hidden) return; // 用户没在看 → 暂停计时
          left -= 1;
          if (left > 0) { setRestartCountdown(left); return; }
          clearInterval(iv);
          setRestartCountdown(0);
          restartHarness(); // 已有实现:重启 + 轮询等它回来 + 自动刷新页面
        }, 1000);
        return function () { clearInterval(iv); };
      }, [restartPending, isRefreshOnly, restartInfo.at, busy, restartCancelled]);

      /** 取消本次自动重启(按事件持久化:同一 pending 事件不再自动重启)。 */
      var cancelAutoRestart = function () {
        markAutoRestartCancelled(restartInfo.at || 0);
        setRestartCancelled(true);
        setRestartCountdown(null);
      };

      /** 交流群弹窗（复用满意度弹窗的 dru-popup 视觉；点遮罩/关闭即收起）。 */
      function renderCommunityModal() {
        if (!commOpen || !(community && community.qrcode)) return null;
        var close = function () { setCommOpen(false); };
        return h("div", { className: "dru-popup", "data-dru-theme": theme, onMouseDown: function (e) { if (e.target === e.currentTarget) close(); } },
          h("div", { className: "dru-popup-card", role: "dialog", "aria-label": "加入企微交流群" },
            h("div", { className: "dru-popup-body" },
              h("div", { className: "dru-popup-icon" }, "💬"),
              h("div", { className: "dru-popup-title" }, "加入企微交流群"),
              h("div", { className: "dru-popup-sub" }, "扫码入群：安装答疑 / 使用技巧 / 版本更新 / 问题反馈"),
              h("img", { className: "dru-community-qr", src: community.qrcode, alt: "企微交流群二维码" }),
              community.wechat
                ? h("div", { className: "dru-hint", style: { marginTop: 10 } }, "二维码失效或群满，可加客服微信：" + community.wechat)
                : h("div", { className: "dru-hint", style: { marginTop: 10 } }, "二维码失效或群满，可到 GitHub 提 Issue 联系作者")
            ),
            h("div", { className: "dru-popup-foot" },
              h("span", null, "手机微信/企业微信扫码即可入群"),
              h("button", { type: "button", onClick: close }, "关闭")
            )
          )
        );
      }

      return h("div", { className: "dru-settings-section", role: "region", "aria-label": "远程访问", "data-dru-theme": theme },
        h("div", { className: "dru-settings-head" },
          h("span", { className: "dru-settings-icon" }, "📱"),
          h("div", null,
            h("h2", { className: "dru-settings-title" }, "远程访问"),
            h("div", { className: "dru-settings-sub" }, "通过手机或另一台电脑远程使用同一份 dsh web，人在哪都能用（免公网 IP）"),
            h("div", { className: "dru-settings-sub" }, "装上即得专属加密地址：人在外面也能用手机全功能接管这台电脑上的 DeepSeek Harness（免内网穿透、免公网 IP、全程加密）。")
          )
        ),
        h("div", { className: "dru-settings-body" },
          restartPending
            ? h("div", { className: "dru-restart-alert", role: "status" },
                h("span", { className: "dru-restart-alert-icon" }, "🔔"),
                h("div", { style: { flex: "1" } },
                  h("div", { className: "dru-restart-alert-title" },
                    // 插件已改为 patch 热加载:装插件/在线更新都不再需要重启 harness,
                    // 唯一要用户动一下的情形是"插件文件在运行中被改写"→ 刷新页面即可。
                    isRefreshOnly ? "插件已更新，刷新页面即可生效" : "需要重启 dsh web 才能载入新插件"),
                  h("div", { className: "dru-restart-alert-sub" },
                    isRefreshOnly
                      ? "刚装好/刚更新的插件已在磁盘上，浏览器里的面板还是旧版本。刷新一下这个页面即可（手机端连接与已登录状态都不受影响）。"
                      : "当前运行中的 dsh web 里还没有载入这个插件。先刷新页面；如果刷新后仍然看不到面板，再重启一次 dsh web。"),
                  // 【自动化】待重启时自动倒计时重启(用户零操作);倒计时期间可一键取消
                  restartCountdown !== null && restartCountdown > 0
                    ? h("div", { className: "dru-restart-auto", role: "status" },
                        h("span", { className: "loading" }),
                        h("span", null, "安装已完成，将在 " + restartCountdown + " 秒后自动重启 DeepSeek harness（页面会自动恢复，无需操作）"))
                    : null,
                  restartCountdown === 0
                    ? h("div", { className: "dru-restart-auto", role: "status" }, h("span", { className: "loading" }), h("span", null, "正在自动重启…"))
                    : null,
                  restartCancelled && restartCountdown === null
                    ? h("div", { className: "dru-restart-auto muted" }, "已取消自动重启 —— 你也可以随时点下面的按钮完成安装")
                    : null,
                  h("div", { className: "dru-actions", style: { marginTop: 10 } },
                    isRefreshOnly
                      ? h("button", {
                          type: "button",
                          className: "dru-btn dru-btn-primary",
                          onClick: function () { try { location.reload(); } catch (e) { /* 忽略 */ } }
                        }, "刷新页面")
                      : null,
                    h("button", {
                      type: "button",
                      className: "dru-btn " + (isRefreshOnly ? "dru-btn-ghost" : "dru-btn-primary"),
                      disabled: busy !== "",
                      onClick: function () { restartHarness(); }
                    }, busy === "restart" ? "重启中…" : (restartCountdown !== null && restartCountdown > 0 ? "立即重启（不用等）" : "重启 dsh web")),
                    restartCountdown !== null && restartCountdown > 0
                      ? h("button", {
                          type: "button",
                          className: "dru-btn dru-btn-ghost",
                          onClick: cancelAutoRestart
                        }, "取消自动重启")
                      : null
                  )
                )
              )
            : null,
          // view 分派：wechat（第三个主 tab，内容自带 tab 条）| feedback | invite | home
          // 🔒 微信通道要求已登录：若 view 还停在 "wechat" 而登录态已失效（会话中途过期），
          //    这里**直接回落到 home**（渲染账号/登录卡）—— 绝不留一个空面板；上一条 effect
          //    会把 view 正式复位成 home，两者一致。
          view === "wechat" && loggedIn ? renderWeChat()
            : view === "wechat" ? renderHome()
            : view === "feedback" ? renderFeedback()
            : view === "invite" ? renderInvite()
            : renderHome()
        ),
        // 常驻入口最底部：「重启 DeepSeek harness」按钮始终可达（首次安装/更新/排查都用它）
        h("div", { className: "dru-restart-foot" },
          h("div", { className: "dru-hint" }, "重启 dsh web：仅在「刷新页面后仍看不到面板」时才需要。日常安装/更新插件已自动热加载，装完刷新页面即可；重启只影响 dsh web 本身，不影响后台服务与手机端连接。"),
          h("button", {
            type: "button",
            className: "dru-btn " + (restartPending ? "dru-btn-primary" : "dru-btn-ghost"),
            disabled: busy !== "",
            onClick: function () { restartHarness(); }
          }, busy === "restart" ? "重启中…" : "🔄 重启 dsh web")
        ),
        renderCommunityModal()
      );
    }

    // ══ 🤖 微信机器人（「📱 远程访问」面板里的第三个 tab：微信机器人通道） ═════════
    // 【0.6.11 业主口径】「不要给它单独弄一个菜单，直接放到面板里面。在面板里单开一个
    // table 页，命名为『微信机器人通道』，并增加上微信的绿泡泡小图标，点开后可以进行绑定设置。」
    // → 不再注册第二个 settings.section 栏目（只有 📱 远程访问 一个），本组件由 renderWeChat()
    //    以 embedded=true 作为**子组件**渲染（见 renderMainTabs / renderWeChat）。
    // 数据全部来自同源 /dsh-remote/wechat/*（宿主半边代理 bridge 的控制面）。
    //
    // ⚠️ 令牌铁律：本组件**只**渲染 bridge 已脱敏的字段；不请求、不拼接、不缓存任何 token
    //    （宿主半边还有第二道按键名过滤，见 lib/index.js 的 scrubWeChatTokens）。
    // ⚠️ 状态模型（规格 §9）：只有**两态** —— 已绑定 / 未绑定。last_error / channel_running /
    //    cooldown_ms 只是**提示**，绝不渲染成第三种绑定状态（否则用户会以为要重新绑定）。
    // ⚠️ 主题不变量：--dru-* 令牌只声明在 .dru-settings-section / .dru-popup / .dru-nav-remote 上。
    //    · 独立态（embedded=false）：本组件就是那个根 → 必须 className=dru-settings-section + data-dru-theme；
    //    · 内嵌态（embedded=true）：外层 .dru-settings-section 是 RemoteControlSection 的根（已带
    //      data-dru-theme），这里**再嵌一层 settings-section 就是套娃**（嵌套 region + 双份内边距），
    //      所以省掉外壳与标题行；令牌照旧从外层祖先继承，不新增任何令牌声明点。
    var WECHAT_STATUS_PATH = "/dsh-remote/wechat/status";
    var WECHAT_POLL_INTERVAL_MS = 1500;
    /** 面板侧请求超时：必须**大于**宿主代理给 bind/poll 的 40s，否则面板会先掐掉一次正常的等待扫码。 */
    var WECHAT_POLL_TIMEOUT_MS = 45000;
    /**
     * 见到这些状态即**停止**绑定轮询：
     *   · confirmed / already_bound / failed —— 有结论了；
     *   · expired / verify_code_blocked / expired-giveup / verify-blocked —— bridge 已在内部换过
     *     新二维码（或已放弃），面板手里这张已经作废、用户扫不出任何东西。继续轮询等于等一个
     *     不可能发生的扫码，所以改为「如实告知 + 给一个刷新二维码的按钮」。
     *   · idle —— bridge 侧已经没有进行中的绑定。
     * 未列出的状态（wait / scaned / need_verifycode / unknown…）继续轮询；unknown 按可重试处理（§3）。
     */
    var WECHAT_POLL_STOP = ["idle", "confirmed", "already_bound", "failed", "expired", "expired-giveup", "verify-blocked", "verify_code_blocked"];

    /** 绑定阶段 → 人话（每句自带文字结论，不靠颜色单独表意）。 */
    function wechatPhaseText(phase) {
      switch (phase) {
        case "wait": return "等待手机扫码…";
        case "scaned": return "已扫码，请在手机上点「确认」；手机若显示了数字配对码，请填到下面。";
        case "need_verifycode": return "请在手机上查看数字配对码，填到下面并提交。";
        case "confirmed": return "绑定成功。";
        case "already_bound": return "这个微信机器人以前绑过，已视为绑定成功。";
        case "expired": return "二维码已过期（后台服务已自动换过一张，你手上这张已作废）。";
        case "expired-giveup": return "二维码连续失效，绑定流程已停止。";
        case "verify-blocked": return "配对码多次不正确，绑定流程已停止。";
        case "verify_code_blocked": return "配对码不正确，请输入手机上最新显示的那一串数字。";
        case "unknown": return "对方返回了无法识别的状态，还在继续等待…";
        default: return "正在进行绑定…";
      }
    }

    /** 把宿主半边的失败体解出来：code 用于分流，text 是给人看的原文（宿主已逐种情形写了人话）。 */
    function wechatErrOf(e) {
      var body = e && e.body;
      return {
        code: body && body.code ? String(body.code) : "",
        text: (e && e.message) ? String(e.message) : "本机后台服务没有响应，请稍后重试。"
      };
    }

    /** 时间戳 → 本地可读时间（拿不到就空串，绝不显示 Invalid Date）。 */
    function wechatTimeText(ms) {
      var n = Number(ms);
      if (!Number.isFinite(n) || n <= 0) return "";
      try { return new Date(n).toLocaleString(); } catch (e) { return ""; }
    }

    /** 冷却剩余毫秒 → 「约 N 分钟」（快照值；状态刷新时更新）。 */
    function wechatCooldownText(ms) {
      var n = Number(ms);
      if (!Number.isFinite(n) || n <= 0) return "";
      if (n < 60_000) return "不到 1 分钟";
      return "约 " + Math.round(n / 60_000) + " 分钟";
    }

    /**
     * 🤖 微信机器人绑定面板。
     * @param {{embedded?: boolean}} [props] embedded=true（远程访问面板里的「微信机器人通道」tab）
     *   → 省掉外层 .dru-settings-section 壳与标题行（避免 settings-section 套娃）；默认独立渲染。
     *   ⚠️ embedded **只**影响返回的 JSX，绝不影响 hooks：hooks 全部无条件、两态同一顺序
     *   （在 hooks 之前 early return 会让 hook 序号错位 —— 那是 React 的硬错误）。
     */
    function WeChatBotSection(props) {
      var embedded = !!(props && props.embedded);

      // 🎨 主题：必须是**第一个** hook（与 RemoteControlSection 同款）—— 根节点的 data-dru-theme
      // 决定整套 --dru-* 令牌走深色还是亮色；放在其它 hook 之前可保证 hook 序号稳定。
      var theme = useSyncExternalStore(themeSubscribe, themeGet);

      var stArr = useState(null); var wx = stArr[0]; var setWx = stArr[1];              // /wechat/status 的脱敏字段
      var loadArr = useState(true); var loading = loadArr[0]; var setLoading = loadArr[1];
      var failArr = useState(null); var fail = failArr[0]; var setFail = failArr[1];    // {code,text} 代理失败
      var bindArr = useState(null); var bind = bindArr[0]; var setBind = bindArr[1];    // {svg,url,message} 正在绑定
      var phaseArr = useState(""); var phase = phaseArr[0]; var setPhase = phaseArr[1]; // wait|scaned|need_verifycode|…
      var askArr = useState(false); var askCode = askArr[0]; var setAskCode = askArr[1]; // 是否弹配对码输入
      var codeArr = useState(""); var verifyCode = codeArr[0]; var setVerifyCode = codeArr[1];
      var pauseArr = useState(false); var pollPaused = pauseArr[0]; var setPollPaused = pauseArr[1];
      var busyArr = useState(""); var busy = busyArr[0]; var setBusy = busyArr[1];
      var msgArr = useState(null); var message = msgArr[0]; var setMessage = msgArr[1]; // {kind,text}
      var okArr = useState(false); var confirmUnbind = okArr[0]; var setConfirmUnbind = okArr[1];
      var tickArr = useState(0); var tick = tickArr[0]; var setTick = tickArr[1];       // 递增即重新拉状态

      var refresh = useCallback(function () { setTick(function (n) { return n + 1; }); }, []);

      // 拉状态：读不到就**如实报错**（含 code），绝不无限转圈 —— 控制面缺失/版本旧是必然会遇到的情况。
      useEffect(function () {
        var alive = true;
        setLoading(true);
        api(WECHAT_STATUS_PATH).then(function (b) {
          if (!alive) return;
          setWx(b && typeof b === "object" ? b : {});
          setFail(null);
        }).catch(function (e) {
          if (!alive) return;
          setWx(null);
          setFail(wechatErrOf(e));
        }).finally(function () { if (alive) setLoading(false); });
        return function () { alive = false; };
      }, [tick]);

      // 绑定状态刷新：面板开着时每 30s 重读一次（健康提示/冷却剩余会随时间变），
      // 但**只在没有进行中的绑定**时做，免得和 1.5s 的绑定轮询叠在一起。
      useEffect(function () {
        if (bind) return undefined;
        var iv = setInterval(function () {
          if (typeof document !== "undefined" && document.hidden) return;
          setTick(function (n) { return n + 1; });
        }, 30_000);
        return function () { clearInterval(iv); };
      }, [bind]);

      /** 推进一步绑定状态机。终态/失败都会**停下轮询**，把结论交给用户。 */
      var pollOnce = useCallback(function () {
        return api("/dsh-remote/wechat/bind/poll", undefined, WECHAT_POLL_TIMEOUT_MS).then(function (r) {
          var next = r && r.state ? String(r.state) : "wait";
          setPhase(next);
          if (r && r.need_verify_code) setAskCode(true);
          if (next === "confirmed" || next === "already_bound") {
            setAskCode(false);
            setMessage({
              kind: "ok",
              text: next === "confirmed"
                ? "已绑定 ✅ 之后需要你拍板、任务报错或停下时会推到你的微信。"
                : "这个微信机器人以前绑过（无需重复绑定），现在就能用。"
            });
            setBind(null);
            setPhase("");
            setTick(function (n) { return n + 1; }); // 重读状态：拿 bot_id / 绑定时间
            return;
          }
          if (next === "failed" || next === "expired-giveup" || next === "verify-blocked" || next === "idle") {
            setAskCode(false);
            setPollPaused(true);
            setMessage({ kind: "err", text: (r && r.error) ? String(r.error) : wechatPhaseText(next) });
            return;
          }
          if (next === "expired" || next === "verify_code_blocked") {
            setAskCode(false);
            setPollPaused(true); // 二维码已被 bridge 换掉，继续轮询没意义
            setMessage({ kind: "warn", text: wechatPhaseText(next) + "点「刷新二维码」重新拿一张。" });
            return;
          }
          if (next === "need_verifycode") setAskCode(true);
          setMessage(null);
        }).catch(function (e) {
          // 代理层失败（后台服务没跑/密钥不匹配/超时…）：停轮询 + 原文照登，绝不无声空转。
          setPollPaused(true);
          setMessage({ kind: "err", text: wechatErrOf(e).text });
        });
      }, []);

      // ▶ 绑定轮询：一次**只有一个请求在飞**，两次之间隔 ~1.5s（bridge 那边是长轮询，
      //   并发调用会对同一个二维码重复打腾讯接口）。终态、暂停、卸载都会立刻停。
      useEffect(function () {
        if (!bind || pollPaused || WECHAT_POLL_STOP.indexOf(phase) >= 0) return undefined;
        var stopped = false;
        var timer = null;
        var schedule = function () {
          timer = setTimeout(function () {
            if (stopped) return;
            if (typeof document !== "undefined" && document.hidden) { schedule(); return; } // 后台标签页不空转
            pollOnce().then(function () { if (!stopped) schedule(); });
          }, WECHAT_POLL_INTERVAL_MS);
        };
        schedule();
        return function () { stopped = true; if (timer !== null) { clearTimeout(timer); timer = null; } };
      }, [bind, phase, pollPaused, pollOnce]);

      /** 开始/刷新绑定：向 bridge 取一张新二维码（旧会话会被 bridge 取消）。 */
      var startBind = useCallback(function () {
        setBusy("start"); setMessage(null); setFail(null); setAskCode(false);
        setVerifyCode(""); setPollPaused(false); setPhase("wait");
        return post("/dsh-remote/wechat/bind/start").then(function (r) {
          if (!r || r.ok === false) {
            setBind(null);
            setMessage({ kind: "err", text: (r && r.error) ? String(r.error) : "后台服务没有返回二维码，请稍后重试。" });
            return;
          }
          setBind({
            svg: String(r.qrcode_svg || ""),
            url: String(r.qrcode_url || ""),
            message: String(r.message || "")
          });
          setMessage({ kind: "ok", text: String(r.message || "请用手机微信扫描二维码完成绑定。") });
        }).catch(function (e) {
          setBind(null);
          setMessage({ kind: "err", text: wechatErrOf(e).text });
        }).finally(function () { setBusy(""); });
      }, []);

      /** 取消本次绑定：先停面板侧轮询，再通知 bridge（顺序反了会出现「点了取消还在轮询」）。 */
      var cancelBind = useCallback(function () {
        setBusy("cancel"); setPollPaused(true);
        return post("/dsh-remote/wechat/bind/cancel").then(function () {
          setBind(null); setPhase(""); setAskCode(false); setVerifyCode("");
          setMessage({ kind: "warn", text: "已取消这次连接，没有绑定任何微信机器人。" });
        }).catch(function (e) {
          // 面板侧照样停：否则用户会以为还在扫。但要如实说明 bridge 那边没确认。
          setBind(null); setPhase(""); setAskCode(false); setVerifyCode("");
          setMessage({ kind: "warn", text: "本页面已停止这次连接。后台服务的取消请求没成功：" + wechatErrOf(e).text });
        }).finally(function () { setBusy(""); });
      }, []);

      /** 提交手机微信上显示的数字配对码。 */
      var submitCode = useCallback(function () {
        var code = String(verifyCode || "").trim();
        if (!/^[0-9]{1,8}$/.test(code)) {
          setMessage({ kind: "err", text: "请输入手机微信上显示的数字配对码（1~8 位数字）。" });
          return;
        }
        setBusy("verify"); setMessage(null);
        return post("/dsh-remote/wechat/bind/verify", { code: code }).then(function () {
          setAskCode(false); setVerifyCode(""); setPollPaused(false);
          setMessage({ kind: "ok", text: "配对码已提交，正在等手机确认…" });
        }).catch(function (e) {
          setMessage({ kind: "err", text: wechatErrOf(e).text });
        }).finally(function () { setBusy(""); });
      }, [verifyCode]);

      /** 解绑（二次确认后才走到这里）：停轮询 → notifystop → 删凭据，全在 bridge 侧完成。 */
      var doUnbind = useCallback(function () {
        setBusy("unbind"); setMessage(null);
        return post("/dsh-remote/wechat/unbind").then(function (r) {
          setConfirmUnbind(false);
          var ne = r && r.notify_error ? String(r.notify_error) : "";
          setMessage({
            kind: "ok",
            text: "已解绑 ✅ 之后不会再向你推送微信通知与回执。" + (ne ? "（腾讯侧下线通知没送到：" + ne + "；不影响解绑结果）" : "")
          });
          setTick(function (n) { return n + 1; });
        }).catch(function (e) {
          setConfirmUnbind(false);
          setMessage({ kind: "err", text: wechatErrOf(e).text });
        }).finally(function () { setBusy(""); });
      }, []);

      var bound = !!(wx && wx.bound);
      var binding = !!bind;
      var expiredLike = phase === "expired" || phase === "verify_code_blocked";
      var canResume = pollPaused && WECHAT_POLL_STOP.indexOf(phase) < 0;
      var msgKind = message ? (message.kind === "ok" ? "ok" : message.kind === "warn" ? "warn" : "err") : "";
      var body = [];

      // ── 首屏「这功能是干什么用的」导览（业主口径：先讲清用途，它就是绑定的理由） ──────────
      // 位置：内嵌内容体的**最上面**，在「连接微信机器人」按钮之前（DOM 顺序也一样）——
      // 第一次进来的人先看懂用途，再决定要不要绑。紧凑小字，
      // 不会把连接按钮挤出首屏（见 .dru-wx-intro 的样式注释）。
      // 只讲**产品真的会做的事**，且必须**按档位如实分层**：
      // 免费档只能收通知 + 回数字拍板，「在微信里交代任务」是会员能力 ——
      // 在面板里含糊其辞，用户绑完去微信发句话拿到付费提示，只会觉得产品骗人。
      // 已绑定态同样保留：它是常驻的用途说明（不是一次性引导气泡），不占用任何按钮。
      var intro = h("div", { className: "dru-wx-intro", role: "note", "aria-label": "微信机器人通道能做什么" },
        h("div", { className: "dru-wx-intro-title" }, "绑定后能做什么"),
        h("div", { className: "dru-wx-intro-row" }, "· 任务完成 / 出错 / 停下时**推送**到微信 —— 不用守着电脑。"),
        h("div", { className: "dru-wx-intro-row" }, "· 需要你拍板时，在微信里**回一个数字**就完成决定（放行 / 拒绝 / 选哪个）。"),
        h("div", { className: "dru-wx-intro-row" }, "· 以上两项**免费用**。"),
        h("div", { className: "dru-wx-intro-row" }, "· **会员**：还能直接在微信里交代任务、切换会话，并对同一个任务继续追问。")
      );

      if (loading && !wx && !fail) {
        // 只在**第一次**读状态时转圈；失败或读到结果后立刻换成具体内容（不留永久 spinner）。
        body.push(h("div", { className: "dru-card" },
          h("div", { className: "dru-status-line" },
            h("span", { className: "dru-spin", "aria-hidden": "true" }),
            h("span", null, "正在读取本机微信通道状态…")
          )
        ));
      } else if (fail) {
        body.push(h("div", { className: "dru-card" },
          h("h3", null, "⚠️ 读不到本机微信通道"),
          h("div", { className: "dru-msg dru-msg-err" }, fail.text),
          fail.code ? h("div", { className: "dru-meta" }, "原因代码：" + fail.code) : null,
          h("div", { className: "dru-actions", style: { marginTop: 10 } },
            h("button", {
              type: "button",
              className: "dru-btn dru-btn-primary",
              disabled: busy !== "",
              onClick: refresh
            }, busy !== "" ? "重试中…" : "重试")
          )
        ));
      } else if (binding) {
        body.push(h("div", { className: "dru-card" },
          h("h3", null, "扫码绑定"),
          h("div", { className: "dru-hint" }, "请用手机微信「扫一扫」扫描下面的二维码。扫码后手机上会显示一串数字配对码，回到这里填进去即可完成绑定。"),
          bind.svg
            ? h("img", { className: "dru-wx-qr", src: bind.svg, alt: "微信机器人绑定二维码", width: 200, height: 200 })
            : h("div", { className: "dru-msg dru-msg-warn" }, "后台服务没有返回可显示的二维码图片。点「刷新二维码」重新取一张。"),
          h("div", { className: "dru-wx-phase", role: "status", "aria-live": "polite" },
            h("span", { className: "dru-dot " + (phase === "scaned" || phase === "need_verifycode" ? "dru-dot-on" : "dru-dot-off"), "aria-hidden": "true" }),
            h("span", null, wechatPhaseText(phase))
          ),
          askCode
            ? h("div", { className: "dru-field", style: { marginTop: 12 } },
                h("label", { htmlFor: "dru-wx-verify-code" }, "手机微信上显示的数字配对码"),
                h("div", { className: "dru-wx-code" },
                  h("input", {
                    id: "dru-wx-verify-code",
                    className: "dru-input",
                    type: "text",
                    inputMode: "numeric",
                    autoComplete: "off",
                    maxLength: 8,
                    placeholder: "例如 123456",
                    value: verifyCode,
                    "aria-label": "手机微信上显示的数字配对码",
                    onChange: function (e) { setVerifyCode(String(e.target.value || "").replace(/[^0-9]/g, "")); }
                  }),
                  h("button", {
                    type: "button",
                    className: "dru-btn dru-btn-primary",
                    disabled: busy !== "" || !verifyCode,
                    onClick: submitCode
                  }, busy === "verify" ? "提交中…" : "提交配对码")
                )
              )
            : null,
          h("div", { className: "dru-actions", style: { marginTop: 10 } },
            h("button", {
              type: "button",
              className: "dru-btn dru-btn-ghost",
              disabled: busy !== "",
              onClick: startBind
            }, busy === "start" ? "获取中…" : (expiredLike ? "刷新二维码" : "换一张二维码")),
            canResume
              ? h("button", {
                  type: "button",
                  className: "dru-btn dru-btn-ghost",
                  disabled: busy !== "",
                  onClick: function () { setPollPaused(false); setMessage({ kind: "ok", text: "继续等待扫码…" }); }
                }, "继续等待")
              : null,
            h("button", {
              type: "button",
              className: "dru-btn dru-btn-danger",
              disabled: busy !== "",
              onClick: cancelBind
            }, busy === "cancel" ? "取消中…" : "取消连接")
          )
        ));
      } else if (bound) {
        // 规格 §9：**只有两态**。这一行是「已绑定 · 健康提示」，两种取值都明确带「已绑定」；
        // 健康只由「最近一次推送是否失败」决定，**不参与绑定状态**（通道没在跑等情形另起一行说明，不冒充第三种状态）。
        var healthy = !wx.last_error;
        body.push(h("div", { className: "dru-card" },
          h("h3", null, "已绑定"),
          h("div", { className: "dru-status-line" },
            h("span", { className: "dru-dot " + (healthy ? "dru-dot-on" : "dru-dot-off"), "aria-hidden": "true" }),
            h("span", null, healthy ? "已绑定 · 连接正常" : "已绑定 · 最近一次推送失败")
          ),
          h("div", { className: "dru-hint", style: { marginTop: 6 } },
            "上面的「连接正常 / 推送失败」只是**健康提示**，不改变绑定状态 —— 不需要为此重新扫码绑定。"),
          h("div", { className: "dru-meta" }, "机器人 ID：" + (wx.bot_id ? String(wx.bot_id) : "（后台服务未下发）")),
          h("div", { className: "dru-meta" }, "绑定时间：" + (wechatTimeText(wx.bound_at) || "（后台服务未下发）")),
          wechatTimeText(wx.connected_at) ? h("div", { className: "dru-meta" }, "最近上线：" + wechatTimeText(wx.connected_at)) : null,
          Number(wx.pending_replies) > 0 ? h("div", { className: "dru-meta" }, "等待你回复的通知：" + Number(wx.pending_replies) + " 条") : null,
          wx.last_error ? h("div", { className: "dru-msg dru-msg-warn", role: "status", "aria-live": "polite" }, "⚠️ 最近一次推送失败：" + String(wx.last_error)) : null,
          Number(wx.cooldown_ms) > 0
            ? h("div", { className: "dru-msg dru-msg-warn" }, [
                "⏳ 微信侧会话超时，后台已按官方做法退避（还剩 " + wechatCooldownText(wx.cooldown_ms) + "）。",
                h("br"),
                h("b", null, "这段时间里机器人不工作：你发消息它不会回，任务通知也不会推。"),
                h("br"),
                "想马上恢复：先「解绑」再重新「连接微信机器人」（换绑会拿到新凭据，冷却会立即清掉）；或者等倒计时走完。",
                h("br"),
                "绑定状态本身没问题，不用管它 —— 只是暂时不能聊。"
              ])
            : null,
          !wx.channel_running
            ? h("div", { className: "dru-msg dru-msg-warn" }, "提示：后台服务的微信通道当前没有在运行（绑定状态不受影响）。到「📱 远程访问」面板重启后台服务后会自动恢复。")
            : null,
          wx.disabled
            ? h("div", { className: "dru-msg dru-msg-warn" }, "提示：微信通道已按配置关闭（环境变量 DSH_WECHAT=0）。凭据仍在，重新开启后会继续推送。")
            : null,
          confirmUnbind
            ? h("div", { className: "dru-hint", style: { marginTop: 10 } },
                "解绑后：所有微信通知与回执都会**立即停止**，需要重新扫码才能恢复。确定要解绑吗？")
            : null,
          h("div", { className: "dru-actions", style: { marginTop: 10 } },
            confirmUnbind
              ? [
                  h("button", {
                    key: "unbind-yes",
                    type: "button",
                    className: "dru-btn dru-btn-danger",
                    disabled: busy !== "",
                    onClick: doUnbind
                  }, busy === "unbind" ? "解绑中…" : "确认解绑"),
                  h("button", {
                    key: "unbind-no",
                    type: "button",
                    className: "dru-btn dru-btn-ghost",
                    disabled: busy !== "",
                    onClick: function () { setConfirmUnbind(false); setMessage(null); }
                  }, "先不解绑")
                ]
              : h("button", {
                  type: "button",
                  className: "dru-btn dru-btn-ghost",
                  disabled: busy !== "",
                  onClick: function () { setConfirmUnbind(true); setMessage(null); }
                }, "解绑"),
            h("button", {
              type: "button",
              className: "dru-btn dru-btn-ghost",
              disabled: busy !== "",
              onClick: refresh
            }, "刷新状态")
          )
        ));
      } else {
        body.push(h("div", { className: "dru-card" },
          h("h3", null, "未绑定"),
          // 怎么绑（**文字**先行）：动效只是多余的强调，状态与操作从不靠动效单独表达。
          // 装饰小圆点（纯装饰 → aria-hidden）与主按钮同步做很慢的呼吸，prefers-reduced-motion 下全部关掉。
          h("div", { className: "dru-wx-cta" },
            h("span", { className: "dru-wx-attn-dot", "aria-hidden": "true" }),
            h("span", null, "还没连接：点下面的「连接微信机器人」，用手机微信扫一扫即可完成绑定。")
          ),
          h("div", { className: "dru-hint" }, "连接一个微信机器人后，DSH 会在这些时刻给你发一条微信：需要你放行的工具调用、agent 的提问与「计划待批」、任务报错、任务停下。"),
          h("div", { className: "dru-hint", style: { marginTop: 6 } }, "消息里带编号选项，**回一个数字**就能放行 / 拒绝 / 选择 —— 不用打开电脑。"),
          h("div", { className: "dru-hint", style: { marginTop: 6 } }, "消息只经腾讯官方通道往返你这台电脑，面板里永远不会显示机器人的令牌；随时可以在这里解绑。"),
          h("div", { className: "dru-actions", style: { marginTop: 10 } },
            h("button", {
              type: "button",
              // 未绑定 + 空闲时才呼吸：这份动效的作用就是把人引到「连接」上；
              // 一点下去（busy）立刻停，绑定成功后这个按钮本身就不再渲染（已绑定态走状态卡）。
              className: "dru-btn dru-btn-primary" + (busy === "" ? " dru-wx-attn" : ""),
              disabled: busy !== "",
              onClick: startBind
            }, busy === "start" ? "正在获取二维码…" : "连接微信机器人"),
            h("button", {
              type: "button",
              className: "dru-btn dru-btn-ghost",
              disabled: busy !== "",
              onClick: refresh
            }, "刷新状态")
          )
        ));
      }

      // 状态变化的播报位（无障碍：读屏软件靠 aria-live 感知，不依赖颜色）。两态共用同一个节点。
      var liveMsg = h("div", { className: "dru-msg" + (msgKind ? " dru-msg-" + msgKind : ""), role: "status", "aria-live": "polite" },
        message ? message.text : "");
      var bodyNode = h("div", { className: "dru-settings-body" }, body);

      // 内嵌态（「微信机器人通道」tab）：**省掉**外层 .dru-settings-section 壳与标题行 ——
      // 外层已经有 RemoteControlSection 的 .dru-settings-section（带 data-dru-theme/令牌），
      // 再嵌一层就是 settings-section 套娃（双内边距 + 嵌套 region），而 tab 的文字标签已经
      // 给出可访问名字。壳与标题行只是**装饰性**的栏目头，内容体/按钮一个不改。
      // 导览（intro）永远排在最前面 → 在「连接」按钮之前（DOM 顺序亦然），未绑定时先讲用途。
      if (embedded) {
        return h("div", { className: "dru-wx-embed", role: "region", "aria-label": "微信机器人通道", "data-dru-theme": theme },
          intro,
          bodyNode,
          liveMsg
        );
      }
      // 独立态（仍被保留：组件可单独挂在别的槽里，两态的 hooks 完全一致，见上面的签名注释）
      return h("div", { className: "dru-settings-section", role: "region", "aria-label": "微信机器人", "data-dru-theme": theme },
        h("div", { className: "dru-settings-head" },
          h("span", { className: "dru-settings-icon", "aria-hidden": "true" }, "🤖"),
          h("div", null,
            h("h2", { className: "dru-settings-title" }, "微信机器人"),
            h("div", { className: "dru-settings-sub" }, "把关键节点推到微信，并让你在微信里回一个数字就完成放行 / 拒绝 / 选择。")
          )
        ),
        intro,
        bodyNode,
        liveMsg
      );
    }

    // ── 插件入口 ─────────────────────────────────────────────────────────────
    var inject = ["slots"];
    function apply(ctx) {
      // 面板入口迁移：从侧边栏（sidebar.footer.action）移入「设置」页官方扩展点
      // settings.section（列表槽，由 ui-settings-general 在 sidebar.settings 下声明）。
      // order 30 > Agent 预设(20)，栏目落在「Agent 预设」下方；label 即栏目名（📱 远程访问）。
      // 【0.6.11】本插件在这个槽里**只有一个栏目**（📱 远程访问）：🤖 微信机器人原先以 order 31
      // 注册成第二个栏目，业主口径「不要给它单独弄一个菜单，直接放到面板里面」→ 已改成面板里的
      // 第三个 tab（renderMainTabs / renderWeChat）。不要再往这个槽里加第二个 register。
      ctx.slots.inject("settings.section", function () {
        var d1 = ctx.slots.register({
          name: "settings.section",
          id: "dsh-remote",
          order: 30,
          label: function () { return "📱 远程访问"; }
        }, RemoteControlSection);
        return function () {
          if (typeof d1 === "function") d1();
        };
      });
      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register({ name: "shell.overlay", id: "dsh-feedback-popup", order: 90 }, FeedbackPopup);
      });

      // 首次安装引导小红点（localStorage dsh-remote-seen-dot；点击后不再显示）
      dotWatch();
      // 侧栏「远程访问」快捷入口（2026-09 恢复注入：与官方「设置」按钮共存不遮挡）
      navEnsureStart();
      // 🎨 主题：**不在这里**建 observer —— 观察器只在真有订阅者时才创建
      // （面板/弹窗挂载 → themeSubscribe；侧栏入口挂上 → mountNavEntry）。
      // 这样「没有任何东西需要跟随主题」时不会白留一个 MutationObserver，
      // 也避免与本插件已有的红点观察器互相干扰。

      // 满意度弹窗已停用（不再调度）；组件与调度代码保留，便于日后恢复。
      var FB_POPUP_RETIRED = true;
      if (FB_POPUP_RETIRED) return; // 改回 false 即恢复原行为

      // 满意度弹窗调度：首次观察到 bridge 运行（即“安装完成并体验”）后约 10 分钟弹出；
      // 每 60 秒复查一次，避免 dsh web 启动晚于到点时间。
      // 弹窗状态按「账号/设备」分作用域(见 fbPopScope);旧版无后缀键视为已完成并迁移,不再打扰老用户。
      var legacyPopState = null;
      try { legacyPopState = JSON.parse(localStorage.getItem(FB_POPUP_KEY) || "null"); } catch (e) { legacyPopState = null; }
      try { localStorage.removeItem(FB_POPUP_KEY); } catch (e) {}
      api("/dsh-remote/status").then(function (body) {
        if (body && body.config) setFbPopScope(body.config.phone || body.config.deviceId || "anon");
        if (legacyPopState && legacyPopState.state === "done") fbSavePopState({ state: "done", firstSeen: legacyPopState.firstSeen || Date.now(), nextAt: 0 });
        if (body && body.service && body.service.running) {
          fbEnsureFirstSeen();
          fbMaybeOpenPopup();
        }
      }).catch(function () {});
      var popupTimer = setInterval(function () {
        var s = fbPopState();
        if (!s || s.state !== "pending") { clearInterval(popupTimer); return; }
        if (!fbFirstSeenAt) {
          api("/dsh-remote/status").then(function (body) {
            if (body && body.config) setFbPopScope(body.config.phone || body.config.deviceId || "anon");
            if (body && body.service && body.service.running) {
              fbEnsureFirstSeen();
              fbMaybeOpenPopup();
            }
          }).catch(function () {});
          return;
        }
        fbMaybeOpenPopup();
      }, 60 * 1000);
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
