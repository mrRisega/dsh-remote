#!/usr/bin/env node
/**
 * 上游端口漂移自愈（2026-10-17）。
 *
 * 生产日志实证：
 *   WS 升级被拒: reason=upstream_ws_open_failed status=502 msg=connect ECONNREFUSED 127.0.0.1:19387
 * 桌面端 App 重启会换本地端口，而 bridge 缓存了旧上游 → 镜像页 502/白屏。
 * HTTP 失败路径早就会 refreshUpstream，**WS 失败路径之前漏了** —— 而镜像页常先开 WS。
 *
 * 这个用例守住：两条失败路径都必须触发重新发现（否则又回到"只能重启 bridge"）。
 *
 * 【2026-10-23 契约变更】ws-open 改为「先快速 ack、再连上游」后，上游建立失败的收尾从
 *   `{type:"ws-open", ok:false, code:502}` 变成 `{type:"ws-close", code:1011, retryable:true}`
 *   —— 升级早已完成，再回 ws-open 失败帧没有意义。自愈要求不变：仍必须 refreshUpstream。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../dsh-bridge.mjs", import.meta.url), "utf8");

/** 取某个锚点到下一处 `\n}` 的函数体（够做源代码契约断言，不追求通用解析）。 */
function bodyAfter(anchor, maxLen = 2000) {
  const i = SRC.indexOf(anchor);
  assert.ok(i > 0, `找不到锚点：${anchor}`);
  return SRC.slice(i, i + maxLen);
}

test("★ WS 上游建立失败必须触发上游重新发现（快速应答后走 ws-close 1011）", () => {
  // ws.on("error") 的未建立分支 → 统一交给 failUpstream 收尾
  const errBranch = bodyAfter('ws.on("error"', 900);
  assert.match(errBranch, /!session\.opened/, "只对未建立的会话做失败收尾");
  assert.match(errBranch, /failUpstream\(/, "未建立失败必须走统一收尾（不要各写一份）");
  // failUpstream 内部：重发现 + ws-close（升级已 ack，不能再回 ws-open）
  const failFn = bodyAfter("const failUpstream =", 2200);
  assert.match(failFn, /refreshUpstream\(/, "★ 必须触发重新发现，否则端口变了会一直失败");
  assert.match(failFn, /failAckedWs\(/, "快速应答之后只能 ws-close 收尾");
  const ackFn = bodyAfter("function failAckedWs(", 600);
  assert.match(ackFn, /type: "ws-close"/, "收尾帧必须是 ws-close");
  assert.match(ackFn, /code: 1011/, "ws-close 用 1011(服务端内部错误)");
  // close 路径也要覆盖「还没 open 就断」：不能只靠 error 事件
  const closeBranch = bodyAfter('ws.on("close"', 900);
  assert.match(closeBranch, /failUpstream\(/, "上游没建立就 close 也要触发重发现");
});

test("★ HTTP 失败路径也要有重新发现（既有能力不得回退）", () => {
  const hits = SRC.match(/refreshUpstream\(/g) || [];
  assert.ok(hits.length >= 3, `至少 HTTP/WS/启动 三处调用，实际 ${hits.length}`);
  assert.match(SRC, /上游请求失败/, "HTTP 失败路径的理由文案应在");
});

test("★ 重新发现必须有冷却（失败连成片时不能每个请求都 lsof/pgrep）", () => {
  assert.match(SRC, /UPSTREAM_REFRESH_COOLDOWN_MS/);
  const m = SRC.match(/UPSTREAM_REFRESH_COOLDOWN_MS\s*=\s*([\d_]+)/);
  assert.ok(m, "必须定义冷却常量");
  const ms = Number(m[1].replace(/_/g, ""));
  assert.ok(ms >= 5000 && ms <= 60000, `冷却应在 5–60s（实际 ${ms}ms）`);
});
