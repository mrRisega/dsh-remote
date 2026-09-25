#!/usr/bin/env node
/**
 * `dsh-remote doctor` —— 一条命令自检「为什么连不上」的契约测试。
 *
 * 【为什么要这个功能】2026-09-25 两条用户反馈（fb_7b4ee6ec9862 / fb_4cc2c9df749c）都是
 * linux + 「连接阶段: starting / bridge 未运行」，而排查时**没有任何一个入口**能一次性看清
 * 「上游端口怎么来的 / 守护在不在 / 事件订阅有没有断 / 有没有通知发不出去」——
 * 只能靠翻日志（而当时日志连时间戳都没有，连"这条错误发生在用户回话之前还是之后"都判断不了）。
 *
 * 本用例锁三件事：
 *   ① 关键结论必须出现在输出里（上游来源与探测结论、进程、待补发、订阅异常、日志尾部）；
 *   ② 日志尾部必须**带时间戳**（否则等于没有）；
 *   ③ `doctor` 必须**真的只读**（连运行时脚本同步都不做，目录不留任何新文件）。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.join(HERE, "..", "..", "..", "dsh-setup.mjs");

/** 造一个"有故事"的配置目录：微信有待补发 + 有订阅异常 + 日志带时间戳。 */
function makeRelayDir() {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-doctor-"));
  const relayDir = path.join(root, ".dsh-remote");
  const home = path.join(root, "home");
  mkdirSync(relayDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(relayDir, ".dsh-config.json"), JSON.stringify({
    api_url: "http://127.0.0.1:1", phone: "13800000000", password: "x", device_id: "dev-test",
  }));
  writeFileSync(path.join(relayDir, ".e2ee-state.json"), JSON.stringify({ enabled: true, reason: "ok" }));
  writeFileSync(path.join(relayDir, ".wechat-state.json"), JSON.stringify({
    bound: true,
    last_push_ok_at: 1790331177460,
    pending_outbox: [{ text: "跑完了", kind: "stopped", at: 1790331000000 }],
    last_fault: { code: "follow-limit", message: "follow 流已达上限 8", at: 1790331100000 },
    current_session_id: "session-abc", current_session_title: "当前任务",
    last_completed_session_id: "session-done", last_completed_session_title: "刚跑完的活",
    last_completed_at: 1790331165248,
    inbound_shape: "msg_id,from_user_id,item_list",
  }));
  writeFileSync(path.join(relayDir, ".dsh-bridge.log"),
    "[2026-09-25T09:29:58.147Z] [bridge] 隧道已连\n[2026-09-25T09:30:01.000Z] [wechat] sendmessage 失败:ret=-2\n");
  writeFileSync(path.join(relayDir, ".dsh-setup-version"), "0.6.15\n");
  return { root, relayDir, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runDoctor(env) {
  const r = spawnSync(process.execPath, [SETUP, "doctor"], {
    encoding: "utf8",
    timeout: 60000,
    env: {
      ...process.env,
      HOME: env.home,
      DSH_RELAY_DIR: env.relayDir,
      DSH_REMOTE_TELEMETRY: "0",
      DSH_RELAY_DEFAULT_API: "http://127.0.0.1:1",
      // 隔离：不碰真实 launchd / systemd
      DSH_RELAY_SKIP_SERVICE: "1",
    },
  });
  return String(r.stdout || "") + String(r.stderr || "");
}

test("★ doctor：上游来源/进程/待补发/订阅异常/日志尾部 必须一条命令全看到", () => {
  const env = makeRelayDir();
  try {
    const out = runDoctor(env);
    // ① 身份
    assert.match(out, /dsh-remote 自检/, "要有明确的标题（用户才知道这是自检报告）");
    assert.match(out, /① 版本/, "版本段缺失");
    // ② 上游：来源与探测结论都要有（"3080 是默认值还是实测"是历史上最容易搞错的一点）
    assert.match(out, /② 上游 dsh web/, "上游段缺失");
    assert.match(out, /最终采用\s*: http:\/\/127\.0\.0\.1:/, "必须给出最终采用的上游地址");
    assert.match(out, /身份校验\s*:/, "必须给出身份校验结论（否则用户不知道那个端口是不是 dsh web）");
    // ③ 进程
    assert.match(out, /③ 进程与自启动/, "进程段缺失");
    assert.match(out, /watcher pid\s*:/, "要看得到守护 pid");
    assert.match(out, /实测进程\s*:/, "要看得到实测进程数（pid 文件会过期）");
    // ④ 通道：待补发与订阅异常是"没收到推送"的两个可判定信号
    assert.match(out, /④ 通道/, "通道段缺失");
    assert.match(out, /待补发通知\s*: ⚠️ 1 条/, "待补发条数必须显示（通知发不出去时唯一的可见信号）");
    assert.match(out, /最近订阅异常\s*: follow-limit/, "订阅异常必须显示（旧实现这类故障完全静默）");
    assert.match(out, /端到端加密\s*: 已启用/, "加密状态要显示");
    assert.match(out, /最近完成\s*: 刚跑完的活/, "最近完成的任务要显示（回话目标就认它）");
    assert.match(out, /msg_id,from_user_id,item_list/, "入站字段形状要显示（用于定位 context_token 缺失）");
    // 手机号必须脱敏
    assert.ok(!out.includes("13800000000"), "诊断报告会外发，手机号必须脱敏");
    // ⑤ 日志尾部要带时间戳（没有时间戳 = 无法对时间，正是那次排查最贵的一课）
    assert.match(out, /⑤ 日志尾部/, "日志段缺失");
    assert.match(out, /\[2026-09-25T09:29:58\.147Z\]/, "日志行必须带时间戳");
    assert.match(out, /sendmessage 失败/, "日志尾部要真的把内容带出来");
  } finally { env.cleanup(); }
});

test("★ doctor 必须**真的只读**：不新建任何文件（否则「自检」本身就是一次写盘）", () => {
  const env = makeRelayDir();
  try {
    const before = readdirSync(env.relayDir).sort();
    runDoctor(env);
    const after = readdirSync(env.relayDir).sort();
    assert.deepEqual(after, before, "doctor 不得新增或删除配置目录里的任何文件");
    assert.ok(!readdirSync(env.home).includes(".dsh-remote"), "也不得在 HOME 下凭空建目录");
  } finally { env.cleanup(); }
});

test("用法里必须有 doctor（否则用户不知道有这个入口）", () => {
  const r = spawnSync(process.execPath, [SETUP, "--help"], { encoding: "utf8", timeout: 30000 });
  const out = String(r.stdout || "") + String(r.stderr || "");
  assert.match(out, /dsh-remote doctor/, "用法里要列出 doctor");
  assert.match(out, /为什么连不上/, "要一句话说清它是干什么的");
});
