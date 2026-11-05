/**
 * PermissionBridge —— 把 Claude Code 的 `PermissionRequest` 钩子接成"本机 HTTP 服务"。
 *
 * ## 它到底做什么
 *
 *   Claude Code ──POST JSON──▶ 127.0.0.1:<随机端口>/permission?t=<token>
 *                                    │
 *                                    ├─ 校验 token / 事件名 / 体积 / 并发
 *                                    ├─ 归一化成一条审批请求（toolName / kind / detail）
 *                                    ├─ 交给可注入的 decide()（M2 第 3 周会接手机端；现在默认 fail-closed）
 *                                    └─ 回写实测确认过的响应体（报告 §3.1）：
 *                                       {hookSpecificOutput:{hookEventName:"PermissionRequest",
 *                                        decision:{behavior:"allow"|"deny", message?}}}
 *
 * ## 三个"必须"来自实测，不是猜的
 *
 * ① **响应体形状必须完全正确**：第 1 周实测 8 种变体，只有 `hookSpecificOutput.hookEventName`
 *    + `decision.behavior` 这一种生效；缺字段/拼错/非 JSON/空 body/HTTP 500 **一律等于无决策 = 拒绝**。
 *    （所以本模块对"异常输入"是**不返回决策**，让上游按 fail-closed 处理，而不是自己编一个 allow。）
 * ② **超时 = 拒绝**：`timeout` 单位是秒且被上游遵守；我们自己的决策窗口默认 90s，
 *    到期主动回 deny，不做"没回复就放行"。
 * ③ **临时 settings 只写权限钩子**：不改用户配置；文件 0600（里面有 token）；`stop()` 必删。
 *
 * ## 隐私
 *
 * `decide()` 拿得到 `detail`（命令原文/文件路径——手机审批要看），但 **log 回调永远拿不到原文**：
 * 只记 `{requestId, toolName, kind, outcome, durationMs}`。命令原文也不落盘（临时 settings 里只有 URL）。
 */

import crypto from "node:crypto";
import fsSync from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/** 默认决策窗口（ms）。留出"手机解锁 + 用户拍板"的时间，又明显短于钩子默认 600s。 */
export const DEFAULT_DECISION_TTL_MS = 90_000;
/** 写进临时 settings 的 hook timeout（秒）。90s 窗口 + 30s 网络/重试余量。 */
export const DEFAULT_HOOK_TIMEOUT_SEC = 120;
/** 请求体上限：钩子 body 就是 tool_input，正常几 KB；超过它多半不是我们的钩子。 */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
/** 同时等待决策的请求上限（超了直接拒绝，不排队——排队会把内存和时延都拖长）。 */
export const DEFAULT_MAX_PENDING = 8;
/** 回给用户的默认拒绝文案（不含命令原文）。 */
export const DEFAULT_DENY_MESSAGE = "远程审批未完成，已按拒绝处理";

/** 工具名 → ACP 的 kind 词表（设计稿 §2.3 直接沿用）。 */
const TOOL_KIND = Object.freeze({
  Bash: "execute",
  BashOutput: "execute",
  KillShell: "execute",
  Read: "read",
  NotebookRead: "read",
  Write: "edit",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Glob: "search",
  Grep: "search",
  WebFetch: "fetch",
  WebSearch: "fetch",
  Task: "other",
  TodoWrite: "other",
  ExitPlanMode: "switch_mode"
});

/** 工具名 → 给人看的一句话（**不含**命令原文）。 */
const TOOL_TITLE = Object.freeze({
  Bash: "执行命令",
  Read: "读取文件",
  Write: "写入文件",
  Edit: "修改文件",
  MultiEdit: "修改文件",
  NotebookEdit: "修改笔记本",
  Glob: "查找文件",
  Grep: "搜索内容",
  WebFetch: "访问网络",
  WebSearch: "联网搜索",
  Task: "派发子任务"
});

/** 映射工具类别；未知工具按 `other`（不猜）。 */
export function toolKindOf(toolName) {
  return TOOL_KIND[toolName] || "other";
}

/** 固定的两个审批选项（实测没有 permission_suggestions，不能依赖上游给）。 */
export function permissionOptions() {
  return [
    { optionId: "allow-once", kind: "allow_once", name: "允许一次" },
    { optionId: "reject-once", kind: "reject_once", name: "拒绝" }
  ];
}

/**
 * 生成实测确认过的响应体（报告 §3.1 第 1、2 行）。
 * @param {"allow"|"deny"} decision
 * @param {string} [message] 仅拒绝时有意义（会原样进入模型上下文）
 */
