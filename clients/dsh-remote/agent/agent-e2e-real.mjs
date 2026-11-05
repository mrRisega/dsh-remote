#!/usr/bin/env node
/**
 * **真实 Claude Code 端到端联调**（M2 第 3 周 A 项）——默认跳过，只有显式开启才跑。
 *
 * 证明的是这条链：`Claude Code 钩子 → 本机 HTTP（PermissionBridge）→ decide 回调 → 回写 → 命令真跑/不跑`。
 *
 * ## 用法
 *
 * ```bash
 * # 1) 必须显式开启（避免 CI 误触 / 误耗额度）
 * export DSH_AGENT_E2E=1
 *
 * # 2) 指向一个 ≥ 2.1.318 的 CLI（本机旧版 2.1.195 不触发 PermissionRequest 钩子，见第 1 周报告 §2.2）
 * export DSH_AGENT_CLAUDE_BIN=/path/to/@anthropic-ai/claude-code/bin/claude.exe
 *
 * node clients/dsh-remote/agent/agent-e2e-real.mjs
 * ```
 *
 * 退出码：`0` 全部通过；`1` 有断言失败；`2` 环境不具备（未开启 / CLI 版本不够 / 起不来），**未执行断言**。
 *
 * ## 三个用例（各 1 次真实 `claude -p`，总共 3 次；脚本硬上限 6 次）
 *
 * | 用例 | decide 返回 | 断言 |
 * |---|---|---|
 * | allow | `{decision:"allow"}` | 钩子被调用（bridge 日志有 `permission.request`）+ 目标文件真的被写入 |
 * | deny  | `{decision:"deny"}`  | 钩子被调用 + 目标文件**不存在** |
 * | timeout | 首个请求永挂（模拟手机没响应） | TTL 到期 → 桥接日志出现 `outcome:"expired"` → 拒绝 + 目标文件不存在 + 进程正常结束 |
 *
 * ## 为什么必须用项目级 `permissions.ask`
 *
 * 第 1 周报告 §1.2 的方法学：**用户级 `~/.claude/settings.json` 的宽 allow 规则会让钩子根本不触发**，
 * 于是第一轮测试得到"钩子不生效"的假结论。这里在临时项目里写 `permissions.ask` 强制升权，
 * 并把探测用的 `homeDir` 指到空目录（隔离用户级 `PermissionRequest` 钩子 → 避免"让位"模式）。
 *
 * ## 隐私
 *
 * 不打印账号、token、网关配置；不打印 `tool_input`（命令原文）；事件落盘走 `agent/events.mjs`，
 * 该模块本身只把"输入字节数"写进 `tool.call`。
 */

import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { createAgentRuntime } from "./index.mjs";
import { createEventMapper, createJsonlSink } from "./events.mjs";
import { spawnAgentProcess, terminateProcessTree } from "./proc.mjs";

/** 硬上限：本脚本最多允许几次真实 `claude -p`。 */
const MAX_CLAUDE_CALLS = 6;
/** 单个用例的进程上限（真实模型 + 工具执行）。 */
const CASE_TIMEOUT_MS = 180_000;
/** 超时用例：TTL 设短一点，断言"进程在预期时间内结束"（模型耗时之外还要加 TTL）。 */
const TIMEOUT_CASE_TTL_MS = 6_000;
const TIMEOUT_CASE_MAX_MS = 150_000;
/** 目标文件内容标记（allow 用例检查它）。 */
const MARKER = "agent-e2e-ok";

const startedAt = Date.now();
let claudeCalls = 0;
const results = [];

function out(msg = "") {
  // 联调脚本是人工工具，允许直写 stdout（不是 bridge 运行期日志）
  process.stdout.write(msg + "\n");
}

function elapsed() {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

/** 环境不具备 → 退出码 2（区别于"断言失败"）。 */
function envSkip(reason) {
  out(`[E2E][SKIP] ${reason}`);
  out(`[E2E] 用时 ${elapsed()}；未执行任何 claude -p 调用。`);
  process.exit(2);
}

/** 断言失败但要收尾。 */
function fail(reason, extra = "") {
  out(`[E2E][FAIL] ${reason}${extra ? `\n${extra}` : ""}`);
}

/** 等子进程退出（带超时）。 */
function waitExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ timedOut: true, code: null, signal: null });
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ timedOut: false, code, signal });
    });
    child.once("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ timedOut: false, code: null, signal: null, error: err });
    });
  });
}

/**
 * 跑一个用例：起 runtime（= PermissionBridge）→ 真起 claude → 喂事件 → 断言。
 *
 * @returns {Promise<{name:string, ok:boolean, detail:object}>}
 */
