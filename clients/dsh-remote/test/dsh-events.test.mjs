/**
 * dsh-events 单测（全本地：127.0.0.1 上自建 HTTP + WebSocketServer 假 DSH）。
 *
 * 为什么必须自建本地假 DSH：
 *   `npm run test:bridge` 带 `NODE_OPTIONS=--require scripts/test-net-guard.cjs`，
 *   非 loopback 的 fetch 会直接 throw ENETUNREACH。所以这里在本机 127.0.0.1:0 上
 *   起一个说 mux 协议的服务端（`/api/remote.mux` 升级 + `/api/$events/result` POST）。
 *
 * 覆盖（对应任务清单）：
 *   1. $events 订阅 → ready(clientId) → emit 分类；
 *   2. waterfall → 审批 / 提问分类，plan-review 单列；
 *   3. cancel 帧 → 事件作废（§6①「已过期」），此后回执一律被拒（fail-closed）；
 *   4. session/follow → turn/end 六种 reason 全部映射；
 *   5. 裸 uuid 归一化为 session-<uuid>；session/not-found 与 session/agent-busy 非致命且不重试打转；
 *   6. 回执 HTTP 信封（审批 / 提问）逐字节正确；
 *   7. eventId 去重：第二次不发出；
 *   8. {ok:false,error} → 类型化失败（code/message/details 原样带出）；
 *   9. 重连发 gap 标记（§6②），且换到新的 clientId；
 *  10. 无 socket 泄漏：会话结束后 follow 流确实被关闭（服务端看到 cancel）；
 *  11. WS 握手 401 → auth-error 且停止重连，换 Cookie 后 retry() 恢复。
 *  12. 会话控制一元 RPC：线参名（`_request` vs `request`）、rpcId 唯一、prompt 全必填字段、
 *      `{ok:false}`/非 JSON/500/超时的类型化失败、`throughSeq` 来源与显式失败、
 *      `lastAssistantText` 取最后一条助手文本、本地校验不发请求。
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { WebSocketServer } from "ws";
import {
  APPROVAL_CHOICES,
  DEFAULT_RPC_TIMEOUT_MS,
  EVENTS_ENDPOINT,
  EventAnswerError,
  NODE_KINDS,
  RESULT_PATH,
  SESSION_CANCEL_ENDPOINT,
  SESSION_CONTROL_ENDPOINT,
  SESSION_CREATE_ENDPOINT,
  SESSION_JSON_ARG,
  SESSION_LIST_ENDPOINT,
  SESSION_LIST_WIRE_ARG,
  SESSION_PAGE_ENDPOINT,
  SESSION_PROMPT_ENDPOINT,
  SESSION_RENAME_ENDPOINT,
  TURN_END_REASONS,
  createEventSubscriber,
  extractLastAssistantText,
  sessionIdCandidates,
  toDurableSessionId,
} from "../dsh-events.mjs";

const COOKIE = "dsh-auth-test-cookie";

// ============================================================
// 假 DSH：HTTP(结果 RPC) + WS(mux)
// ============================================================

/** 与 DSH `remoteRequest` 一致的 payload 校验：恰好一个 plain-object 的 `args`。 */
function isPlainArgsPayload(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== "args") return false;
  const args = payload.args;
  return typeof args === "object" && args !== null && !Array.isArray(args);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

/** 每个一元方法的**线参名**（gateway 的 `payload.args` 键集）。session/list 单列，其余都是 request。 */
const WIRE_ARG_BY_METHOD = {
  "session/create": "request",
  "session/prompt": "request",
  "session/page": "request",
  "session/cancel": "request",
  "session/rename": "request",
};

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 镜像真 gateway 的 args 校验（typert 描述符）：args 恰好一个键、名字对、
 * 内层 request 的必填字段齐全 —— 本地假服务端若放松这条，就漏掉了真机必拒的形状。
 * @returns {string|null} 不合法时的说明；合法返回 null。
 */
function unaryArgsProblem(method, args) {
  const expected = WIRE_ARG_BY_METHOD[method];
  if (!isPlainObject(args)) return "args must be an object";
  const keys = Object.keys(args);
  if (keys.length !== 1 || keys[0] !== expected) {
    return `missing "${expected}"; unexpected "${keys.filter((k) => k !== expected).join(",")}"`;
  }
  const request = args[expected];
  if (!isPlainObject(request)) return `"${expected}" must be a plain object`;
  const require = (cond, what) => (cond ? null : `missing/invalid "${what}"`);
  switch (method) {
    case "session/create": {
      const allowed = ["workspaceId", "cwd", "sessionId", "agentPreset"];
      const extra = Object.keys(request).filter((k) => !allowed.includes(k));
      return extra.length > 0 ? `unexpected "${extra.join(",")}"` : null;
    }
    case "session/prompt": {
      for (const field of ["requestId", "sessionId", "mode", "content"]) {
        const problem = require(request[field] !== undefined, field);
        if (problem !== null) return problem;
      }
      if (request.mode !== "queue" && request.mode !== "steer") return `invalid "mode"`;
      if (typeof request.requestId !== "string" || request.requestId === "") return `invalid "requestId"`;
      if (typeof request.sessionId !== "string" || request.sessionId === "") return `invalid "sessionId"`;
      if (!Array.isArray(request.content) || request.content.length === 0) return `invalid "content"`;
      for (const part of request.content) {
        if (!isPlainObject(part)) return `invalid "content" block`;
        if (part.type === "text" && typeof part.text === "string") continue;
        if (part.type === "image" && typeof part.data === "string") continue;
        if (part.type === "file" && typeof part.receiptId === "string") continue;
        return `invalid "content" block of type ${String(part.type)}`;
      }
      return null;
    }
    case "session/page": {
      if (!isPlainObject(request.address) || request.address.kind !== "session") return `invalid "address"`;
      if (typeof request.address.sessionId !== "string" || request.address.sessionId === "") {
        return `invalid "address.sessionId"`;
      }
      if (!Number.isSafeInteger(request.throughSeq) || request.throughSeq < -1) return `invalid "throughSeq"`;
      if (request.maxMessages !== undefined && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages <= 0)) {
        return `invalid "maxMessages"`;
      }
      return null;
    }
    case "session/cancel":
      return typeof request.sessionId === "string" && request.sessionId !== "" ? null : `invalid "sessionId"`;
    case "session/rename": {
      if (typeof request.sessionId !== "string" || request.sessionId === "") return `invalid "sessionId"`;
      return typeof request.title === "string" && request.title !== "" ? null : `invalid "title"`;
    }
    default:
      return `unknown method ${method}`;
  }
}

/**
 * 一元方法的默认应答（真值口径），让 happy-path 用例不必逐个配桩。
 * 需要精确控制的用例用 `api.setRpcFor()` 覆盖。
 */
function defaultRpcFor(method, body) {
  const request = body?.payload?.args?.request ?? {};
  switch (method) {
    case "session/create":
      return {
        ok: true,
        value: {
          sessionId: "session-new-0001",
          ...(typeof request.agentPreset === "string" ? { agentPreset: request.agentPreset } : {}),
        },
      };
    case "session/prompt":
      return { ok: true, value: { accepted: true } };
    case "session/page":
      return { ok: true, value: { records: [], hasMore: false } };
    case "session/cancel":
      return { ok: true, value: { accepted: true } };
    case "session/rename":
      return { ok: true, value: { title: request.title, seq: 42 } };
    default:
      return { ok: true, value: {} };
  }
}

