/* dsh-e2ee-shim — 镜像页 E2EE 加密 shim(Phase-4;由 bridge 注入到经隧道回传的
 * 官方 dsh web text/html 文档的 </head> 前,与 mobile-adapter 同一注入管线)。
 *
 * 运行时语义(docs/e2ee-protocol.md §4/§5/§6/§9;字节约定对齐 clients/dsh-remote/
 * e2ee-client.mjs「规范化决定 1–6」与 native.html Phase-3 手机端):
 *   0. document-start:读一次性交接单(sessionStorage dsh-e2ee-handover)→ 立即删除,
 *      用内存重建「已与桥端探针互认」的会话(仅 SHK+saltH+sessId;MK/密码不下放)。
 *   1. 有会话 → patch window.fetch / window.WebSocket:命中 §4.5 策略表(/api 排除
 *      SSE、/sidebar、/git、/pet;channel 形态 /remote/{api|sidebar|git|pet}/* 与
 *      device 形态 /remote/<dev>/… 归一后同样判定)→ HTTP 封 v2 信封发送、响应信封
 *      解密(含 gzip)重建 Response;WS 追加 &e2ee=<sessId>&w=<8B hex> 逐消息封/解。
 *      静态壳/SSE/manifest/其余路径/跨源/router 错误页 → 原样明文(零行为)。
 *   2. 无交接单 / 刷新丢密钥 / 解封失败 → 数据面不拦截 + 状态徽标显式
 *      「⚠ 未加密/无法解密」并给出重解锁指引,绝不静默。
 *   3. 状态徽标 #dsh-e2ee-badge(固定右上角小药丸,点击展开说明)。
 *
 * 密钥纪律:会话密钥只存本页 JS 内存;不写 localStorage/sessionStorage(交接单读后即删);
 * 不记录任何密钥/明文到控制台。
 *
 * ==DSH-E2EE-SHIM-CORE== 区间(纯 WebCrypto/传输逻辑,无 DOM)由测试抽取后在 node 与
 * e2ee-client.mjs / native.html WC-CORE 对拍(字节一致),见 test/lib-e2ee-shim.mjs。
 */