async function runCase({
  name,
  scratch,
  binPath,
  decideFactory,
  ttlMs,
  expectFile,
  expectExpired
}) {
  const caseDir = path.join(scratch, `case-${name}`);
  const projectDir = path.join(caseDir, "project");
  const homeDir = path.join(caseDir, "home"); // 空目录：隔离用户级钩子，避免"让位"模式
  const settingsDir = path.join(caseDir, "bridge-settings");
  const targetFile = path.join(projectDir, `out-${name}.txt`);
  fsSync.mkdirSync(path.join(projectDir, ".claude"), { recursive: true });
  fsSync.mkdirSync(homeDir, { recursive: true });
  fsSync.mkdirSync(settingsDir, { recursive: true });

  // 关键：项目级 ask 强制升权（用户级 allow 规则否则会把审批吞掉，见第 1 周报告 §1.2）
  fsSync.writeFileSync(
    path.join(projectDir, ".claude", "settings.json"),
    JSON.stringify({ permissions: { ask: ["Bash", "Write", "Edit"] } }, null, 2) + "\n"
  );

  const logs = [];
  const decideCalls = [];
  const decide = decideFactory({ decideCalls });

  const runtime = createAgentRuntime({
    enabled: true,
    decide,
    log: (e) => logs.push(e),
    env: {
      ...process.env,
      DSH_AGENT_ENABLED: "1",
      DSH_AGENT_CLAUDE_BIN: binPath,
      DSH_AGENT_SETTINGS_DIR: settingsDir,
      DSH_AGENT_PERMISSION_TTL_MS: String(ttlMs),
      DSH_AGENT_HOOK_TIMEOUT_SEC: "120"
    },
    deps: { cwd: projectDir, homeDir }
  });

  const detail = {
    runtimeStatus: "",
    bridgePort: 0,
    permissionRequests: 0,
    decideCalls: 0,
    decisions: [],
    expiredLogged: false,
    fileCreated: false,
    fileContentOk: false,
    claudeExit: "",
    events: {},
    eventFile: "",
    elapsedMs: 0
  };

  let child = null;
  let bridgeStopped = false;
  const caseStart = Date.now();
  try {
    const r = await runtime.start();
    detail.runtimeStatus = r.status;
    if (!r.ok) {
      return { name, ok: false, detail: { ...detail, reason: `runtime 不可用: ${r.status} ${r.reason || ""}` } };
    }
    detail.bridgePort = r.port;

    // 真实调用计数（硬上限 6）
    if (claudeCalls >= MAX_CLAUDE_CALLS) {
      return { name, ok: false, detail: { ...detail, reason: `已达 claude -p 调用上限 ${MAX_CLAUDE_CALLS}，停止` } };
    }
    claudeCalls += 1;

    const prompt = [
      "用 Bash 工具执行下面这一条命令，只执行这一条，不要询问、不要做别的事，执行后简要报告结果：",
      `printf '${MARKER}' > ${targetFile}`
    ].join("\n");

    const spawnArgs = [
      ...(r.claude.argsPrefix || []),
      ...r.launch.args, // ["--permission-mode","default","--settings",<tmp settings>]
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose"
    ];

    out(`[E2E] ${name}: 起 claude（binKind=${r.claude.kind}, port=${r.port}, ttl=${ttlMs}ms）`);
    const proc = spawnAgentProcess(
      { command: r.claude.command, args: spawnArgs, cwd: projectDir, env: process.env },
      { platform: process.platform }
    );
    child = proc.child;

    // 事件映射（B 项在真实输出上的验证）：落 jsonl 便于事后回看
    const eventFile = path.join(caseDir, `events-${name}.jsonl`);
    detail.eventFile = eventFile;
    const sink = createJsonlSink({ filePath: eventFile });
    const mapper = createEventMapper({ sink });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    // 先挂 close 的 promise：若在 waitExit 之后才挂，close 可能已经发过 → 永远等不到
    const rlClosed = new Promise((res) => rl.once("close", res));
    const dumpRaw = String(process.env.DSH_AGENT_E2E_DUMP_RAW || "") === "1";
    const rawFile = path.join(caseDir, `raw-${name}.jsonl`);
    rl.on("line", (line) => {
      if (dumpRaw) {
        try {
          fsSync.appendFileSync(rawFile, line + "\n", { encoding: "utf8" });
        } catch {
          /* 诊断用，失败无所谓 */
        }
      }
      try {
        mapper.writeLine(line);
      } catch {
        /* 映射器本身不抛，这里只是双保险 */
      }
    });

    let stderr = "";
    child.stderr.on("data", (buf) => {
      if (stderr.length < 4096) stderr += String(buf);
    });

    const timeoutMs = expectExpired ? TIMEOUT_CASE_MAX_MS : CASE_TIMEOUT_MS;
    const exit = await waitExit(child, timeoutMs);
    detail.claudeExit = exit.timedOut ? "TIMEOUT" : `code=${exit.code} signal=${exit.signal || "-"}`;
    if (exit.timedOut) {
      await terminateProcessTree(child.pid, { platform: process.platform, graceMs: 1500 }).catch(() => {});
    }
    await rlClosed;

    // stop() 会结算可能还挂着的审批（一律 deny）——超时用例必须靠它/桥接 TTL
    await runtime.stop();
    bridgeStopped = true;

    // ── 汇总 ────────────────────────────────────────────────────────────────
    const stats = mapper.stats();
    detail.events = stats.byType;
    detail.eventReasons = stats.byReason;
    detail.eventStats = {
      lines: stats.lines,
      unknown: stats.unknown,
      badJson: stats.badJson,
      tooLong: stats.tooLong,
      unknownReasons: stats.unknownReasons || {}
    };
    detail.permissionRequests = logs.filter((e) => e && e.event === "permission.request").length;
    detail.decideCalls = decideCalls.length;
    detail.decisions = decideCalls.map((d) => d.decision);
    detail.expiredLogged = logs.some((e) => e && e.event === "permission.decision" && e.outcome === "expired");
    detail.fileCreated = fsSync.existsSync(targetFile);
    detail.fileContentOk = detail.fileCreated && fsSync.readFileSync(targetFile, "utf8").includes(MARKER);
    detail.elapsedMs = Date.now() - caseStart;

    // ── 断言 ────────────────────────────────────────────────────────────────
    const problems = [];
    if (detail.permissionRequests < 1) problems.push("钩子没有被调用（permission.request 日志为 0）");
    if (detail.decideCalls < 1) problems.push("decide 回调没有被调用");
    if (detail.events["turn.end"] !== 1) problems.push(`turn.end 事件数异常: ${detail.events["turn.end"] || 0}`);
    if (exit.timedOut) problems.push(`claude 进程超时（>${timeoutMs}ms）未结束`);

    if (expectFile) {
      if (!detail.fileCreated) problems.push("目标文件未创建（allow 未生效？）");
      else if (!detail.fileContentOk) problems.push(`目标文件内容不含标记 ${MARKER}`);
    } else if (detail.fileCreated) {
      problems.push("目标文件被创建了（deny/超时未生效！）");
    }
    if (expectExpired && !detail.expiredLogged) problems.push("没有观察到 TTL 到期（outcome:expired）");
    if (expectExpired && detail.elapsedMs > TIMEOUT_CASE_MAX_MS) {
      problems.push(`超时用例耗时 ${detail.elapsedMs}ms，超过预期上限 ${TIMEOUT_CASE_MAX_MS}ms`);
    }

    if (problems.length) {
      const tail = stderr.trim().slice(-600);
      return { name, ok: false, detail: { ...detail, reason: problems.join("；"), stderrTail: tail } };
    }
    return { name, ok: true, detail };
  } catch (err) {
    return { name, ok: false, detail: { ...detail, reason: `异常: ${String(err?.message || err).slice(0, 300)}` } };
  } finally {
    if (!bridgeStopped) {
      try {
        await runtime.stop();
      } catch {
        /* ignore */
      }
    }
    if (child) {
      try {
        await terminateProcessTree(child.pid, { platform: process.platform, graceMs: 1200 });
      } catch {
        /* ignore */
      }
    }
  }
}

