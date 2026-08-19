import http from "node:http";
import https from "node:https";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, extname, normalize, resolve } from "node:path";
import { createProxy, probeUpstream, clientIp } from "./proxy.js";
import {
  verifyPassword,
  LoginRateLimiter,
  generateSessionToken,
  fingerprint,
  sessionCookieName
} from "./auth.js";

/**
 * dsh-remote 主服务:组装登录页/静态资源/健康检查 + 反向代理。
 *
 * 路由表:
 *   GET  /login           登录页(未认证也能访问)
 *   POST /api/login       提交口令(表单)
 *   POST /api/logout      登出
 *   GET  /healthz         健康检查(无需认证)
 *   其他                   已认证 → 代理到上游;未认证 → 302 到 /login
 */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json"
};

/** 读取 cookie。 */
function parseCookies(req) {
  const raw = req.headers.cookie;
  if (!raw) return {};
  const out = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/** 会话存储(内存 Map)。 */
class SessionStore {
  #sessions = new Map(); // tokenFingerprint -> { createdAt, lastSeenAt, ip }
  #ttlMs;

  constructor(ttlMs) {
    this.#ttlMs = ttlMs;
  }

  create(ip) {
    const token = generateSessionToken();
    const now = Date.now();
    this.#sessions.set(fingerprint(token), { createdAt: now, lastSeenAt: now, ip });
    return token;
  }

  /** 校验并滑动续期。 */
  touch(token) {
    if (typeof token !== "string" || token === "") return false;
    const rec = this.#sessions.get(fingerprint(token));
    if (!rec) return false;
    if (Date.now() - rec.lastSeenAt > this.#ttlMs) {
      this.#sessions.delete(fingerprint(token));
      return false;
    }
    rec.lastSeenAt = Date.now();
    return true;
  }

  destroy(token) {
    if (typeof token === "string") this.#sessions.delete(fingerprint(token));
  }

  count() {
    return this.#sessions.size;
  }
}

/** 从请求体读取字符串(小 body)。 */
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * 启动网关服务。
 * @param {import('./config.js').config} config
 * @returns {Promise<{server: import('node:http').Server, port: number, host: string}>}
 */
export async function startServer(config) {
  const sessions = new SessionStore(config.sessionTtlMs);
  const limiter = new LoginRateLimiter(config.rateLimit);

  const proxy = createProxy(config.upstream, {
    isTrusted: (req) => {
      // 已认证会话放行
      const token = parseCookies(req)[sessionCookieName()];
      if (sessions.touch(token)) return true;
      // IP 白名单(可选):命中白名单视为受信(仍需认证;此处用于跳过会话?不,
      // 白名单仅作为附加防线,认证始终必须)。
      return false;
    },
    onRequest: (req) => {
      if (process.env.DSH_REMOTE_LOG === "1") {
        console.log(`[dsh-remote] ${req.method} ${req.url} (${clientIp(req)})`);
      }
    }
  });

  function allowIp(req) {
    if (config.allowIps.length === 0) return true;
    const ip = clientIp(req);
    return config.allowIps.includes(ip) || config.allowIps.includes(ip.replace(/^::ffff:/, ""));
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? "/", "http://dsh-remote.local");
    const pathname = url.pathname;

    // —— 安全头(全站) ——
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");

    // 健康检查
    if (pathname === "/healthz" && req.method === "GET") {
      const reachable = await probeUpstream(config.upstream);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        upstream: config.upstream.href,
        reachable,
        sessions: sessions.count()
      }));
      return;
    }

    // 登录页(未认证)
    if (pathname === "/login" && req.method === "GET") {
      serveLoginPage(res);
      return;
    }

    // 登录提交
    if (pathname === "/api/login" && req.method === "POST") {
      await handleLogin(req, res);
      return;
    }

    // 登出
    if (pathname === "/api/logout" && req.method === "POST") {
      const token = parseCookies(req)[sessionCookieName()];
      sessions.destroy(token);
      clearSessionCookie(res);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // 静态资源(登录页相关,公开)
    if (pathname.startsWith("/static/")) {
      serveStatic(pathname, res);
      return;
    }

    // 认证检查
    const token = parseCookies(req)[sessionCookieName()];
    if (!sessions.touch(token)) {
      if (req.method === "GET" && !isApiPath(pathname)) {
        res.writeHead(302, { location: "/login" });
        res.end();
        return;
      }
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    // 白名单(附加防线)
    if (!allowIp(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }

    // 其余全部代理到 dsh web
    proxy.request(req, res);
  };

  // —— 认证判定(供 upgrade 用,逻辑与 handler 一致) ——
  const isAuthenticated = (req) => sessions.touch(parseCookies(req)[sessionCookieName()]);

  function handleLogin(req, res) {
    const ip = clientIp(req);
    if (limiter.isBlocked(ip)) {
      const retryAfter = Math.ceil(limiter.retryAfterMs(ip) / 1000);
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": String(retryAfter)
      });
      res.end(JSON.stringify({ error: "rate_limited", retryAfter }));
      return;
    }
    readBody(req).then((body) => {
      let password = "";
      try {
        const parsed = JSON.parse(body);
        if (typeof parsed.password === "string") password = parsed.password;
      } catch {
        // 兼容 form 编码
        const m = body.match(/password=([^&]*)/);
        if (m) password = decodeURIComponent(m[1].replace(/\+/g, " "));
      }
      const ok = verifyPassword(password, config.passwordHash ?? config.password);
      if (!ok) {
        const fails = limiter.recordFailure(ip);
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_credentials", fails }));
        return;
      }
      limiter.reset(ip);
      const token = sessions.create(ip);
      setSessionCookie(res, token, config);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }).catch((e) => {
      console.error("[dsh-remote] login error:", e);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad_request" }));
    });
  }

  function setSessionCookie(res, token, cfg) {
    const secure = cfg.tls ? " Secure;" : "";
    res.setHeader("Set-Cookie", [
      `${sessionCookieName()}=${token}; Path=/; HttpOnly; SameSite=Strict${secure} Max-Age=${Math.floor(cfg.sessionTtlMs / 1000)}`
    ].join(""));
  }

  function clearSessionCookie(res) {
    res.setHeader("Set-Cookie", `${sessionCookieName()}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  }

  function serveLoginPage(res) {
    // 优先从 distDir(默认 public/)读取登录页;缺失时回退到内联版本
    const dist = config.distDir;
    if (dist && existsSync(join(dist, "login.html"))) {
      const body = readFileSync(join(dist, "login.html"));
      res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
      res.end(body);
      return;
    }
    const html = loginHtml();
    res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
    res.end(html);
  }

  function serveStatic(pathname, res) {
    const dist = config.distDir;
    if (!dist) {
      res.writeHead(404);
      res.end("static not configured");
      return;
    }
    const relative = pathname.replace(/^\/static\//, "");
    const target = resolve(join(dist, relative));
    if (!target.startsWith(resolve(dist))) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!existsSync(target) || statSync(target).isDirectory()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(target)] ?? "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(readFileSync(target));
  }

  function loginHtml() {
    const dist = config.distDir;
    let cssLink = "";
    if (dist && existsSync(join(dist, "login.css"))) cssLink = '<link rel="stylesheet" href="/static/login.css" />';
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#0b0d12" />
<title>DSH Remote · 登录</title>
${cssLink}
</head>
<body>
<main class="login-card">
  <div class="brand">
    <svg viewBox="0 0 48 48" width="56" height="56" aria-hidden="true"><rect width="48" height="48" rx="12" fill="#4f8cff"/><path d="M14 18c0-4 3-7 8-7h4c5 0 8 3 8 7s-3 7-8 7h-4c-5 0-8 3-8 7s3 7 8 7h4c5 0 8-3 8-7" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/></svg>
    <h1>DSH Remote</h1>
    <p>远程控制 DeepSeek Harness</p>
  </div>
  <form id="loginForm" autocomplete="on">
    <label for="password">访问口令</label>
    <input id="password" name="password" type="password" required
           autocomplete="current-password" inputmode="text"
           placeholder="请输入口令" autofocus />
    <button type="submit">连接</button>
    <p id="msg" class="msg" role="status"></p>
  </form>
  <footer>
    <span id="statusDot" class="dot"></span><span id="statusText">正在检查连接…</span>
  </footer>
</main>
<script>
(function () {
  var form = document.getElementById('loginForm');
  var msg = document.getElementById('msg');
  var dot = document.getElementById('statusDot');
  var text = document.getElementById('statusText');

  fetch('/healthz').then(function (r) { return r.json(); }).then(function (h) {
    dot.classList.add(h.reachable ? 'ok' : 'warn');
    text.textContent = h.reachable ? 'dsh web 在线 · 请输入口令' : 'dsh web 未运行(仅本机可修复)';
  }).catch(function () {
    dot.classList.add('warn');
    text.textContent = '网关在线 · 等待输入';
  });

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var pwd = document.getElementById('password').value;
    msg.textContent = '';
    msg.className = 'msg';
    fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: pwd })
    }).then(function (r) {
      if (r.ok) { window.location.href = '/'; return; }
      return r.json().then(function (j) {
        msg.textContent = j.error === 'rate_limited'
          ? '尝试过于频繁,请稍后再试'
          : '口令错误,请重试';
        msg.className = 'msg error';
      });
    }).catch(function () {
      msg.textContent = '网络错误';
      msg.className = 'msg error';
    });
  });
})();
</script>
</body>
</html>`;
  }

  function isApiPath(p) {
    return p.startsWith("/api/") || p === "/api";
  }

  // —— 创建服务器 ——
  const server = config.tls
    ? https.createServer({
        cert: readFileSync(config.tls.cert),
        key: readFileSync(config.tls.key)
      }, handler)
    : http.createServer(handler);

  // WebSocket 升级(未认证拒绝)
  server.on("upgrade", (req, socket, head) => {
    if (!isAuthenticated(req)) {
      socket.end([
        "HTTP/1.1 401 Unauthorized",
        "Connection: close",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Length: 12",
        "",
        "unauthorized"
      ].join("\r\n"));
      return;
    }
    proxy.upgrade(req, socket, head);
  });

  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;

  return {
    server,
    port,
    host: config.host,
    upstream: config.upstream.href,
    sessions: () => sessions.count()
  };
}
