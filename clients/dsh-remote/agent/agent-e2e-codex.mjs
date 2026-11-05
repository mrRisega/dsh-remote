#!/usr/bin/env node
/**
 * **Codex 事件映射真实校准**（M2 第 5 周）——默认跳过，只有显式开启才跑。
 *
 * 跑**恰好 1 次** `codex exec --json`（只读沙箱，不调模型工具、不改文件），把真实 stdout 喂给
 * `createCodexDriver`，断言映射器能吃下真实流（`unknown=0`），并打印实测与官方文档样本的差异线索。
 *
 * ## 用法
 *
 * ```bash
 * export DSH_AGENT_E2E_CODEX=1
 * node clients/dsh-remote/agent/agent-e2e-codex.mjs
 * ```
 *
 * 退出码：`0` 断言通过（**即使 CLI 本身因账号/模型配置退出非 0**——只要流是合法 JSONL 就算校准成功）；
 *         `1` 映射断言失败；`2` 环境不具备（未开启 / 找不到 codex CLI）。
 *
 * ## 为什么"CLI 失败"也可能算校准成功
 *
 * 首次实测（本机 0.150.1）CLI 退出码 1：本机 codex 配置的模型 `gpt-6.1-sol` 与当前 ChatGPT 账号不兼容
 * （400 model_not_found）。但 stdout 仍是 6 行合法 JSONL，且暴露了两个**真实差异**
 * （error 类 item 早于 turn.started、error.message 是嵌套 JSON 字符串）——那正是校准要拿到的东西。
 * 所以脚本把"CLI 退出码"和"事件流可映射"分开判定，并明确提示下一步（先修 codex model 才能校准正常路径）。
 *
 * ## 隐私
 *
 * 不打印账号/token/网关配置；不打印命令原文（prompt 是我们自己写的 "Reply with exactly: OK"）。
 */

import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { createCodexDriver } from "./codex.mjs";
import { detectCodex } from "./codex.mjs";
import { spawnAgentProcess, terminateProcessTree } from "./proc.mjs";

/** 硬上限：本脚本**只允许 1 次**真实调用（任务约束）。 */
const MAX_CLAUDE_CALLS = 1;
const CASE_TIMEOUT_MS = 180_000;
const PROMPT = "Reply with exactly: OK";