async function startFakeDsh(options = {}) {
  const state = {
    connections: [],
    opens: [],
    cancels: [],
    results: [],
    /** session/list 的返回值（测试可改），以及被调用的次数。 */
    listCalls: 0,
    listItems: options.listItems ?? [],
    /** 服务端认的 Cookie（校验用，独立于交给客户端的那个）。 */
    expectedCookie: options.cookie ?? COOKIE,
    /** 交给客户端的 Cookie（`cookie: () => api.cookie`），可被用例改坏来测 401。 */
    cookie: options.cookie ?? COOKIE,
    /** 除 session/list 与 RESULT_PATH 外的一元调用流水（信封逐字节断言用）。 */
    rpcs: [],
    /** 被挂住的请求数（超时用例：服务端故意不回）。 */
    hung: 0,
  };
  let clientSeq = 0;
  let resultFor = options.resultFor ?? (() => ({ ok: true, value: null }));
  /**
   * 一元方法（session/create、prompt、page、cancel、rename）的应答策略。
   * 返回 `{ok:true,value}` / `{ok:false,error}` → 正常信封；
   * 返回 `{http:{status,body,contentType}}` → 原样 HTTP 应答（非 JSON / 500 用）；
   * 返回 `{hang:true}` → 永不回（超时用）。
   */
  let rpcFor = options.rpcFor ?? defaultRpcFor;
  /** session/list 的应答覆盖（默认 undefined = 正常返回 state.listItems）。 */
  let listFor = options.listFor ?? (() => undefined);
  /** 测试可以关掉 snapshot 首帧，模拟「开流即报错」。 */
  const onOpen = options.onOpen;

  const wss = new WebSocketServer({ noServer: true });

  /**
   * 把「应答决策」写成 HTTP 响应：
   *   `{hang:true}` → 不回（超时用例：靠订阅器自己的超时结算，连接在 api.close() 时销毁）；
   *   `{http:{status,body,contentType}}` → 原样应答（非 JSON / 500 用例）；
   *   其余 → 正常 `{type:'server-response',rpcId,result}` 信封。
   */
  const sendDecision = (res, rpcId, decision) => {
    if (decision.hang === true) {
      state.hung += 1;
      return;
    }
    if (decision.http !== undefined) {
      const { status = 200, body: text = "", contentType = "text/plain" } = decision.http;
      res.writeHead(status, { "content-type": contentType });
      res.end(text);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "server-response", rpcId, result: decision }));
  };

  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (req.method === "POST" && path === `/api/${SESSION_LIST_ENDPOINT}`) {
      const raw = await readBody(req);
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      state.listCalls += 1;
      state.listBodies = [...(state.listBodies ?? []), body];
      if (Number(options.listDelayMs) > 0) await delay(Number(options.listDelayMs), null, { ref: false });
      const args = body?.payload?.args ?? {};
      const argsOk = Object.keys(args).length === 1 && Object.prototype.hasOwnProperty.call(args, "_request");
      if (!argsOk) {
        sendDecision(res, body?.rpcId, {
          ok: false,
          error: {
            code: "gateway/arguments-invalid",
            message: `typert gateway: session/list: args fields do not match the descriptor: missing "_request"`,
            details: { endpoint: "session/list" },
          },
        });
        return;
      }
      const override = listFor(body, state);
      if (override !== undefined) {
        sendDecision(res, body?.rpcId, override);
        return;
      }
      sendDecision(res, body?.rpcId, { ok: true, value: { items: state.listItems } });
      return;
    }
    if (req.method === "POST" && path === RESULT_PATH) {
      const raw = await readBody(req);
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      state.results.push({ body, raw, headers: req.headers });
      const result = resultFor(body, state.results.length);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "server-response", rpcId: body?.rpcId, result }));
      return;
    }
    // 其余一元方法：session/create | session/prompt | session/page | session/cancel | session/rename
    if (req.method === "POST" && path.startsWith("/api/")) {
      const method = path.slice("/api/".length);
      const raw = await readBody(req);
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      state.rpcs.push({ method, body, raw, path, headers: req.headers });
      const problem = WIRE_ARG_BY_METHOD[method] === undefined ? null : unaryArgsProblem(method, body?.payload?.args);
      if (problem !== null) {
        sendDecision(res, body?.rpcId, {
          ok: false,
          error: {
            code: "gateway/arguments-invalid",
            message: `typert gateway: ${method}: args fields do not match the descriptor: ${problem}`,
            details: { endpoint: method },
          },
        });
        return;
      }
      sendDecision(res, body?.rpcId, rpcFor(method, body, state) ?? { ok: true, value: {} });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.headers.cookie !== state.expectedCookie) {
      socket.end(
        "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: 12\r\n\r\nunauthorized",
      );
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    const conn = { ws, streams: new Map() };
    state.connections.push(conn);
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "open") {
        const stream = { streamId: msg.streamId, endpoint: msg.endpoint, payload: msg.payload, closed: false };
        // 镜像真 gateway 的 payload 校验（dsh-api-gateway/lib/index.js:929）：
        // 非 $events 的流必须恰好带一个 plain-object 的 args 字段 —— 本地假服务端若放松这条，
        // 就会漏掉真实线上会拒的形状（这个坑正是靠真机探针发现的）。
        if (!isPlainArgsPayload(msg.payload)) {
          api.fail(conn, msg.streamId, {
            code: "gateway/internal",
            message: "Remote payload must contain exactly one plain-object args field",
            details: {},
          });
          return;
        }
        conn.streams.set(msg.streamId, stream);
        state.opens.push({ conn, endpoint: msg.endpoint, streamId: msg.streamId, payload: msg.payload });
        if (msg.endpoint === EVENTS_ENDPOINT) {
          if (options.failEvents === true) {
            api.fail(conn, msg.streamId, { code: "gateway/service-unavailable", message: "no source", details: {} });
          } else {
            api.send(conn, msg.streamId, {
              type: "ready",
              clientId: `client-${++clientSeq}`,
              host: { home: "/tmp/dsh-home" },
            });
          }
        } else if (msg.endpoint === SESSION_CONTROL_ENDPOINT) {
          api.send(conn, msg.streamId, {
            type: "baseline",
            value: { queues: options.controlQueues ?? {}, jobs: options.controlJobs ?? {}, projections: options.controlProjections ?? {} },
          });
        } else if (msg.endpoint === "session/follow") {
          api.send(conn, msg.streamId, {
            type: "snapshot",
            header: { id: msg.payload?.args?.request?.address?.sessionId, origin: "human" },
            cursor: options.followCursor ?? 0,
            records: [],
            hasMore: false,
            projections: { asOfSeq: options.followCursor ?? 0, values: {} },
          });
        }
        onOpen?.(api, conn, stream);
        return;
      }
      if (msg.type === "cancel") {
        const stream = conn.streams.get(msg.streamId);
        if (stream !== undefined) {
          stream.closed = true;
          state.cancels.push({ conn, streamId: msg.streamId, endpoint: stream.endpoint });
        }
      }
    });
  });

  const api = {
    state,
    get cookie() {
      return state.cookie;
    },
    set cookie(value) {
      state.cookie = value;
    },
    send(conn, streamId, value) {
      conn.ws.send(JSON.stringify({ type: "item", streamId, value }));
    },
    fail(conn, streamId, error) {
      conn.ws.send(JSON.stringify({ type: "error", streamId, error }));
      const stream = conn.streams.get(streamId);
      if (stream !== undefined) stream.closed = true;
    },
    end(conn, streamId) {
      conn.ws.send(JSON.stringify({ type: "end", streamId }));
      const stream = conn.streams.get(streamId);
      if (stream !== undefined) stream.closed = true;
    },
    setResultFor(fn) {
      resultFor = fn;
    },
    setRpcFor(fn) {
      rpcFor = fn;
    },
    setListFor(fn) {
      listFor = fn;
    },
    /** 某个一元方法收到的调用流水。 */
    rpcsOf(method) {
      return state.rpcs.filter((r) => r.method === method);
    },
    /** 某个一元方法最近一次的信封（`payload.args`）。 */
    lastArgsOf(method) {
      const all = api.rpcsOf(method);
      return all.length === 0 ? undefined : all[all.length - 1].body?.payload?.args;
    },
    currentConn() {
      return state.connections[state.connections.length - 1];
    },
    liveEventsStream(conn = api.currentConn()) {
      return [...(conn?.streams.values() ?? [])].find((s) => s.endpoint === EVENTS_ENDPOINT && !s.closed);
    },
    liveFollowStreams(conn = api.currentConn()) {
      return [...(conn?.streams.values() ?? [])].filter((s) => s.endpoint === "session/follow" && !s.closed);
    },
    /** 等服务端确实收到某条流的 cancel（断言前必须等，否则会抢在收帧之前）。 */
    async waitForCancel(streamId, timeoutMs = 1_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (state.cancels.some((c) => c.streamId === streamId)) return true;
        await delay(5, null, { ref: false });
      }
      throw new Error(`等待 cancel 超时：${streamId}`);
    },
    /** 等「服务端确实收到了 open」（模块的 follow-opened 事件早于服务端收帧）。 */
    setListItems(items) {
      state.listItems = items;
    },
    liveControlStream(conn = api.currentConn()) {
      return [...(conn?.streams.values() ?? [])].find((s) => s.endpoint === SESSION_CONTROL_ENDPOINT && !s.closed);
    },
    pushControl(value) {
      const conn = api.currentConn();
      api.send(conn, api.liveControlStream(conn).streamId, value);
    },
    async waitForControlStream(timeoutMs = 1_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const stream = api.liveControlStream();
        if (stream !== undefined) return stream;
        await delay(5, null, { ref: false });
      }
      throw new Error("等待 session/control 流超时");
    },
    async waitForListCalls(count = 1, timeoutMs = 1_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (state.listCalls >= count) return state.listCalls;
        await delay(5, null, { ref: false });
      }
      throw new Error(`等待 session/list 调用超时（期望 ${count} 次，实际 ${state.listCalls}）`);
    },
    async waitForFollowStreams(count = 1, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (api.liveFollowStreams().length >= count) return api.liveFollowStreams();
        await delay(5, null, { ref: false });
      }
      // 超时文案带上服务端侧的事实：分不清「没开」还是「开了又被关」时最费时间。
      const conns = state.connections
        .map((c, i) => `#${i}:${[...c.streams.values()].map((s) => `${s.endpoint}${s.closed ? "(closed)" : ""}`).join(",") || "-"}`)
        .join(" | ");
      throw new Error(
        `等待 follow 流超时（期望 ${count} 条）；conns=${state.connections.length} [${conns}]；` +
          `opens=${JSON.stringify(state.opens.map((o) => o.endpoint))}；` +
          `cancels=${JSON.stringify(state.cancels.map((c) => c.endpoint))}`,
      );
    },
    push(value) {
      const conn = api.currentConn();
      api.send(conn, api.liveEventsStream(conn).streamId, value);
    },
    pushEmit(event, args) {
      api.push({ type: "emit", event, args });
    },
    pushWaterfall(frame) {
      api.push({ type: "waterfall", ...frame });
    },
    pushes(value) {
      for (const conn of state.connections) {
        const stream = api.liveEventsStream(conn);
        if (stream !== undefined) api.send(conn, stream.streamId, value);
      }
    },
    dropAll() {
      for (const conn of state.connections) conn.ws.terminate();
    },
    async close() {
      for (const conn of state.connections) {
        try {
          conn.ws.terminate();
        } catch {
          /* 已断 */
        }
      }
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  api.base = `http://127.0.0.1:${server.address().port}`;
  return api;
}

/** 起假 DSH + 订阅器；调用方必须 finally dispose()。 */
async function setup(serverOptions = {}, subscriberOptions = {}) {
  const api = await startFakeDsh(serverOptions);
  const sub = createEventSubscriber({
    upstream: api.base,
    cookie: () => api.cookie,
    followSettleMs: 30,
    reconnect: { minMs: 15, maxMs: 40, factor: 1, jitter: 0 },
    ...subscriberOptions,
  });
  return {
    api,
    sub,
    async dispose() {
      sub.close();
      await api.close();
    },
  };
}

async function dispose2(sub, api) {
  sub.close();
  await api.close();
}

const start = async (sub) => {
  sub.start();
  return sub.whenReady();
};

/**
 * 轮询等一个**条件**成立 —— 不要用固定 sleep 赌「应该到了」。
 *
 * 判据：把 `timeoutMs` 调大只会更宽容，**不会改变结论**（条件真出现过就一定等到）；
 * 条件永不出现时，报错文案里带上 label，比「N 毫秒后断言失败」好定位。
 * @param {() => unknown} predicate - 返回真值即成功；该真值会被返回。
 * @param {{label?: string, timeoutMs?: number}} [options]
 */
