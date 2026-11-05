#!/usr/bin/env node
/**
 * Agent Runtime 编排契约测试 —— 验证"默认关 / 门禁 / 让位 / 就绪 / 降级"五种出口。
 *
 * 这是挂载方唯一会直接调的入口，所以每条出口都要有明确、可断言的返回，
 * 不能"抛错让上层猜"：
 *
 *   disabled → 不探测不占端口；cli-missing / version-* → 灰显原因；
 *   existing-hooks → **只通知模式**（让位给本机策略）；bridge-error → 降级原因；
 *   ready → 返回 launch.args + 临时 settings，并真的接上决策回调。
 *
 * 用法: node --test clients/dsh-remote/test/agent-runtime.test.mjs
 */
import assert from "node:assert/strict";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AGENT_STATUS, createAgentRuntime } from "../agent/index.mjs";

/** ENOENT 风格的 fs 假实现。 */
function makeFs(overrides = {}) {
  const enoent = () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  return {
    existsSync: () => false,
    statSync: () => enoent(),
    readFileSync: () => enoent(),
    realpathSync: (p) => p,
    constants: {},
    ...overrides
  };
}

const okVersion = (text) => () => ({ status: 0, stdout: `${text} (Claude Code)\n`, stderr: "" });
const noNpm = () => {
  throw new Error("npm 不存在");
};

test("默认关：enabled 未给 → disabled，且**连探测都不做**（不占端口、不跑 CLI）", async () => {
  let spawned = false;
  const rt = createAgentRuntime({
    env: {},
    deps: {
      spawnSync: () => {
        spawned = true;
        return { status: 0, stdout: "2.1.318", stderr: "" };
      }
    }
  });
  const r = await rt.start();
  assert.equal(r.ok, false);
  assert.equal(r.status, AGENT_STATUS.DISABLED);
  assert.equal(r.mode, "notify-only");
  assert.equal(spawned, false, "关闭状态不该探测（不浪费资源、不暴露能力）");
  assert.equal(rt.status().status, AGENT_STATUS.DISABLED);
});

test("env 打开：DSH_AGENT_ENABLED=1 即启用（挂载方不必传参）", async () => {
  const rt = createAgentRuntime({
    env: { DSH_AGENT_ENABLED: "1", DSH_AGENT_CLAUDE_BIN: "/fake/claude" },
    deps: { fs: makeFs(), spawnSync: okVersion("2.1.318"), execFileSync: noNpm }
  });
  const probed = rt.probe();
  assert.equal(probed.ok, true, "显式 bin + 达标版本应探测通过");
});

test("probe()：只探测不占端口、不写盘（给入口灰显用）", () => {
  const rt = createAgentRuntime({
    env: { DSH_AGENT_CLAUDE_BIN: "/fake/claude" },
    deps: { fs: makeFs(), spawnSync: okVersion("2.1.318"), execFileSync: noNpm }
  });
  const p = rt.probe();
  assert.equal(p.ok, true);
  assert.equal(p.status, "ok");
  assert.equal(p.claude.path, "/fake/claude");
  assert.equal(p.version.text, "2.1.318");
  assert.equal(rt.status().status, AGENT_STATUS.DISABLED, "probe 不应改变运行状态");
});

test("probe() 结果缓存：面板重绘不反复 spawn CLI；force 可强测", () => {
  let spawnCount = 0;
  const rt = createAgentRuntime({
    env: { DSH_AGENT_CLAUDE_BIN: "/fake/claude" },
    deps: {
      fs: makeFs(),
      execFileSync: noNpm,
      spawnSync: () => {
        spawnCount += 1;
        return { status: 0, stdout: "2.1.318 (Claude Code)\n", stderr: "" };
      }
    }
  });
  assert.equal(rt.probe().ok, true);
  assert.equal(rt.probe().ok, true);
  assert.equal(spawnCount, 1, "缓存期内第二次 probe 不应再 spawn（杀软会盯上常驻轮询）");
  assert.equal(rt.probe({ force: true }).ok, true);
  assert.equal(spawnCount, 2, "force 必须绕过缓存");
});

test("版本门禁：2.1.195 → version-unsupported，不启动桥接", async () => {
  const rt = createAgentRuntime({
    enabled: true,
    env: { DSH_AGENT_CLAUDE_BIN: "/fake/claude" },
    deps: { fs: makeFs(), spawnSync: okVersion("2.1.195"), execFileSync: noNpm }
  });
  const r = await rt.start();
  assert.equal(r.ok, false);
  assert.equal(r.status, AGENT_STATUS.VERSION_UNSUPPORTED);
  assert.equal(r.mode, "notify-only");
  assert.match(r.reason, /低于最低支持版本/);
  assert.equal(r.port, undefined, "不可用时不得占端口");
  assert.equal(rt.status().status, AGENT_STATUS.VERSION_UNSUPPORTED);
});

test("找不到 CLI → cli-missing（不抛错）", async () => {
  const rt = createAgentRuntime({
    enabled: true,
    env: { PATH: "" },
    deps: { fs: makeFs(), spawnSync: okVersion("2.1.318"), execFileSync: noNpm, npmRoot: "" }
  });
  const r = await rt.start();
  assert.equal(r.ok, false);
  assert.equal(r.status, AGENT_STATUS.CLI_MISSING);
  assert.match(r.reason, /没有找到 Claude Code/);
});

