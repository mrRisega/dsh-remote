/* DSH Remote 登录页交互 */
(function () {
  "use strict";
  var form = document.getElementById("loginForm");
  var password = document.getElementById("password");
  var toggle = document.getElementById("togglePwd");
  var msg = document.getElementById("msg");
  var submitBtn = document.getElementById("submitBtn");
  var submitText = submitBtn.querySelector(".submit__text");
  var spinner = submitBtn.querySelector(".submit__spinner");
  var dot = document.getElementById("statusDot");
  var statusText = document.getElementById("statusText");

  function setStatus(state, text) {
    dot.className = "status__dot " + state;
    statusText.textContent = text;
  }

  function setMsg(text, kind) {
    if (!text) {
      msg.hidden = true;
      msg.textContent = "";
      msg.className = "msg";
      return;
    }
    msg.hidden = false;
    msg.textContent = text;
    msg.className = "msg " + (kind || "error");
  }

  function setBusy(busy) {
    submitBtn.disabled = busy;
    submitText.hidden = busy;
    spinner.hidden = !busy;
    password.disabled = busy;
  }

  // 口令可见性切换
  toggle.addEventListener("click", function () {
    var show = password.type === "password";
    password.type = show ? "text" : "password";
    toggle.setAttribute("aria-label", show ? "隐藏口令" : "显示口令");
  });

  // 健康检查(仅提示,不阻塞)
  fetch("/healthz", { cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(function (h) {
      setStatus(h.reachable ? "ok" : "warn",
        h.reachable ? "dsh web 在线 · 请输入口令" : "dsh web 未运行(需在电脑端启动)");
    })
    .catch(function () {
      setStatus("warn", "网关在线 · 等待输入");
    });

  // 登录
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (!password.value) {
      setMsg("请输入口令");
      password.focus();
      return;
    }
    setBusy(true);
    setMsg(null);
    fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: password.value })
    }).then(function (r) {
      if (r.ok) {
        setMsg("连接成功,正在进入…", "ok");
        window.location.href = "/";
        return;
      }
      return r.json().then(function (j) {
        if (j && j.error === "rate_limited") {
          setMsg("尝试过于频繁,请 " + (j.retryAfter || 60) + " 秒后再试");
        } else {
          setMsg("口令错误,请重试");
          setStatus("err", "认证失败");
          password.select();
          password.focus();
        }
      });
    }).catch(function () {
      setMsg("网络错误,请检查连接");
    }).finally(function () {
      setBusy(false);
    });
  });

  // 清空提示
  password.addEventListener("input", function () { setMsg(null); });
})();