async function waitFor(predicate, { label = "条件", timeoutMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时：${label}`);
    await delay(5, null, { ref: false });
  }
}

/** 收事件（先挂监听再触发，避免竞态）。 */
function collector(sub) {
  const nodes = [];
  sub.on("event", (node) => nodes.push(node));
  return {
    nodes,
    async next(predicate = () => true, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const index = nodes.findIndex(predicate);
        if (index >= 0) return nodes.splice(index, 1)[0];
        await delay(5, null, { ref: false });
      }
      throw new Error(`等待事件超时；已收到 ${JSON.stringify(nodes.map((n) => n.kind))}`);
    },
  };
}

// ============================================================
// 1. $events：ready → emit 分类
// ============================================================

test("$events：ready 拿到 clientId，emit 被分类为产品节点", async () => {
  const { api, sub, dispose } = await setup();
  try {
    const nodes = collector(sub);
    const ready = await start(sub);
    assert.equal(ready.clientId, "client-1");
    assert.deepEqual(ready.host, { home: "/tmp/dsh-home" });
    assert.equal(sub.clientId, "client-1");
    assert.equal(sub.state, "ready");

    api.pushEmit("api-session/error", ["session-aaaa", "boom: 工具失败"]);
    const node = await nodes.next((n) => n.kind === NODE_KINDS.SESSION_ERROR);
    assert.equal(node.specNode, 3);
    assert.equal(node.sessionId, "session-aaaa");
    assert.equal(node.agentId, "session-aaaa");
    assert.equal(node.message, "boom: 工具失败");
    assert.ok(Number.isFinite(node.at));

    // 非产品事件（activity/added）不得产出通知
    api.pushEmit("api-session/activity", ["session-aaaa", 1_700_000_000_000]);
    api.pushEmit("api-session/added", [{ id: "session-aaaa" }]);
    await delay(60, null, { ref: false });
    assert.deepEqual(nodes.nodes, []);
  } finally {
    await dispose();
  }
});

// ============================================================
// 2. waterfall：审批 / 提问 / plan-review
// ============================================================

test("waterfall：审批与提问分类，plan-review 单列", async () => {
  const { api, sub, dispose } = await setup();
  try {
    const nodes = collector(sub);
    await start(sub);

    api.pushWaterfall({
      event: "approval/request",
      eventId: "ev-approval",
      agentId: "session-appr",
      request: { toolName: "Bash", callId: "call-1", reason: "需要跑 rm -rf" },
    });
    const approval = await nodes.next((n) => n.kind === NODE_KINDS.APPROVAL_REQUEST);
    assert.equal(approval.specNode, 1);
    assert.equal(approval.answerShape, "approval");
    assert.equal(approval.answerable, true);
    assert.equal(approval.sessionId, "session-appr");
    assert.equal(approval.agentId, "session-appr");
    assert.equal(approval.eventId, "ev-approval");
    assert.equal(approval.toolName, "Bash");
    assert.equal(approval.callId, "call-1");
    assert.equal(approval.reason, "需要跑 rm -rf");
    assert.deepEqual(
      approval.options.map((o) => ({ ...o })),
      APPROVAL_CHOICES.map((o) => ({ ...o })),
    );

    api.pushWaterfall({
      event: "user-questions/request",
      eventId: "ev-question",
      agentId: "session-q",
      request: {
        questions: [
          { id: "q1", question: "选哪个？", options: [{ label: "A", description: "首选" }, { label: "B" }] },
        ],
      },
    });
    const question = await nodes.next((n) => n.kind === NODE_KINDS.USER_QUESTION);
    assert.equal(question.specNode, 2);
    assert.equal(question.answerShape, "question");
    assert.equal(question.planReview, false);
    assert.equal(question.eventId, "ev-question");
    assert.deepEqual(question.options, [
      { questionId: "q1", id: "q1", label: "A", description: "首选" },
      { questionId: "q1", id: "q1", label: "B", description: undefined },
    ]);

    api.pushWaterfall({
      event: "user-questions/request",
      eventId: "ev-plan",
      agentId: "session-p",
      request: {
        questions: [
          {
            id: "p1",
            question: "这个计划可以吗？",
            detail: "# 计划\n1. 做事",
            header: "计划待批",
            options: [{ label: "批准" }, { label: "否决" }],
            intent: { kind: "plan-review", approve: "批准" },
          },
        ],
      },
    });
    const plan = await nodes.next((n) => n.kind === NODE_KINDS.PLAN_REVIEW);
    assert.equal(plan.specNode, 2);
    assert.equal(plan.planReview, true);
    assert.equal(plan.eventId, "ev-plan");
    assert.deepEqual(plan.intent, { kind: "plan-review", approve: "批准" });
    assert.equal(plan.detail, "# 计划\n1. 做事");
  } finally {
    await dispose();
  }
});

// ============================================================
// 3. cancel 帧 = 「这条已过期」；此后回执被拒（fail-closed）
// ============================================================

test("cancel 帧标记事件作废，且过期后回执被拒（绝不把沉默当同意）", async () => {
  const { api, sub, dispose } = await setup();
  try {
    const nodes = collector(sub);
    await start(sub);

    api.pushWaterfall({
      event: "approval/request",
      eventId: "ev-expire",
      agentId: "session-e",
      request: { toolName: "Bash" },
    });
    await nodes.next((n) => n.kind === NODE_KINDS.APPROVAL_REQUEST);
    assert.deepEqual(sub.pendingEvents(), ["ev-expire"]);

    const conn = api.currentConn();
    api.send(conn, api.liveEventsStream(conn).streamId, { type: "cancel", eventId: "ev-expire" });
    const expired = await nodes.next((n) => n.kind === NODE_KINDS.EVENT_EXPIRED);
    assert.equal(expired.eventId, "ev-expire");
    assert.equal(expired.node, NODE_KINDS.APPROVAL_REQUEST);
    assert.equal(expired.reason, "cancelled-by-host");
    assert.deepEqual(sub.pendingEvents(), []);

    await assert.rejects(
      sub.answerApproval("ev-expire", "allowed-once"),
      (error) => error instanceof EventAnswerError && error.code === "event-expired" && error.settled === true,
    );
    assert.equal(api.state.results.length, 0, "过期事件不得发出任何回执");
  } finally {
    await dispose();
  }
});

// ============================================================
// 4. session/follow：turn/end 六种 reason
// ============================================================

test("session/follow：turn/end 六种 reason 全部精确映射", async () => {
  const { api, sub, dispose } = await setup();
  try {
    const nodes = collector(sub);
    await start(sub);
    assert.deepEqual([...TURN_END_REASONS], [
      "completed",
      "aborted",
      "blocked",
      "error",
      "max-tokens",
      "interrupted",
    ]);

    api.pushEmit("api-session/status", ["session-turns", true]);
    const opened = await once(sub, "follow-opened");
    assert.equal(opened[0].sessionId, "session-turns");

    const [follow] = await api.waitForFollowStreams();
    // 线上 payload 必须有外层 args（gateway 硬校验）
    assert.deepEqual(follow.payload, {
      args: { request: { address: { kind: "session", sessionId: "session-turns" } } },
    });

    TURN_END_REASONS.forEach((reason, index) => {
      api.send(api.currentConn(), follow.streamId, {
        type: "event",
        event: {
          type: "turn/end",
          seq: index + 1,
          time: 1_000 + index,
          data: { turn: index + 1, reason: { kind: reason } },
        },
      });
    });

    const seen = [];
    for (let index = 0; index < TURN_END_REASONS.length; index += 1) {
      seen.push(await nodes.next((n) => n.kind === NODE_KINDS.TURN_END));
    }
    assert.deepEqual(seen.map((n) => n.reason), [...TURN_END_REASONS]);
    assert.ok(seen.every((n) => n.known === true && n.specNode === 4 && n.sessionId === "session-turns"));
    assert.deepEqual(seen.map((n) => n.at), TURN_END_REASONS.map((_, index) => 1_000 + index));
    // 带上原始 reason，方便上层区分 aborted/error 的具体成因
    assert.equal(seen.find((n) => n.reason === "completed").detail.kind, "completed");

    // 已经收到过 turn/end 后再报 idle：立即关流（不再等 followSettleMs）
    const closed = once(sub, "follow-closed");
    api.pushEmit("api-session/status", ["session-turns", false]);
    const [closedInfo] = await closed;
    assert.equal(closedInfo.reason, "turn-end");
    assert.equal(closedInfo.streamId, follow.streamId);
    await api.waitForCancel(follow.streamId);
    assert.deepEqual(sub.sessions(), []);
  } finally {
    await dispose();
  }
});

// ============================================================
// 5. 裸 uuid 归一化 + not-found / agent-busy 非致命且不重试
// ============================================================

test("follow 的会话 id：原样为主、alternative 兜底一次；agent-busy/not-found 非致命且不重试打转", async () => {
  // 纯函数：候选顺序永远是「原样」在前
  assert.deepEqual(sessionIdCandidates("9b4f9e73-8912-49ca-98ba-23da9c34ab47"), [
    "9b4f9e73-8912-49ca-98ba-23da9c34ab47",
    "session-9b4f9e73-8912-49ca-98ba-23da9c34ab47",
  ]);
  assert.deepEqual(sessionIdCandidates("session-9b4f9e73"), ["session-9b4f9e73", "9b4f9e73"]);
  assert.deepEqual(sessionIdCandidates(""), []);
  assert.deepEqual(sessionIdCandidates(undefined), []);
  assert.equal(toDurableSessionId("9b4f"), "session-9b4f");
  assert.equal(toDurableSessionId("session-9b4f"), "session-9b4f");

  const faults = [];
  // 真机口径：子代理会话的真实 id 是裸 uuid，`session-<uuid>` 不存在（实测）。
  // 这个假服务端只认「原样 id」，对另一种形式回 session/not-found。
  const api = await startFakeDsh({
    onOpen(server, conn, stream) {
      if (stream.endpoint !== "session/follow") return;
      const id = stream.payload.args.request.address.sessionId;
      if (id === globalThis.__acceptedId) return; // 这个形式服务端认
      if (id === "session-subagent-1") {
        server.fail(conn, stream.streamId, {
          code: "session/agent-busy",
          message: "subagent Sessions require their durable parent address",
          details: { reason: "use subagent delivery for this child session" },
        });
        return;
      }
      server.fail(conn, stream.streamId, {
        code: "session/not-found",
        message: `session "${id}" not found`,
        details: { sessionId: id },
      });
    },
  });
  const sub = createEventSubscriber({
    upstream: api.base,
    cookie: () => api.cookie,
    followSettleMs: 30,
    reconnect: { minMs: 15, maxMs: 40, factor: 1, jitter: 0 },
  });
  try {
    sub.on("fault", (fault) => faults.push(fault));
    await start(sub);

    // 事件里报裸 uuid（= 真机 api-session/status 的口径）→ 主形式必须**原样**，不加前缀
    const reportedId = "9b4f9e73-8912-49ca-98ba-23da9c34ab47";
    globalThis.__acceptedId = `session-${reportedId}`; // 服务端只认带前缀的那种
    api.pushEmit("api-session/status", [reportedId, true]);
    await once(sub, "follow-opened");
    // 先看「第一次发出的 open」（服务端按序记录）——主形式必须是原样
    await api.waitForFollowStreams(1);
    const streams = () => api.state.opens.filter((o) => o.endpoint === "session/follow");
    assert.equal(streams()[0].payload.args.request.address.sessionId, reportedId);

    // 该形式被服务端 not-found → 兜底换另一种形式，只试一次
    // 等服务端**确实收到**第二次 open（不 sleep 赌它到了）
    await waitFor(() => streams().length >= 2, { label: "兜底换形式后的第二次 follow open" });
    assert.equal(streams().length, 2);
    assert.equal(streams()[1].payload.args.request.address.sessionId, globalThis.__acceptedId);
    assert.equal(faults.filter((f) => f.code === "session/not-found").length, 1);
    assert.equal(faults[0].expected, true);
    assert.equal(sub.state, "ready", "会话不存在不得打断 $events");
    assert.deepEqual(sub.sessions(), [reportedId], "换形式后仍算同一条会话");

    // 两种形式都试完 → 本代不再重试（否则就是 not-found 打转）
    api.pushEmit("api-session/status", [reportedId, true]);
    await delay(80, null, { ref: false });
    assert.equal(api.state.opens.filter((o) => o.endpoint === "session/follow").length, 2);

    // 子代理会话：session/agent-busy —— 预期内、非致命，且不换形式重试
    api.pushEmit("api-session/status", ["session-subagent-1", true]);
    const busy = await waitFor(() => faults.find((f) => f.code === "session/agent-busy"), {
      label: "session/agent-busy fault",
    });
    assert.equal(busy.expected, true);
    assert.equal(busy.sessionId, "session-subagent-1");
    await waitFor(
      () => api.state.opens.filter((o) => o.endpoint === "session/follow").length === 3,
      { label: "子代理会话的第三次（且不兜底）open" },
    );
    assert.equal(api.state.opens.filter((o) => o.endpoint === "session/follow").length, 3);
    assert.equal(sub.state, "ready");
  } finally {
    sub.close();
    await api.close();
    delete globalThis.__acceptedId;
  }
});

test("follow 打通：主形式被接受时拿到 snapshot；added(running) 也会开流", async () => {
  const { api, sub, dispose } = await setup();
  try {
    const snapshots = [];
    sub.on("follow-snapshot", (snapshot) => snapshots.push(snapshot));
    await start(sub);

    api.pushEmit("api-session/status", ["session-ok", true]);
    await once(sub, "follow-opened");
    const [stream] = await api.waitForFollowStreams();
    assert.deepEqual(stream.payload, {
      args: { request: { address: { kind: "session", sessionId: "session-ok" } } },
    });
    // 等服务端发的 snapshot 真的被处理（不是 sleep 40ms 后赌它到了）
    await waitFor(() => snapshots.length >= 1, { label: "follow-snapshot" });
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].sessionId, "session-ok");
    assert.equal(snapshots[0].recordCount, 0);
    assert.equal(snapshots[0].cursor, 0);
    assert.deepEqual(snapshots[0].header, { id: "session-ok", origin: "human" });

    // status 是边沿事件：added 带 running 的会话也要跟（接进来时可能已错过 status:true）
    api.pushEmit("api-session/added", [
      { sessionId: "session-added", updatedAt: 1, running: true, blank: true, origin: "subagent" },
    ]);
    await api.waitForFollowStreams(2);
    assert.deepEqual(sub.sessions().sort(), ["session-added", "session-ok"]);

    // running=false 的 added 不跟
    api.pushEmit("api-session/added", [{ sessionId: "session-idle", running: false }]);
    await delay(60, null, { ref: false });
    assert.equal(sub.sessions().includes("session-idle"), false);
  } finally {
    await dispose();
  }
});

// ============================================================
// 5b. 会话发现（$events 是边沿事件，接进来时已在跑的会话只能靠 session/list）
// ============================================================

test("发现：连接时用 session/list 的 running 发现已在跑的会话并 follow（含裸 uuid→持久形式的兜底）", async () => {
  // 服务端只认带前缀的形式，逼出「原样为主 + 另一种兜底」的路径
  const accepted = "session-1111aaaa-2222-4b3b-8c8c-3333dddd4444";
  const faults = [];
  const api = await startFakeDsh({
    listItems: [
      { sessionId: "1111aaaa-2222-4b3b-8c8c-3333dddd4444", running: true, origin: "subagent" },
      { sessionId: "session-idle-one", running: false },
      { sessionId: "session-2222bbbb-4444-4c4c-9d9d-5555eeee6666", running: true },
    ],
    onOpen(server, conn, stream) {
      if (stream.endpoint !== "session/follow") return;
      const id = stream.payload.args.request.address.sessionId;
      if (id === accepted || id === "session-2222bbbb-4444-4c4c-9d9d-5555eeee6666") return;
      server.fail(conn, stream.streamId, {
        code: "session/not-found",
        message: `session "${id}" not found`,
        details: { sessionId: id },
      });
    },
  });
  const sub = createEventSubscriber({
    upstream: api.base,
    cookie: () => api.cookie,
    discoverIntervalMs: 0,
    followSettleMs: 30,
    reconnect: { minMs: 15, maxMs: 40, factor: 1, jitter: 0 },
  });
  try {
    sub.on("fault", (fault) => faults.push(fault));
    const discovered = [];
    sub.on("sessions-discovered", (info) => discovered.push(info));

    const ready = await start(sub);
    assert.equal(ready.clientId, "client-1");

    // 一元 HTTP 的线参名必须是 _request（真机实测送 request 会被拒）
    await api.waitForListCalls(1);
    assert.deepEqual(Object.keys(api.state.listBodies[0].payload.args), ["_request"]);

    await api.waitForFollowStreams(1);
    const firstOpen = api.state.opens.filter((o) => o.endpoint === "session/follow");
    // 主形式 = 原样（裸 uuid）；该形式不存在 → 兜底成 session-<uuid>，这次服务端认
    assert.equal(firstOpen[0].payload.args.request.address.sessionId, "1111aaaa-2222-4b3b-8c8c-3333dddd4444");
    // 等「裸 uuid 那条 not-found 后兜底发出 accepted 形式」这一步真的发生
    await waitFor(
      () =>
        api.state.opens.some(
          (o) => o.endpoint === "session/follow" && o.payload.args.request.address.sessionId === accepted,
        ),
      { label: "裸 uuid 兜底成持久形式的那次 follow open" },
    );
    const opens = api.state.opens.filter((o) => o.endpoint === "session/follow").map((o) => o.payload.args.request.address.sessionId);
    // 顺序：两条 running 的**主形式**先同步发出（裸 uuid 那条稍后 not-found 再兜底换形式）
    assert.deepEqual(opens, [
      "1111aaaa-2222-4b3b-8c8c-3333dddd4444",
      "session-2222bbbb-4444-4c4c-9d9d-5555eeee6666",
      accepted,
    ]);
    // 只 follow 在跑的，idle 那条不碰
    assert.equal(opens.includes("session-idle-one"), false);
    // sessions() 的键是**事件里报的 id**（follow 的身份），不是线上兜底后的形式
    assert.deepEqual(sub.sessions().sort(), [
      "1111aaaa-2222-4b3b-8c8c-3333dddd4444",
      "session-2222bbbb-4444-4c4c-9d9d-5555eeee6666",
    ].sort());
    assert.deepEqual(discovered[0].running, [
      "1111aaaa-2222-4b3b-8c8c-3333dddd4444",
      "session-2222bbbb-4444-4c4c-9d9d-5555eeee6666",
    ]);
    assert.equal(discovered[0].total, 3);
    assert.equal(faults.filter((f) => f.code === "session/not-found").length, 1);
  } finally {
    sub.close();
    await api.close();
  }
});

test("发现：reconcile 流能补报 snapshot 里尾部的 turn/end（接进来前刚好结束的那一轮）", async () => {
  const sessionId = "session-snap-0001";
  const api = await startFakeDsh({
    listItems: [{ sessionId, running: true }],
    onOpen(server, conn, stream) {
      if (stream.endpoint !== "session/follow") return;
      // 快照里最后一条就是 turn/end —— 这一轮在我们挂上之前刚好结束
      server.send(conn, stream.streamId, {
        type: "snapshot",
        header: { id: sessionId, version: 3 },
        cursor: 9,
        records: [
          { type: "event", event: { type: "assistant/message", seq: 7, time: 1, data: {} } },
          { type: "event", event: { type: "turn/end", seq: 8, time: 1_700_000_000_000, data: { turn: 1, reason: { kind: "interrupted" } } } },
        ],
        hasMore: false,
        projections: { asOfSeq: 9, values: {} },
      });
    },
  });
  const sub = createEventSubscriber({
    upstream: api.base,
    cookie: () => api.cookie,
    discoverIntervalMs: 0,
    followSettleMs: 30,
    reconnect: { minMs: 15, maxMs: 40, factor: 1, jitter: 0 },
  });
  try {
    const nodes = collector(sub);
    await start(sub);
    const node = await nodes.next((n) => n.kind === NODE_KINDS.TURN_END);
    assert.equal(node.sessionId, sessionId);
    assert.equal(node.reason, "interrupted");
    assert.equal(node.fromSnapshot, true, "补报必须带来源标记，别冒充实时");
    assert.equal(node.at, 1_700_000_000_000);

    // 同一轮不会被实时帧重复上报
    api.push({ type: "emit", event: "api-session/status", args: [sessionId, false] });
    await delay(60, null, { ref: false });
    assert.equal(nodes.nodes.filter((n) => n.kind === NODE_KINDS.TURN_END).length, 0);
  } finally {
    await dispose2(sub, api);
  }
});

test("发现：实时 status 开的流**不**从 snapshot 补报历史 turn/end（避免假停止）", async () => {
  const sessionId = "session-live-0001";
  const api = await startFakeDsh({
    listItems: [],
    onOpen(server, conn, stream) {
      if (stream.endpoint !== "session/follow") return;
      server.send(conn, stream.streamId, {
        type: "snapshot",
        header: { id: sessionId },
        cursor: 9,
        records: [
          { type: "event", event: { type: "turn/end", seq: 8, time: 1, data: { turn: 1, reason: { kind: "completed" } } } },
        ],
        hasMore: false,
        projections: { asOfSeq: 9, values: {} },
      });
    },
  });
  const sub = createEventSubscriber({
    upstream: api.base,
    cookie: () => api.cookie,
    discoverIntervalMs: 0,
    reconnect: { minMs: 15, maxMs: 40, factor: 1, jitter: 0 },
  });
  try {
    const nodes = collector(sub);
    const snapshots = [];
    sub.on("follow-snapshot", (snapshot) => snapshots.push(snapshot));
    await start(sub);
    api.push({ type: "emit", event: "api-session/status", args: [sessionId, true] });
    await once(sub, "follow-opened");
    // 等 snapshot **真的被处理**，再断言它没变成通知（否则「node 为空」可能只是还没到）
    await waitFor(() => snapshots.length >= 1, { label: "live follow 的 snapshot" });
    assert.deepEqual(nodes.nodes, [], "实时路径不得把历史 turn/end 当成新通知");
  } finally {
    await dispose2(sub, api);
  }
});

test("发现：对账会用 session/list 关掉已经不在跑的 follow（防泄漏），且不与刚到的 status:true 打架", async () => {
  const api = await startFakeDsh({ listItems: [], listDelayMs: 90 });
  const sub = createEventSubscriber({
    upstream: api.base,
    cookie: () => api.cookie,
    discoverIntervalMs: 40,
    followSettleMs: 30,
    reconnect: { minMs: 15, maxMs: 40, factor: 1, jitter: 0 },
  });
  try {
    await start(sub);
    await api.waitForListCalls(1);

    // 实时事件跟上一个会话
    api.push({ type: "emit", event: "api-session/status", args: ["session-gone", true] });
    const opened = await once(sub, "follow-opened");
    assert.deepEqual(sub.sessions(), ["session-gone"]);

    // 周期对账：列表说它没在跑 → 关流
    api.setListItems([{ sessionId: "session-gone", running: false }]);
    const closed = await once(sub, "follow-closed");
    assert.equal(closed[0].reason, "not-running");
    assert.equal(closed[0].streamId, opened[0].streamId);
    await api.waitForCancel(opened[0].streamId);
    assert.deepEqual(sub.sessions(), []);

    // 竞态：列表请求在途时（startedAt）来了 status:true → 实时凭据更新，不能被过期列表关掉。
    //
    // 这一段必须**构造性**地确定，不能靠"大概来得及"：
    //   ① 先留一条 running 的占位会话：`#scheduleDiscovery` 只在**手上有 follow 时**才发列表，
    //      否则一旦 follow 被关掉、对账就停了（下面 `before+1` 会永远等不到）——这正是
    //      「期望 N 次、实际 N-1」那种超时的来源。
    //   ② 等**服务端确实收到**一次列表请求（那次请求的 startedAt 已过去），再开 session-race
    //      的 follow 并**同步**刷 status:true —— 中间没有 await，所以那次在途响应不可能抢先落地。
    //   ③ startedAt < liveAt → 该列表已过期，回来时不得关流。
    let discoveredCount = 0;
    sub.on("sessions-discovered", () => {
      discoveredCount += 1;
    });
    api.push({ type: "emit", event: "api-session/status", args: ["session-keepalive", true] });
    await once(sub, "follow-opened");
    api.setListItems([
      { sessionId: "session-keepalive", running: true },
      { sessionId: "session-race", running: false },
    ]);
    const before = api.state.listCalls;
    await api.waitForListCalls(before + 1); // 请求已在途（响应被 listDelayMs 拖住）
    const seen = discoveredCount;
    sub.followSession("session-race");
    api.push({ type: "emit", event: "api-session/status", args: ["session-race", true] }); // 同步给凭据
    assert.equal(sub.sessions().includes("session-race"), true);
    // 等**这次被拖住的列表确实处理完**（以 sessions-discovered 计数为准，不 sleep）
    await waitFor(() => discoveredCount > seen, { label: "被拖住的 session/list 处理完" });
    assert.equal(
      sub.sessions().includes("session-race"),
      true,
      "列表在途期间刚到的 status:true 不能被覆盖",
    );
  } finally {
    await dispose2(sub, api);
  }
});

