// dsh-remote-ui — browser half（手写 bundle，无需构建）
//
// 格式遵循 dsh 浏览器插件约定（双半插件，bundle 手写无构建）：
//   window.__ModuleLoader__.load({ id: <包名>, factory: (require) => {...} })
// factory 内只能 require shell 种子模块（react / react/jsx-runtime 等）。
//
// 功能：
//   - settings.section：设置页「远程控制」栏目（位于「Agent 预设」下方，官方扩展点）
//   - 栏目内联渲染配置面板（浅色高对比 UI，遵循主流登录体验）
//     · 登录态：已登录显示账号 + 退出登录；未登录显示 登录/注册 tabs
//     · 登录要求图形验证码；注册要求两次密码 + 图形验证码
//     · 远程地址展示 + bridge 状态与启停开关 + 关于 dsh-remote 说明卡片
//   - 首次安装引导：设置页栏目旁小红点（localStorage dsh-remote-seen-dot 控制）
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
      // 首次安装引导小红点（挂在设置页「远程控制」导航栏目右上角）
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
    ].join("\n");
    document.head.appendChild(styleEl);

    // ── 首次安装引导小红点（设置页「远程控制」栏目，localStorage 控制） ────
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
    /** 扫描设置页导航，找到「远程控制」栏目按钮后注入红点。 */
    function dotScan() {
      if (dotSeen()) return;
      var cells = document.querySelectorAll("button");
      for (var i = 0; i < cells.length; i++) {
        var c = cells[i];
        // 语义化匹配：设置页导航按钮（navCell）+ 栏目名「远程控制」。
        // class 为 shell 的 hashed 类名，取子串匹配避免依赖具体 hash；
        // 若未来 hash 变化导致匹配失败，仅红点不显示，栏目本身不受影响。
        if (String(c.className || "").indexOf("navCell") === -1) continue;
        if ((c.textContent || "").indexOf("远程控制") === -1) continue;
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

    // ── 用户反馈模块：本地状态（thread 令牌 / 弹窗节流） ───────────────────
    var FB_THREADS_KEY = "dsh-feedback-threads";
    var FB_POPUP_KEY = "dsh-feedback-popup";
    var FB_POPUP_DELAY_MS = 60 * 60 * 1000;   // 安装/体验后至少 1 小时才弹窗(只弹一次)
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
      try { return JSON.parse(localStorage.getItem(FB_POPUP_KEY) || "null"); } catch (e) { return null; }
    }
    function fbSavePopState(s) {
      try { localStorage.setItem(FB_POPUP_KEY, JSON.stringify(s)); } catch (e) {}
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

      function setMsg(kind, text) { setFbMsg({ kind: kind, text: text }); }

      var loadCfg = useCallback(function () {
        api("/dsh-remote/feedback-config").then(function (b) {
          setCfg(b);
          // 登录态（节点半自动附加 JWT）→ 提交自动带上账号身份；
          // 匿名（自建/未登录）→ 不要求任何验证码，服务端只记录 IP / 浏览器标识。
          setFbAuth(b.auth === "account" ? "account" : "anonymous");
          if (!b.reachable) setMsg("warn", "反馈服务未连接，请检查网络或 feedback_url 配置");
        }).catch(function (e) { setCfg({ reachable: false }); setMsg("warn", "反馈服务未连接：" + e.message); });
      }, []);

      function loadThread(id) {
        var t = threads.filter(function (x) { return x.id === id; })[0];
        if (!t) return;
        setBusy("thread:" + id);
        fbApi("/feedback/" + id, { token: t.token }).then(function (b) {
          setThreadData(b.feedback);
        }).catch(function (e) {
          setMsg("err", "加载反馈详情失败：" + e.message);
        }).finally(function () { setBusy(""); });
      }

      useEffect(function () { loadCfg(); }, [loadCfg]);

      var doSubmit = function () {
        if (!fbContent.trim()) { setMsg("err", "请填写反馈内容"); return; }
        if (fbContent.length > 2000) { setMsg("err", "内容不能超过 2000 字"); return; }
        setBusy("submit");
        var payload = {
          kind: "feedback",
          category: cat,
          title: fbTitle.trim(),
          content: fbContent.trim(),
          contact: contact.trim() || (cfg && cfg.phone ? cfg.phone : ""),
        };
        fbApi("/feedback", { method: "POST", body: JSON.stringify(payload) })
          .then(function (b) {
            fbRememberThread(b.feedback.id, b.thread_token);
            setThreads(fbLoadThreads());
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
        if (!t) return;
        setBusy("reply:" + id);
        fbApi("/feedback/" + id + "/replies", { method: "POST", body: JSON.stringify({ content: text }), token: t.token })
          .then(function () {
            if (input) input.value = "";
            loadThread(id);
            setMsg("ok", "✅ 已回复");
          })
          .catch(function (e) {
            var errBody = e.body && e.body.error;
            if (errBody && errBody.code === "rate_limited") setMsg("err", "今天回复次数已达上限，请明天再试");
            else setMsg("err", "回复失败：" + (errBody && errBody.message ? errBody.message : e.message));
          })
          .finally(function () { setBusy(""); });
      };

      var openThread = function (id) {
        setOpenId(id === openId ? "" : id);
        setThreadData(null);
        if (id !== openId) loadThread(id);
      };

      return h("div", { className: "dru-card" },
        h("h3", null, "💬 用户反馈"),
        h("div", { className: "dru-fb-tabs" },
          h("div", { className: "dru-fb-tab" + (tab === "submit" ? " active" : ""), onClick: function () { setTab("submit"); setFbMsg(null); } }, "提交反馈"),
          h("div", { className: "dru-fb-tab" + (tab === "mine" ? " active" : ""), onClick: function () { setTab("mine"); setFbMsg(null); setThreads(fbLoadThreads()); } }, "我的反馈" + (threads.length ? "(" + threads.length + ")" : ""))
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
          : h("div", null,
              threads.length === 0
                ? h("div", { className: "dru-fb-empty" }, "还没有提交过反馈。" + (cfg && cfg.reachable === false ? "（反馈服务未连接）" : ""))
                : threads.slice().reverse().map(function (t) {
                    var open = openId === t.id;
                    var td = open ? threadData : null;
                    return h("div", { key: t.id, className: "dru-fb-item" },
                      h("div", { className: "dru-fb-item-head" },
                        fbStatusBadge(td ? td.status : "open"),
                        h("span", { className: "dru-fb-cat" }, (function () {
                          var c = FB_CATEGORIES.filter(function (x) { return x.value === (td ? td.category : ""); })[0];
                          return c ? c.label : (td ? td.category : "反馈");
                        })()),
                        h("span", { className: "dru-fb-item-title" }, td ? (td.title || "反馈") : "反馈 #" + t.id.slice(-6)),
                        h("span", { className: "dru-fb-item-time" }, td ? new Date(td.created_at).toLocaleString() : "")
                      ),
                      open && td
                        ? h("div", null,
                            h("div", { className: "dru-fb-item-content" }, td.content),
                            td.replies.map(function (r) {
                              return h("div", { key: r.id, className: "dru-fb-reply" },
                                h("div", { className: "dru-fb-reply-row" },
                                  h("span", { className: "dru-fb-reply-who" + (r.author === "user" ? " user" : "") }, r.author === "admin" ? "管理员回复" : "我"),
                                  h("span", { className: "dru-fb-reply-text" }, r.content)
                                ),
                                h("div", { className: "dru-fb-item-time" }, new Date(r.created_at).toLocaleString())
                              );
                            }),
                            h("div", { className: "dru-fb-reply" },
                              h("textarea", { id: "dru-fb-reply-" + t.id, className: "dru-fb-reply-input", placeholder: "回复管理员…", maxLength: 2000 }),
                              h("div", { style: { textAlign: "right", marginTop: 6 } },
                                h("button", { type: "button", className: "dru-btn dru-btn-ghost", disabled: busy !== "", onClick: function () { doReply(t.id); } }, busy === "reply:" + t.id ? "发送中…" : "回复")
                              )
                            ),
                            h("div", { className: "dru-fb-item-time", style: { textAlign: "right", marginTop: 8 } },
                              h("button", { type: "button", className: "dru-btn dru-btn-ghost", style: { padding: "2px 10px", fontSize: 12 }, disabled: busy !== "", onClick: function () { loadThread(t.id); } }, "↻ 刷新"),
                              " ",
                              h("button", { type: "button", className: "dru-btn dru-btn-ghost", style: { padding: "2px 10px", fontSize: 12 }, onClick: function () { setOpenId(""); setThreadData(null); } }, "收起")
                            )
                          )
                        : h("div", { className: "dru-fb-item-time", style: { textAlign: "right" } },
                            h("button", { type: "button", className: "dru-btn dru-btn-ghost", style: { padding: "2px 10px", fontSize: 12 }, disabled: busy !== "", onClick: function () { openThread(t.id); } }, open ? "收起" : "查看 / 回复"))
                    );
                  }),
              fbMsg && h("div", { className: "dru-msg dru-msg-" + fbMsg.kind }, fbMsg.text)
            )
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
          content: note.trim() || (rating >= 4 ? "对远程控制功能满意" : "对远程控制功能不太满意"),
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
                  h("div", { className: "dru-popup-title" }, "您对远程控制功能满意吗？"),
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
    // 通用「远程控制」图标（🖥 风格 emoji，与面板内既有 emoji 图标体系一致）：
    // 栏目导航 label 与栏目头部均使用它。原侧边栏入口（电源图标按钮）已随入口迁移移除。

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
      var launchdPid = st && st.service && st.service.launchd && st.service.launchd.pid;

      // 已登录(SaaS)→ 拉我的信息/配额/公共配置
      useEffect(function () {
        if (!(st && st.config && st.config.phone)) return;
        api("/dsh-remote/account").then(function (b) { if (b && b.ok) setAccount(b.account); }).catch(function () {});
        api("/dsh-remote/quota").then(function (b) { if (b && b.ok) setQuota(b.quota); }).catch(function () {});
        api("/dsh-remote/remote-url").then(function (b) { if (b && b.ok && b.publicConfig) setPub(b.publicConfig); }).catch(function () {});
      }, [st && st.config && st.config.phone]);

      useEffect(function () { refresh(); }, [refresh]);
      useEffect(function () {
        if (st !== null && !loggedIn && mode === "saas" && authTab === "login" && !lcap) loadCaptcha("login");
      }, [st, loggedIn, mode, authTab, lcap]);

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
          // 退出登录：清除本机保存的用户反馈线程凭据（thread_token 见 FB_THREADS_KEY），
          // 反馈历史保留在服务端（按账号校验），账号身份变化后本机不再可见旧线程。
          fbClearThreads();
          if (clearForm) { setPhone(""); setPass(""); setLcapTxt(""); setLcap(null); setRphone(""); setRpass(""); setRpass2(""); setRsms(""); setRsmsBtn("获取验证码"); setRcapTxt(""); setRcap(null); }
          setMessage(null);
        }).catch(function (e) { setMsg("err", "退出失败: " + e.message); })
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

      var copyUrl = function () {
        if (!st) return;
        try { navigator.clipboard.writeText(st.remoteUrl).then(function () { setCopied(true); setTimeout(function () { setCopied(false); }, 1500); }); } catch (e) {}
      };

      var saveLocal = function () {
        if (!selfHost.trim() || !localKey.trim()) { setMsg("err", "请填写服务器地址与访问密钥"); return; }
        setBusy("local");
        post("/dsh-remote/config", { mode: "local", selfHostUrl: selfHost.trim(), localKey: localKey.trim() })
          .then(function (body) {
            // 切换到自建服务（连接账号上下文变为本地无账号）：清除 SaaS 账号的反馈线程凭据
            fbClearThreads();
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
      /** 推广/升级页地址（/app/promo），取不到时返回空（按钮隐藏）。 */
      function promoUrl() {
        var base = (pub && pub.app_url) || (st && st.remoteUrl) || "";
        if (!base) return "";
        return base.replace(/\/+$/, "") + "/promo";
      }
      function renderAccount() {
        var a = account;
        var plan = a ? a.plan : "free";
        var source = a ? (a.plan_source || "plan") : "plan";
        var isMember = plan === "pro" || plan === "pro_max";
        var endsAt = a && (a.plan_ends_at || a.trial_expires_at) ? Number(a.plan_ends_at || a.trial_expires_at) : 0;
        var quotaPct = quota && quota.limit_enabled ? quota.percent : null;
        var promo = promoUrl();
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
            promo && h("a", { className: "dru-btn dru-btn-primary", style: { textDecoration: "none", display: "inline-flex", alignItems: "center" }, href: promo, target: "_blank", rel: "noopener" },
              !isMember ? "🚀 升级 PRO" : source === "trial" ? "🚀 转正式 PRO" : "🔄 续费会员"),
            h("button", { type: "button", className: "dru-btn dru-btn-ghost", disabled: busy !== "", onClick: function () { setView("invite"); loadInvite(); } }, "🎯 邀请好友赚会员"),
            h("button", { type: "button", className: "dru-btn dru-btn-ghost", disabled: busy !== "", onClick: function () { setView("feedback"); } }, "💬 用户反馈"),
            h("button", { type: "button", className: "dru-btn dru-btn-danger", disabled: busy !== "", onClick: function () { doLogout(false); } }, "退出登录")
          ),
          endsAt && isMember ? h("div", { className: "dru-hint", style: { marginTop: 8 } },
            "到期后如需继续使用会员权益，请在到期前续费。" + (promo ? "升级/续费入口在推广页。" : "")
          ) : null
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

      // ---------- 主视图 ----------
      function renderHome() {
        var isLocal = mode === "local";
        return h("div", null,
          // 连接模式主 Tab(云端服务 / 自建服务,二选一)
          h("div", { className: "dru-tabs", style: { marginTop: 4 } },
            h("div", { className: "dru-tab" + (!isLocal ? " active" : ""), onClick: function () { setMode("saas"); setMessage(null); } }, "☁️ 云端服务"),
            h("div", { className: "dru-tab" + (isLocal ? " active" : ""), onClick: function () { setMode("local"); setMessage(null); } }, "🖥 自建服务")
          ),
          // 云端 tab：远程控制地址 + 账号（手机号登录，官方托管）
          !isLocal ? h("div", null,
            card("📱 远程控制地址",
              h("div", { className: "dru-url" },
                h("span", null, st ? st.remoteUrl : "加载中…"),
                h("button", { type: "button", onClick: copyUrl }, copied ? "已复制" : "复制")
              ),
              h("div", { className: "dru-hint", style: { marginTop: 6 } },
                st && st.relayReachable === false ? "⚠ 云端服务不可达（地址可能不是最新）" : "手机浏览器打开此地址登录后即可远程控制本机。")
            ),
            card("🔑 账号",
              st === null
                ? h("div", { className: "dru-hint" }, "正在读取远控状态…")
                : loggedIn && st.config.phone
                  ? renderAccount()
                  : h("div", null,
                      h("div", { className: "dru-tabs" },
                        h("div", { className: "dru-tab" + (authTab === "login" ? " active" : ""), onClick: function () { setAuthTab("login"); setMessage(null); } }, "登录"),
                        h("div", { className: "dru-tab" + (authTab === "register" ? " active" : ""), onClick: function () { setAuthTab("register"); setMessage(null); } }, "注册")
                      ),
                      authTab === "login"
                        ? h("div", null,
                            field("手机号", input({ type: "tel", value: phone, placeholder: "11 位手机号", autoComplete: "tel", onChange: function (e) { setPhone(e.target.value); } })),
                            field("密码", input({ type: "password", value: pass, placeholder: "密码", autoComplete: "current-password", onChange: function (e) { setPass(e.target.value); } })),
                            field("验证码", h("div", { className: "dru-captcha" },
                              input({ value: lcapTxt, placeholder: "图中数字", autoComplete: "off", inputMode: "numeric", maxLength: 6, onChange: function (e) { setLcapTxt(e.target.value); } }),
                              h("div", { className: "dru-captcha-box", title: "看不清？点击刷新", onClick: function () { loadCaptcha("login"); }, dangerouslySetInnerHTML: lcap && lcap.svg && lcap.svg.indexOf("<svg") === 0 ? { __html: lcap.svg } : void 0 },
                                lcap && lcap.svg && lcap.svg.indexOf("<svg") !== 0 ? lcap.svg : null)
                            )),
                            h("button", { type: "button", className: "dru-btn dru-btn-primary", style: { width: "100%" }, disabled: busy !== "", onClick: doLogin }, busy === "login" ? "登录中…" : "登录")
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
            h("div", { className: "dru-meta" }, st ? (st.service && st.service.plistExists ? "自启动服务已安装" : "自启动服务未安装（启动时自动创建）") : "")
          ),
          // 关于 dsh-remote（开源项目说明卡片）
          card("📖 关于 dsh-remote", [
            h("div", { className: "dru-hint", style: { marginBottom: 6 } }, "① 为什么推荐用 SaaS：不用自己买服务器、不用折腾部署，装好客户端就能用，最省心。"),
            h("div", { className: "dru-hint", style: { marginBottom: 6 } }, "② 会员费去向：付的是网络带宽/服务器成本，也是给开发者的合理支持，让项目持续维护。"),
            h("div", { className: "dru-hint", style: { marginBottom: 6 } }, "③ 也可以自建：项目完全开源，有服务器可自行部署，流量走自己的服务器，闭环自控。"),
            h("div", { className: "dru-hint" }, "④ 一句话总结：简单省心用 SaaS，技术玩家可自建。")
          ]),
          message && h("div", { className: "dru-msg dru-msg-" + message.kind }, message.text)
        );
      }

      return h("div", { className: "dru-settings-section", role: "region", "aria-label": "远程控制" },
        h("div", { className: "dru-settings-head" },
          h("span", { className: "dru-settings-icon" }, "🖥"),
          h("div", null,
            h("h2", { className: "dru-settings-title" }, "远程控制"),
            h("div", { className: "dru-settings-sub" }, "通过手机远程控制本机 dsh web")
          )
        ),
        h("div", { className: "dru-settings-body" },
          view === "feedback" ? renderFeedback() : view === "invite" ? renderInvite() : renderHome()
        )
      );
    }

    // ── 插件入口 ─────────────────────────────────────────────────────────────
    var inject = ["slots"];
    function apply(ctx) {
      // 面板入口迁移：从侧边栏（sidebar.footer.action）移入「设置」页官方扩展点
      // settings.section（列表槽，由 ui-settings-general 在 sidebar.settings 下声明）。
      // order 30 > Agent 预设(20)，栏目落在「Agent 预设」下方；label 即栏目名（🖥 通用远程控制图标）。
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "dsh-remote",
          order: 30,
          label: function () { return "🖥 远程控制"; }
        }, RemoteControlSection);
      });
      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register({ name: "shell.overlay", id: "dsh-feedback-popup", order: 90 }, FeedbackPopup);
      });

      // 首次安装引导小红点（localStorage dsh-remote-seen-dot；点击后不再显示）
      dotWatch();

      // 满意度弹窗调度：首次观察到 bridge 运行（即“安装完成并体验”）后约 10 分钟弹出；
      // 每 60 秒复查一次，避免 dsh web 启动晚于到点时间。
      api("/dsh-remote/status").then(function (body) {
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
