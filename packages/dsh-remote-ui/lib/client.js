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
//     · bridge 状态与启停开关 + 关于 dsh-remote 说明卡片
//   - 首次安装引导：设置页「远程访问」栏目（官方导航 navCell）旁小红点（localStorage dsh-remote-seen-dot 控制）
//   - shell.overlay：满意度弹窗（安装体验至少 1 小时后弹出，只弹一次）
// 所有数据经同源 /dsh-remote/* 宿主路由读写（node 半提供）。
window.__ModuleLoader__.load({
  id: "dsh-remote-ui",
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
    styleEl.setAttribute("data-plugin", "dsh-remote-ui");
    styleEl.textContent = [
      // 设置页栏目容器（nav 选中后渲染在 settings.section 内容区）
      ".dru-settings-section{max-width:720px;display:flex;flex-direction:column;gap:14px;padding-top:2px}",
      ".dru-settings-head{display:flex;align-items:center;gap:10px;padding:6px 2px 2px}",
      ".dru-settings-icon{font-size:24px;line-height:1;flex:none}",
      ".dru-settings-title{margin:0;font-size:17px;font-weight:600;color:var(--dsw-alias-label-primary,#e6edf3)}",
      ".dru-settings-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#8c959f);margin-top:2px}",
      ".dru-settings-body{display:flex;flex-direction:column;gap:14px}",
      // 首次安装引导小红点（挂在设置页「远程访问」导航栏目右上角）
      ".dru-reddot{position:absolute;top:9px;right:12px;width:7px;height:7px;border-radius:50%;background:#e5484d;box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-2,#fff);pointer-events:none;z-index:1}",
      ".dru-card{background:#f6f8fa;border:1px solid #eaeef2;border-radius:10px;padding:14px 16px}",
      ".dru-card h3{margin:0 0 8px;font-size:13px;font-weight:700;color:#1f2328}",
      ".dru-url{background:#ffffff;border:1px solid #d0d7de;border-radius:8px;padding:9px 11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;word-break:break-all;display:flex;align-items:center;justify-content:space-between;gap:8px;color:#1f2328}",
      ".dru-url button{flex:none;border:1px solid #d0d7de;background:#ffffff;color:#0969da;border-radius:6px;padding:3px 8px;font-size:12px;cursor:pointer}",
      ".dru-url button:hover{background:#f6f8fa}",
      ".dru-field{margin-bottom:11px}",
      ".dru-field > label{display:block;font-size:12.5px;font-weight:600;color:#1f2328;margin-bottom:5px}",
      ".dru-input{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid #d0d7de;background:#ffffff;color:#1f2328;font-size:13.5px;font-family:inherit}",
      ".dru-input:focus{outline:none;border-color:#0969da;box-shadow:0 0 0 3px rgba(9,105,218,.15)}",
      ".dru-actions{display:flex;gap:8px;flex-wrap:wrap}",
      ".dru-btn{padding:8px 14px;border-radius:8px;border:1px solid transparent;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}",
      ".dru-btn:disabled{opacity:.55;cursor:default}",
      ".dru-btn-primary{background:#0969da;color:#ffffff;border-color:#0969da}",
      ".dru-btn-primary:hover:not(:disabled){background:#0860bd}",
      ".dru-btn-ghost{background:#ffffff;color:#1f2328;border-color:#d0d7de}",
      ".dru-btn-ghost:hover:not(:disabled){background:#f6f8fa}",
      ".dru-btn-danger{background:#ffffff;color:#cf222e;border-color:#cf222e}",
      ".dru-btn-danger:hover:not(:disabled){background:#fff0f1}",
      ".dru-linkbtn{display:inline-block;padding:0;border:none;background:none;color:#0969da;font-size:12.5px;line-height:1.6;cursor:pointer;font-family:inherit;text-decoration:none}",
      ".dru-linkbtn:hover{text-decoration:underline}",
      ".dru-tabs{display:flex;gap:8px;margin-bottom:12px}",
      ".dru-tab{flex:1;padding:7px 0;text-align:center;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;color:#57606a;background:#f6f8fa;border:1px solid #d0d7de;user-select:none}",
      ".dru-tab.active{color:#0969da;background:#ffffff;border-color:#0969da}",
      ".dru-captcha{display:flex;align-items:stretch;gap:8px}",
      ".dru-captcha .dru-input{flex:1;min-width:0}",
      ".dru-captcha-box{width:118px;height:42px;flex:none;border-radius:8px;border:1px solid #d0d7de;cursor:pointer;background:#f6f8fa;display:flex;align-items:center;justify-content:center;font-size:12px;color:#57606a;overflow:hidden}",
      ".dru-captcha-box svg{display:block;width:100%;height:100%}",
      ".dru-user{display:flex;align-items:center;gap:10px;margin-bottom:12px}",
      ".dru-avatar{width:40px;height:40px;border-radius:50%;background:#0969da;color:#ffffff;display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:700;flex-shrink:0}",
      ".dru-user .mail{font-size:14px;font-weight:600;color:#1f2328;word-break:break-all}",
      ".dru-user .plan{font-size:12px;color:#57606a;margin-top:2px}",
      ".dru-status-line{display:flex;align-items:center;gap:8px;font-size:13px;color:#1f2328}",
      ".dru-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}",
      ".dru-dot-on{background:#1a7f37;box-shadow:0 0 6px rgba(26,127,55,.6)}",
      ".dru-dot-off{background:#8c959f}",
      ".dru-meta{font-size:12px;color:#57606a;margin-top:6px;word-break:break-all}",
      ".dru-msg{font-size:12.5px;min-height:18px;margin-top:8px}",
      ".dru-msg-ok{color:#1a7f37}",
      ".dru-msg-err{color:#cf222e}",
      ".dru-msg-warn{color:#9a6700}",
      ".dru-hint{font-size:12px;color:#57606a;line-height:1.6}",
      // ── 用户反馈模块 ──
      ".dru-fb-tabs{display:flex;gap:8px;margin-bottom:10px}",
      ".dru-fb-tab{flex:1;padding:6px 0;text-align:center;border-radius:8px;cursor:pointer;font-size:12.5px;font-weight:600;color:#57606a;background:#eaeef2;border:1px solid #d0d7de;user-select:none}",
      ".dru-fb-tab.active{color:#0969da;background:#ffffff;border-color:#0969da}",
      ".dru-fb-select{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid #d0d7de;background:#ffffff;color:#1f2328;font-size:13.5px;font-family:inherit}",
      ".dru-fb-textarea{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid #d0d7de;background:#ffffff;color:#1f2328;font-size:13.5px;font-family:inherit;resize:vertical;min-height:64px}",
      ".dru-fb-textarea:focus{outline:none;border-color:#0969da;box-shadow:0 0 0 3px rgba(9,105,218,.15)}",
      ".dru-fb-item{border:1px solid #eaeef2;border-radius:8px;background:#ffffff;padding:10px 12px;margin-bottom:8px}",
      ".dru-fb-item-head{display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap}",
      ".dru-fb-badge{font-size:11px;border-radius:999px;padding:1px 8px;flex:none}",
      ".dru-fb-badge-open{color:#9a6700;background:#fff8c5;border:1px solid #eed888}",
      ".dru-fb-badge-processing{color:#0969da;background:#ddf4ff;border:1px solid #b6e3ff}",
      ".dru-fb-badge-done{color:#1a7f37;background:#dafbe1;border:1px solid #aceebb}",
      ".dru-fb-cat{font-size:11px;border-radius:999px;padding:1px 8px;flex:none;color:#57606a;background:#f6f8fa;border:1px solid #d0d7de}",
      ".dru-fb-item-title{font-size:13px;font-weight:600;color:#1f2328;flex:1;min-width:120px}",
      ".dru-fb-item-content{font-size:12.5px;color:#57606a;white-space:pre-wrap;word-break:break-word;margin:4px 0}",
      ".dru-fb-item-time{font-size:11px;color:#8c959f}",
      ".dru-fb-reply{border-top:1px dashed #eaeef2;margin-top:8px;padding-top:8px}",
      ".dru-fb-reply-row{display:flex;gap:6px;align-items:flex-start;margin-bottom:6px}",
      ".dru-fb-reply-who{font-size:12px;font-weight:600;color:#0969da;flex:none;width:76px}",
      ".dru-fb-reply-who.user{color:#57606a}",
      ".dru-fb-reply-text{font-size:12.5px;color:#1f2328;white-space:pre-wrap;word-break:break-word;flex:1}",
      ".dru-fb-reply-input{width:100%;box-sizing:border-box;padding:7px 10px;border-radius:8px;border:1px solid #d0d7de;background:#ffffff;font-size:12.5px;font-family:inherit;resize:vertical;min-height:44px}",
      ".dru-fb-empty{font-size:12.5px;color:#8c959f;text-align:center;padding:14px 0}",
      // ── 满意度弹窗（1 小时体验后，只弹一次） ──
      ".dru-popup{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147482000;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}",
      ".dru-popup-card{width:min(400px,calc(100vw - 48px));background:#ffffff;color:#1f2328;border:1px solid #d0d7de;border-radius:12px;box-shadow:0 24px 64px rgba(0,0,0,.45);font-size:14px;line-height:1.5;font-family:var(--dsw-font-family,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif);overflow:hidden}",
      ".dru-popup-body{padding:22px 22px 16px;text-align:center}",
      ".dru-popup-icon{font-size:34px;margin-bottom:8px}",
      ".dru-popup-title{font-size:16px;font-weight:700;color:#1f2328;margin-bottom:6px}",
      ".dru-popup-sub{font-size:12.5px;color:#57606a;margin-bottom:16px}",
      ".dru-popup-rate{display:flex;gap:10px;justify-content:center;margin-bottom:14px}",
      ".dru-popup-rate button{flex:1;max-width:96px;border:1px solid #d0d7de;background:#f6f8fa;border-radius:10px;padding:12px 6px;font-size:20px;cursor:pointer;font-family:inherit}",
      ".dru-popup-rate button:hover{border-color:#0969da;background:#ddf4ff}",
      ".dru-popup-rate button.sel{border-color:#0969da;background:#ddf4ff;box-shadow:0 0 0 3px rgba(9,105,218,.15)}",
      ".dru-popup-rate button .lbl{display:block;font-size:11px;color:#57606a;margin-top:4px;font-weight:600}",
      ".dru-popup-textarea{width:100%;box-sizing:border-box;padding:9px 11px;border-radius:8px;border:1px solid #d0d7de;background:#ffffff;color:#1f2328;font-size:13px;font-family:inherit;resize:vertical;min-height:56px;text-align:left}",
      ".dru-popup-invite{background:#f6f8fa;border:1px dashed #d0d7de;border-radius:8px;padding:12px;font-size:13px;color:#57606a;text-align:center;margin-bottom:12px}",
      ".dru-popup-actions{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:14px}",
      ".dru-popup-foot{display:flex;justify-content:space-between;padding:10px 22px;border-top:1px solid #eaeef2;font-size:12px;color:#8c959f}",
      ".dru-popup-foot button{border:none;background:none;color:#57606a;cursor:pointer;font-size:12px;font-family:inherit;padding:4px 6px}",
      ".dru-popup-foot button:hover{color:#0969da}",
      ".dru-popup .dru-msg{text-align:left}",
      ".dru-community-qr{display:block;width:220px;max-width:62vw;margin:0 auto;background:#ffffff;padding:10px;border-radius:10px;border:1px solid #d0d7de;box-sizing:content-box}",
      ".dru-fb-community{margin-top:16px;padding-top:14px;border-top:1px dashed #d0d7de;text-align:center}",
      ".dru-fb-community .dru-community-qr{width:180px;max-width:56vw}",
      // ── 自管理：版本与更新（插件面板内提供在线更新/彻底卸载，市场无更新按钮） ──
      ".dru-ver-badge{display:inline-block;font-size:11px;border-radius:999px;padding:1px 8px;margin-left:6px;vertical-align:1px}",
      ".dru-ver-badge-new{color:#9a6700;background:#fff8c5;border:1px solid #eed888}",
      ".dru-ver-badge-ok{color:#1a7f37;background:#dafbe1;border:1px solid #aceebb}",
      ".dru-up-log{margin-top:8px;background:#0d1117;color:#e6edf3;border-radius:8px;padding:8px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:150px;overflow:auto}",
      // ── 📱 远程访问（一次性访问密钥 + 已授权设备管理） ──
      ".dru-access-flex{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start;margin-top:10px}",
      ".dru-access-col{flex:1;min-width:230px;display:flex;flex-direction:column;gap:8px}",
      ".dru-qr-img{width:180px;height:180px;flex:none;border-radius:8px;border:1px solid #d0d7de;background:#ffffff;object-fit:contain}",
      ".dru-qr-ph{width:180px;height:180px;flex:none;border-radius:8px;border:1px dashed #d0d7de;background:#f6f8fa;color:#8c959f;font-size:12px;display:flex;align-items:center;justify-content:center;text-align:center;padding:10px;box-sizing:border-box}",
      ".dru-url.big{font-size:13.5px;font-weight:600}",
      ".dru-cd{font-size:12px;color:#9a6700;margin-top:2px}",
      ".dru-cd-ok{color:#1a7f37}",
      ".dru-key-note{font-size:12px;color:#57606a;line-height:1.6}",
      ".dru-dev{border:1px solid #eaeef2;border-radius:8px;background:#ffffff;padding:9px 11px;margin-bottom:8px}",
      ".dru-dev-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dru-dev-name{font-size:13px;font-weight:600;color:#1f2328;flex:1;min-width:130px}",
      ".dru-dev-meta{font-size:11.5px;color:#57606a}",
      ".dru-dev-sub{font-size:11px;color:#8c959f;margin-top:3px}",
      ".dru-dev-tag{font-size:10.5px;color:#8c959f;border:1px solid #d0d7de;border-radius:999px;padding:0 7px;flex:none;white-space:nowrap}",
      ".dru-dev-tag-off{color:#cf222e;border-color:#ffb3b6;background:#fff0f1}",
      // Phase-5:端到端加密(E2EE)状态行 —— 启用=绿字绿点,未启用=灰字(纯文字状态行,不打扰)
      ".dru-e2ee-line{display:flex;align-items:center;gap:7px;margin-top:6px;font-size:12px;line-height:1.5;color:#57606a}",
      ".dru-e2ee-line.ok{color:#1a7f37}",
      // 侧栏「远程访问」快捷按钮(2026-09 恢复注入,与官方「设置」按钮共存不遮挡):
      // 独立 button(非 clone),插在官方「设置」按钮之前,同源同布局不覆盖官方热区。
      ".dru-nav-remote{display:inline-flex;align-items:center;gap:6px;height:30px;margin:0 0 2px;padding:0 10px;border:1px solid #d0d7de;border-radius:8px;background:#ffffff;color:#0969da;font:500 12.5px/1 inherit;cursor:pointer;white-space:nowrap;user-select:none}",
      ".dru-nav-remote:hover:not(:disabled){background:#f0f6ff;border-color:#0969da}",
      ".dru-nav-remote-dot{position:absolute;top:-2px;right:-2px;width:8px;height:8px;border-radius:50%;background:#e5484d;box-shadow:0 0 0 2px #fff;pointer-events:none}",
    ].join("\n");
    document.head.appendChild(styleEl);

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
    function api(path, options) {
      return fetch(path, options).then(function (res) {
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

    // ── 交流群（运营二维码;管理后台统一上传,node 半经公开配置下发） ─────────
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

    /** 一次性访问密钥 / 已授权设备列表的自动重试状态（放在组件外：不随渲染重建）。 */
    var akeyRetry = { timer: null, attempt: 0 };
    var devRetry = { timer: null, attempt: 0 };
    // 请求在途标记同样放组件外：组件内 state 闭包会在定时器/轮询回调里过期，
    // 导致 busy 护栏失效（重复请求）或误拦（该重试却跳过）。
    var akeyInFlight = { v: false };
    var devInFlight = { v: false };
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
            setPopupInvite({ code: acct.invite_code, link: base.replace(/\/+$/, "") + "/?invite=" + encodeURIComponent(acct.invite_code) });
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

      return h("div", { className: "dru-popup", onMouseDown: function (e) { if (e.target === e.currentTarget) fbPopupLater(); } },
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
                  h("div", { className: "dru-popup-sub" }, "邀请好友一起使用，双方都能获得更好的体验"),
                  recommend === true
                    ? h("div", { className: "dru-popup-invite" },
                        h("div", null, "🎉 感谢推荐！"),
                        popupInvite && popupInvite.code && popupInvite.link
                          ? h("div", null,
                              h("div", { className: "dru-url", style: { marginTop: 10, textAlign: "left" } },
                                h("span", null, popupInvite.link),
                                h("button", { type: "button", onClick: function () {
                                  try { navigator.clipboard.writeText(popupInvite.link).then(function () { setInviteCopied(true); setTimeout(function () { setInviteCopied(false); }, 1500); }); } catch (e) {}
                                } }, inviteCopied ? "已复制" : "复制邀请链接")
                              ),
                              h("div", { style: { marginTop: 8, fontSize: 12 } }, "把链接发给好友，注册时自动带上你的邀请码。")
                            )
                          : h("div", { style: { marginTop: 6, fontSize: 12 } },
                              popupInvite && popupInvite.code
                                ? "邀请码 " + popupInvite.code + " 已生成：在设置面板 →「🎯 邀请好友赚会员」中复制邀请链接。"
                                : "登录手机号账号后，在设置面板 →「🎯 邀请好友赚会员」中获取专属邀请链接。")
                      )
                    : h("div", null,
                        h("div", { className: "dru-popup-actions" },
                          h("button", { type: "button", className: "dru-btn dru-btn-primary", onClick: function () { setRecommend(true); loadPopupInvite(); } }, "愿意推荐"),
                          h("button", { type: "button", className: "dru-btn dru-btn-ghost", onClick: function () { setRecommend(false); } }, "暂时不了")
                        ),
                        h("div", { className: "dru-hint", style: { marginTop: 10 } }, "推荐成功可获得专属邀请链接")
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
    // 数据来自 node 半新增的 /dsh-remote/self* 路由；逻辑均在插件 node 半实现，
    // 因此无论插件从「插件市场」还是 npx 安装，界面与行为完全一致。
    function SelfManageCard() {
      var verArr = useState(null); var ver = verArr[0]; var setVer = verArr[1];       // {version, runtimeReady}
      var chkArr = useState(null); var chk = chkArr[0]; var setChk = chkArr[1];       // {current, latest, outdated}
      var chkBusyArr = useState(false); var chkBusy = chkBusyArr[0]; var setChkBusy = chkBusyArr[1];
      var upBusyArr = useState(false); var upBusy = upBusyArr[0]; var setUpBusy = upBusyArr[1];
      var unBusyArr = useState(false); var unBusy = unBusyArr[0]; var setUnBusy = unBusyArr[1];
      var logArr = useState(""); var log = logArr[0]; var setLog = logArr[1];         // 更新日志尾部
      var updArr = useState(false); var updating = updArr[0]; var setUpdating = updArr[1]; // 更新任务是否仍在跑
      var doneArr = useState(false); var updated = doneArr[0]; var setUpdated = doneArr[1]; // 本轮已更新完成（提示重启）
      var armArr = useState(false); var armed = armArr[0]; var setArmed = armArr[1];   // 彻底卸载二次确认
      var msgArr = useState(null); var selfMsg = msgArr[0]; var setSelfMsg = msgArr[1]; // {kind, text}

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

      // 轮询更新日志：点击一键更新后，每 2s 拉一次日志；直到 running=false 视为完成
      var logTimer = useCallback(function (force) {
        if (!force && updating) return;
        api("/dsh-remote/self/update-log").then(function (b) {
          if (b && b.ok) {
            setLog(b.log || "");
            if (!b.running) {
              setUpdating(false);
              setUpdated(true);
              loadVer();
              return;
            }
          }
          setUpdating(true);
        }).catch(function () { setUpdating(false); });
      }, [updating, loadVer]);

      useEffect(function () { loadVer(); doCheck(); }, [loadVer, doCheck]);
      useEffect(function () {
        if (!updating) return;
        var iv = setInterval(function () {
          api("/dsh-remote/self/update-log").then(function (b) {
            if (!b || !b.ok) return;
            setLog(b.log || "");
            if (!b.running) {
              clearInterval(iv);
              setUpdating(false);
              setUpdated(true);
              loadVer();
              doCheck();
            }
          }).catch(function () {});
        }, 2000);
        return function () { clearInterval(iv); };
      }, [updating, loadVer, doCheck]);

      var doUpdate = function () {
        setUpBusy(true);
        setUpdated(false);
        setSelfMsg(null);
        post("/dsh-remote/self/update", {}).then(function (b) {
          if (b && b.ok) {
            setSelfMsg({ kind: "ok", text: "更新已在后台开始，正在下载安装…（本页会实时显示进度日志）" });
            setUpdating(true);
            logTimer(true);
          } else {
            var detail = String((b && (b.detail || b.error)) || "更新启动失败");
            // 另一种常见情况：node 半返回 ok:false + “已有更新在进行中” → 转为跟踪进度而非报错
            api("/dsh-remote/self/update-log").then(function (lb) {
              if (lb && lb.ok && lb.running) {
                setSelfMsg({ kind: "ok", text: "检测到已有一次更新正在进行，正在跟踪进度…" });
                setUpdating(true);
                logTimer(true);
              } else {
                setSelfMsg({ kind: "err", text: detail });
              }
            }).catch(function () { setSelfMsg({ kind: "err", text: detail }); });
          }
        }).catch(function (e) {
          setSelfMsg({ kind: "err", text: "更新失败：" + e.message });
        }).finally(function () { setUpBusy(false); });
      };

      var doUninstall = function () {
        if (!armed) { setArmed(true); return; }
        setUnBusy(true);
        setSelfMsg(null);
        post("/dsh-remote/self/uninstall", {}).then(function (b) {
          if (b && b.ok) {
            setArmed(false);
            // 优先展示服务端 detail（含 bridge 自启动/配置目录的逐项清理结果与重启提示）；
            // 兜底文案同样说明 bridge 自启动服务与本地配置目录会一并移除/清空
            var detail = b && b.detail ? String(b.detail) : "";
            setSelfMsg({ kind: "ok", text: detail || "已彻底卸载：插件引用、bridge 自启动服务与本地配置目录（账号/密钥/运行时等）已一并移除并清空。请重启 dsh web 后完全生效（本栏目将消失）；如需再次使用，在插件市场重新安装即可。" });
          } else {
            setArmed(false);
            setSelfMsg({ kind: "err", text: "卸载失败：" + ((b && (b.error || b.detail)) || "未知错误") });
          }
        }).catch(function (e) {
          setArmed(false);
          setSelfMsg({ kind: "err", text: "卸载失败：" + e.message });
        }).finally(function () { setUnBusy(false); });
      };

      var outdated = !!(chk && chk.outdated && chk.latest && chk.latest !== chk.current);
      var currentV = (ver && ver.version) || (chk && chk.current) || "…";
      var runtimeReady = ver ? !!ver.runtimeReady : null;

      return h("div", { className: "dru-card", style: { marginTop: 2 } },
        h("h3", null, "🔄 版本与更新"),
        h("div", { className: "dru-status-line" },
          h("span", null, "插件版本 v" + currentV),
          chk === null && chkBusy ? h("span", { className: "dru-meta", style: { margin: 0 } }, "（检查新版本中…）") : null,
          chk && outdated
            ? h("span", { className: "dru-ver-badge dru-ver-badge-new" }, "发现新版本 v" + chk.latest)
            : chk && !outdated ? h("span", { className: "dru-ver-badge dru-ver-badge-ok" }, "已是最新版本") : null
        ),
        h("div", { className: "dru-meta" },
          runtimeReady === false ? "⚠ 桌面运行环境缺失（点击下方「一键更新」会自动补全并启动）" : runtimeReady === true ? "桌面运行环境正常" : "读取运行环境中…"
        ),
        h("div", { className: "dru-actions", style: { marginTop: 10 } },
          outdated
            ? h("button", { type: "button", className: "dru-btn dru-btn-primary", disabled: upBusy || unBusy || chkBusy || updating, onClick: doUpdate },
                upBusy ? "更新启动中…" : updating ? "正在更新…" : "一键更新到 v" + chk.latest)
            : h("button", { type: "button", className: "dru-btn dru-btn-ghost", disabled: upBusy || unBusy || chkBusy || updating, onClick: doUpdate },
                updating ? "正在更新…" : (ver && !ver.runtimeReady) ? "安装并启动（一键修复）" : "重新检查 / 修复"),
          h("button", { type: "button", className: "dru-btn dru-btn-ghost", disabled: chkBusy || updating || upBusy, onClick: doCheck }, chkBusy ? "检查中…" : "检查更新"),
          h("button", {
            type: "button",
            className: "dru-btn dru-btn-danger",
            style: { marginLeft: "auto" },
            disabled: unBusy || updating || upBusy,
            onClick: doUninstall
          }, unBusy ? "卸载中…" : armed ? "⚠ 再点一次确认彻底卸载" : "彻底卸载")
        ),
        updated
          ? h("div", { className: "dru-msg dru-msg-ok" },
              "✅ 更新已完成，最新代码已就位。请", h("strong", null, "重启 dsh web"), "后生效；桌面 bridge 会随系统自启自动运行新版本。")
          : null,
        log ? h("div", { className: "dru-up-log", title: "更新日志（尾部）" }, log) : null,
        selfMsg ? h("div", { className: "dru-msg dru-msg-" + selfMsg.kind }, selfMsg.text) : null,
        h("div", { className: "dru-hint", style: { marginTop: 8 } },
          armed ? "⚠ 再次点击后即开始彻底卸载：① 移除 dsh web 配置中的插件引用与本地文件；② 停止并移除 bridge 自启动服务（macOS com.dshremote.bridge / Linux dsh-bridge）并结束残留进程；③ 清空本地配置目录（~/.dsh-remote：账号、设备密钥、固化运行时等）。此操作不可撤销，如需再次使用请在插件市场重新安装。" :
            "检测新版、一键在线更新、彻底卸载都在本卡片完成。")
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
    function RemoteControlSection(props) {

      var statusArr = useState(null); var st = statusArr[0]; var setSt = statusArr[1];
      var modeArr = useState("saas"); var mode = modeArr[0]; var setMode = modeArr[1];   // saas | local
      var viewArr = useState("home"); var view = viewArr[0]; var setView = viewArr[1];   // home | feedback | invite
      var busyArr = useState(""); var busy = busyArr[0]; var setBusy = busyArr[1];
      var msgArr = useState(null); var message = msgArr[0]; var setMessage = msgArr[1];
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
        try {
          navigator.clipboard.writeText(akey.url).then(function () {
            setCopiedKey(true);
            setTimeout(function () { setCopiedKey(false); }, 1500);
          });
        } catch (e) {}
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

      function setMsg(kind, text) { setMessage({ kind: kind, text: text }); }

      // ---------- 登录(密码/短信) ----------
      var doLogin = function () {
        if (!phone.trim() || !pass) { setMsg("err", "请填写手机号与密码"); return; }
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
                setSt(cfg); setPass(""); setLcapTxt(""); setLcap(null);
                setMsg("ok", "✅ 登录成功，账号已保存");
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
        var regPayload = { phone: rphone.trim(), sms_code: rsms.trim(), password: rpass };
        var invite = rInvite.trim().toUpperCase();
        if (invite) regPayload.invite_code = invite;
        if (rcap) { regPayload.captcha_id = rcap.id; regPayload.captcha_answer = rcapTxt.trim(); }
        post("/dsh-remote/register", regPayload)
          .then(function (body) {
            if (body.ok || body.status === 201 || (body.body && body.body.token)) {
              return post("/dsh-remote/config", { phone: rphone.trim(), password: rpass }).then(function (cfg) {
                setPwdOpen(false);
                setSt(cfg);
                setRphone(""); setRpass(""); setRpass2(""); setRsms(""); setRcap(null); setRcapTxt(""); setRInvite("");
                setMsg("ok", "✅ 注册成功，已自动登录");
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
            setMsg(body.ok ? "ok" : "err", body.ok ? (start ? "✅ bridge 已启动" + (body.pid ? " (pid=" + body.pid + ")" : "") : "bridge 已停止") : (body.detail || body.status || "操作失败"));
          })
          .catch(function (e) { setMsg("err", (start ? "启动" : "停止") + "失败: " + e.message); })
          .finally(function () { setBusy(""); });
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
            setMsg(body.ok ? "ok" : "err", body.ok ? "✅ 已切换到自建服务，bridge 已重启" : (body.error || (body.body && body.body.error) || "保存失败"));
          })
          .catch(function (e) { setMsg("err", "保存失败: " + e.message); })
          .finally(function () { setBusy(""); });
      };

      var loadInvite = function () {
        setBusy("invite");
        api("/dsh-remote/remote-url").then(function (b) {
          var pubBody = (b && b.publicConfig) || {};
          setPub(pubBody);
        }).catch(function () {});
        api("/dsh-remote/invite-records").then(function (b) {
          if (b && b.ok) setInviteData({ records: b.records || [], rewards: b.rewards || [] });
          else setInviteData({ records: [], rewards: [] });
        }).catch(function () { setInviteData({ records: [], rewards: [] }); })
          .finally(function () { setBusy(""); });
      };

      var field = function (label, inputEl) {
        return h("div", { className: "dru-field" }, h("label", null, label), inputEl);
      };
      var input = function (attrs) { return h("input", Object.assign({ className: "dru-input", type: "text" }, attrs)); };
      var card = function (title, children) { return h("div", { className: "dru-card" }, title ? h("h3", null, title) : null, children); };

      // ---------- 我的信息(个人中心) ----------
      function fmtDate(ts) {
        if (!ts) return "—";
        try { var d = new Date(Number(ts)); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); } catch (e) { return "—"; }
      }
      function renderAccount() {
        var a = account;
        var plan = a ? a.plan : "free";
        var source = a ? (a.plan_source || "plan") : "plan";
        var isMember = plan === "pro" || plan === "pro_max";
        var endsAt = a && (a.plan_ends_at || a.trial_expires_at) ? Number(a.plan_ends_at || a.trial_expires_at) : 0;
        var quotaPct = quota && quota.limit_enabled ? quota.percent : null;
        var planText;
        if (!isMember) planText = "免费额度: 带宽 ≈1Mbps" + (quotaPct !== null ? " · 本月流量已用 " + quotaPct + "%" : " · 本月流量限额 1GB");
        else if (source === "trial") planText = "试用 PRO 会员 · 到期 " + fmtDate(a.trial_expires_at);
        else if (endsAt) planText = plan === "pro_max" ? "Pro Max 会员 · 到期 " + fmtDate(endsAt) : "PRO 会员 · 到期 " + fmtDate(endsAt);
        else planText = plan === "pro_max" ? "Pro Max 长期会员" : "PRO 长期会员";
        return h("div", null,
          h("div", { className: "dru-user" },
            h("div", { className: "dru-avatar" }, (st.config.phone || "D").charAt(0).toUpperCase()),
            h("div", null,
              h("div", { className: "mail" }, st.config.phone),
              h("div", { className: "plan" }, plan === "pro_max" ? "Pro Max 会员" : plan === "pro" ? "PRO 会员" : "免费用户")
            )
          ),
          // 套餐状态（免费额度 / 会员到期日）
          h("div", { className: "dru-status-line", style: { marginTop: 10 } },
            h("span", { className: "dru-dot " + (isMember ? "dru-dot-on" : "dru-dot-off") }),
            h("span", null, planText)
          ),
          h("div", { className: "dru-actions", style: { marginTop: 10 } },
            h("button", { type: "button", className: "dru-btn dru-btn-primary", style: { display: "inline-flex", alignItems: "center" }, disabled: busy !== "", title: "升级/续费（带登录态打开）", onClick: openUpgradeAuth },
              busy === "upgrade" ? "生成链接中…" : (!isMember ? "🚀 升级 PRO" : source === "trial" ? "🚀 转正式 PRO" : "🔄 续费会员")),
            h("button", { type: "button", className: "dru-btn dru-btn-ghost", disabled: busy !== "", onClick: function () { setView("invite"); loadInvite(); } }, "🎯 邀请好友赚会员"),
            h("button", { type: "button", className: "dru-btn dru-btn-ghost", disabled: busy !== "", onClick: function () { setView("feedback"); } }, "💬 用户反馈"),
            h("button", { type: "button", className: "dru-btn dru-btn-ghost", disabled: busy !== "", onClick: togglePwdForm }, pwdOpen ? "收起修改密码" : "🔒 修改密码"),
            h("button", { type: "button", className: "dru-btn dru-btn-danger", disabled: busy !== "", onClick: function () { doLogout(false); } }, "退出登录")
          ),
          h("div", { className: "dru-hint", style: { marginTop: 8 } },
            "升级/续费以带登录态方式打开：点击后生成一次性访问链接并直接跳转，无需重新登录。" +
            (endsAt && isMember ? "到期后如需继续使用会员权益，请在到期前续费。" : "")),
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
        return h("div", { className: "dru-card", style: { marginTop: 10, border: "1px dashed #d0d7de" } },
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

      // ---------- 邀请视图 ----------
      function renderInvite() {
        var rule = (pub && pub.invite_rule) || { n: 3, days: 15 };
        var code = (account && account.invite_code) || "";
        var base = (st && st.remoteUrl) || (pub && pub.app_url) || "https://n.risegao.cn:13443/app/";
        var link = base.replace(/\/+$/, "") + "/?invite=" + encodeURIComponent(code);
        var copyInvite = function () {
          try { navigator.clipboard.writeText(link).then(function () { setCopied(true); setTimeout(function () { setCopied(false); }, 1500); }); } catch (e) {}
        };
        return h("div", null,
          h("button", { type: "button", className: "dru-btn dru-btn-ghost", style: { width: "100%" }, onClick: function () { setView("home"); } }, "← 返回"),
          card("🎯 邀请好友赚会员", [
            h("div", { className: "dru-hint", style: { marginBottom: 8 } },
              "每邀请 " + rule.n + " 位好友安装并注册，你获得 " + rule.days + " 天 PRO 会员（好友完成设备安装后计入有效邀请）。"),
            code ? h("div", null,
              h("div", { className: "dru-hint" }, "我的邀请码: " + code),
              h("div", { className: "dru-url" },
                h("span", null, link),
                h("button", { type: "button", onClick: copyInvite }, copied ? "已复制" : "复制链接")
              ),
              h("div", { className: "dru-hint", style: { marginTop: 8 } },
                "把链接发给好友，或把邀请码「" + code + "」告诉他们，注册时填写即可。")
            ) : h("div", null,
              h("div", { className: "dru-hint" }, "需要手机号账号登录后才能生成专属邀请链接。"),
              h("button", { type: "button", className: "dru-btn dru-btn-primary", style: { width: "100%", marginTop: 10 }, disabled: busy !== "", onClick: function () {
                setBusy("invite-refresh");
                api("/dsh-remote/account").then(function (b) {
                  if (b && b.ok && b.account && b.account.invite_code) { setAccount(b.account); setMsg("ok", "邀请码已生成"); }
                  else setMsg("err", "获取邀请码失败，请稍后重试或先登录手机号账号");
                }).catch(function (e) { setMsg("err", "获取邀请码失败：" + e.message); })
                  .finally(function () { setBusy(""); });
              } }, busy === "invite-refresh" ? "生成中…" : "获取邀请码")
            ),
            h("div", { className: "dru-hint", style: { marginTop: 10 } }, "有效邀请记录(登录可见):")
          ]),
          code ? card("我的邀请记录",
            (inviteData && inviteData.records && inviteData.records.length)
              ? h("div", { className: "dru-status-line" }, "已邀请 " + inviteData.records.length + " 人(有效绑定), 获得奖励 " + ((inviteData.rewards || []).length) + " 次")
              : h("div", { className: "dru-hint" }, "暂无有效邀请记录。邀请好友安装并注册，完成设备绑定后即计入。")
          ) : null
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
        var statusTxt = st === null
          ? "查询中…"
          : !loggedInSaaS
            ? "请先登录（下方账号卡片）后启用远程访问"
            : serviceRunning ? "已连接（可远程访问）" : "等待设备连接";
        var dotCls = "dru-dot " + (loggedInSaaS && serviceRunning ? "dru-dot-on" : "dru-dot-off");
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
                    ? "本机 bridge 未运行：先在下方「🖥 Bridge 服务」卡启动。"
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
                  style: { color: "#cf222e", borderColor: "#cf222e" },
                  disabled: devBusy !== "",
                  onClick: function () { doDeleteDevice(id); }
                }, devBusy === "delete:" + id ? "删除中…" : armedDel === id ? "⚠ 再点一次确认删除记录" : "删除记录")
              )
            );
          }),
          h("div", { className: "dru-hint", style: { marginTop: 4 } },
            "取消配对后，对方需重新扫码/登录才能再次远程访问本机。"),
          h("div", { className: "dru-actions", style: { marginTop: 8, borderTop: "1px dashed #eaeef2", paddingTop: 8 } },
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
      function renderHome() {
        var isLocal = mode === "local";
        return h("div", null,
          // 连接模式主 Tab(云端服务 / 自建服务,二选一)
          h("div", { className: "dru-tabs", style: { marginTop: 4 } },
            h("div", { className: "dru-tab" + (!isLocal ? " active" : ""), onClick: function () { setMode("saas"); setMessage(null); } }, "☁️ 云端服务"),
            h("div", { className: "dru-tab" + (isLocal ? " active" : ""), onClick: function () { setMode("local"); setMessage(null); } }, "🖥 自建服务")
          ),
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
                            field("邀请码（选填）", input({ value: rInvite, placeholder: "好友的邀请码，如 A8K2M4XQ", autoComplete: "off", onChange: function (e) { setRInvite(e.target.value); } })),
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
          // Bridge 状态
          card("🖥 Bridge 服务",
            h("div", { className: "dru-status-line" },
              h("span", { className: "dru-dot " + (serviceRunning ? "dru-dot-on" : "dru-dot-off") }),
              h("span", null, st ? (serviceRunning ? "运行中" : "已停止") : "查询中…"),
              launchdPid ? h("span", { className: "dru-meta", style: { marginTop: 0 } }, "(pid=" + launchdPid + ")") : null
            ),
            h("div", { className: "dru-actions", style: { marginTop: 10 } },
              !serviceRunning
                ? h("button", { type: "button", className: "dru-btn dru-btn-primary", disabled: busy !== "", onClick: function () { toggleBridge(true); } }, busy === "start" ? "启动中…" : "启动 bridge")
                : h("button", { type: "button", className: "dru-btn dru-btn-danger", disabled: busy !== "", onClick: function () { toggleBridge(false); } }, busy === "stop" ? "停止中…" : "停止 bridge")
            ),
            h("div", { className: "dru-meta" }, st && st.config && st.config.deviceId ? "设备 ID：" + st.config.deviceId : "设备 ID：生成中"),
            h("div", { className: "dru-meta" }, st ? (st.service && st.service.plistExists ? "自启动服务已安装" : "自启动服务未安装（启动时自动创建）") : ""),
            st && st.service && st.service.bindError
              ? h("div", { className: "dru-msg dru-msg-err", style: { marginTop: 8 } },
                  "⚠️ 设备注册失败：" + (st.service.bindError.message || "未说明原因"),
                  h("div", { className: "dru-hint", style: { marginTop: 4 } },
                    st.service.bindError.code === "device_limit_exceeded"
                      ? "已达本套餐设备数上限。若是同一台电脑重装，稍等片刻会自动顶替旧设备；仍未恢复请在手机端「设备管理」解绑旧设备（免费用户每月可解绑 3 次）后，回到这里点「启动 bridge」。"
                      : "请确认网络与账号状态后重试；仍未解决可点下方「彻底卸载」后重新安装。")
                )
              : null
          ),
          // 关于 dsh-remote（v0.5+ 远程访问价值说明卡片）
          card("📖 关于 dsh-remote", [
            h("div", { className: "dru-hint", style: { marginBottom: 6 } }, "📱 远程访问：用手机或另一台电脑的浏览器，随时随地使用同一份 dsh web——人在哪都能用（免公网 IP、免内网穿透）；官方托管中继，4G/5G 即用，也可自建服务。"),
            h("div", { className: "dru-hint", style: { marginBottom: 6 } }, "🛠 电脑端一键安装：bridge 与「远程访问」面板一次到位——云端/自建切换、账号登录、bridge 启停、一次性扫码访问、已授权设备管理、意见反馈都在这里。"),
            h("div", { className: "dru-hint", style: { marginBottom: 6 } }, "🔒 安全与通道：HTTP / WebSocket 全量透传，一次性访问密钥认证，面板实时显示设备与已授权设备列表；服务端可配置流量配额。"),
            h("div", { className: "dru-hint" }, "🛡 端到端加密：手机↔电脑之间的消息内容用「你的账号密码派生密钥」端到端加密——密钥与密码不落服务端（仅存校验值），中继只可见路径/大小/时间（详见 README「安全与隐私」）。"),
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

      /** 交流群弹窗（复用满意度弹窗的 dru-popup 视觉；点遮罩/关闭即收起）。 */
      function renderCommunityModal() {
        if (!commOpen || !(community && community.qrcode)) return null;
        var close = function () { setCommOpen(false); };
        return h("div", { className: "dru-popup", onMouseDown: function (e) { if (e.target === e.currentTarget) close(); } },
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

      return h("div", { className: "dru-settings-section", role: "region", "aria-label": "远程访问" },
        h("div", { className: "dru-settings-head" },
          h("span", { className: "dru-settings-icon" }, "📱"),
          h("div", null,
            h("h2", { className: "dru-settings-title" }, "远程访问"),
            h("div", { className: "dru-settings-sub" }, "通过手机或另一台电脑远程使用同一份 dsh web，人在哪都能用（免公网 IP）")
          )
        ),
        h("div", { className: "dru-settings-body" },
          view === "feedback" ? renderFeedback() : view === "invite" ? renderInvite() : renderHome()
        ),
        renderCommunityModal()
      );
    }

    // ── 插件入口 ─────────────────────────────────────────────────────────────
    var inject = ["slots"];
    function apply(ctx) {
      // 面板入口迁移：从侧边栏（sidebar.footer.action）移入「设置」页官方扩展点
      // settings.section（列表槽，由 ui-settings-general 在 sidebar.settings 下声明）。
      // order 30 > Agent 预设(20)，栏目落在「Agent 预设」下方；label 即栏目名（📱 远程访问）。
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "dsh-remote",
          order: 30,
          label: function () { return "📱 远程访问"; }
        }, RemoteControlSection);
      });
      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register({ name: "shell.overlay", id: "dsh-feedback-popup", order: 90 }, FeedbackPopup);
      });

      // 首次安装引导小红点（localStorage dsh-remote-seen-dot；点击后不再显示）
      dotWatch();
      // 侧栏「远程访问」快捷入口（2026-09 恢复注入：与官方「设置」按钮共存不遮挡）
      navEnsureStart();

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