(function () {
  "use strict";
  /* ===DSH-E2EE-SHIM-CORE-START=== */
  var SE_NUL = String.fromCharCode(0);
  var SE_DOMAIN = "dsh-e2ee/v1";
  var SE_VERSION = 2;
  var SE_SESS_RE = /^[0-9a-f]{32}$/i;
  var SE_NONCE_BYTES = 12;
  var SE_TAG_BYTES = 16;
  var SE_KEY_BYTES = 32;
  var SE_DIR_P2B = "p2b";
  var SE_DIR_B2P = "b2p";
  var SE_CT = "application/vnd.dsh.e2ee-v2";
  var SE_HDR = "x-dsh-e2ee";
  var DSH_E2EE_HANDOVER_KEY = "dsh-e2ee-handover";
  /* §4.5 策略表:受保护的上游路径前缀(用户内容)。 */
  var SE_PROTECTED_PREFIXES = ["/api", "/sidebar", "/git", "/pet"];

  function seErr(code, message) {
    var e = new Error(message || code);
    e.code = code;
    e.seE2ee = true;
    return e;
  }
  function seUtf8(s) { return new TextEncoder().encode(String(s == null ? "" : s)); }
  function seUtf8Decode(u8) { return new TextDecoder().decode(u8); }
  function seB64ToBytes(b64) {
    if (typeof b64 !== "string" || b64 === "") throw seErr("bad_b64", "e2ee: base64url 非法");
    var s = b64.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function seBytesToB64(bytes) {
    var u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var bin = "";
    var CH = 0x8000;
    for (var i = 0; i < u.length; i += CH) bin += String.fromCharCode.apply(null, u.subarray(i, i + CH));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function seConcat(parts) {
    var total = 0;
    for (var i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total);
    var o = 0;
    for (var j = 0; j < parts.length; j++) { out.set(parts[j], o); o += parts[j].length; }
    return out;
  }
  function seRandomBytes(n) {
    var u = new Uint8Array(n);
    crypto.getRandomValues(u);
    return u;
  }
  function seRandomHex(n) {
    var s = "";
    var u = seRandomBytes(n);
    for (var i = 0; i < u.length; i++) s += u[i].toString(16).padStart(2, "0");
    return s;
  }
  function seSchemeFamily(proto) {
    if (proto === "https:" || proto === "wss:") return 2;
    if (proto === "http:" || proto === "ws:") return 1;
    return 0;
  }
  /** 同源判定:同 host:port 且同 scheme 族(http/ws ↔ wss/https 视为同隧道源)。 */
  function seSameWebContext(u, originStr) {
    try {
      var o = new URL(originStr || "");
      return u.host === o.host && seSchemeFamily(u.protocol) === seSchemeFamily(o.protocol);
    } catch (e) { return false; }
  }
  function seHkdf(ikm, salt, infoStr, len) {
    return crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"])
      .then(function (key) {
        return crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt, info: seUtf8(infoStr) }, key, len * 8);
      })
      .then(function (bits) { return new Uint8Array(bits); });
  }
  function seHeaderValueOf(headers, name) {
    var lk = String(name).toLowerCase();
    if (!headers) return "";
    if (typeof headers.get === "function") { try { return String(headers.get(lk) || ""); } catch (e) { return ""; } }
    var out = "";
    try {
      for (var k in headers) {
        if (Object.prototype.hasOwnProperty.call(headers, k) && String(k).toLowerCase() === lk) {
          var v = headers[k];
          out = Array.isArray(v) ? v.join(", ") : String(v);
        }
      }
    } catch (e) { /* ignore */ }
    return out;
  }
  function seEntriesOf(headers) {
    var out = [];
    if (!headers) return out;
    if (typeof headers.entries === "function") {
      try {
        var it = headers.entries();
        var step = it.next();
        while (!step.done) { out.push([step.value[0], String(step.value[1])]); step = it.next(); }
      } catch (e) { /* ignore */ }
    } else {
      for (var k in headers) {
        if (Object.prototype.hasOwnProperty.call(headers, k) && headers[k] != null) out.push([k, Array.isArray(headers[k]) ? headers[k].join(", ") : String(headers[k])]);
      }
    }
    return out;
  }

  /** 一个解锁会话(由交接单重建;与桥端已探针互认的会话同 sessId)。密钥仅内存。 */
  function SeSession(o) {
    if (!o || typeof o.sessId !== "string" || !SE_SESS_RE.test(o.sessId)) throw seErr("bad_session", "e2ee: sessId 非法");
    if (!o.shk || o.shk.length !== SE_KEY_BYTES || !o.saltH || o.saltH.length !== SE_KEY_BYTES) throw seErr("bad_session", "e2ee: SHK/saltH 非法");
    this.sessId = o.sessId;
    this.shk = o.shk;
    this.saltH = o.saltH;
    this.profile = typeof o.profile === "string" ? o.profile : "";
    this.epoch = Number(o.epoch) || 0;
    this.verified = true; // 交接单来源 = 已通过探针的解锁会话
  }
  /** 子密钥(node keyFor / wc keyBytesFor 同构)。 */
  SeSession.prototype.keyBytesFor = function (opt) {
    var kind = opt.kind, dir = opt.dir, use;
    if (kind === "http" || kind === "http-resp") {
      if (!opt.reqNonceB64) throw seErr("bad_keyinfo", "e2ee: http 子密钥需要 reqNonceB64");
      use = "http" + SE_NUL + opt.reqNonceB64 + SE_NUL + dir;
    } else if (kind === "w") {
      if (!opt.wsLabel) throw seErr("bad_keyinfo", "e2ee: ws 子密钥需要 wsLabel");
      use = "ws" + SE_NUL + opt.wsLabel + SE_NUL + dir;
    } else if (kind === "ctrl") {
      use = "ctrl" + SE_NUL + dir;
    } else {
      throw seErr("bad_keyinfo", "e2ee: 未知信封 kind: " + kind);
    }
    if (dir !== SE_DIR_P2B && dir !== SE_DIR_B2P) throw seErr("bad_keyinfo", "e2ee: 未知方向: " + dir);
    return seHkdf(this.shk, this.saltH, SE_DOMAIN + SE_NUL + use, SE_KEY_BYTES);
  };
  /** AAD(与 node aadOf 同构)。 */
  SeSession.prototype.aadBytesOf = function (opt) {
    return seUtf8(SE_DOMAIN + SE_NUL + opt.kind + SE_NUL + this.sessId + SE_NUL + opt.dir + SE_NUL + String(opt.counter == null ? 0 : opt.counter));
  };
  /** 密封一条消息 → 信封对象(node seal 的浏览器异步版)。 */
  SeSession.prototype.seal = async function (opt) {
    var kind = opt.kind, dir = opt.dir;
    var counter = opt.counter == null ? 0 : opt.counter;
    var isText = typeof opt.data === "string";
    var pt = isText ? seUtf8(opt.data) : (opt.data instanceof Uint8Array ? opt.data : new Uint8Array(opt.data));
    var tOut = opt.t !== undefined ? (opt.t === 0 ? 0 : 1) : kind === "w" ? (isText ? 0 : 1) : 0;
    var n = opt.nonceBytes || seRandomBytes(SE_NONCE_BYTES);
    if (!n || n.length !== SE_NONCE_BYTES) throw seErr("bad_nonce", "e2ee: nonce 须为 12B");
    var keyNonce = kind === "http-resp" ? (opt.reqNonceB64 || "") : (opt.reqNonceB64 || seBytesToB64(n));
    var keyBytes = await this.keyBytesFor({ kind: kind, dir: dir, reqNonceB64: keyNonce, wsLabel: opt.wsLabel || "" });
    var key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
    var enc = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: n, additionalData: this.aadBytesOf({ kind: kind, dir: dir, counter: counter }), tagLength: 128 },
      key, pt
    );
    return { v: SE_VERSION, k: kind, s: this.sessId, c: counter, n: seBytesToB64(n), t: tOut, d: seBytesToB64(new Uint8Array(enc)) };
  };
  /** 打开(解密+认证)一条消息。失败抛 code 错误(node open 的浏览器异步版)。 */
  SeSession.prototype.open = async function (opt) {
    var env = opt.env;
    if (!env || typeof env !== "object") throw seErr("bad_envelope", "e2ee: 信封缺失");
    if (env.v !== SE_VERSION) throw seErr("bad_version", "e2ee: 信封版本不受支持: " + env.v);
    if (env.k !== opt.kind) throw seErr("bad_kind", "e2ee: 信封 kind 不符");
    if (env.s !== this.sessId) throw seErr("bad_session", "e2ee: 信封会话不符");
    var raw = null;
    try { raw = seB64ToBytes(env.d); } catch (e) { raw = null; }
    if (!raw || raw.length < SE_TAG_BYTES + 1) throw seErr("bad_cipher", "e2ee: 密文非法");
    var n = null;
    try { n = seB64ToBytes(env.n); } catch (e) { n = null; }
    if (!n || n.length !== SE_NONCE_BYTES) throw seErr("bad_nonce", "e2ee: nonce 非法");
    var keyNonce = opt.kind === "http-resp" ? (opt.reqNonceB64 || "") : (opt.reqNonceB64 || String(env.n || ""));
    var keyBytes = await this.keyBytesFor({ kind: opt.kind, dir: opt.dir, reqNonceB64: keyNonce, wsLabel: opt.wsLabel || "" });
    var key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
    var out = null;
    try {
      out = new Uint8Array(await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: n, additionalData: this.aadBytesOf({ kind: opt.kind, dir: opt.dir, counter: opt.counter == null ? 0 : opt.counter }), tagLength: 128 },
        key, raw
      ));
    } catch (e) {
      throw seErr("auth_failed", "e2ee: AEAD 打开失败(密文被篡改或密钥不一致)");
    }
    return { data: out, t: env.t === 1 ? 1 : 0 };
  };

  /* ---- http 明文载荷编解码(与 node encode/decodeHttp*Plain 同构) ---- */
  /* 0.6.15:响应明文支持二进制框架(首字节 0x02)，省掉"gzip 正文 → base64"那一层(+33%)。
     由**本客户端主动声明**(请求明文里的 x-dsh-e2ee-want: bin)，桥端只对声明过的请求用它 ——
     老客户端/企业版内置的那份不认识这个头，也就永远收不到看不懂的字节。 */
  var SE_PLAIN_BIN_MAGIC = 2;
  var SE_WANT_BIN_HEADER = "x-dsh-e2ee-want";
  function seEncodeHttpReqPlain(opt) {
    var b = opt.bodyBytes && opt.bodyBytes.length ? seBytesToB64(opt.bodyBytes) : "";
    var src = opt.headers || {};
    var h = {};
    for (var k in src) { if (Object.prototype.hasOwnProperty.call(src, k)) h[k] = src[k]; }
    h[SE_WANT_BIN_HEADER] = "bin"; // 只加在信封明文里（外层 HTTP 头不带它）
    return seUtf8(JSON.stringify({ m: String(opt.method || "GET").toUpperCase(), p: opt.path, h: h, b: b }));
  }
  function seDecodeHttpRespPlain(buf) {
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(0);
    // ① 二进制框架：[0x02][4B 大端头长度][头 JSON][正文原始字节]
    if (u8.length >= 5 && u8[0] === SE_PLAIN_BIN_MAGIC) {
      var headLen = ((u8[1] << 24) | (u8[2] << 16) | (u8[3] << 8) | u8[4]) >>> 0;
      if (headLen > 0 && 5 + headLen <= u8.length) {
        var head = null;
        try { head = JSON.parse(seUtf8Decode(u8.subarray(5, 5 + headLen))); } catch (e) { throw seErr("bad_plain", "e2ee: http 响应明文头不是 JSON"); }
        if (!head || typeof head !== "object") throw seErr("bad_plain", "e2ee: http 响应明文缺失");
        return {
          status: Number(head.st) || 502,
          headers: head.h && typeof head.h === "object" ? head.h : {},
          enc: typeof head.enc === "string" ? head.enc : "",
          bodyBytes: u8.subarray(5 + headLen),
          bodyB64: ""
        };
      }
    }
    // ② 兼容 JSON：{st,h,enc,b:<base64>}
    var text = buf instanceof Uint8Array ? seUtf8Decode(buf) : String(buf || "");
    var pt = null;
    try { pt = JSON.parse(text); } catch (e) { throw seErr("bad_plain", "e2ee: http 响应明文不是 JSON"); }
    if (!pt || typeof pt !== "object") throw seErr("bad_plain", "e2ee: http 响应明文缺失");
    return {
      status: Number(pt.st) || 502,
      headers: pt.h && typeof pt.h === "object" ? pt.h : {},
      enc: typeof pt.enc === "string" ? pt.enc : "",
      bodyBytes: typeof pt.b === "string" && pt.b ? seB64ToBytes(pt.b) : new Uint8Array(0),
      bodyB64: typeof pt.b === "string" ? pt.b : ""
    };
  }
  function seEnvelopeHeaders(sessId) {
    var h = {};
    h["content-type"] = SE_CT;
    h[SE_HDR] = "v=" + SE_VERSION + ";s=" + sessId + ";k=http";
    return h;
  }
  function seIsEnvelopeResponse(res) {
    try {
      var ct = String(res.headers.get("content-type") || "");
      if (ct.split(";")[0].trim().toLowerCase() !== SE_CT) return false;
      return !!res.headers.get(SE_HDR);
    } catch (e) { return false; }
  }
  function seGunzip(u8) {
    try {
      var ds = new DecompressionStream("gzip");
      var stream = new Blob([u8]).stream().pipeThrough(ds);
      return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
    } catch (e) { return null; }
  }

  /* ---- 上游路径 / channel|device 形态归一(与 router resolveRoute / native wcUpstreamPathOf 同构) ---- */
  /**
   * 从镜像页路径取出 deviceId：`/remote/<deviceId>/…` → deviceId（其余形态返回 ""）。
   * 与 mobile-adapter.mjs 的 deviceIdOfPath() 同一套判据；这里不查任何 cookie。
   */
  function seDeviceIdOfPath(pathname) {
    try {
      var parts = String(pathname || "").split("/").filter(Boolean);
      if (parts[0] !== "remote" || !parts[1]) return "";
      var id = decodeURIComponent(parts[1]);
      return /^[A-Za-z0-9._-]{1,64}$/.test(id) ? id : "";
    } catch (e) { return ""; }
  }
  /**
   * 把**根路径**的受保护请求改写成"设备作用域"形态：`/api/x` → `/remote/<deviceId>/api/x`。
   *
   * 为什么必须（2026-09-26 线上事故，nginx access/error 日志为证）：
   *   官方客户端把 mux WS 的地址固定按 **`location.origin`** 拼成 `/api/remote.mux`
   *   （@deepseek-ai/dsh-api-gateway/lib/client.js:544 的 remoteStreamUrl()）—— 它**永远**不带设备前缀，
   *   于是中继只能靠 **`dsh_device` cookie** 来判"这是哪台设备"（relay-router/src/index.mjs:626-627
   *   的根路径兜底）。该 cookie 是会过期的：拿不到就 resolveRoute → null → upgrade 直接
   *   `rejectUpgrade(socket, 404)`（:1294），nginx 侧只看到 `009`/`404 9` 这种截断响应。
   *   而设备作用域形态 `/remote/<deviceId>/api/remote.mux` 由**路径本身**携带设备身份，
   *   不依赖任何 cookie（同 rc 的测试就是这么连的：relay-router/test/router-e2e.test.mjs:267）。
   *
   * 安全性：中继对两种形态会归一到**同一个上游路径**（resolveRoute 的 device 分支取 m[2]），
   *   bridge/宿主看到的 path/label 与改写前逐字节一致 —— 只是"设备凭据从 cookie 挪到了 URL"。
   * 保守性：只有在**页面路径里能读到 deviceId**（`/remote/<id>/…`，也就是 2026-09-19 起的标准入口）
   *   且该路径确实是根形态的受保护前缀时才改写；读不到（老入口/根路径打开）就原样不动，
   *   行为与今天完全一致 —— 宁可退化，也绝不猜设备。
   */
  function seScopeToDevice(fullPath, deviceId) {
    if (!deviceId) return String(fullPath || "");
    var p = String(fullPath || "");
    if (p.indexOf("/remote/") === 0) return p;               // 已经是设备/通道形态 → 不动
    var qIdx = p.indexOf("?");
    var path = qIdx === -1 ? p : p.slice(0, qIdx);
    var qs = qIdx === -1 ? "" : p.slice(qIdx);
    if (!seIsProtectedPath(path)) return p;                  // 只改写受保护前缀(与加密策略同源)
    return "/remote/" + encodeURIComponent(deviceId) + path + qs;
  }
  function seUpstreamPathOf(fullPath) {
    var p = String(fullPath || "");
    var query = "";
    var qIdx = p.indexOf("?");
    if (qIdx !== -1) { query = p.slice(qIdx + 1); p = p.slice(0, qIdx); }
    var params = new URLSearchParams(query);
    params.delete("device"); // router 对 channel 形态剥 device 参数
    var path = p;
    if (p.indexOf("/remote/") === 0) {
      var rest = p.slice("/remote/".length);
      var slash = rest.indexOf("/");
      var head = slash === -1 ? rest : rest.slice(0, slash);
      var tail = slash === -1 ? "" : rest.slice(slash);
      var marker = head === "api" || head === "sidebar" || head === "git" || head === "pet" || head === "_e2ee";
      path = marker ? "/" + head + tail : (tail || "/");
    }
    var qs = params.size ? "?" + params.toString() : "";
    return path + qs;
  }
  function seIsProtectedPath(path) {
    for (var i = 0; i < SE_PROTECTED_PREFIXES.length; i++) {
      var pre = SE_PROTECTED_PREFIXES[i];
      if (path === pre || path.indexOf(pre + "/") === 0) return true;
    }
    return false;
  }
  /** HTTP fetch 是否应加密(§4.5:命中前缀;SSE /api/…/events* 与 event-stream 目标排除)。 */
  function seShouldEncryptHttp(fullPath, headers) {
    var up = seUpstreamPathOf(fullPath);
    var qIdx = up.indexOf("?");
    var path = qIdx === -1 ? up : up.slice(0, qIdx);
    if (!seIsProtectedPath(path)) return false;
    if (/(^|\/)events([/.]|$)/i.test(path)) return false; // SSE 端点保持明文(§4.5)
    var accept = seHeaderValueOf(headers, "accept").toLowerCase();
    if (accept.indexOf("text/event-stream") !== -1) return false;
    return true;
  }
  /** 数据 WS 是否应加密(§4.6:命中前缀即加密,SSE 例外只作用于 HTTP)。 */
  function seShouldEncryptWs(fullPath) {
    var up = seUpstreamPathOf(fullPath);
    var qIdx = up.indexOf("?");
    var path = qIdx === -1 ? up : up.slice(0, qIdx);
    if (path.indexOf("/_e2ee/") === 0) return false;
    return seIsProtectedPath(path);
  }
  /** 解析含 e2ee/w 标记的上游路径 → {sessId,w,wsLabel,upstreamPath}(与 bridge parseWsE2eeParams 同构)。 */
  function seWsLabelParts(fullSentPath) {
    var up = seUpstreamPathOf(fullSentPath);
    var qIdx = up.indexOf("?");
    var path = qIdx === -1 ? up : up.slice(0, qIdx);
    if (qIdx === -1) return null;
    var params = new URLSearchParams(up.slice(qIdx + 1));
    var sessId = params.get("e2ee") || "";
    var w = params.get("w") || "";
    if (!sessId || !w || !SE_SESS_RE.test(sessId)) return null;
    params.delete("e2ee");
    var qsLabel = params.size ? "?" + params.toString() : "";
    var labelWithW = path + qsLabel; // w 保留其中
    params.delete("w");
    var qsUp = params.size ? "?" + params.toString() : "";
    return { sessId: sessId, w: w, wsLabel: labelWithW, upstreamPath: path + qsUp };
  }
  /** 构造数据 WS 目标 URL:追加 &w=<8B hex>&e2ee=<sessId>(参数顺序与 native e2eeOpenDataWs 一致)。
   *  幂等:URL 已带同 sessId 的 e2ee(如从 ws.url 重开)→ 保留 w/补 w,不再二次加参;
   *  若带的是其它会话 e2ee → null(不接管,原样放行)。 */
  function seBuildWsTarget(urlStr, sessId, wHex, baseUrl) {
    var u = new URL(urlStr, baseUrl || undefined);
    if (u.protocol === "https:") u.protocol = "wss:";
    else if (u.protocol !== "wss:" && u.protocol !== "ws:") u.protocol = "ws:";
    var params = new URLSearchParams(u.search);
    var existing = params.get("e2ee");
    if (existing && existing !== sessId) return null;
    if (!existing) params.set("e2ee", sessId);
    if (!params.get("w")) params.set("w", wHex);
    u.search = params.toString();
    var fullSent = u.pathname + (params.size ? "?" + params.toString() : "");
    var parts = seWsLabelParts(fullSent);
    if (!parts) return null;
    return { href: u.href, fullSentPath: fullSent, sessId: parts.sessId, w: parts.w, wsLabel: parts.wsLabel, upstreamPath: parts.upstreamPath };
  }

  /* ---- 一次性交接单(与 native.html DSH-E2EE-HANDOVER-CORE 同格式) ---- */
  function seHandoverDecode(raw) {
    var obj = null;
    try { obj = JSON.parse(String(raw || "")); } catch (e) { return null; }
    if (!obj || obj.v !== SE_VERSION) return null;
    if (typeof obj.s !== "string" || !SE_SESS_RE.test(obj.s)) return null;
    var shk = null, saltH = null;
    try { shk = seB64ToBytes(obj.shk); saltH = seB64ToBytes(obj.salt); } catch (e) { return null; }
    if (!shk || shk.length !== SE_KEY_BYTES || !saltH || saltH.length !== SE_KEY_BYTES) return null;
    return { v: 2, s: obj.s, shk: shk, saltH: saltH, profile: typeof obj.profile === "string" ? obj.profile : "", epoch: Number(obj.epoch) || 0 };
  }
  function seSessionOfHandover(raw) {
    var h = seHandoverDecode(raw);
    if (!h) return null;
    try {
      return new SeSession({ sessId: h.s, shk: h.shk, saltH: h.saltH, profile: h.profile, epoch: h.epoch });
    } catch (e) { return null; }
  }

  /* ---- 失败上报钩子(DOM 徽标接线注入;node 测试可替换为收集器) ---- */
  var seFailureHook = null;
  function seNotifyFail(message) {
    try { if (typeof seFailureHook === "function") seFailureHook(String(message || "")); } catch (e) { /* ignore */ }
    if (typeof console !== "undefined" && console.warn) console.warn("[dsh-e2ee-shim]", message);
  }

  /* ---- 会话失效自愈(2026-09-26 线上事故:unknown_session 502 + 刷新也好不了) -------------
     链路:手机镜像页 → 加密信封 → 中继透明转发 → 桥端 e2ee-client 查会话表 → 查不到就回
     **明文** 502 + `x-dsh-e2ee-error: unknown_session`(桥端会话表是进程内存 + 24h TTL + CAP=32 LRU,
     桥重启/被挤掉之后就没了)。而手机侧靠 **localStorage 持久交接单**长期复用同一个 sessId
     (见 _boot 的"记住本机"分支)→ 每个受保护路径全 502,且**刷新只会把同一张失效交接单再装回去**。
     修法(只做两件事,绝不静默降级):
       ① 收到该头 → 立刻清掉 sessionStorage/localStorage 的交接单 → 下一次进入镜像页时
          "没有交接单"→ 走正常流程回设备列表重新解锁;
       ② 通过 seStaleSessionHook 把**明确原因**交给 DOM 层写进徽标(需要重新解锁),
          不再让用户看到"加密好好的,但什么都点不动"。
     ⚠️ 不改 SE_PROTECTED_PREFIXES:把 /sidebar 移出白名单会让 fs.read/write、pty.*、git.commit
        明文过境(见 :39 的策略表),那是安全红线。 */
  var seStaleSessionHook = null;
  var seLastStaleCode = "";
  /** 清掉本机保存的 E2EE 交接单(sessionStorage 一次性 + localStorage 持久)。node 测试无 storage → 静默跳过。 */
  function seForgetHandoverStores() {
    try { if (typeof sessionStorage !== "undefined" && sessionStorage && sessionStorage.removeItem) sessionStorage.removeItem(DSH_E2EE_HANDOVER_KEY); } catch (e) { /* ignore */ }
    try { if (typeof localStorage !== "undefined" && localStorage && localStorage.removeItem) localStorage.removeItem(DSH_E2EE_HANDOVER_KEY); } catch (e) { /* ignore */ }
  }
  /** 读响应头里的桥端 E2EE 错误码(非信封响应才有;取不到返回 "")。 */
  function seE2eeErrorOf(res) {
    try { return String((res && res.headers && res.headers.get && res.headers.get("x-dsh-e2ee-error")) || ""); } catch (e) { return ""; }
  }
  /** 收到带 x-dsh-e2ee-error 的响应 → 清失效会话 + 上报(同一个码只报一次,避免刷屏)。 */
  function seNoteE2eeError(res) {
    var code = seE2eeErrorOf(res);
    if (!code) return "";
    seForgetHandoverStores();
    if (code !== seLastStaleCode) {
      seLastStaleCode = code;
      try { if (typeof seStaleSessionHook === "function") seStaleSessionHook(code); } catch (e) { /* ignore */ }
      seNotifyFail("加密会话已失效(" + code + "):本机保存的会话已不可用,需要重新解锁。");
    }
    return code;
  }

  /* ---- 数据 WS 握手失败上报(2026-09-26:线上 mux 握手 404/009 → 用户只看到"什么都没发生") ----
     mux WS 是镜像页与电脑端之间**唯一**的实时数据通道;它连不上时页面不报错,只是所有数据都停住。
     这里只做**可观测**:把"没连上"作为明确原因交给徽标(区分"会话未建立/设备离线/网络中断"),
     绝不在这里做重连 —— 官方客户端自己会重连,我们再加一层只会变成"静默无限重连"。 */
  var seWsFailHook = null;
  var seWsFailCount = 0;
  var seWsFailReported = false;
  function seNoteWsHandshakeFail(label, detail) {
    seWsFailCount++;
    if (seWsFailReported) return;
    seWsFailReported = true;
    try { if (typeof seWsFailHook === "function") seWsFailHook(String(label || ""), String(detail || ""), seWsFailCount); } catch (e) { /* ignore */ }
  }
  /** 握手成功后复位(下一次再断时还能再报一次;不清 count,用于展示"重试了几次")。 */
  function seNoteWsOpened() { seWsFailReported = false; }

  /* ---- HTTP 信封传输包装(与 native e2eeFetchEnveloped 同构;输入/输出为 fetch 语义) ---- */
  var SE_OUTER_STRIP = {
    "host": 1, "origin": 1, "referer": 1, "cookie": 1, "connection": 1, "upgrade": 1,
    "keep-alive": 1, "transfer-encoding": 1, "content-length": 1, "accept-encoding": 1,
    "sec-fetch-site": 1, "sec-fetch-mode": 1, "sec-fetch-dest": 1, "sec-fetch-user": 1,
    "te": 1, "trailer": 1, "proxy-connection": 1, "x-forwarded-for": 1, "x-forwarded-proto": 1, "x-forwarded-host": 1
  };
  function seHeadersForEnvelope(headers) {
    var h = {};
    var entries = seEntriesOf(headers);
    for (var i = 0; i < entries.length; i++) {
      var k = entries[i][0], v = entries[i][1];
      var lk = String(k).toLowerCase();
      if (SE_OUTER_STRIP[lk]) continue;
      if (v === undefined || v === null || v === "") continue;
      h[k] = Array.isArray(v) ? v.join(", ") : String(v);
    }
    return h;
  }
  function seErrorResponse(code, message) {
    var hdrs = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-dsh-e2ee-error": String(code || "e2ee_failed") };
    return new Response(JSON.stringify({ error: { code: String(code || "e2ee_failed"), message: message } }), { status: 502, headers: hdrs });
  }
  function seBuildResponse(status, headers, bodyU8) {
    var hdrs = new Headers();
    var entries = seEntriesOf(headers);
    for (var i = 0; i < entries.length; i++) {
      var k = entries[i][0], v = entries[i][1];
      var lk = String(k).toLowerCase();
      if (lk === "content-length" || lk === "content-encoding" || lk === "transfer-encoding") continue;
      try { hdrs.append(k, v); } catch (e) { /* ignore */ }
    }
    try { hdrs.set("content-length", String(bodyU8.length)); } catch (e) { /* ignore */ }
    var noBody = status === 204 || status === 205 || status === 304 || bodyU8.length === 0;
    return new Response(noBody ? null : bodyU8, { status: status, headers: hdrs });
  }
  /**
   * fetch 包装核心:命中策略 → 密封→发→响应信封解密→重建 Response;
   * 未命中/跨源/无法读取 body/明文响应 → 原样透传(零行为)。
   * @param {function} origFetch
   * @param {{sess: SeSession, origin: string}} ctx
   */
  async function seFetchWrapper(origFetch, ctx, input, init) {
    if (!ctx || !ctx.sess) return origFetch(input, init);
    var inputReq = input instanceof Request;
    var req = inputReq ? input : new Request(input, init);
    var urlObj = null;
    try { urlObj = new URL(req.url, ctx.origin); } catch (e) { return origFetch(input, init); }
    if (!seSameWebContext(urlObj, ctx.origin)) return origFetch(input, init); // 仅同隧道源
    var fullPath = urlObj.pathname + urlObj.search;
    if (!seShouldEncryptHttp(fullPath, req.headers)) return origFetch(input, init);
    // body 需可安全读取:已消费/流式 → 明文回退(不打断调用方)
    var bodyBytes = null;
    if (req.body != null) {
      var readTarget = req;
      if (inputReq) {
        if (req.bodyUsed) return origFetch(input, init);
        if (req.body && typeof req.body.getReader === "function") return origFetch(input, init);
        try { readTarget = req.clone(); } catch (e) { return origFetch(input, init); }
      }
      try { bodyBytes = new Uint8Array(await readTarget.arrayBuffer()); } catch (e) { return origFetch(input, init); }
    }
    var upstream = seUpstreamPathOf(fullPath);
    var plain = seEncodeHttpReqPlain({ method: req.method, path: upstream, headers: seHeadersForEnvelope(req.headers), bodyBytes: bodyBytes });
    var n = seRandomBytes(SE_NONCE_BYTES);
    var nonceB64 = seBytesToB64(n);
    var env = await ctx.sess.seal({ kind: "http", dir: SE_DIR_P2B, counter: 0, data: plain, nonceBytes: n });
    var outerHeaders = seEnvelopeHeaders(ctx.sess.sessId);
    var cookieH = seHeaderValueOf(req.headers, "cookie");
    if (cookieH && req.credentials !== "omit") outerHeaders.cookie = cookieH; // node 测试显式 cookie;浏览器同源自动带
    var res;
    try {
      res = await origFetch(urlObj.href, {
        method: "POST",
        headers: outerHeaders,
        body: JSON.stringify(env),
        credentials: req.credentials,
        signal: req.signal
      });
    } catch (e) { throw e; }
    /* router/桥端明文错误页 → 原样透传(零行为)，但**先看一眼**是不是桥端在说"会话我不认识"
       (x-dsh-e2ee-error)——是的话清掉本机失效交接单并给出明确原因(见 seNoteE2eeError)。 */
    if (!seIsEnvelopeResponse(res)) { seNoteE2eeError(res); return res; }
    var envResp = null;
    try { envResp = await res.json(); } catch (e) {
      seNotifyFail("响应信封非法");
      return seErrorResponse("bad_envelope", "⚠ 无法解密:响应信封非法");
    }
    var opened = null;
    try {
      opened = await ctx.sess.open({ kind: "http-resp", dir: SE_DIR_B2P, env: envResp, counter: envResp.c == null ? 0 : envResp.c, reqNonceB64: nonceB64 });
    } catch (e) {
      var code = e && e.code ? e.code : "auth_failed";
      seNotifyFail("响应解封失败: " + (e && e.message || code));
      return seErrorResponse(code, "⚠ 无法解密(" + code + "):密钥不一致、传输被篡改或会话已过期。请返回设备列表重新解锁。");
    }
    var rp = null;
    try { rp = seDecodeHttpRespPlain(opened.data); } catch (e) {
      seNotifyFail("响应明文非法");
      return seErrorResponse("bad_plain", "⚠ 无法解密:响应明文非法");
    }
    var bodyU8 = rp.bodyBytes instanceof Uint8Array ? rp.bodyBytes : (rp.bodyB64 ? seB64ToBytes(rp.bodyB64) : new Uint8Array(0));
    if (rp.enc === "gzip" && bodyU8.length) {
      var un = await seGunzip(bodyU8);
      if (!un) return seErrorResponse("gunzip", "⚠ 无法解压:响应 gzip 解压失败");
      bodyU8 = un;
    }
    return seBuildResponse(rp.status, rp.headers, bodyU8);
  }

  /* ---- 数据 WS 代理(逐消息信封;上层看到的是解密后的原文) ---- */
  function SeE2eeWs(NativeWS, url, protocols, meta) {
    var self = this;
    this.url = url;
    this._meta = meta;
    this._inner = new NativeWS(url, protocols);
    this._state = 0; // CONNECTING
    this._p2b = 0;
    this._b2pLast = -1;
    this._msgHandlers = [];
    this._sendQ = Promise.resolve();
    this._recvQ = Promise.resolve();
    this.binaryType = "blob";
    var inner = this._inner;
    this._opened = false;   // 是否**曾经**握手成功(区分"没连上"与"连上后断开")
    inner.onopen = function (ev) { self._state = 1; self._opened = true; seNoteWsOpened(); if (typeof self._onopen === "function") self._onopen(ev || { type: "open", target: self }); };
    inner.onerror = function (ev) {
      /* 握手上就失败(error 早于任何 open)→ 让用户知道"加密数据通道没建立"。
         这是 2026-09-26 事故里最缺的一条信号:mux 被 404 掐掉时页面**一声不响**,
         用户只看到所有数据都停住。 */
      if (!self._opened) seNoteWsHandshakeFail(self._meta && self._meta.wsLabel, "error");
      if (typeof self._onerror === "function") self._onerror(ev || { type: "error", target: self });
    };
    inner.onclose = function (ev) {
      self._state = 3;
      if (!self._opened) seNoteWsHandshakeFail(self._meta && self._meta.wsLabel, (ev && (ev.code || ev.reason)) || "close");
      if (typeof self._onclose === "function") self._onclose(ev || { type: "close", target: self });
    };
    inner.onmessage = function (ev) { self._enqueueInbound(ev); };
  }
  SeE2eeWs.prototype._enqueueInbound = function (ev) {
    var self = this;
    this._recvQ = this._recvQ.then(function () { return self._processInbound(ev); })
      .catch(function (e) {
        var msg = "⚠ 无法解密 WS 消息" + (e && e.message ? ": " + e.message : "");
        seNotifyFail(msg);
        try { self.close(1008, msg); } catch (err) { /* ignore */ }
      });
  };
  SeE2eeWs.prototype._processInbound = async function (ev) {
    var raw = typeof ev.data === "string" ? ev.data : String(ev.data || "");
    var env = null;
    try { env = JSON.parse(raw); } catch (e) { env = null; }
    if (!env || typeof env !== "object" || env.k !== "w") { this._deliver(raw, false); return; } // 明文帧透传(不应出现)
    if (!Number.isInteger(env.c) || env.c <= this._b2pLast) throw seErr("replay", "b2p 计数重放/乱序 " + env.c);
    var opened = await this._meta.sess.open({ kind: "w", dir: SE_DIR_B2P, env: env, counter: env.c, wsLabel: this._meta.wsLabel });
    this._b2pLast = env.c;
    this._deliver(opened.data, opened.t === 1);
  };
  SeE2eeWs.prototype._deliver = function (data, isBinary) {
    var payload;
    if (!isBinary) payload = typeof data === "string" ? data : seUtf8Decode(data);
    else if (this.binaryType === "arraybuffer") payload = data.slice().buffer;
    else if (typeof Blob !== "undefined") payload = new Blob([data]);
    else payload = data;
    var ev = { type: "message", data: payload, target: this, currentTarget: this, origin: "", timeStamp: Date.now() };
    var handlers = this._msgHandlers.slice();
    for (var i = 0; i < handlers.length; i++) {
      var h = handlers[i];
      if (h.once) this._removeMsgHandler(h.fn);
      try { h.fn.call(this, ev); } catch (e) { /* 上层处理错误不阻断 */ }
    }
    if (typeof this._onmessage === "function") {
      try { this._onmessage.call(this, ev); } catch (e) { /* ignore */ }
    }
  };
  SeE2eeWs.prototype._removeMsgHandler = function (fn) {
    for (var i = 0; i < this._msgHandlers.length; i++) {
      if (this._msgHandlers[i].fn === fn) { this._msgHandlers.splice(i, 1); return; }
    }
  };
  SeE2eeWs.prototype.send = function (data) {
    var self = this;
    /* ⚠️ 消息体在**调用时刻**归一化（同步完成，保持调用者看到的语义），
       但**加密与发送必须排进 `_sendQ` 队列里做**。
       2026-09-19 修：原先写成
           if (typeof data === "string") p = this._sealSend(data, 0);
           this._sendQ = this._sendQ.then(function () { return p; });
       队列只串了 **promise**，没有串住"开始加密"这个动作 —— 两次背靠背的 `send()`
       会**各自立刻**发起一次 seal（WebCrypto 走线程池，完成顺序无保证），而
       `counter: this._p2b++` 是在 seal **之前**求值的，于是**计数 1 的信封可能先于
       计数 0 发出**。WebSocket 本该保证消息有序，这条路被破坏了。
       （它是间歇性的：端到端用例 `e2ee-shim.test.mjs` 的 WS 顺序断言约 1/5 概率变红，
       一直被当成"flaky 测试"，其实是它抓到了真竞态。）
       现在把 `_sealSend` 整体推迟到队列里执行，计数器与发送顺序严格一致。 */
    var norm;
    if (typeof data === "string") norm = Promise.resolve({ payload: data, t: 0 });
    else if (typeof Blob !== "undefined" && data instanceof Blob) norm = data.arrayBuffer().then(function (ab) { return { payload: new Uint8Array(ab), t: 1 }; });
    else if (data instanceof ArrayBuffer) norm = Promise.resolve({ payload: new Uint8Array(data), t: 1 });
    else if (ArrayBuffer.isView(data)) norm = Promise.resolve({ payload: new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength || data.length), t: 1 });
    else norm = Promise.reject(seErr("bad_ws_data", "e2ee: 不支持的 WS 消息类型"));
    this._sendQ = this._sendQ.then(function () {
      return norm.then(function (m) { return self._sealSend(m.payload, m.t); });
    }).catch(function (e) { seNotifyFail("⚠ 无法加密 WS 消息: " + (e && e.message || e)); });
  };
  SeE2eeWs.prototype._sealSend = async function (payload, t) {
    var env = await this._meta.sess.seal({ kind: "w", dir: SE_DIR_P2B, counter: this._p2b++, data: payload, t: t, wsLabel: this._meta.wsLabel });
    this._inner.send(JSON.stringify(env));
  };
  SeE2eeWs.prototype.close = function (code, reason) { try { this._inner.close(code, reason); } catch (e) { /* ignore */ } };
  SeE2eeWs.prototype.addEventListener = function (type, fn, opts) {
    if (type === "message") { if (typeof fn === "function") this._msgHandlers.push({ fn: fn, once: !!(opts && opts.once) }); return; }
    try { this._inner.addEventListener(type, fn, opts); } catch (e) { /* ignore */ }
  };
  SeE2eeWs.prototype.removeEventListener = function (type, fn) {
    if (type === "message") { this._removeMsgHandler(fn); return; }
    try { this._inner.removeEventListener(type, fn); } catch (e) { /* ignore */ }
  };
  function seWsEventProp(name) {
    Object.defineProperty(SeE2eeWs.prototype, name, {
      configurable: true,
      get: function () { return this["_" + name] || null; },
      set: function (fn) { this["_" + name] = typeof fn === "function" ? fn : null; }
    });
  }
  seWsEventProp("onopen"); seWsEventProp("onerror"); seWsEventProp("onclose"); seWsEventProp("onmessage");
  Object.defineProperty(SeE2eeWs.prototype, "readyState", { configurable: true, get: function () { return this._state; } });
  Object.defineProperty(SeE2eeWs.prototype, "bufferedAmount", { configurable: true, get: function () { try { return this._inner.bufferedAmount || 0; } catch (e) { return 0; } } });
  Object.defineProperty(SeE2eeWs.prototype, "protocol", { configurable: true, get: function () { try { return this._inner.protocol || ""; } catch (e) { return ""; } } });
  Object.defineProperty(SeE2eeWs.prototype, "extensions", { configurable: true, get: function () { try { return this._inner.extensions || ""; } catch (e) { return ""; } } });

  /** 生成 window.WebSocket 的替换构造函数:命中策略才套 SeE2eeWs,否则原样放行。 */
  function seMakeWsCtor(NativeWS, ctx) {
    function SeWs(url, protocols) {
      var full = "", should = false, scoped = String(url);
      try {
        var base = ctx.origin || (typeof window !== "undefined" ? window.location.href : undefined);
        var uo = new URL(url, base);
        if (seSameWebContext(uo, ctx.origin)) {
          /* ★ 设备作用域改写（2026-09-26 事故）：官方客户端把 mux WS 固定拼成**根路径**
             `/api/remote.mux`（dsh-api-gateway/lib/client.js:544 用 location.origin 拼），
             于是中继只能靠 `dsh_device` cookie 判设备；cookie 一过期/缺失就是 404（upgrade 被
             rejectUpgrade 掐掉，nginx 只看到 009）→ E2EE 会话永远建不起来 → 之后每个受保护请求
             全是 unknown_session 502。镜像页的标准入口是 `/remote/<deviceId>/`（2026-09-19 起），
             deviceId 就在地址里 —— 拿它把 WS 改写成 `/remote/<deviceId>/api/remote.mux`，
             设备身份由路径携带，不再依赖任何 cookie（中继会把两种形态归一到同一上游路径）。
             ⚠️ 只改 WS：HTTP 那条链路影响面大得多，且线上证据显示它当时是通的
                （502 是桥端回的**信封响应**，说明 HTTP 请求已经到达该设备）。 */
          scoped = seScopeToDevice(uo.pathname + uo.search, ctx.deviceId);
          var so = scoped === (uo.pathname + uo.search) ? uo : new URL(scoped, base);
          full = so.pathname + so.search;
          should = seShouldEncryptWs(full);
        }
      } catch (e) { should = false; }
      if (!should) return new NativeWS(url, protocols);
      var target = seBuildWsTarget(scoped, ctx.sess.sessId, seRandomHex(8), base);
      if (!target) return new NativeWS(url, protocols);
      return new SeE2eeWs(NativeWS, target.href, protocols, { sess: ctx.sess, wsLabel: target.wsLabel });
    }
    SeWs.OPEN = 1; SeWs.CONNECTING = 0; SeWs.CLOSING = 2; SeWs.CLOSED = 3;
    return SeWs;
  }
  /* ===DSH-E2EE-SHIM-CORE-END=== */

  /* =====================================================================
   * 以下为浏览器接线(不在 ==DSH-E2EE-SHIM-CORE== 抽取区间;node 测试不引用)
   * ===================================================================== */
  var _storage = null;
  try { _storage = window.sessionStorage; } catch (e) { _storage = null; }

  function _readHandover() {
    if (!_storage) return null;
    var raw = null;
    try { raw = _storage.getItem(DSH_E2EE_HANDOVER_KEY); } catch (e) { return null; }
    if (raw) { try { _storage.removeItem(DSH_E2EE_HANDOVER_KEY); } catch (e) { /* ignore */ } } // 读后即删(一次性)
    return raw || null;
  }

  /* ---- 状态徽标 ---- */
  var _badgeCollapseTimer = null; // 自动收缩(仅 ok 态):展示几秒后缩成仅 🔒,不挡界面
  var _badgeState = null;         // 最近一次状态 {mode,text,note} —— 供合并后的悬浮菜单读取
  /** 对外只读接口:让统一的「远程控制」悬浮按钮显示加密状态（不暴露任何密钥/会话材料）。 */
  try {
    window.__dshE2eeBadge = {
      state: function () { return _badgeState; },
      open: function () { var el = document.getElementById("dsh-e2ee-badge"); if (el && el.click) el.click(); return !!el; }
    };
  } catch (e) { /* ignore */ }
  function _badgeClearCollapse() {
    try { if (_badgeCollapseTimer) { clearTimeout(_badgeCollapseTimer); _badgeCollapseTimer = null; } } catch (e) {}
  }
  function _badgeArmCollapse(el) {
    _badgeClearCollapse();
    _badgeCollapseTimer = setTimeout(function () {
      try {
        if (!el.classList.contains("expanded") && el.classList.contains("ok")) el.classList.add("collapsed");
      } catch (e) {}
      _badgeCollapseTimer = null;
    }, 5000);
  }
  function _badgeEl() {
    var el = document.getElementById("dsh-e2ee-badge");
    if (el) return el;
    var host = document.body || document.documentElement;
    if (!host) return null;
    el = document.createElement("div");
    el.id = "dsh-e2ee-badge";
    el.setAttribute("role", "status");
    var ico = document.createElement("span");
    ico.className = "dsh-e2ee-badge-ico";
    var txt = document.createElement("span");
    txt.className = "dsh-e2ee-badge-txt";
    var note = document.createElement("div");
    note.className = "dsh-e2ee-badge-note";
    el.appendChild(ico); el.appendChild(txt); el.appendChild(note);
    el.addEventListener("click", function () {
      if (el.classList.contains("collapsed")) {
        // 从仅🔒芯片展开:展示完整文案(文本),不再自动收缩
        el.classList.remove("collapsed");
        el.classList.add("expanded");
        _badgeClearCollapse();
      } else {
        el.classList.toggle("expanded");
        _badgeClearCollapse();
      }
    });
    el.addEventListener("pointerenter", function () { _badgeClearCollapse(); el.classList.remove("collapsed"); });
    host.appendChild(el);
    return el;
  }
  function _badge(mode, text, note) {
    try {
      // 合并给「远程控制悬浮菜单」(2026-09-19):状态挂到 window.__dshE2eeBadge 并广播事件,
      // 让 mobile-adapter 的统一悬浮按钮显示加密状态、并把独立药丸收起来（只读、不碰加解密逻辑）。
      _badgeState = { mode: String(mode), text: String(text == null ? "" : text), note: String(note == null ? "" : note) };
      try {
        var ev = new CustomEvent("dsh-e2ee-badge", { detail: _badgeState });
        document.dispatchEvent(ev);
        if (window !== document) window.dispatchEvent(ev);
      } catch (e0) { /* 老浏览器:忽略 */ }
      // 桌面宽屏(>820)明文/告警态不加**独立**徽标 —— 与 mobile-adapter 的“桌面零打扰”契约一致;
      // 加密态(ok)或窄屏始终给出明确状态(协议 §2.4“不静默”)。
      // 状态本身照常发布，合并后的悬浮菜单无论宽窄都能看到它。
      if (mode !== "ok" && window.innerWidth > 820) return;
      var el = _badgeEl();
      if (!el) return;
      el.className = mode; // ok | warn | err(重置 expanded/collapsed 由下方状态机管理)
      el.querySelector(".dsh-e2ee-badge-ico").textContent = mode === "ok" ? "🔒" : "⚠";
      el.querySelector(".dsh-e2ee-badge-txt").textContent = text;
      var noteEl = el.querySelector(".dsh-e2ee-badge-note");
      noteEl.textContent = "";
      if (note) {
        noteEl.appendChild(document.createTextNode(note));
        if (mode !== "ok") {
          var link = document.createElement("a");
          link.href = _appUrl();
          link.textContent = " 返回设备列表重新解锁 →";
          noteEl.appendChild(link);
        }
      }
      el.title = text;
      // 自动收缩:仅加密态(ok)几秒后缩成纯 🔒 芯片(warn/err 属安全提示保持文本,不静默)
      if (mode === "ok") _badgeArmCollapse(el);
    } catch (e) { /* 徽标失败不阻断页面 */ }
  }
  function _appUrl() {
    try { return new URL("/app/", window.location.href).href; } catch (e) { return "/app/"; }
  }
  function _reportFail(message) {
    _badge("err", "无法解密", String(message || "会话异常"));
  }
  /* 桥端回了 x-dsh-e2ee-error（unknown_session / not_verified / auth_failed …）：
     会话已经**不可恢复**，本机交接单已由 seNoteE2eeError 清掉 —— 这里只负责把"为什么"
     说清楚（用户看到的必须是"需要重新解锁"，而不是一个说不清的 502 或一句"已失效"）。 */
  var _STALE_HINT = {
    unknown_session: "电脑端已不认识这个加密会话(通常是电脑端重启过，或会话太多被挤掉)。",
    not_verified: "这个加密会话还没完成校验。",
    auth_failed: "解密校验失败:密码与电脑端不一致，或传输被篡改。",
    replay: "检测到重放。",
    bad_envelope: "响应信封非法。",
    bad_plain: "响应明文非法。"
  };
  function _reportStaleSession(code) {
    var hint = _STALE_HINT[String(code || "")] || ("电脑端返回:" + String(code || "") + "。");
    _badge("warn", "加密会话已失效，需要重新解锁", hint + " 已清除本机保存的会话；返回设备列表重新点选设备解锁即可恢复加密。");
  }
  /* 加密数据 WS（mux）**握手就没成功**：官方客户端只会安静地重连，页面不报错、数据全停。
     这里把原因分档说清楚（会话/设备/网络），但**不做任何重连**（重连是官方的事，
     我们再叠一层就变成"静默无限重连"——正是这次要修掉的形态）。 */
  function _reportWsFail(label, detail, count) {
    var n = Number(count) || 1;
    var why = String(detail || "") === "error"
      ? "电脑端可能未连接(设备离线)、网络中断，或加密会话已失效。"
      : ("连接被关闭(" + String(detail || "close") + ")，多半是握手被拒或被中继/代理掐断。");
    _badge("warn", "加密数据通道未建立(第 " + n + " 次)",
      "与电脑端的加密 WebSocket 没连上:" + why + " 弱网时官方客户端会自动重连，稍等即可；"
      + "一直这样请返回设备列表重新解锁（会自动重建加密通道）。");
  }

  /* ---- 安装 fetch/WS 加密补丁(有会话才安装) ---- */
  var _installed = false;
  function _install(sess) {
    if (_installed) return;
    _installed = true;
    seFailureHook = _reportFail;
    seStaleSessionHook = _reportStaleSession;
    seWsFailHook = _reportWsFail;
    /* deviceId 取自**页面路径**（`/remote/<deviceId>/…`，2026-09-19 起的标准入口）：
       WS 侧用它把根路径的 mux 改写成设备作用域形态，从而不再依赖会过期的 dsh_device cookie
       （见 seScopeToDevice 的长注释与 2026-09-26 的 nginx 日志证据）。读不到就留空 = 不改写。 */
    var ctx = { sess: sess, origin: window.location.origin, deviceId: seDeviceIdOfPath(window.location.pathname) };
    try {
      if (window.fetch) {
        var origFetch = window.fetch.bind(window);
        window.fetch = function (input, init) { return seFetchWrapper(origFetch, ctx, input, init); };
      }
    } catch (e) { /* ignore */ }
    try {
      if (window.WebSocket) {
        var NativeWS = window.WebSocket;
        window.WebSocket = seMakeWsCtor(NativeWS, ctx);
      }
    } catch (e) { /* ignore */ }
  }

  /* (刷新恢复见 _boot:优先 localStorage 持久交接单,2026-09) */
  /* ---- 启动 ---- */
  function _boot() {
    try {
      if (!(window.crypto && window.crypto.subtle && window.crypto.getRandomValues)) {
        _badge("warn", "未加密:环境不支持", "当前浏览器环境不支持 WebCrypto(需 HTTPS 安全上下文),镜像页数据流保持明文。");
        return;
      }
      var raw = _readHandover();
      if (!raw) {
        // 刷新/重开:sessionStorage 一次性交接单已被读走 → 尝试 localStorage「记住本机」持久交接单
        // (2026-09 用户决策;同一解锁会话的 SHK,刷新镜像页后仍能恢复加密)。
        var lsRaw = null;
        try { lsRaw = localStorage.getItem(DSH_E2EE_HANDOVER_KEY); } catch (e) { lsRaw = null; }
        if (lsRaw) {
          var lsSess = null;
          try { lsSess = seSessionOfHandover(lsRaw); } catch (e) { lsSess = null; }
          if (lsSess) {
            _install(lsSess);
            /* ⚠️ 0.6.18 起这句文案不再无条件说"加密好好的"（2026-09-26 事故的教训）：
               从 localStorage 恢复的会话**没法在本机验证**桥端是否还认它（桥端会话表是进程内存 +
               24h TTL + CAP=32 LRU，桥重启/被挤掉之后这张交接单就是死票）。真实校验只能等
               第一个受保护请求 —— 那一步由 seNoteE2eeError 兜底：一旦桥端回 unknown_session，
               会话被清掉、徽标转 warn 并明说"需要重新解锁"。
               这里**刻意仍用 ok 态**（而不是一刷新就报 ⚠）：99% 的刷新会话是有效的，
               照 R2 的建议无条件降级会让每次刷新都出现一个假告警 —— 本仓库一贯的取向是
               "宁可漏报，也不要误报吓人"（见 mobile-adapter 的 load-warn 看门狗注释）。
               折中做法：文案如实说明"恢复但未验证"，并把出口写清楚。 */
            _badge("ok", "端到端加密已开启(本机记忆恢复)",
              "刷新后已自动恢复端到端加密(记住本机)，密钥仅存内存。"
              + "注意:这次恢复的会话要到第一个数据请求才能确认电脑端仍认可它 —— "
              + "若稍后提示「加密会话已失效」，说明电脑端已重启或会话被挤掉，请返回设备列表重新解锁。");
            return;
          }
        }
        _badge("warn", "未加密:未解锁(明文)", "本次为明文连接。密钥只存内存;请返回设备列表重新点选设备解锁后,镜像页的数据请求与 WebSocket 将自动加密。");
        return;
      }
      var sess = null;
      try { sess = seSessionOfHandover(raw); } catch (e) { sess = null; }
      if (!sess) {
        _badge("warn", "未加密:交接单无效", "一次性交接单无法解析(可能已损坏或过期)。请返回设备列表重新解锁。");
        return;
      }
      _install(sess);
      _badge("ok", "端到端加密已开启", "本镜像页的 /api、/sidebar、/git、/pet 数据请求与数据 WebSocket 已加密(密钥仅存内存)。");
    } catch (e) {
      try { if (window.console) console.warn("[dsh-e2ee-shim]", e && e.message); } catch (err) { /* ignore */ }
    }
  }
  _boot();
})();