test("既有审批钩子 → existing-hooks + notify-only（让位，不注入自己的钩子）", async () => {
  const homeDir = "/home/u";
  const fs = makeFs({
    readFileSync: (p) => {
      if (p === path.join(homeDir, ".claude", "settings.json")) {
        return JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: "policy.sh" }] }] } });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
  });
  const rt = createAgentRuntime({
    enabled: true,
    env: { DSH_AGENT_CLAUDE_BIN: "/fake/claude" },
    deps: { fs, spawnSync: okVersion("2.1.318"), execFileSync: noNpm, homeDir }
  });
  const r = await rt.start();
  assert.equal(r.ok, false);
  assert.equal(r.status, AGENT_STATUS.EXISTING_HOOKS);
  assert.equal(r.mode, "notify-only");
  assert.match(r.reason, /让位/);
});

test("DSH_AGENT_NOTIFY_ONLY=1 → 强制只通知（企业策略/排障）", async () => {
  const rt = createAgentRuntime({
    env: {
      DSH_AGENT_ENABLED: "1",
      DSH_AGENT_NOTIFY_ONLY: "1",
      DSH_AGENT_CLAUDE_BIN: "/fake/claude"
    },
    deps: { fs: makeFs(), spawnSync: okVersion("2.1.318"), execFileSync: noNpm }
  });
  const r = await rt.start();
  assert.equal(r.ok, false);
  assert.equal(r.status, AGENT_STATUS.EXISTING_HOOKS);
  assert.equal(r.mode, "notify-only");
  assert.match(r.reason, /强制只通知/);
});

test("就绪 → 返回 launch.args + 临时 settings，并真的接上决策回调", async () => {
  const settingsDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-rt-"));
  const decided = [];
  let settingsPath = "";
  try {
    const rt = createAgentRuntime({
      enabled: true,
      env: {
        DSH_AGENT_CLAUDE_BIN: "/fake/claude",
        DSH_AGENT_SETTINGS_DIR: settingsDir
      },
      decide: async (req) => {
        decided.push(req);
        return { decision: "deny", message: "手机端拒绝" };
      },
      deps: { fs: makeFs(), spawnSync: okVersion("2.1.318"), execFileSync: noNpm }
    });

    const r = await rt.start();
    assert.equal(r.ok, true);
    assert.equal(r.status, AGENT_STATUS.READY);
    assert.equal(r.mode, "approval");
    assert.ok(r.port > 0, "随机端口应已占用");
    assert.equal(r.launch.args[0], "--permission-mode");
    assert.equal(r.launch.args[1], "default");
    assert.equal(r.launch.args[2], "--settings");
    settingsPath = r.launch.args[3];
    assert.equal(settingsPath, r.settingsPath);
    assert.ok(fsSync.existsSync(settingsPath), "临时 settings 必须落盘");

    // 从 settings 里取出带 token 的钩子 URL，模拟 Claude Code 发一次审批
    const saved = JSON.parse(fsSync.readFileSync(settingsPath, "utf8"));
    const hookUrl = saved.hooks.PermissionRequest[0].hooks[0].url;
    const res = await fetch(hookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "s",
        cwd: "/tmp/p",
        permission_mode: "default",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "rm -rf build" }
      })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.hookSpecificOutput.decision.behavior, "deny");
    assert.equal(body.hookSpecificOutput.decision.message, "手机端拒绝");
    assert.equal(decided.length, 1, "决策回调应被调用一次");
    assert.equal(decided[0].toolName, "Bash");
    assert.equal(decided[0].detail, "rm -rf build", "detail 给决策方（手机）看");

    await rt.stop();
    assert.equal(fsSync.existsSync(settingsPath), false, "stop() 必须清理临时 settings");
    assert.equal(rt.status().status, AGENT_STATUS.DISABLED, "停止后回到未启用状态");
    await rt.stop(); // 幂等
  } finally {
    fsSync.rmSync(settingsDir, { recursive: true, force: true });
  }
});

test("没有决策来源 → 立即拒绝（fail-closed，不等 90s）", async () => {
  const settingsDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-rt2-"));
  try {
    const rt = createAgentRuntime({
      enabled: true,
      env: { DSH_AGENT_CLAUDE_BIN: "/fake/claude", DSH_AGENT_SETTINGS_DIR: settingsDir },
      deps: { fs: makeFs(), spawnSync: okVersion("2.1.318"), execFileSync: noNpm }
    });
    const r = await rt.start();
    assert.equal(r.ok, true);
    const saved = JSON.parse(fsSync.readFileSync(r.settingsPath, "utf8"));
    const res = await fetch(saved.hooks.PermissionRequest[0].hooks[0].url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "echo hi" }
      })
    });
    const body = await res.json();
    assert.equal(body.hookSpecificOutput.decision.behavior, "deny");
    assert.match(body.hookSpecificOutput.decision.message, /未接入决策来源/);
    await rt.stop();
  } finally {
    fsSync.rmSync(settingsDir, { recursive: true, force: true });
  }
});

test("桥接启动失败（临时目录不可写）→ bridge-error + notify-only，不抛错", async () => {
  const rt = createAgentRuntime({
    enabled: true,
    env: { DSH_AGENT_CLAUDE_BIN: "/fake/claude" },
    deps: {
      fs: makeFs(),
      spawnSync: okVersion("2.1.318"),
      execFileSync: noNpm,
      bridgeFs: {
        mkdtempSync: () => {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        },
        writeFileSync: () => {},
        rmSync: () => {}
      }
    }
  });
  const r = await rt.start();
  assert.equal(r.ok, false);
  assert.equal(r.status, AGENT_STATUS.BRIDGE_ERROR);
  assert.equal(r.mode, "notify-only");
  assert.match(r.reason, /审批桥接启动失败/);
  assert.equal(rt.status().status, AGENT_STATUS.BRIDGE_ERROR);
});