async function main() {
  out("=== agent-e2e-real：真实 Claude Code 审批闭环联调 ===");

  if (String(process.env.DSH_AGENT_E2E || "") !== "1") {
    out("[E2E][SKIP] 未设置 DSH_AGENT_E2E=1 —— 默认跳过（避免 CI 误触 / 误耗额度）。");
    out("          开启方式：DSH_AGENT_E2E=1 DSH_AGENT_CLAUDE_BIN=/path/to/claude node clients/dsh-remote/agent/agent-e2e-real.mjs");
    process.exit(0);
  }

  const binPath = String(process.env.DSH_AGENT_CLAUDE_BIN || "").trim();
  if (!binPath) {
    envSkip("未设置 DSH_AGENT_CLAUDE_BIN。本机全局 CLI 若低于 2.1.318 不会触发审批钩子（第 1 周报告 §2.2），请显式指向一个 ≥2.1.318 的 CLI。");
  }

  // 先探测一次（版本门禁 / 既有钩子 / CLI 可用性），拿不到明确原因就跳过，不硬跑
  const probeRt = createAgentRuntime({
    enabled: true,
    env: { ...process.env, DSH_AGENT_ENABLED: "1", DSH_AGENT_CLAUDE_BIN: binPath },
    deps: { cwd: process.cwd(), homeDir: os.tmpdir() }
  });
  const probe = probeRt.probe({ force: true });
  out(`[E2E] CLI: ${probe.claude?.path || "(未找到)"}  version=${probe.version?.text || "?"}  min=${probe.gate?.required || "?"}`);
  if (!probe.ok) {
    envSkip(`能力探测未通过：status=${probe.status}；${probe.reason || ""}`);
  }

  const scratch = fsSync.mkdtempSync(path.join(os.tmpdir(), "dsh-agent-e2e-"));
  out(`[E2E] 临时工作区: ${scratch}`);

  const requested = String(process.env.DSH_AGENT_E2E_CASES || "allow,deny,timeout")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  try {
    if (requested.includes("allow")) {
      // ① allow：钩子被调用 + allow → 命令真的执行
      results.push(await runCase({
      name: "allow",
      scratch,
      binPath,
      ttlMs: 90_000,
      expectFile: true,
      expectExpired: false,
      decideFactory: ({ decideCalls }) => async (req) => {
        decideCalls.push({ decision: "allow", toolName: req.toolName });
        return { decision: "allow" };
      }
    }));

    }
    if (requested.includes("deny")) {
      // ② deny：钩子被调用 + deny → 命令不执行
      results.push(await runCase({
      name: "deny",
      scratch,
      binPath,
      ttlMs: 90_000,
      expectFile: false,
      expectExpired: false,
      decideFactory: ({ decideCalls }) => async (req) => {
        decideCalls.push({ decision: "deny", toolName: req.toolName });
        return { decision: "deny", message: "agent-e2e：已按拒绝处理" };
      }
    }));

    }
    if (requested.includes("timeout")) {
      // ③ timeout：决定一直不到 → TTL 到期自动 deny（模拟手机没响应）
      results.push(await runCase({
      name: "timeout",
      scratch,
      binPath,
      ttlMs: TIMEOUT_CASE_TTL_MS,
      expectFile: false,
      expectExpired: true,
      decideFactory: ({ decideCalls }) => (req) => {
        decideCalls.push({ decision: "hang", toolName: req.toolName });
        if (decideCalls.length === 1) return new Promise(() => {}); // 第一条：永挂 → 交给桥接 TTL
        return { decision: "deny", message: "agent-e2e：重试不再等待，已拒绝" };
      }
      }));
    }
  } finally {
    if (String(process.env.DSH_AGENT_E2E_KEEP || "") === "1") {
      out(`[E2E] 保留临时工作区（DSH_AGENT_E2E_KEEP=1）: ${scratch}`);
    } else {
      try {
        fsSync.rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  // ── 摘要（脱敏：只有元数据） ─────────────────────────────────────────────
  out("");
  out("=== 结果摘要 ===");
  for (const r of results) {
    const d = r.detail || {};
    const ev = d.events || {};
    out(
      `${r.ok ? "✅" : "❌"} ${r.name.padEnd(7)} ` +
      `permissionRequests=${d.permissionRequests ?? 0} decideCalls=${d.decideCalls ?? 0} ` +
      `decisions=[${(d.decisions || []).join(",")}] expired=${d.expiredLogged ? "yes" : "no"} ` +
      `file=${d.fileCreated ? "created" : "absent"} exit=${d.claudeExit || "-"} ` +
      `events={tool.call:${ev["tool.call"] || 0},tool.result:${ev["tool.result"] || 0},turn.end:${ev["turn.end"] || 0}} ` +
      `elapsed=${((d.elapsedMs || 0) / 1000).toFixed(1)}s`
    );
    if (d.eventStats && (d.eventStats.unknown || d.eventStats.badJson || d.eventStats.tooLong)) {
      out(`         未识别行: unknown=${d.eventStats.unknown} badJson=${d.eventStats.badJson} tooLong=${d.eventStats.tooLong}` +
        (Object.keys(d.eventStats.unknownReasons || {}).length
          ? ` 原因=${JSON.stringify(d.eventStats.unknownReasons)}`
          : ""));
    }
    if (!r.ok) out(`         原因: ${d.reason}${d.stderrTail ? `\n         stderr尾: ${d.stderrTail.split("\n").slice(-4).join(" | ")}` : ""}`);
  }

  const passed = results.filter((r) => r.ok).length;
  out("");
  out(`[E2E] ${passed}/${results.length} 通过；真实 claude -p 调用 ${claudeCalls} 次（上限 ${MAX_CLAUDE_CALLS}）；总用时 ${elapsed()}`);
  process.exit(passed === results.length && results.length > 0 ? 0 : 1);
}

main().catch((err) => {
  out(`[E2E][FAIL] 未捕获异常: ${String(err?.message || err)}`);
  process.exit(1);
});
