#!/usr/bin/env node
/**
 * SSE(`text/event-stream`)流式转发 —— 中继 ↔ bridge 的**跨文件协议契约**。
 *
 * 事故原貌(2026-09-23):DSH 的 `/plugins/events`(client-hmr 事件通道)是一条**永不结束**的流,
 * 而旧协议只有「一个完整响应」帧 —— bridge 只能一直 await 到自己 120s 的上游超时才报错;
 * 手机端于是每次开页面都挂满两分钟,浏览器 EventSource 再立刻重连,
 * **Network 里永远有一条转圈的请求**,页面也始终拿不到任何事件。
 *
 * 修法:加三帧(追加式,旧中继不认识就忽略,不会把页面打挂)——
 *   ← { id, type:"http",       status, headers, streaming:true }  仅头部,无 body
 *   ← { id, type:"http-chunk", seq, body, bodyBase64:true }       0..n 次
 *   ← { id, type:"http-end",   seq }                              流结束
 *   → { id, type:"http-abort" }                                   手机断开 → 掐上游
 *
 * 这里把**两侧**(bridge 发包 / router 收包)同时钉住:只改一侧是最容易漏的回归
 * (改了 bridge 不改 router → chunk 被当垃圾丢掉;改了 router 不改 bridge → 退回整包缓冲)。
 *
 * 行为级端到端覆盖在闭源仓库 relay-router/test/router-e2e.test.mjs(协议级 stub bridge);
 * 本文件守的是"两份实现别漂移"。
 *
 * 用法: node --test test/sse-streaming-contract.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ROUTER = readFileSync(path.join(ROOT, "packages/relay-router/src/index.mjs"), "utf8");
const BRIDGE = readFileSync(path.join(ROOT, "clients/dsh-remote/dsh-bridge.mjs"), "utf8");

test("bridge:按 Accept: text/event-stream 判定流式,且头部帧不带 body", () => {
  assert.match(BRIDGE, /export async function handleFrame/);
  assert.match(BRIDGE, /String\(headerValue\(headers, "accept"\) \|\| ""\)\.includes\("text\/event-stream"\)/,
    "必须以 Accept 头判定(不按路径白名单,免得漏掉别的 SSE 端点)");
  assert.match(BRIDGE, /async function doHttpStream\(send, id, method, path, reqHeaders\)/);
  // 头部帧:streaming:true,且**不塞 body**(字节只能走 http-chunk,否则中继会按整包处理并 end)
  const head = BRIDGE.slice(BRIDGE.indexOf("async function doHttpStream"), BRIDGE.indexOf("send({", BRIDGE.indexOf("async function doHttpStream") + 900));
  assert.match(head, /streaming: true/);
  assert.ok(!/body:/.test(head), "头部帧不得夹带 body");
});

test("bridge:E2EE 路径**不得**偷偷降级成明文流", () => {
  // 流式分支必须落在"无信封标记"的明文分支里;密文 SSE 需要另立协议,不允许顺手明文转发
  const e2eeBranch = BRIDGE.indexOf("hasEnvelopeMarker(headers)");
  const streamCall = BRIDGE.indexOf("doHttpStream(send, id, method, path, headers)");
  assert.ok(e2eeBranch > 0 && streamCall > e2eeBranch, "流式调用必须在 E2EE 分支之后(即仅明文路径)");
  assert.match(BRIDGE, /⚠️ E2EE 路径\*\*不\*\*走这里/, "实现处必须写明这条约束");
});

test("bridge:发送 chunk/end,并处理中继发来的 http-abort", () => {
  assert.match(BRIDGE, /type: "http-chunk", seq: \+\+seq/);
  assert.match(BRIDGE, /type: "http-end", seq/);
  assert.match(BRIDGE, /const streamAborts = new Map\(\)/);
  assert.match(BRIDGE, /if \(type === "http-abort"\)/);
  assert.match(BRIDGE, /c\.abort\(\)/, "收到 abort 必须真的掐掉上游请求");
  // 头部已发出后出错:**只能**以 http-end 收尾,绝不能再回一个 502 的 http 帧
  assert.match(BRIDGE, /头部已经发出去了:这里\*\*绝不能\*\*抛/);
});

test("router:头部帧先 writeHead 且**不删** pendingHttp(否则后续 chunk 无处可去)", () => {
  const start = ROUTER.indexOf("if (frame.streaming === true) {");
  assert.ok(start > 0, "缺少 streaming 头部帧分支");
  // 分支边界就取那条声明"刻意不删"的 return —— 不能靠固定长度切片,
  // 否则会切进后面"整包路径"的 pendingHttp.delete(id) 里,把正确的代码判成违规。
  const endMark = "return; // ⚠️ 刻意**不删** pendingHttp:后续 chunk 还要靠它";
  const end = ROUTER.indexOf(endMark, start);
  assert.ok(end > start, "分支结尾必须显式写明'不删 pendingHttp'");
  const block = ROUTER.slice(start, end + endMark.length);
  assert.match(block, /p\.streaming = true;/);
  assert.match(block, /delete sHeaders\["content-length"\]/, "流式响应不得带 content-length");
  assert.ok(!/pendingHttp\.delete\(id\)/.test(block), "头部帧分支里不得删 pendingHttp");
});

test("router:http-chunk 逐块写、http-end 收尾,且 streaming 标记不匹配就忽略", () => {
  assert.match(ROUTER, /if \(type === "http-chunk"\) \{[\s\S]{0,200}?if \(!p \|\| p\.streaming !== true\) return;/);
  assert.match(ROUTER, /if \(type === "http-end"\) \{[\s\S]{0,200}?if \(!p \|\| p\.streaming !== true\) return;/);
  assert.match(ROUTER, /if \(cbuf\.length === 0\) return;/);
});

test("router:手机断开 → 发 http-abort;bridge 掉线 → 直接 end(不能写新的响应头)", () => {
  assert.match(ROUTER, /res\.on\("close", \(\) => \{[\s\S]{0,600}?if \(p\.streaming === true\) sendToBridge\(devices\.get\(p\.deviceId\), \{ id, type: "http-abort" \}\);/);
  const cleanup = ROUTER.slice(ROUTER.indexOf("function cleanupDevice(dev)"), ROUTER.indexOf("function cleanupDevice(dev)") + 1400);
  assert.match(cleanup, /if \(p\.streaming === true\) \{[\s\S]{0,120}?p\.res\.end\(\)/);
  assert.ok(
    cleanup.indexOf("p.streaming === true") < cleanup.indexOf('p.res.writeHead(502'),
    "必须先判 streaming 再决定能不能写 502 头(响应头早发出去了,再写会抛)"
  );
});

test("★ 能力协商:bridge 只在**中继声明** http-stream 时才用流式帧(否则退回整包缓冲)", () => {
  // 为什么必须有这道闸:browser→中继→bridge 是两段独立升级的链路。
  // 新 bridge 对着**旧中继**发 http-chunk 时,旧中继只认那个"仅头部"的 http 帧 →
  // 当成完整空响应直接 end() → SSE 变成"秒断 + 浏览器狂重连",比原来的 120s 挂起更糟。
  assert.match(BRIDGE, /const routerCaps = new Set\(\)/, "bridge 必须维护中继能力集合");
  assert.match(BRIDGE, /routerCaps\.has\("http-stream"\) && String\(headerValue\(headers, "accept"\)/,
    "流式分支必须同时要求中继声明了 http-stream");
  assert.match(BRIDGE, /for \(const c of Array\.isArray\(frame\.caps\) \? frame\.caps : \[\]\) routerCaps\.add\(String\(c\)\)/,
    "必须从 tunnel-register-ok 的 caps 里学习能力");
  assert.match(BRIDGE, /routerCaps\.clear\(\); \/\/ 换中继\/断线/, "断线要清空能力(重新协商)");

  // 两侧中继都要在注册 ack 里声明同一组能力
  assert.match(ROUTER, /const ROUTER_FRAME_CAPS = \["http-stream"\]/);
  assert.match(ROUTER, /type: "tunnel-register-ok", deviceId, caps: ROUTER_FRAME_CAPS/);

  const SAAS = readFileSync(
    path.resolve(ROOT, "..", "dsh-relay-enterprise", "relay-router", "src", "index.mjs"),
    "utf8"
  );
  assert.match(SAAS, /const ROUTER_FRAME_CAPS = \["http-stream"\]/, "SaaS 中继也要声明(线上跑的是它)");
  assert.match(SAAS, /type: "tunnel-register-ok", deviceId, caps: ROUTER_FRAME_CAPS/);
});
