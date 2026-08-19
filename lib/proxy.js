import http from "node:http";
import https from "node:https";

/**
 * dsh-remote 反向代理模块。
 *
 * 将已认证的请求转发到上游 dsh web(默认 http://127.0.0.1:3080),同时:
 *   - 重写 Host 头为上游 loopback 地址(通过信任围栏的 loopback 分支);
 *   - 剥离 Origin / Sec-Fetch-* / Referer(围栏要求 Origin 匹配 Host,
 *     而浏览器会带真实 origin;剥离后围栏走 "无 Origin 直接放行" 分支);
 *   - 注入 X-Forwarded-For / X-Forwarded-Proto(审计与后续扩展);
 *   - WebSocket 升级原样透传(节点 socket 对接,不依赖 ws 库)。
 *
 * 返回 { request, upgrade } 两个处理函数,分别挂到 server 的
 * 'request' 与 'upgrade' 事件。
 */

/** 需要剥离的浏览器标记头(信任围栏相关)。 */
const STRIP_HEADERS = new Set([
  "origin",
  "referer",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user"
]);

/** hop-by-hop 头,由 HTTP 层处理,不转发。 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "sec-websocket-extensions" // 由上游自行协商
]);

/** 由客户端 socket 解析真实 IP(支持直接连接与 X-Forwarded-For)。 */
export function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * 构造转发用的请求头。
 * @param {import('node:http').IncomingMessage} req
 * @param {string} upstreamHostPort 形如 "127.0.0.1:3080"
 * @param {boolean} isSecure 网关侧是否为 HTTPS
 * @param {boolean} forUpgrade 是否为 WebSocket 升级请求
 */
function forwardHeaders(req, upstreamHostPort, isSecure, forUpgrade = false) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (STRIP_HEADERS.has(lk) || HOP_BY_HOP.has(lk)) continue;
    if (lk === "host") continue; // 统一重写
    if (Array.isArray(v)) out[k] = v.join(", ");
    else if (v !== undefined) out[k] = v;
  }
  out["Host"] = upstreamHostPort;
  out["X-Forwarded-For"] = clientIp(req);
  out["X-Forwarded-Proto"] = isSecure ? "https" : "http";
  if (forUpgrade) {
    out["Connection"] = "Upgrade";
    out["Upgrade"] = "websocket";
  }
  return out;
}

/**
 * 创建反向代理。
 * @param {URL} upstream 上游地址
 * @param {{isTrusted?: (req) => boolean, onRequest?: (req) => void}} opts
 */
export function createProxy(upstream, { isTrusted, onRequest } = {}) {
  const mod = upstream.protocol === "https:" ? https : http;
  const upstreamAuthority = upstream.host; // host:port
  const upstreamPort = upstream.port || (upstream.protocol === "https:" ? 443 : 80);

  function rejected(res, status = 401) {
    res.writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(status === 401 ? "unauthorized" : "forbidden");
  }

  /** 普通 HTTP 请求处理。 */
  function request(req, res) {
    if (isTrusted && !isTrusted(req)) {
      rejected(res, 401);
      return;
    }
    onRequest?.(req);

    const headers = forwardHeaders(req, upstreamAuthority, req.socket.encrypted === true);
    const options = {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers,
      agent: false
    };

    const upstreamReq = mod.request(options, (upstreamRes) => {
      const resHeaders = { ...upstreamRes.headers };
      delete resHeaders["transfer-encoding"];
      res.writeHead(upstreamRes.statusCode ?? 502, resHeaders);
      upstreamRes.pipe(res);
    });

    upstreamReq.on("error", (err) => {
      if (res.writableEnded) return;
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`upstream unreachable: ${err.message}`);
    });

    req.pipe(upstreamReq);
  }

  /** WebSocket 升级处理。 */
  function upgrade(req, socket, head) {
    const respond = (status, text) => {
      socket.end([
        `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Status"}`,
        "Connection: close",
        "Content-Type: text/plain; charset=utf-8",
        `Content-Length: ${Buffer.byteLength(text)}`,
        "",
        text
      ].join("\r\n"));
    };

    if (isTrusted && !isTrusted(req)) {
      respond(401, "unauthorized");
      return;
    }
    onRequest?.(req);

    const headers = forwardHeaders(req, upstreamAuthority, req.socket.encrypted === true, true);
    const options = {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstreamPort,
      method: "GET",
      path: req.url,
      headers,
      agent: false
    };

    const upstreamReq = mod.request(options);
    upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
      console.error("[dsh-remote][ws] upstream upgrade status:", upstreamRes.statusCode, "headers:", JSON.stringify(upstreamRes.headers));
      const status = upstreamRes.statusCode ?? 101;
      const headLines = [
        `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Status"}`,
        "Upgrade: websocket",
        "Connection: Upgrade"
      ];
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        const lk = k.toLowerCase();
        if (lk === "transfer-encoding" || lk === "connection" || lk === "upgrade") continue;
        headLines.push(`${k}: ${v}`);
      }
      socket.write(headLines.join("\r\n") + "\r\n\r\n");

      if (upstreamHead && upstreamHead.length > 0) upstreamSocket.unshift(upstreamHead);
      if (head && head.length > 0) socket.unshift(head);

      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);

      const kill = () => {
        socket.destroy();
        upstreamSocket.destroy();
      };
      socket.on("error", kill);
      upstreamSocket.on("error", kill);
      socket.on("close", () => upstreamSocket.destroy());
      upstreamSocket.on("close", () => socket.destroy());
    });

    upstreamReq.on("error", (err) => {
      console.error("[dsh-remote][ws] upstream error:", err.message);
      if (socket.destroyed) return;
      respond(502, `upstream unreachable: ${err.message}`);
    });
    upstreamReq.on("response", (res) => {
      console.error("[dsh-remote][ws] upstream responded with HTTP", res.statusCode, "not upgrade");
      res.resume();
    });

    upstreamReq.end();
  }

  return { request, upgrade };
}

/** 探测上游是否可达(供健康检查)。 */
export function probeUpstream(upstream, timeoutMs = 1500) {
  return new Promise((resolvePromise) => {
    const mod = upstream.protocol === "https:" ? https : http;
    const req = mod.get({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
      path: "/",
      headers: { Host: upstream.host },
      agent: false,
      timeout: timeoutMs
    }, (res) => {
      res.resume();
      resolvePromise(true);
    });
    req.on("error", () => resolvePromise(false));
    req.on("timeout", () => {
      req.destroy();
      resolvePromise(false);
    });
  });
}
