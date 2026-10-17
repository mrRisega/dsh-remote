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
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../dsh-bridge.mjs", import.meta.url), "utf8");

test("★ WS 打开失败必须触发上游重新发现（不只是回 502）", () => {
  // 找到 ws.on("error" ...) 的未建立分支
  const i = SRC.indexOf('ws.on("error"');
  assert.ok(i > 0, "必须有 ws error 处理");
  const branch = SRC.slice(i, i + 1200);
  assert.match(branch, /!session\.opened/, "只对未建立的会话做 502");
  assert.match(branch, /refreshUpstream\(/, "★ 必须触发重新发现，否则端口变了会一直 502");
  assert.match(branch, /code: 502/, "行为不变：本次仍然回 502");
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