export function buildDecisionResponse(decision, message) {
  if (decision === "allow") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" }
      }
    };
  }
  const out = { behavior: "deny" };
  const msg = String(message ?? "").trim();
  if (msg) out.message = msg.slice(0, 1024);
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: out } };
}

/**
 * 生成临时 `--settings` 文件内容。
 *
 * 只声明 `PermissionRequest` 一个钩子（http 类型，实测 PermissionRequest 支持 http；
 * SessionStart 不支持，所以别往这里加别的钩子）。`matcher:"*"` 实测可用。
 */
export function buildPermissionSettings({ port, token, hookTimeoutSec = DEFAULT_HOOK_TIMEOUT_SEC, matcher = "*" }) {
  const url = `http://127.0.0.1:${port}/permission?t=${encodeURIComponent(token)}`;
  return {
    hooks: {
      PermissionRequest: [
        {
          matcher,
          hooks: [{ type: "http", url, timeout: hookTimeoutSec }]
        }
      ]
    }
  };
}

/** 截断（detail 可能很长；给手机看的，不需要全文）。 */
function truncate(text, max) {
  const s = String(text ?? "");
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max), truncated: true };
}

/**
 * 把钩子请求体归一化。**未知形状不猜**：返回 `{ok:false}`，由调用方按拒绝处理。
 *
 * @param {{body:object, requestId:string, now:number, ttlMs:number, maxDetailChars:number}} input
 */
export function normalizePermissionRequest({ body, requestId, now, ttlMs, maxDetailChars = 1024 }) {
  if (!body || typeof body !== "object") return { ok: false, reason: "body 不是对象" };
  if (body.hook_event_name !== "PermissionRequest") {
    return { ok: false, reason: `未知钩子事件: ${String(body.hook_event_name || "").slice(0, 40)}` };
  }
  const toolName = String(body.tool_name || "").slice(0, 64);
  if (!toolName) return { ok: false, reason: "缺少 tool_name" };
  const input = body.tool_input && typeof body.tool_input === "object" ? body.tool_input : {};

  // detail：Bash 取命令原文，文件类工具取路径（都截断；命令原文只给 decide()，不进日志）
  let detailRaw = "";
  if (typeof input.command === "string") detailRaw = input.command;
  else if (typeof input.file_path === "string") detailRaw = input.file_path;
  else if (typeof input.path === "string") detailRaw = input.path;
  else if (typeof input.url === "string") detailRaw = input.url;
  else if (typeof input.pattern === "string") detailRaw = input.pattern;
  const detail = truncate(detailRaw, maxDetailChars);

  return {
    ok: true,
    request: {
      requestId,
      sessionId: typeof body.session_id === "string" ? body.session_id : "",
      cwd: typeof body.cwd === "string" ? body.cwd : "",
      permissionMode: typeof body.permission_mode === "string" ? body.permission_mode : "",
      toolName,
      kind: toolKindOf(toolName),
      title: `${toolName}: ${TOOL_TITLE[toolName] || "需要确认"}`,
      detail: detail.text,
      detailTruncated: detail.truncated,
      options: permissionOptions(),
      createdAt: now,
      expiresAt: now + ttlMs
    }
  };
}

