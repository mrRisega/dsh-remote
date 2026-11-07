import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  startDingtalkAuthCommandWatcher,
  stopDingtalkAuthCommandWatcher,
  handleDingtalkAuthCommand,
  beginDingtalkAuth,
  resumeDingtalkAuth,
  cancelDingtalkAuth,
  authStatus,
  readDingtalkAuthSession,
  DINGTALK_AUTH_FILE,
  DINGTALK_AUTH_CMD_FILE,
  __resetDingtalkAuthForTest,
  __resetDingtalkAuthCmdForTest
} from "../dingtalk-auth.mjs";

/**
 * 工程化端到端：**扫码授权整条生命周期**（全注入 fetch，零真实网络）。
 *
 * 这组用例存在的理由：真机上发生过「钉钉侧显示连接成功、我们没接住」——
 * 根因是授权会话只在内存里，进程一重启就丢。这里把 5 个真实场景钉死：
 *   ① 面板写命令文件 → 桥监听 → begin 落盘（0600）→ 状态 waiting
 *   ② 模拟桥重启（停监听、保留文件）→ resume 续轮询 → 拿到凭据写 im-bots.json → 清理 auth
 *   ③ 同一 at 的重复命令不重复执行
 *   ④ 钉钉明确拒绝 → 中文人话 + 清理
 *   ⑤ 用户取消 → 清理
 * 任何一环退化（例如把会话放回内存、忘记重启后续轮询、泄露 deviceCode/secret）都会红。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileMode = (f) => fs.statSync(f).mode & 0o777;
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dt-auth-e2e-"));
  fs.writeFileSync(path.join(d, "im-bots.json"), "{}\n");
  fs.chmodSync(path.join(d, "im-bots.json"), 0o600);
  return d;
};

function makeFetch(state) {
  return async (url) => {
    const u = String(url);
    const json = (o) => ({ ok: true, status: 200, json: async () => o });
    if (u.endsWith("/init")) return json({ errcode: 0, nonce: "nr_e2e_" + state.seq++, expires_in: 300 });
    if (u.endsWith("/begin")) {
      return json({
        errcode: 0,
        device_code: "DEV_e2e_" + state.seq++,
        interval: 1,
        expires_in: 7200,
        verification_uri_complete: "https://open-dev.dingtalk.com/openapp/registration/openClaw?user_code=E2E-CODE&source=DING_DWS_CLAW"
      });
    }
    if (u.endsWith("/poll")) {
      state.polls += 1;
      if (state.mode === "fail") return json({ errcode: 0, status: "FAIL", fail_reason: "user_cancelled" });
      if (state.mode === "waiting") return json({ errcode: 0, status: "WAITING" });
      if (state.polls < 2) return json({ errcode: 0, status: "WAITING" });
      return json({ errcode: 0, status: "SUCCESS", client_id: "cli_e2e_123456", client_secret: "SECRET_E2E_VALUE" });
    }
    throw new Error("unexpected url " + u);
  };
}

test("钉钉扫码授权端到端：命令→落盘→重启续轮询→成功写配置→失败/取消", async () => {
  const state = { mode: "waiting", polls: 0, seq: 1 };
  const fetchImpl = makeFetch(state);

  // ① 面板写命令文件 → 桥监听 → begin 落盘
  let relayDir = tmpDir();
  fs.writeFileSync(path.join(relayDir, DINGTALK_AUTH_CMD_FILE), JSON.stringify({ action: "begin", at: Date.now() }));
  fs.chmodSync(path.join(relayDir, DINGTALK_AUTH_CMD_FILE), 0o600);
  startDingtalkAuthCommandWatcher({ relayDir, fetchImpl, intervalMs: 50, pollMs: 50 });
  await sleep(500);
  assert.equal(fs.existsSync(path.join(relayDir, DINGTALK_AUTH_CMD_FILE)), false, "命令文件必须被消费删除");
  const session = readDingtalkAuthSession(relayDir);
  assert.ok(session && session.deviceCode && session.url, "auth 文件必须落盘 deviceCode/url");
  assert.equal(fileMode(path.join(relayDir, DINGTALK_AUTH_FILE)), 0o600, "auth 文件必须 0600");
  const st = authStatus({ relayDir });
  assert.equal(st.status, "waiting");
  const stFile = JSON.parse(fs.readFileSync(path.join(relayDir, "im-bot-status.json"), "utf8"));
  assert.equal(stFile.dingtalk.auth.state, "waiting", "状态文件必须透出 dingtalk.auth.state");
  assert.ok(stFile.dingtalk.auth.remainingSec > 0);
  assert.ok(!JSON.stringify(stFile).includes("DEV_e2e_"), "状态文件不得含 deviceCode");

  // ② 模拟桥重启 → resume 续轮询 → 成功写配置
  stopDingtalkAuthCommandWatcher(relayDir);
  assert.ok(fs.existsSync(path.join(relayDir, DINGTALK_AUTH_FILE)), "桥退出后 auth 文件必须保留（否则重启丢会话）");
  state.mode = "success";
  state.polls = 0;
  await resumeDingtalkAuth({ relayDir, fetchImpl, pollMs: 50 });
  await sleep(400);
  const bots = JSON.parse(fs.readFileSync(path.join(relayDir, "im-bots.json"), "utf8"));
  assert.equal(bots.dingtalk.enabled, true);
  assert.equal(bots.dingtalk.credentialSource, "scan");
  assert.equal(bots.dingtalk.robotCode, bots.dingtalk.clientId, "robotCode 缺省应等于 clientId");
  assert.equal(fileMode(path.join(relayDir, "im-bots.json")), 0o600, "im-bots.json 必须 0600");
  assert.equal(fs.existsSync(path.join(relayDir, DINGTALK_AUTH_FILE)), false, "成功后必须删除 auth 文件");
  const st2 = authStatus({ relayDir });
  assert.equal(st2.status, "success");
  assert.ok(!JSON.stringify(st2).includes("SECRET_E2E_VALUE"), "摘要不得泄露 secret");

  // ③ 同一 at 重复命令不重复执行
  const atSame = Date.now();
  fs.writeFileSync(path.join(relayDir, DINGTALK_AUTH_CMD_FILE), JSON.stringify({ action: "begin", at: atSame }));
  await handleDingtalkAuthCommand({ relayDir, fetchImpl });
  fs.writeFileSync(path.join(relayDir, DINGTALK_AUTH_CMD_FILE), JSON.stringify({ action: "begin", at: atSame }));
  const dup = await handleDingtalkAuthCommand({ relayDir, fetchImpl });
  assert.equal(dup.skipped, true, "同一 at 的命令必须跳过");

  // ④ 钉钉明确拒绝 → 中文人话 + 清理
  __resetDingtalkAuthForTest();
  __resetDingtalkAuthCmdForTest();
  relayDir = tmpDir();
  state.mode = "fail";
  state.polls = 0;
  await beginDingtalkAuth({ relayDir, fetchImpl, pollMs: 50 });
  await sleep(300);
  const failed = authStatus({ relayDir });
  assert.equal(failed.status, "failed");
  assert.match(String(failed.message || ""), /[\u4e00-\u9fa5]/, "失败原因必须是中文人话");
  assert.equal(fs.existsSync(path.join(relayDir, DINGTALK_AUTH_FILE)), false, "失败必须清理 auth 文件");

  // ⑤ 取消
  __resetDingtalkAuthForTest();
  relayDir = tmpDir();
  state.mode = "waiting";
  state.polls = 0;
  await beginDingtalkAuth({ relayDir, fetchImpl, pollMs: 50 });
  assert.ok(fs.existsSync(path.join(relayDir, DINGTALK_AUTH_FILE)));
  cancelDingtalkAuth({ relayDir });
  await sleep(100);
  assert.equal(fs.existsSync(path.join(relayDir, DINGTALK_AUTH_FILE)), false, "取消必须清理 auth 文件");
});