const t0 = Date.now();
const out = (m = "") => process.stdout.write(m + "\n");
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function main() {
  out("=== agent-e2e-codex：真实 `codex exec --json` → 事件映射校准（默认跳过） ===");

  if (String(process.env.DSH_AGENT_E2E_CODEX || "") !== "1") {
    out("[codex-e2e][SKIP] 未设置 DSH_AGENT_E2E_CODEX=1 —— 默认跳过（避免 CI 误触 / 误耗额度）。");
    process.exit(0);
  }

  // 1) 探测 CLI（只跑 --version / exec --help，不调模型）
  const bin = String(process.env.DSH_AGENT_CODEX_BIN || "").trim();
  const det = detectCodex({
    env: bin ? { ...process.env, DSH_AGENT_CODEX_BIN: bin } : process.env,
    npmRoot: process.env.DSH_AGENT_NPM_ROOT || undefined
  });
  out(`[codex-e2e] CLI: ${det.cli?.path || "(未找到)"}  version=${det.version?.text || "?"}  caps.json=${det.caps?.jsonOutput}`);
  if (!det.ok) {
    out(`[codex-e2e][SKIP] 能力探测未通过：status=${det.status} ${det.reason || ""}`);
    process.exit(2);
  }

  // 2) 起真实 codex（只读沙箱；1 次）
  const scratch = fsSync.mkdtempSync(path.join(os.tmpdir(), "dsh-codex-e2e-"));
  const rawFile = path.join(scratch, "raw.jsonl");
  let child = null;
  let callCount = 0;
  try {
    if (callCount >= MAX_CLAUDE_CALLS) throw new Error("调用次数超限");
    callCount += 1;

    const args = [
      ...(det.cli.argsPrefix || []),
      "exec",
      "--json",
      "--sandbox",
      "read-only", // 只读：绝不让它改文件
      "--skip-git-repo-check", // 临时目录不是 git 仓库
      PROMPT
    ];
    out(`[codex-e2e] 起 codex（第 ${callCount}/${MAX_CLAUDE_CALLS} 次，只读沙箱）…`);
    const proc = spawnAgentProcess(
      { command: det.cli.command, args, cwd: scratch, env: process.env },
      { platform: process.platform }
    );
    child = proc.child;

    // 3) 真实 stdout → 驱动
    const driver = createCodexDriver({ now: () => Date.now() });
    const events = [];
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const rlClosed = new Promise((res) => rl.once("close", res));
    rl.on("line", (line) => {
      try {
        events.push(...driver.writeLine(line));
      } catch {
        /* 驱动本身不抛，双保险 */
      }
    });
    let stderr = "";
    child.stderr.on("data", (b) => {
      if (stderr.length < 2048) stderr += String(b);
    });

    const exit = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timedOut: true }), CASE_TIMEOUT_MS);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ timedOut: false, code, signal });
      });
    });
    if (exit.timedOut) await terminateProcessTree(child.pid, { platform: process.platform, graceMs: 1500 }).catch(() => {});
    await rlClosed;

    const stats = driver.stats();
    const byType = stats.byType || {};
    const turnReasons = stats.byReason || {};
    const sawNormalPath = Boolean(byType["message.delta"] || byType["tool.call"]);

    out("");
    out("=== 校准结果 ===");
    out(`CLI 退出: ${exit.timedOut ? "TIMEOUT" : `code=${exit.code} signal=${exit.signal || "-"}`}（exit!=0 不一定是失败，见文件头）`);
    out(`行数=${stats.lines}  事件=${stats.events}  unknown=${stats.unknown}  badJson=${stats.badJson}  tooLong=${stats.tooLong}  mapperErrors=${stats.mapperErrors}`);
    out(`事件分布: ${JSON.stringify(byType)}`);
    out(`turn.end reason: ${JSON.stringify(turnReasons)}`);
    out(`覆盖到的路径: ${sawNormalPath ? "正常路径（有 message.delta / tool.call）" : "仅错误路径（无 agent_message / tool_call）"}`);
    if (stats.unknownReasons && Object.keys(stats.unknownReasons).length) {
      out(`未识别原因: ${JSON.stringify(stats.unknownReasons)}`);
    }

    const problems = [];
    if (stats.unknown !== 0) problems.push(`unknown=${stats.unknown}（映射器有未覆盖的真实事件）`);
    if (stats.badJson !== 0) problems.push(`badJson=${stats.badJson}（真实流里有非 JSON 行）`);
    if (stats.mapperErrors !== 0) problems.push(`mapperErrors=${stats.mapperErrors}`);
    if (stats.events === 0) problems.push("一条事件都没映射出来（流是空的？）");
    if (!(turnReasons.completed || turnReasons.error || turnReasons["max-turns"])) {
      problems.push("没有映射出 turn.end/turn.failed 边界");
    }

    if (!sawNormalPath) {
      out("");
      out("[codex-e2e][提示] 本次只走到错误路径（常见原因：本机 codex 的 model 与账号不兼容）。");
      out("            下一步：先修 `~/.codex/config.toml` 的 model（或换 API key），再跑本脚本校准正常路径。");
      if (stderr.trim()) out(`            stderr 尾: ${stderr.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}`);
    }

    if (problems.length) {
      out("");
      out(`[codex-e2e][FAIL] ${problems.join("；")}`);
      process.exitCode = 1;
    } else {
      out("");
      out(`[codex-e2e][OK] 真实流可完全映射（unknown=0）；用时 ${elapsed()}；临时目录 ${scratch}`);
      process.exitCode = 0;
    }

    if (String(process.env.DSH_AGENT_E2E_CODEX_KEEP || "") !== "1") {
      try {
        fsSync.rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    } else {
      out(`[codex-e2e] 保留临时目录（DSH_AGENT_E2E_CODEX_KEEP=1）: ${scratch}`);
    }
  } finally {
    if (child) {
      try {
        await terminateProcessTree(child.pid, { platform: process.platform, graceMs: 1200 });
      } catch {
        /* ignore */
      }
    }
  }
}

main().catch((err) => {
  out(`[codex-e2e][FAIL] 未捕获异常: ${String(err?.message || err)}`);
  process.exit(1);
});