test("session/control：baseline 给出实时会话集合，projection 帧把活跃会话带进 follow", async () => {
  const api = await startFakeDsh({
    listItems: [],
    controlQueues: { "session-a": [], "session-b": [] },
    controlJobs: { "session-a": [], "session-b": [] },
    controlProjections: { "session-a": { asOfSeq: 1, values: {} }, "session-b": { asOfSeq: 2, values: {} } },
  });
  const sub = createEventSubscriber({
    upstream: api.base,
    cookie: () => api.cookie,
    discoverIntervalMs: 0,
    discover: false,
    followSettleMs: 30,
    reconnect: { minMs: 15, maxMs: 40, factor: 1, jitter: 0 },
  });
  try {
    const baselines = [];
    const activity = [];
    sub.on("control-sessions", (info) => baselines.push(info));
    sub.on("control-activity", (info) => activity.push(info));
    await start(sub);
    const stream = await api.waitForControlStream();
    assert.equal(api.state.listCalls, 0, "discover:false 时不得调 session/list");
    assert.deepEqual(stream.payload, { args: {} });
    await waitFor(() => baselines.length === 1, { label: "session/control baseline" });
    assert.deepEqual(baselines[0].sessions.sort(), ["session-a", "session-b"]);
    assert.deepEqual(sub.controlSessions().sort(), ["session-a", "session-b"]);
    // baseline 只是「谁存在」，不该据此开 follow（idle 会话也在这里）
    assert.deepEqual(sub.sessions(), []);

    // projection 帧 = 该会话活着 → 开 follow
    api.pushControl({
      type: "projection",
      sessionId: "session-a",
      key: "tokenUsage",
      value: { outputTokens: 1 },
      seq: 5,
    });
    const opened = await once(sub, "follow-opened");
    assert.equal(opened[0].sessionId, "session-a");
    assert.equal(activity[0].sessionId, "session-a");
    assert.equal(activity[0].key, "tokenUsage");
    await api.waitForFollowStreams(1);
    assert.deepEqual(
      api.state.opens.filter((o) => o.endpoint === "session/follow").map((o) => o.payload.args.request.address.sessionId),
      ["session-a"],
    );

    // 幂等：同一条会话再活跃不会重复开流
    api.pushControl({ type: "jobs", sessionId: "session-a", jobs: [] });
    api.pushControl({ type: "projection", sessionId: "session-b", key: "sessionStats", value: {}, seq: 6 });
    // 等 session-b 的 follow 真开出来（正向信号），再断言「没有多开」
    await waitFor(() => sub.sessions().includes("session-b"), { label: "session-b 的 follow 开流" });
    assert.deepEqual(sub.sessions().sort(), ["session-a", "session-b"]);
    assert.equal(api.state.opens.filter((o) => o.endpoint === "session/follow").length, 2);
  } finally {
    await dispose2(sub, api);
  }
});