/** 常量时间比较 token（避免按字节提前返回）。长度不同直接 false。 */
export function tokenMatches(expected, actual) {
  const a = Buffer.from(String(expected ?? ""), "utf8");
  const b = Buffer.from(String(actual ?? ""), "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * 创建 PermissionBridge（**未 start 前不占端口、不写文件、默认不启用**）。
 *
 * @param {object} opts
 * @param {number} [opts.port=0]        0 = 随机端口（生产默认；测试可注入固定端口）
 * @param {string} [opts.host="127.0.0.1"] 只允许回环（广域绑定直接抛错）
 * @param {number} [opts.ttlMs]         决策窗口，默认 90s
 * @param {number} [opts.hookTimeoutSec] 写进 settings 的 timeout（秒），默认 120
 * @param {(req:object)=>Promise<{decision:"allow"|"deny",message?:string}>} [opts.decide] 决策来源；缺省 fail-closed
 * @param {(entry:object)=>void} [opts.log] 结构化日志回调（**不会收到命令原文**）
 * @param {object} [opts.timers]        {setTimeout, clearTimeout} 可注入（测试）
 * @param {()=>number} [opts.now]       时钟可注入
 * @param {object} [opts.fs]            {mkdirSync, writeFileSync, rmSync, mkdtempSync} 可注入
 * @param {string} [opts.settingsDir]   临时 settings 的父目录（默认 os.tmpdir()）
 * @param {string} [opts.token]         URL token（默认随机 16B hex）
 */
export function createPermissionBridge({
  port = 0,
  host = "127.0.0.1",
  ttlMs = DEFAULT_DECISION_TTL_MS,
  hookTimeoutSec = DEFAULT_HOOK_TIMEOUT_SEC,
  decide,
  log,
  timers = { setTimeout, clearTimeout },
  now = () => Date.now(),
  fs = {
    mkdirSync: fsSync.mkdirSync,
    mkdtempSync: fsSync.mkdtempSync,
    writeFileSync: fsSync.writeFileSync,
    rmSync: fsSync.rmSync
  },
  settingsDir,
  token = crypto.randomBytes(16).toString("hex"),
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  maxPending = DEFAULT_MAX_PENDING,
  maxDetailChars = 1024
} = {}) {
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`PermissionBridge 只允许绑回环地址，收到 host=${host}`);
  }

  const pending = new Map(); // requestId → {timer, settle}
  let server = null;
  let dir = "";
  let settingsPath = "";
  let started = false;

  const logger = typeof log === "function" ? log : () => {};

  /** 结构化日志：只记元数据，**绝不带 detail/命令原文**。 */
  function logEntry(entry) {
    try {
      logger(entry);
    } catch {
      /* 日志失败不得影响审批（沿用仓库 logger 约定） */
    }
  }

  /**
   * 结算所有 pending：**一律 deny**（停止/关闭时绝不能"挂着"，更不能放行）。
   * 先把 HTTP 响应发完再关端口，避免 client 侧等到超时。
   */
  function cleanupPending() {
    for (const [, p] of pending) {
      try {
        p.finish("deny", "审批通道已关闭，已按拒绝处理", "stopped");
      } catch {
        /* finish 内部幂等，异常不影响后续清理 */
      }
      try {
        timers.clearTimeout(p.timer);
      } catch {
        /* ignore */
      }
    }
    pending.clear();
  }

  function writeSettings() {
    const parent = settingsDir || os.tmpdir();
    dir = fs.mkdtempSync(path.join(parent, "dsh-agent-perm-"));
    settingsPath = path.join(dir, "settings.json");
    const json = buildPermissionSettings({ port: server.address().port, token, hookTimeoutSec });
    fs.writeFileSync(settingsPath, JSON.stringify(json, null, 2) + "\n", { mode: 0o600 });
    return json;
  }

  function removeSettings() {
    if (!dir) return;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不阻断（残留目录在 tmp 下） */
    }
    dir = "";
    settingsPath = "";
  }

  function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
      "cache-control": "no-store"
    });
    res.end(text);
  }

  /**
   * 等一个决策：decide() 与 TTL 计时器赛跑。
   * 任何一个先到都 settle 一次（幂等）；TTL 先到 → deny。
   */
  function awaitDecision(request) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (decision, message, outcome) => {
        if (settled) return;
        settled = true;
        const p = pending.get(request.requestId);
        if (p) {
          try {
            timers.clearTimeout(p.timer);
          } catch {
            /* ignore */
          }
          pending.delete(request.requestId);
        }
        logEntry({
          level: outcome === "allow" ? "info" : "warn",
          event: "permission.decision",
          requestId: request.requestId,
          toolName: request.toolName,
          kind: request.kind,
          outcome,
          durationMs: now() - request.createdAt
        });
        resolve({ decision, message });
      };

      const timer = timers.setTimeout(() => finish("deny", DEFAULT_DENY_MESSAGE, "expired"), ttlMs);
      pending.set(request.requestId, { timer, finish });

      logEntry({
        level: "info",
        event: "permission.request",
        requestId: request.requestId,
        toolName: request.toolName,
        kind: request.kind,
        detailTruncated: request.detailTruncated,
        expiresAt: request.expiresAt
        // 刻意不含 detail：命令原文不进日志
      });

      let result;
      try {
        result = typeof decide === "function" ? decide(request) : null;
      } catch (err) {
        finish("deny", `审批处理器异常: ${err?.message || err}`, "error");
        return;
      }
      Promise.resolve(result)
        .then((d) => {
          if (!d || typeof d !== "object") return finish("deny", "审批处理器未返回决策", "error");
          if (d.cancelled) return finish("deny", "审批已取消", "cancelled");
          const decision = d.decision === "allow" ? "allow" : "deny";
          finish(decision, d.message, decision);
        })
        .catch((err) => finish("deny", `审批处理器异常: ${err?.message || err}`, "error"));
    });
  }

  async function handle(req, res) {
    const requestId = crypto.randomUUID();
    const startedAt = now();
    let url;
    try {
      url = new URL(req.url, `http://${host}`);
    } catch {
      sendJson(res, 400, { error: "bad-url" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, pending: pending.size, started });
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/permission") {
      sendJson(res, 404, { error: "not-found" });
      return;
    }
    // ① token（t 参数）：不对就 403。**不返回决策体**，让上游按无决策失败关闭。
    if (!tokenMatches(token, url.searchParams.get("t") || "")) {
      logEntry({ level: "warn", event: "permission.reject", reason: "bad-token", requestId });
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    if (pending.size >= maxPending) {
      logEntry({ level: "warn", event: "permission.reject", reason: "too-many-pending", requestId });
      sendJson(res, 429, { error: "too-many-pending" });
      return;
    }

    // ② 读 body（限流；超限直接 413）
    const chunks = [];
    let size = 0;
    let tooBig = false;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBodyBytes) {
        tooBig = true;
        break;
      }
      chunks.push(chunk);
    }
    if (tooBig) {
      logEntry({ level: "warn", event: "permission.reject", reason: "body-too-large", requestId });
      sendJson(res, 413, { error: "body-too-large" });
      return;
    }

    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      logEntry({ level: "warn", event: "permission.reject", reason: "invalid-json", requestId });
      sendJson(res, 400, { error: "invalid-json" });
      return;
    }

    // ③ 归一化；形状不认识就 400（上游无决策 → 拒绝，符合 fail-closed）
    const normalized = normalizePermissionRequest({ body, requestId, now: now(), ttlMs, maxDetailChars });
    if (!normalized.ok) {
      logEntry({ level: "warn", event: "permission.reject", reason: "unknown-shape", requestId, detail: normalized.reason });
      sendJson(res, 400, { error: "unknown-shape" });
      return;
    }

    // ④ 客户端提前断开：不再等待（记一条，决策丢弃；**绝不因此放行**）
    const onAborted = () => {
      const p = pending.get(requestId);
      if (p) {
        try {
          timers.clearTimeout(p.timer);
        } catch {
          /* ignore */
        }
        pending.delete(requestId);
      }
      logEntry({ level: "warn", event: "permission.aborted", requestId, durationMs: now() - startedAt });
    };
    req.on("aborted", onAborted);

    // ⑤ 等决策 → 回写实测形状
    const { decision, message } = await awaitDecision(normalized.request);
    req.off("aborted", onAborted);
    sendJson(res, 200, buildDecisionResponse(decision, message));
  }

  return {
    /** 启动：占端口 → 写临时 settings。失败抛错（由上层转成"不可用"，不静默）。 */
    async start() {
      if (started) throw new Error("PermissionBridge 已经启动");
      server = http.createServer((req, res) => {
        // client 提前断开时写响应会 emit error；吞掉，别让未处理 error 带走进程
        res.on("error", () => {});
        handle(req, res).catch((err) => {
          // 兜底：任何未预期异常都不许把进程带崩，也不返回 allow
          logEntry({ level: "error", event: "permission.internal-error", message: String(err?.message || err).slice(0, 200) });
          try {
            if (!res.headersSent) sendJson(res, 500, { error: "internal" });
            else res.end();
          } catch {
            /* client gone */
          }
        });
      });
      server.keepAliveTimeout = 1000;
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      started = true;
      const settings = writeSettings();
      logEntry({
        level: "info",
        event: "permission-bridge.started",
        port: server.address().port,
        ttlMs,
        hookTimeoutSec
      });
      return {
        ok: true,
        port: server.address().port,
        host,
        url: `http://${host}:${server.address().port}`,
        settingsPath,
        settings,
        token,
        ttlMs,
        pendingCount: () => pending.size,
        stop: () => this.stop()
      };
    },

    /** 停止：关端口、清计时器、删临时 settings。**幂等**。 */
    async stop() {
      cleanupPending();
      removeSettings();
      if (server) {
        const s = server;
        server = null;
        started = false;
        await new Promise((resolve) => {
          try {
            s.close(() => resolve());
            // keep-alive 连接不会自己走，主动断开（Node ≥18.2；老版本用可选链跳过）
            s.closeAllConnections?.();
          } catch {
            resolve();
          }
          // 兜底：等 200ms 还不关就强制断开（避免测试/退出挂住）
          setTimeout(resolve, 200).unref?.();
        });
      }
      logEntry({ level: "info", event: "permission-bridge.stopped" });
      return { ok: true };
    },

    /** 探针（测试/挂载自检用）。 */
    status() {
      return {
        started,
        port: server ? server.address()?.port || 0 : 0,
        settingsPath,
        pendingCount: pending.size
      };
    }
  };
}
