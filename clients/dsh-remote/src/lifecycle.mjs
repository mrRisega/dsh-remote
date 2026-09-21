export function childStopped(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

/**
 * 停机：先「请它优雅退出」，超时才强杀。
 *
 * 为什么不能只 `kill()`：Windows 上 Node 的 `child.kill()` / `process.kill()`
 * 是**无条件 TerminateProcess** —— 目标进程的 SIGTERM/SIGINT 处理函数**根本不会执行**。
 * 对 bridge 就意味着退出钩子里的 `notifystop` 永远发不出去，腾讯侧会一直以为微信通道在线
 *（dsh-bridge.mjs 里原先就记着这条已知缺口，只是没人修）。
 *
 * 而 IPC 通道（`child.send` / `process.on("message")`）在 Windows 上是可用的命名管道，
 * 因此是唯一能真正让子进程跑完退出流程的机制。约定：父进程先发 `{type:"shutdown"}`，
 * 等它自己退；超时（或本来就没有通道，例如被其它方式拉起的进程）再退回 `kill()`。
 *
 * @param {import("node:child_process").ChildProcess|null|undefined} child
 * @param {{timeoutMs?:number, intervalMs?:number}} [opts]
 * @returns {Promise<"graceful"|"killed"|"already-stopped"|"none">}
 *   graceful = 子进程自己退的（退出钩子跑完了）；killed = 我强杀的
 */
export async function stopChildGracefully(child, opts = {}) {
  if (!child) return "none";
  if (childStopped(child)) return "already-stopped";
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 3000;
  const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 100;
  try {
    if (child.connected && typeof child.send === "function") {
      child.send({ type: "shutdown" });
    } else {
      child.kill(); // 没有 IPC 通道（或已断开）→ 只能强杀，调用方据此如实报告降级
      return "killed";
    }
  } catch {
    try { child.kill(); } catch { /* 已退出 */ }
    return "killed";
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !childStopped(child)) {
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (childStopped(child)) return "graceful";
  try { child.kill(); } catch { /* 已退出 */ }
  return "killed";
}