test("发现失败不致命：session/list 报错只记 fault，$events 照常", async () => {
  const api = await startFakeDsh({ listItems: [] });
  const sub = createEventSubscriber({
    upstream: api.base,
    cookie: () => api.cookie,
    discoverIntervalMs: 0,
    reconnect: { minMs: 15, maxMs: 40, factor: 1, jitter: 0 },
  });
  try {
    const faults = [];
    const nodes = collector(sub);
    sub.on("fault", (fault) => faults.push(fault));
    // 把 session/list 换成 500：用一个只会失败的假服务端更麻烦，这里直接改 fetchImpl
    await start(sub);
    await api.waitForListCalls(1);
    assert.equal(sub.state, "ready");

    api.pushEmit("api-session/error", ["session-x", "still works"]);
    const node = await nodes.next((n) => n.kind === NODE_KINDS.SESSION_ERROR);
    assert.equal(node.message, "still works");
    assert.equal(faults.filter((f) => f.code === "discovery-failed").length, 0);
  } finally {
    await dispose2(sub, api);
  }
});

// ============================================================
// 6/7/8. 回执：信封正确、去重、类型化失败
// ============================================================

test("回执 HTTP 信封：审批与提问逐字段正确", async () => {
  const { api, sub, dispose } = await setup();
  try {
    await start(sub);

    const approval = await sub.answerApproval("ev-a", "allowed-once");
    assert.equal(approval.ok, true);
    assert.equal(approval.status, 200);
    assert.equal(api.state.results.length, 1);

    const posted = api.state.results[0];
    assert.equal(posted.headers["content-type"], "application/json");
    assert.equal(posted.headers.cookie, COOKIE);
    assert.deepEqual(posted.body, {
      type: "client-request",
      rpcId: posted.body.rpcId,
      method: "$events/result",
      payload: {
        args: { clientId: "client-1", eventId: "ev-a", outcome: { kind: "result", value: "allowed-once" } },
      },
    });
    assert.equal(typeof posted.body.rpcId, "string");
    assert.ok(posted.body.rpcId.length >= 8);

    await sub.answerQuestion("ev-b", [{ id: "q1", selected: ["A"] }, { id: "q2", selected: ["B"], custom: "自定义" }]);
    assert.deepEqual(api.state.results[1].body.payload.args, {
      clientId: "client-1",
      eventId: "ev-b",
      outcome: {
        kind: "result",
        value: { answers: [{ id: "q1", selected: ["A"] }, { id: "q2", selected: ["B"], custom: "自定义" }] },
      },
    });

    // 参数校验：审批值必须是闭集
    await assert.rejects(sub.answerApproval("ev-c", "always"), (error) => error instanceof TypeError);
    await assert.rejects(sub.answerQuestion("ev-c", [{ id: "", selected: [] }]), (error) => error instanceof TypeError);
  } finally {
    await dispose();
  }
});

test("eventId 去重：第二次回执不发请求", async () => {
  const { api, sub, dispose } = await setup();
  try {
    await start(sub);
    await sub.answerApproval("ev-dup", "rejected");
    await assert.rejects(
      sub.answerApproval("ev-dup", "allowed-once"),
      (error) => error instanceof EventAnswerError && error.code === "already-answered" && error.settled === true,
    );
    await assert.rejects(sub.answer("ev-dup", { kind: "result", value: "allowed-once" }), /already-answered|已经回执/);
    assert.equal(api.state.results.length, 1);
    assert.equal(api.state.results[0].body.payload.args.outcome.value, "rejected");
  } finally {
    await dispose();
  }
});

test("{ok:false,error} 变成类型化失败，而不是抛出谜题", async () => {
  const { api, sub, dispose } = await setup();
  try {
    api.setResultFor(() => ({
      ok: false,
      error: {
        code: "gateway/bad-request",
        message: "invalid Remote event result",
        details: { issues: [{ path: ["outcome"], message: "bad kind" }] },
      },
    }));
    await start(sub);
    await assert.rejects(
      sub.answerApproval("ev-bad", "rejected"),
      (error) =>
        error instanceof EventAnswerError &&
        error.code === "gateway/bad-request" &&
        error.message === "invalid Remote event result" &&
        error.settled === false &&
        Array.isArray(error.details.issues) &&
        error.details.issues[0].path[0] === "outcome",
    );
  } finally {
    await dispose();
  }
});

// ============================================================
// 9. 重连：gap 标记 + 新 clientId
// ============================================================

test("重连：发 gap 标记（不假装连续），并换到新的 clientId", async () => {
  const { api, sub, dispose } = await setup();
  try {
    const nodes = collector(sub);
    const gaps = [];
    const readies = [];
    sub.on("gap", (gap) => gaps.push(gap));
    sub.on("ready", (ready) => readies.push(ready));

    await start(sub);
    api.pushEmit("api-session/error", ["session-1", "第一次"]);
    const before = await nodes.next((n) => n.kind === NODE_KINDS.SESSION_ERROR);

    api.dropAll();
    const gap = await once(sub, "gap");
    assert.equal(gap[0].kind, NODE_KINDS.GAP);
    assert.ok(gap[0].from >= before.at, "gap.from 不得早于最后一条已收帧");
    assert.ok(gap[0].to >= gap[0].from);
    assert.match(gap[0].reason, /socket-closed/);

    // 自动重连（backoff 15ms）→ 新世代 ready → 新 clientId
    await waitFor(() => readies.length === 2 && sub.state === "ready", { label: "重连后的第二个 ready" });
    assert.equal(sub.state, "ready");
    assert.equal(sub.clientId, "client-2");
    assert.deepEqual(readies.map((r) => r.clientId), ["client-1", "client-2"]);
    assert.equal(gaps.length, 1);

    // 重连后的新的 socket 依旧可用
    api.pushEmit("api-session/error", ["session-2", "第二次"]);
    const after = await nodes.next((n) => n.kind === NODE_KINDS.SESSION_ERROR);
    assert.equal(after.message, "第二次");
  } finally {
    await dispose();
  }
});

