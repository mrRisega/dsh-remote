/**
 * 子进程治理 —— 起 Claude Code、**可靠地**把它和它的工具子进程一起杀掉。
 *
 * ## 为什么单独一个模块（第 1 周实测教训，报告 §4.5）
 *
 * 实测：经 `cli-wrapper.cjs` 启动时，对 **wrapper 的 node 进程**发 SIGTERM，
 * wrapper 退出了，但**原生 claude 被 reparent 到 PPID=1 继续活着**（因为 wrapper 用
 * `spawnSync`，阻塞时不会转发信号）。
 *
 * 对用户的后果很重：手机上点"停止" → 界面显示已停止 → **Agent 仍在跑，还在执行工具**。
 * 所以：
 *   · posix：`detached:true` 建**独立进程组**，停止时 `process.kill(-pid, …)` 杀整组；
 *   · Windows：预留 `taskkill /PID <pid> /T /F` 分支（**未在本轮真机验证**，见 README 的"未验证项"）；
 *   · 先 SIGTERM 留 3s 收尾，再 SIGKILL —— 直接 SIGKILL 会让 mcp/hook 清理逻辑没机会跑。
 *
 * ## 可测性
 *
 * `spawn` / `kill` / `execFile` / 计时器全部可注入：单测用假实现验证"杀组、升级、兜底"三条路径，
 * **不会真的起 claude、也不会真的杀进程**。
 */

import { spawn as nodeSpawn, execFile as nodeExecFile } from "node:child_process";

/** 默认宽容期：SIGTERM 后等多久再 SIGKILL。 */
export const DEFAULT_GRACE_MS = 3000;

/**
 * 启动 Agent 子进程。
 *
 * - **参数数组**，永不拼 shell 字符串（用户输入不经过命令行解析）；
 * - posix 用 `detached:true` 建独立进程组（这样 `kill(-pid)` 才能一次杀干净）；
 * - Windows `windowsHide:true`（不弹黑框），且不 detached（Windows 语义不同，杀树走 taskkill）。
 *
 * @param {{command:string,args?:string[],cwd?:string,env?:object,stdio?:Array}} spec
 * @param {{spawn?:Function,platform?:string}} deps
 */
export function spawnAgentProcess(
  { command, args = [], cwd, env, stdio = ["ignore", "pipe", "pipe"] },
  { spawn = nodeSpawn, platform = process.platform, windowsHide = true } = {}
) {
  if (!command) throw new Error("spawnAgentProcess: 缺少 command");
  const detached = platform !== "win32";
  const child = spawn(command, args, {
    cwd,
    env: env || process.env,
    stdio,
    detached,
    windowsHide,
    shell: false // 绝不经过 shell
  });
  return {
    child,
    pid: child.pid,
    // 有独立进程组时，-pid 才是"整组"；Windows 没有这个概念
    group: detached,
    detached,
    platform
  };
}

/** 进程是否还活着。ESRCH=不存在；EPERM=存在但没权限（也算活着）。 */
export function isProcessAlive(pid, { kill = process.kill } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/** 睡 ms（可注入计时器，单测不需要真等 3 秒）。 */
function sleep(ms, { timers = { setTimeout, clearTimeout } } = {}) {
  return new Promise((resolve) => {
    const t = timers.setTimeout(resolve, ms);
    // 允许 fake timer 返回非 Timer 对象（无所谓，只要能触发）
    void t;
  });
}

/**
 * 杀掉一个 Agent 及其后代。
 *
 * posix：先 `kill(-pid, SIGTERM)`（整组）→ 等 graceMs → 还活着就 `kill(-pid, SIGKILL)`；
 *        组信号 ESRCH（组已没了/不是组长）时退回单进程信号。
 * win32：`taskkill /PID <pid> /T /F`。**本轮未真机验证**，返回 `verified:false`，
 *        上层不得向用户宣称"已确认杀死"，只能按"已请求"显示。
 *
 * @returns {Promise<{ok:boolean, method:string, escalated:boolean, verified:boolean, error?:string}>}
 */
export async function terminateProcessTree(
  pid,
  {
    platform = process.platform,
    kill = process.kill,
    execFile = nodeExecFile,
    timers = { setTimeout, clearTimeout },
    graceMs = DEFAULT_GRACE_MS,
    log = () => {}
  } = {}
) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, method: "noop", escalated: false, verified: false, error: "invalid-pid" };
  }
  const alive = () => isProcessAlive(pid, { kill });

  // ── Windows：taskkill /T /F（杀整棵树）。未验证，只报"已请求"。
  if (platform === "win32") {
    try {
      await new Promise((resolve, reject) => {
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (err) =>
          err ? reject(err) : resolve()
        );
      });
      log({ level: "info", event: "proc.kill", method: "taskkill-tree", pid, verified: false });
      return { ok: true, method: "taskkill-tree", escalated: false, verified: false };
    } catch (err) {
      // 兜底：至少杀掉主进程
      try {
        kill(pid, "SIGKILL");
        log({ level: "warn", event: "proc.kill", method: "taskkill-fallback-kill", pid, error: String(err?.message || err).slice(0, 120) });
        return { ok: true, method: "taskkill-fallback-kill", escalated: false, verified: false, error: "taskkill-failed" };
      } catch (err2) {
        return { ok: false, method: "taskkill", escalated: false, verified: false, error: String(err2?.message || err2).slice(0, 120) };
      }
    }
  }

  // ── posix：优先杀进程组
  let method = "group-term";
  let signalled = false;
  try {
    kill(-pid, "SIGTERM");
    signalled = true;
  } catch (err) {
    if (err?.code === "ESRCH") {
      // 组不存在（未 detached，或已经是孤儿）→ 退回单进程
      try {
        kill(pid, "SIGTERM");
        method = "pid-term";
        signalled = true;
      } catch (err2) {
        if (err2?.code === "ESRCH") {
          log({ level: "info", event: "proc.kill", method: "already-gone", pid });
          return { ok: true, method: "already-gone", escalated: false, verified: true };
        }
        return { ok: false, method: "pid-term", escalated: false, verified: false, error: String(err2?.message || err2).slice(0, 120) };
      }
    } else if (err?.code === "EPERM") {
      return { ok: false, method: "group-term", escalated: false, verified: false, error: "eperm" };
    } else {
      return { ok: false, method: "group-term", escalated: false, verified: false, error: String(err?.message || err).slice(0, 120) };
    }
  }

  log({ level: "info", event: "proc.term", method, pid, signalled });
  await sleep(graceMs, { timers });

  if (!alive()) {
    log({ level: "info", event: "proc.kill", method: `${method}-done`, pid });
    return { ok: true, method, escalated: false, verified: true };
  }

  // 升级 SIGKILL（整组 + 单进程都试；组杀不到时单进程是最后保障）
  try {
    kill(-pid, "SIGKILL");
  } catch {
    /* 组可能已散 */
  }
  try {
    kill(pid, "SIGKILL");
  } catch (err) {
    if (err?.code !== "ESRCH") {
      return { ok: false, method: `${method}-kill9`, escalated: true, verified: false, error: String(err?.message || err).slice(0, 120) };
    }
  }
  log({ level: "warn", event: "proc.kill", method: `${method}-kill9`, pid, escalated: true });
  return { ok: true, method: `${method}-kill9`, escalated: true, verified: true };
}