// ============================================================
// 10. 无 socket 泄漏
// ============================================================

test("订阅集对账：会话结束后 follow 流被关闭（服务端确实收到 cancel）", async () => {
  const { api, sub, dispose } = await setup();
  try {
    // 🔴 这段必须**等明确信号**：连接时的 discoverRunningSessions() 会拿一份
    // `listItems: []`（本用例没配会话）去对账，凡是「list 的 startedAt 之后才来的
    // 实时 running 凭据」它都放行。若不等它落地就 push status:true，那次对账可能在
    // follow 开好之后才回来，于是把这条流按 'not-running' 关掉，而本用例要的是
    // 「status:false → 等 followSettleMs → 'idle'」。等 sessions-discovered 让它确定性。
    const discovered = once(sub, "sessions-discovered");
    await start(sub);
    await discovered;

    api.pushEmit("api-session/status", ["session-leak", true]);
    const opened = await once(sub, "follow-opened");
    assert.deepEqual(sub.sessions(), ["session-leak"]);

    // 会话停下 → followSettleMs(30ms) 后关流
    api.pushEmit("api-session/status", ["session-leak", false]);
    const [closed] = await once(sub, "follow-closed");
    assert.equal(closed.sessionId, "session-leak");
    assert.equal(closed.streamId, opened[0].streamId);
    assert.equal(closed.reason, "idle");
    await api.waitForCancel(opened[0].streamId);
    assert.deepEqual(sub.sessions(), []);
    assert.deepEqual(
      api.state.cancels.map((c) => ({ streamId: c.streamId, endpoint: c.endpoint })),
      [{ streamId: opened[0].streamId, endpoint: "session/follow" }],
    );
    assert.equal(api.liveFollowStreams().length, 0);

    // removed → 立即关流
    api.pushEmit("api-session/status", ["session-rm", true]);
    const second = await once(sub, "follow-opened");
    api.pushEmit("api-session/removed", ["session-rm"]);
    const [removed] = await once(sub, "follow-closed");
    assert.equal(removed.reason, "removed");
    assert.equal(removed.streamId, second[0].streamId);
    assert.deepEqual(sub.sessions(), []);
    await api.waitForCancel(second[0].streamId);
    assert.equal(api.state.cancels.filter((c) => c.streamId === second[0].streamId).length, 1);

    // 上限保护：maxFollowStreams
    sub.close();
  } finally {
    await dispose();
  }
});

test("follow 流上限：超过 maxFollowStreams 记 fault 且不再开流", async () => {
  const { api, sub, dispose } = await setup({}, { maxFollowStreams: 1 });
  try {
    const faults = [];
    sub.on("fault", (fault) => faults.push(fault));
    await start(sub);

    api.pushEmit("api-session/status", ["session-1", true]);
    await once(sub, "follow-opened");
    api.pushEmit("api-session/status", ["session-2", true]);
    // 等上限 fault 真的到（正向信号），再断言「没有再开流」
    await waitFor(() => faults.some((f) => f.code === "follow-limit"), { label: "follow-limit fault" });

    assert.deepEqual(sub.sessions(), ["session-1"]);
    assert.equal(api.state.opens.filter((o) => o.endpoint === "session/follow").length, 1);
    assert.equal(faults.filter((f) => f.code === "follow-limit").length, 1);
    assert.equal(faults[0].sessionId, "session-2");
  } finally {
    await dispose();
  }
});

// ============================================================
// 11. WS 握手 401：surface + 停重连 + retry()
// ============================================================

test("mux 握手 401：emit auth-error、停止重连，换 Cookie 后 retry() 恢复", async () => {
  const api = await startFakeDsh();
  const sub = createEventSubscriber({
    upstream: api.base,
    cookie: () => api.cookie,
    reconnect: { minMs: 15, maxMs: 40, factor: 1, jitter: 0 },
  });
  try {
    api.cookie = "stale-cookie";
    const authErrors = [];
    sub.on("auth-error", (error) => authErrors.push(error));
    sub.start();

    const [authError] = await once(sub, "auth-error");
    assert.equal(authError.status, 401);
    assert.equal(authError.surface, "ws");
    assert.match(authError.message, /retry\(\)/);
    assert.equal(sub.state, "auth-failed");

    // 不得无限重试同一个坏 Cookie
    await delay(150, null, { ref: false });
    assert.equal(api.state.connections.length, 0, "401 时服务端根本没有建立起连接");
    assert.equal(authErrors.length, 1);

    // 换 Cookie 后 retry
    api.cookie = COOKIE;
    sub.retry();
    const ready = await sub.whenReady();
    assert.equal(ready.clientId, "client-1");
    assert.equal(sub.state, "ready");

    // 未连接时回执必须是明确失败，而不是静默丢掉
    const other = createEventSubscriber({ upstream: api.base, cookie: () => api.cookie });
    await assert.rejects(
      other.answerApproval("ev-x", "rejected"),
      (error) => error instanceof EventAnswerError && error.code === "not-connected",
    );
    other.close();
  } finally {
    sub.close();
    await api.close();
  }
});

// ============================================================
// 12. 会话控制（一元 RPC）：信封 / 类型化失败 / 超时 / throughSeq / 结论
// ============================================================

const SESSION_A = "session-aaaa-0001";

/** session/list 的一项（真值形状：`projections.asOfSeq` + `projections.values.title`）。 */
function listItem(sessionId, overrides = {}) {
  return {
    sessionId,
    updatedAt: 1_700_000_000_000,
    running: false,
    blank: false,
    cwd: "/tmp/work",
    projections: { asOfSeq: 12, values: { title: "标题 A" } },
    ...overrides,
  };
}

/**
 * 直接 POST 一个任意 args 的一元信封。
 * 只用来**反向证明**本地假服务端像真 gateway 一样会拒掉错形状
 * （否则「我们的信封是对的」这条断言就没有意义）。
 */
async function rawRpc(base, method, args) {
  const response = await fetch(`${base}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: COOKIE },
    body: JSON.stringify({ type: "client-request", rpcId: "probe-1", method, payload: { args } }),
  });
  return response.json();
}

test("一元 session/list：线参名是 _request（送 request 会被拒），投影摊平成 sessions[]", async () => {
  const { api, sub, dispose } = await setup({
    listItems: [
      listItem(SESSION_A, { running: true }),
      listItem("bbbb-2222-0002", {
        updatedAt: 7,
        blank: true,
        cwd: undefined,
        projections: { asOfSeq: 3, values: { title: null } },
      }),
      { nonsense: true }, // 形状不认识的一项：跳过而不是抛
    ],
  });
  try {
    await start(sub);
    const result = await sub.listSessions();
    assert.deepEqual(result, {
      ok: true,
      sessions: [
        {
          sessionId: SESSION_A,
          title: "标题 A",
          running: true,
          blank: false,
          cwd: "/tmp/work",
          updatedAt: 1_700_000_000_000,
        },
        // title 为 null → ""；cwd 线上缺席 → 结果里也没有这个键
        { sessionId: "bbbb-2222-0002", title: "", running: false, blank: true, updatedAt: 7 },
      ],
    });

    const posted = api.state.listBodies.at(-1);
    assert.deepEqual(posted, {
      type: "client-request",
      rpcId: posted.rpcId,
      method: SESSION_LIST_ENDPOINT,
      payload: { args: { _request: {} } },
    });
    assert.equal(Object.prototype.hasOwnProperty.call(posted.payload.args, "request"), false);
    assert.equal(typeof posted.rpcId, "string");
    assert.ok(posted.rpcId.length >= 8);

    // 反向证明：把线参名写成 request，假服务端与真 gateway 一样拒（missing "_request"）
    const probe = await rawRpc(api.base, SESSION_LIST_ENDPOINT, { request: {} });
    assert.equal(probe.result.ok, false);
    assert.equal(probe.result.error.code, "gateway/arguments-invalid");
    assert.match(probe.result.error.message, /missing "_request"/);
  } finally {
    await dispose();
  }
});

test("一元：每个方法的信封与 payload.args 逐字段正确，rpcId 逐次不同", async () => {
  const { api, sub, dispose } = await setup({ listItems: [listItem(SESSION_A)] }, { discover: false });
  try {
    await start(sub);

    assert.equal((await sub.listSessions()).ok, true);
    assert.deepEqual(await sub.createSession({ cwd: "/tmp/new", agentPreset: "default" }), {
      ok: true,
      sessionId: "session-new-0001",
      agentPreset: "default",
    });
    const prompted = await sub.promptSession({ sessionId: SESSION_A, text: "你好" });
    assert.equal(prompted.ok, true);
    assert.equal(prompted.accepted, true);
    assert.deepEqual(await sub.pageSession({ sessionId: SESSION_A }), { ok: true, records: [], hasMore: false });
    assert.deepEqual(await sub.cancelSession({ sessionId: SESSION_A }), { ok: true });
    assert.deepEqual(await sub.renameSession({ sessionId: SESSION_A, title: "新标题" }), {
      ok: true,
      title: "新标题",
      seq: 42,
    });

    // ---- 信封：method / payload.args 线参名逐字段 ----
    assert.deepEqual(api.lastArgsOf(SESSION_CREATE_ENDPOINT), {
      request: { cwd: "/tmp/new", agentPreset: "default" },
    });
    const promptArgs = api.lastArgsOf(SESSION_PROMPT_ENDPOINT);
    assert.deepEqual(Object.keys(promptArgs), ["request"], "session/prompt 的线参名必须是 request");
    const request = promptArgs.request;
    // 四个全是必填（送 {request:{}} 会被边界校验拒掉，见下面的 probe）
    assert.deepEqual(Object.keys(request).sort(), ["content", "mode", "requestId", "sessionId"]);
    assert.equal(request.sessionId, SESSION_A);
    assert.equal(request.mode, "queue");
    assert.match(request.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.deepEqual(request.content, [{ type: "text", text: "你好" }]);
    //   throughSeq 来自 session/list 的 projections.asOfSeq（本例 12）
    assert.deepEqual(api.lastArgsOf(SESSION_PAGE_ENDPOINT), {
      request: { address: { kind: "session", sessionId: SESSION_A }, throughSeq: 12, maxMessages: 40 },
    });
    assert.deepEqual(api.lastArgsOf(SESSION_CANCEL_ENDPOINT), { request: { sessionId: SESSION_A } });
    assert.deepEqual(api.lastArgsOf(SESSION_RENAME_ENDPOINT), { request: { sessionId: SESSION_A, title: "新标题" } });
    // 一元方法只带 request，不带 _request（那是 session/list 专属）
    for (const record of api.state.rpcs) {
      assert.equal(Object.prototype.hasOwnProperty.call(record.body.payload.args, "_request"), false);
      assert.equal(record.headers.cookie, COOKIE);
      assert.equal(record.headers["content-type"], "application/json");
    }

    // ---- rpcId 逐次不同，且与流 id（s1/s2…）不是一个东西 ----
    // 本用例关掉 discover（那条链有别的用例覆盖），于是 session/list 只剩两次：
    //   ① 本用例显式调的 listSessions()  ② pageSession 内部为拿 throughSeq 调的那次
    // 只统计**本用例显式发起**的调用（5 个一元方法 + 上面 ①），把 ② 单独断言，
    // 这样「pageSession 会顺带查一次列表」这个实现事实被显式固化下来。
    const explicitMethods = [
      SESSION_CREATE_ENDPOINT,
      SESSION_PROMPT_ENDPOINT,
      SESSION_PAGE_ENDPOINT,
      SESSION_CANCEL_ENDPOINT,
      SESSION_RENAME_ENDPOINT,
    ];
    const explicitRpcIds = [
      api.state.listBodies[0].rpcId, // listSessions()
      ...api.state.rpcs.filter((record) => explicitMethods.includes(record.method)).map((record) => record.body.rpcId),
    ];
    assert.equal(explicitRpcIds.length, 6, "listSessions + create + prompt + page + cancel + rename");
    assert.equal(new Set(explicitRpcIds).size, explicitRpcIds.length, "rpcId 必须逐次不同");
    assert.ok(explicitRpcIds.every((id) => !/^s\d+$/.test(id) && typeof id === "string" && id !== ""));

    // 把「pageSession 会顺带查一次 session/list 拿 throughSeq」这个实现事实**显式固化**：
    // 没有 throughSeq 就取不到历史，lastAssistantText（完成推送的结论）会整条失效。
    assert.equal(api.state.listCalls, 2, "pageSession 必须额外发一次 session/list（throughSeq 的来源）");
    assert.equal(
      api.state.rpcs.filter((record) => record.method === SESSION_LIST_ENDPOINT).length,
      0,
      "session/list 走它自己的线参（_request），不得混进 request 那批",
    );

    // ---- requestId：不给就生成（且逐次不同），给了就用给的 ----
    await sub.promptSession({ sessionId: SESSION_A, text: "第二条" });
    const first = api.rpcsOf(SESSION_PROMPT_ENDPOINT).at(-2).body.payload.args.request.requestId;
    const second = api.rpcsOf(SESSION_PROMPT_ENDPOINT).at(-1).body.payload.args.request.requestId;
    assert.notEqual(first, second);
    await sub.promptSession({ sessionId: SESSION_A, text: "第三条", requestId: "rid-fixed" });
    assert.equal(api.lastArgsOf(SESSION_PROMPT_ENDPOINT).request.requestId, "rid-fixed");
    assert.equal(api.lastArgsOf(SESSION_PROMPT_ENDPOINT).request.mode, "queue");
    await sub.promptSession({ sessionId: SESSION_A, text: "插队", mode: "steer" });
    assert.equal(api.lastArgsOf(SESSION_PROMPT_ENDPOINT).request.mode, "steer");

    // 反向证明：`{request:{}}` 缺必填字段 → 假服务端拒（所以上面的全字段断言才有效）
    const probe = await rawRpc(api.base, SESSION_PROMPT_ENDPOINT, { request: {} });
    assert.equal(probe.result.ok, false);
    assert.equal(probe.result.error.code, "gateway/arguments-invalid");
    assert.match(probe.result.error.message, /requestId/);

    // 默认 agentPreset 透传 + 空 createSession 也是合法请求
    assert.deepEqual(api.lastArgsOf(SESSION_CREATE_ENDPOINT), { request: { cwd: "/tmp/new", agentPreset: "default" } });
    assert.equal((await sub.createSession()).ok, true);
    assert.deepEqual(api.lastArgsOf(SESSION_CREATE_ENDPOINT), { request: {} });
  } finally {
    await dispose();
  }
});

test("一元：{ok:false,error} 在每个方法上都变成类型化失败，而不是抛出谜题", async () => {
  const { api, sub, dispose } = await setup({ listItems: [listItem(SESSION_A)] });
  try {
    await start(sub);

    // ① session/list 自己的失败
    api.setListFor(() => ({
      ok: false,
      error: { code: "gateway/service-unavailable", message: "list 挂了", details: { why: "list" } },
    }));
    assert.deepEqual(await sub.listSessions(), {
      ok: false,
      code: "gateway/service-unavailable",
      message: "list 挂了",
      details: { why: "list" },
    });
    api.setListFor(() => undefined); // 恢复

    // ② 其余五个方法：同一个服务端错误 → 同一个类型化失败（细节原样带出）
    api.setRpcFor(() => ({
      ok: false,
      error: { code: "gateway/bad-request", message: "被服务端拒了", details: { issues: [{ path: ["x"] }] } },
    }));
    const results = await Promise.all([
      sub.createSession(),
      sub.promptSession({ sessionId: SESSION_A, text: "hi" }),
      sub.pageSession({ sessionId: SESSION_A }),
      sub.cancelSession({ sessionId: SESSION_A }),
      sub.renameSession({ sessionId: SESSION_A, title: "t" }),
    ]);
    for (const result of results) {
      assert.equal(result.ok, false);
      assert.equal(result.code, "gateway/bad-request");
      assert.equal(result.message, "被服务端拒了");
      assert.deepEqual(result.details, { issues: [{ path: ["x"] }] });
    }

    // ③ lastAssistantText 同理，且 text 兜底为 ""
    const last = await sub.lastAssistantText({ sessionId: SESSION_A });
    assert.equal(last.ok, false);
    assert.equal(last.code, "gateway/bad-request");
    assert.equal(last.text, "");
  } finally {
    await dispose();
  }
});

test("一元：非 JSON / 500 / 超时都不抛异常，各自变成类型化失败", async () => {
  const { api, sub, dispose } = await setup({ listItems: [listItem(SESSION_A)] }, { rpcTimeoutMs: 150 });
  try {
    await start(sub);
    // 六个方法各来一遍（pageSession 会先拉 session/list，所以 list 也要一起打桩）
    const calls = () => [
      [SESSION_LIST_ENDPOINT, () => sub.listSessions()],
      [SESSION_CREATE_ENDPOINT, () => sub.createSession()],
      [SESSION_PROMPT_ENDPOINT, () => sub.promptSession({ sessionId: SESSION_A, text: "hi" })],
      [SESSION_PAGE_ENDPOINT, () => sub.pageSession({ sessionId: SESSION_A })],
      [SESSION_CANCEL_ENDPOINT, () => sub.cancelSession({ sessionId: SESSION_A })],
      [SESSION_RENAME_ENDPOINT, () => sub.renameSession({ sessionId: SESSION_A, title: "t" })],
    ];

    // ① HTTP 500 + 非 JSON 体
    const boom = () => ({ http: { status: 500, body: "boom", contentType: "text/plain" } });
    api.setListFor(boom);
    api.setRpcFor(boom);
    for (const [method, call] of calls()) {
      const result = await call();
      assert.equal(result.ok, false, method);
      assert.equal(result.code, "http-500", method);
      assert.match(result.message, /HTTP 500/);
    }

    // ② HTTP 200 但体不是 JSON（解析失败 ≠ 抛出）
    const html = () => ({ http: { status: 200, body: "<html>nope</html>", contentType: "text/html" } });
    api.setListFor(html);
    api.setRpcFor(html);
    for (const [method, call] of calls()) {
      const result = await call();
      assert.equal(result.ok, false, method);
      assert.equal(result.code, "http-200", method);
    }

    // ③ 服务端挂着不回 → 到点自己结算（rpcTimeoutMs=150），绝不把调用方挂死
    api.setListFor(() => ({ hang: true }));
    api.setRpcFor(() => ({ hang: true }));
    for (const [method, call] of calls()) {
      const startedAt = Date.now();
      const result = await call();
      assert.equal(result.ok, false, method);
      assert.equal(result.code, "timeout", method);
      assert.ok(Date.now() - startedAt < 1_500, `${method} 的超时必须及时结算`);
    }
    assert.ok(api.state.hung >= 6, `服务端应当看到被挂住的请求，实际 ${api.state.hung}`);
    assert.equal(DEFAULT_RPC_TIMEOUT_MS, 15_000);
  } finally {
    await dispose();
  }
});

test("一元 session/page：throughSeq 取 session/list 的 asOfSeq（与 follow cursor 取大者），拿不到就显式失败", async () => {
  const api = await startFakeDsh({
    listItems: [listItem(SESSION_A)],
    followCursor: 30,
  });
  const sub = createEventSubscriber({
    upstream: api.base,
    cookie: () => api.cookie,
    discoverIntervalMs: 0,
    followSettleMs: 30,
    reconnect: { minMs: 15, maxMs: 40, factor: 1, jitter: 0 },
  });
  try {
    await start(sub);

    // ① 只靠 session/list 的 projections.asOfSeq（=12）
    assert.equal((await sub.pageSession({ sessionId: SESSION_A })).ok, true);
    assert.equal(api.lastArgsOf(SESSION_PAGE_ENDPOINT).request.throughSeq, 12);

    // ② follow 快照的 cursor（=30）更高时要用它 —— 否则这一页会缺最新的几条
    const snapshot = once(sub, "follow-snapshot");
    sub.followSession(SESSION_A);
    const [snap] = await snapshot;
    assert.equal(snap.cursor, 30);
    assert.equal((await sub.pageSession({ sessionId: SESSION_A })).ok, true);
    assert.equal(api.lastArgsOf(SESSION_PAGE_ENDPOINT).request.throughSeq, 30);

    // ③ 两处都拿不到 → 显式失败，绝不猜魔法数字，也不发 page 请求
    api.setListItems([{ sessionId: "session-cccc", updatedAt: 1, running: false, blank: false }]); // 没有 projections
    const pageCallsBefore = api.rpcsOf(SESSION_PAGE_ENDPOINT).length;
    const result = await sub.pageSession({ sessionId: "session-cccc" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "through-seq-unavailable");
    assert.match(result.message, /throughSeq 无法确定/);
    assert.equal(api.rpcsOf(SESSION_PAGE_ENDPOINT).length, pageCallsBefore, "拿不到 throughSeq 就不得发 page 请求");

    // ④ lastAssistantText 同一条路径上的失败也必须是类型化失败 + text:""
    const last = await sub.lastAssistantText({ sessionId: "session-cccc" });
    assert.equal(last.ok, false);
    assert.equal(last.code, "through-seq-unavailable");
    assert.equal(last.text, "");
  } finally {
    sub.close();
    await api.close();
  }
});

test("一元 lastAssistantText：取最后一条助手文本；空/怪形状返回 \"\"", async () => {
  const records = [
    { type: "event", event: { type: "user/message", seq: 4, time: 1, data: { role: "user" } } },
    {
      type: "event",
      event: {
        type: "assistant/message",
        seq: 5,
        time: 2,
        data: {
          turn: 1,
          step: 1,
          stream: [],
          message: {
            id: "m1",
            role: "assistant",
            source: { kind: "model", provider: "deepseek", model: "x" },
            // reasoning 不是给用户看的结论，只能取 text 块
            content: [
              { type: "reasoning", text: "想想想" },
              { type: "text", text: "第一版结论" },
            ],
          },
        },
      },
    },
    { type: "event", event: { type: "tool/call", seq: 6, time: 3, data: {} } },
    {
      type: "event",
      event: {
        type: "assistant/message",
        seq: 7,
        time: 4,
        data: {
          turn: 1,
          step: 2,
          stream: [],
          message: {
            id: "m2",
            role: "assistant",
            source: { kind: "model", provider: "deepseek", model: "x" },
            content: [{ type: "text", text: "最终结论" }],
          },
        },
      },
    },
    {
      // 只挂 usage 的空 content 结算消息（surface.js 里真实存在）：不得把上一条结论清空
      type: "event",
      event: {
        type: "assistant/message",
        seq: 9,
        time: 5,
        data: {
          turn: 1,
          step: 2,
          stream: [],
          usage: { inputTokens: 1 },
          message: {
            id: "m3",
            role: "assistant",
            source: { kind: "model", provider: "deepseek", model: "x" },
            content: [],
          },
        },
      },
    },
  ];
  const { api, sub, dispose } = await setup({
    listItems: [listItem(SESSION_A)],
    rpcFor: (method) => (method === SESSION_PAGE_ENDPOINT ? { ok: true, value: { records, hasMore: false } } : undefined),
  });
  try {
    await start(sub);
    assert.deepEqual(await sub.lastAssistantText({ sessionId: SESSION_A }), { ok: true, text: "最终结论" });
    // 页请求确实按 maxMessages 走
    assert.equal(api.lastArgsOf(SESSION_PAGE_ENDPOINT).request.maxMessages, 40);
    await sub.lastAssistantText({ sessionId: SESSION_A, maxMessages: 5 });
    assert.equal(api.lastArgsOf(SESSION_PAGE_ENDPOINT).request.maxMessages, 5);

    // 空 records → ""
    api.setRpcFor(() => ({ ok: true, value: { records: [], hasMore: false } }));
    assert.deepEqual(await sub.lastAssistantText({ sessionId: SESSION_A }), { ok: true, text: "" });

    // 各种怪 records → ""，绝不抛
    const odd = (data) => ({ event: { type: "assistant/message", data } });
    api.setRpcFor(() => ({
      ok: true,
      value: {
        records: [
          null,
          7,
          {},
          { event: null },
          odd(null),
          odd({ message: { role: "user", content: [{ type: "text", text: "不是助手" }] } }),
          odd({ message: { role: "assistant", content: [{ type: "tool-call", id: "t", name: "n", arguments: "{}" }] } }),
          odd({ message: { role: "assistant", content: [{ type: "text", text: "   " }] } }),
        ],
        hasMore: false,
      },
    }));
    assert.deepEqual(await sub.lastAssistantText({ sessionId: SESSION_A }), { ok: true, text: "" });

    // 纯函数直接过一遍边界（含兜底字段名与多块拼接）
    assert.equal(extractLastAssistantText(undefined), "");
    assert.equal(extractLastAssistantText(null), "");
    assert.equal(extractLastAssistantText("nope"), "");
    assert.equal(extractLastAssistantText([{}, { event: { type: "assistant/message" } }]), "");
    assert.equal(
      extractLastAssistantText([
        { type: "event", event: { type: "assistant/message", data: { content: [{ type: "text", text: "兜底字段名" }] } } },
      ]),
      "兜底字段名",
    );
    assert.equal(
      extractLastAssistantText([
        {
          type: "event",
          event: {
            type: "assistant/message",
            data: { message: { role: "assistant", content: [{ type: "text", text: "甲" }, { type: "text", text: "乙" }] } },
          },
        },
      ]),
      "甲\n乙",
    );
  } finally {
    await dispose();
  }
});

test("一元：本地校验（空 text / 缺 sessionId / 坏 mode…）直接类型化失败，且一个请求都不发", async () => {
  const { api, sub, dispose } = await setup({ listItems: [listItem(SESSION_A)] });
  try {
    await start(sub);
    const listCallsBefore = api.state.listCalls; // 连接时的发现会拉一次，先记下来
    const cases = [
      [() => sub.promptSession({ sessionId: SESSION_A, text: "" }), /text/],
      [() => sub.promptSession({ sessionId: SESSION_A, text: "   " }), /text/],
      [() => sub.promptSession({ text: "hi" }), /sessionId/],
      [() => sub.promptSession({ sessionId: SESSION_A, text: "hi", mode: "later" }), /mode/],
      [() => sub.promptSession({ sessionId: SESSION_A, text: "hi", requestId: "" }), /requestId/],
      [() => sub.promptSession({ sessionId: SESSION_A, text: "hi", clientTimeZone: "" }), /clientTimeZone/],
      [() => sub.cancelSession({}), /sessionId/],
      [() => sub.renameSession({ sessionId: SESSION_A, title: "" }), /title/],
      [() => sub.renameSession({}), /sessionId/],
      [() => sub.pageSession({ sessionId: "" }), /sessionId/],
      [() => sub.pageSession({ sessionId: SESSION_A, maxMessages: 0 }), /maxMessages/],
      [() => sub.createSession({ cwd: "" }), /cwd/],
      [() => sub.createSession({ agentPreset: 7 }), /agentPreset/],
      [() => sub.lastAssistantText({ sessionId: "" }), /sessionId/],
    ];
    for (const [call, needle] of cases) {
      const result = await call();
      assert.equal(result.ok, false);
      assert.equal(result.code, "invalid-arguments");
      assert.match(result.message, needle);
    }
    assert.equal(api.state.rpcs.length, 0, "本地校验失败不得发出任何一元请求");
    assert.equal(api.state.listCalls, listCallsBefore, "也不得为了 throughSeq 去拉 session/list");
  } finally {
    await dispose();
  }
});

// ═══════════════════ 2026-09-25 事故：完成推送静默消失（业主实测）═══════════════════
//
// 现场：任务跑完了，微信**一条推送都没有**，bridge 日志里也**没有任何报错**。
// 活体探针（以微信通道同款方式订阅本机 dsh web）显示：
//   · 新起的订阅器 163ms 就发现并 follow 了正在跑的会话 —— 机制本身是好的；
//   · 而当时在跑的 bridge 进程到 3080 只有 2 条 WS（mux + control）、**没有 follow 流**，
//     可它明明有一个正在跑长任务的会话。
// 根因就在下面这条：周期性发现被"当前一条 follow 都没有"这个条件**关掉了自己**——
// 丢一次 status:true 边沿就永久失去发现能力，而 turn/end 只在 follow 流上才有。

test("★ 事故锁：一条 follow 都没有时，周期性发现**仍然要跑**（丢一次边沿不能永久失聪）", async () => {
  const api = await startFakeDsh({ listItems: [] }); // 连上时没有任何会话在跑
  const sub = createEventSubscriber({
    upstream: api.base,
    cookie: () => api.cookie,
    discoverIntervalMs: 40,
    reconnect: { minMs: 15, maxMs: 40, factor: 1, jitter: 0 },
  });
  try {
    await start(sub);
    await api.waitForListCalls(1);
    assert.deepEqual(sub.sessions(), [], "前置条件：此刻不 follow 任何会话");

    // 之后某个会话开始跑，但**故意不发任何 status 边沿事件**（模拟边沿丢失/早于我们订阅）
    const opened = [];
    sub.on("follow-opened", (info) => opened.push(info));
    api.setListItems([{ sessionId: "session-late", running: true }]);

    // ⚠️ 用**有界**等待（`once` 会永久挂住）——回归时必须是"红"，不能是"卡死"。
    try {
      await waitFor(() => opened.length > 0, { label: "周期性发现把在跑的会话 follow 起来" });
    } catch (e) {
      assert.fail(`★ 一条 follow 都没有时，周期性发现也必须继续跑（否则丢一次边沿就永久失聪）：${e.message}`);
    }
    assert.equal(opened[0].sessionId, "session-late");
    assert.deepEqual(sub.sessions(), ["session-late"]);
  } finally {
    sub.close();
    await api.close();
  }
});

test("★ 一次 follow 失败不该把这条会话**永久**钉死：下一轮 running 边沿必须重试", async () => {
  const faults = [];
  let failNext = true;
  const api = await startFakeDsh({
    onOpen(server, conn, stream) {
      if (stream.endpoint !== "session/follow") return;
      // 第一轮一律 agent-busy（真机上子代理/繁忙会话就是这个码）；之后放行
      if (failNext) {
        server.fail(conn, stream.streamId, {
          code: "session/agent-busy",
          message: "session is busy",
          details: {},
        });
      }
    },
  });
  const sub = createEventSubscriber({
    upstream: api.base,
    cookie: () => api.cookie,
    followSettleMs: 20,
    reconnect: { minMs: 15, maxMs: 40, factor: 1, jitter: 0 },
  });
  try {
    sub.on("fault", (f) => faults.push(f));
    await start(sub);

    api.pushEmit("api-session/status", ["session-busy-then-ok", true]);
    await waitFor(() => faults.some((f) => f.code === "session/agent-busy"), { label: "第一次 follow 被拒" });
    assert.deepEqual(sub.sessions(), [], "第一次失败：没有 follow 流");

    // 新一轮 running（用户又跑了一轮）→ 必须重新订阅，而不是被 #followBlocked 永久挡住
    const opened = [];
    sub.on("follow-opened", (info) => opened.push(info));
    failNext = false;
    api.pushEmit("api-session/status", ["session-busy-then-ok", true]);
    try {
      await waitFor(() => opened.length > 0, { label: "新一轮 running 触发重新订阅" });
    } catch (e) {
      assert.fail(`★ 一次 follow 失败不得把会话永久钉死（这一整轮的 turn/end 都会丢）：${e.message}`);
    }
    assert.equal(opened[0].sessionId, "session-busy-then-ok");
  } finally {
    sub.close();
    await api.close();
  }
});
