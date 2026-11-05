/**
 * Agent Runtime 的入口工厂 —— **默认不启用**，显式 `start()` 才动。
 *
 * 设计约束（来自任务与设计稿）：
 *   · 不碰 DSH 现有链路：本模块只被 bridge 侧显式调用，不 import 任何 dsh 相关模块；
 *   · 默认关：`enabled` 默认 false（也可用 `DSH_AGENT_ENABLED=1` 打开），关闭时**不探测、不占端口、不写文件**；
 *   · 启动失败**不抛错**：返回带 `status` 的对象，让挂载方决定"降级成只通知 / 不渲染入口"；
 *   · 日志只走回调，不直写 stdout；不记录命令原文。
 *
 * ## 挂载方式（给 Lead，详见 agent/README.md）
 *
 * ```js
 * 用法：从 ./agent/index.mjs 导入 createAgentRuntime（不要在这里写 import 语句）
 *
 * ⚠️ 本行以下原本是一句 import 示例，被插件运行时的「闭包扫描」当成了真实依赖
 *    （它按正则扫 `from "./..."`，**连注释也算**），于是要求运行时里存在
 *    `clients/dsh-remote/agent/agent/index.mjs` → 半装自检永远不通过。
 *    规则：agent/ 下的任何文件**不要在注释里写 `from "./xxx"` 形式的句子**。
 * const runtime = createAgentRuntime({ log: (e) => logger.info(JSON.stringify(e)) });
 * const r = await runtime.start();          // 默认 enabled=false → 立即返回 disabled
 * if (r.ok) {
 *   // 给 claude 的启动参数：把 r.launch.args 追加到 CLI 参数
 *   // 手机端审批回调：createAgentRuntime({ decide }) 里接
 * }
 * ```
 *
 * ## 状态与降级
 *
 * | status | 含义 | 挂载方该做什么 |
 * |---|---|---|
 * | `disabled` | 未启用 | 不渲染 Agent 入口 |
 * | `cli-missing` | 找不到 Claude Code | 入口灰显 + "请安装 Claude Code" |
 * | `version-unsupported` / `version-unknown` | 版本不够/认不出 | 入口灰显 + "请升级 Claude Code ≥ X" |
 * | `existing-hooks` | 本机已有审批钩子 | **只通知模式**（不回执），UI 明示"远程审批已让位" |
 * | `bridge-error` | 端口/文件写入失败 | 只通知模式 + 错误原因（含排障码） |
 * | `ready` | 审批通道就绪 | 正常启用 |
 */

import os from "node:os";

import { detectClaude, probeNpmRoot } from "./detect.mjs";
import { createPermissionBridge, DEFAULT_DECISION_TTL_MS, DEFAULT_HOOK_TIMEOUT_SEC } from "./permission-bridge.mjs";
import { resolveMinVersion } from "./version.mjs";

/** 环境变量：总开关（默认关）。 */
export const ENABLED_ENV = "DSH_AGENT_ENABLED";
/** 环境变量：强制只通知模式（企业策略/排障用）。 */
export const NOTIFY_ONLY_ENV = "DSH_AGENT_NOTIFY_ONLY";
/** 环境变量：决策窗口 ms。 */
export const TTL_ENV = "DSH_AGENT_PERMISSION_TTL_MS";
/** 环境变量：写进临时 settings 的 hook timeout（秒）。 */
export const HOOK_TIMEOUT_ENV = "DSH_AGENT_HOOK_TIMEOUT_SEC";
/** 环境变量：桥接端口（0=随机；测试可固定）。 */
export const PORT_ENV = "DSH_AGENT_BRIDGE_PORT";
/** 环境变量：临时 settings 父目录（默认 os.tmpdir()）。 */
export const SETTINGS_DIR_ENV = "DSH_AGENT_SETTINGS_DIR";
/**
 * 环境变量：探测结果缓存时长（ms，默认 5 分钟）。
 *
 * 为什么要缓存：探测要 spawn 一次 `claude --version`。设置面板每次重绘都探，就是
 * "常驻轮询 spawn 子进程" —— 杀软会盯上这种模式（设计稿 §5.3）。缓存把探测压到
 * 用户主动打开面板的频率，同时保留 `probe({force:true})` 给"一键重测"用。
 */
export const PROBE_CACHE_ENV = "DSH_AGENT_PROBE_CACHE_MS";
/** 默认探测缓存 5 分钟（远长于面板重绘，短于用户"我刚装了/刚升级"的耐心）。 */
export const DEFAULT_PROBE_CACHE_MS = 5 * 60_000;

/** 对外状态（UI 直接映射文案）。 */
export const AGENT_STATUS = Object.freeze({
  DISABLED: "disabled",
  CLI_MISSING: "cli-missing",
  VERSION_UNSUPPORTED: "version-unsupported",
  VERSION_UNKNOWN: "version-unknown",
  EXISTING_HOOKS: "existing-hooks",
  BRIDGE_ERROR: "bridge-error",
  READY: "ready"
});

function envFlag(env, name) {
  const v = String(env?.[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function envInt(env, name, def) {
  const raw = String(env?.[name] ?? "").trim();
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}

/**
 * 创建 runtime（**不启动**）。
 *
 * @param {object} opts
 * @param {boolean} [opts.enabled]        默认 false（默认关）
 * @param {(req:object)=>Promise<{decision:"allow"|"deny",message?:string}>} [opts.decide]
 *        审批决策来源。M2 第 2 周不接手机；缺省 = fail-closed（TTL 到期 deny）。
 * @param {(entry:object)=>void} [opts.log] 结构化日志
 * @param {object} [opts.deps]            透传给 detect/bridge 的可注入依赖（测试用）
 * @param {object} [opts.env]             默认 process.env
 */
export function createAgentRuntime({
  enabled = false,
  decide,
  log,
  deps = {},
  env = process.env
} = {}) {
  const logger = typeof log === "function" ? log : () => {};
  const isEnabled = envFlag(env, ENABLED_ENV) || enabled === true;
  const notifyOnlyForced = envFlag(env, NOTIFY_ONLY_ENV);

  let bridge = null;
  let status = Object.freeze({ ok: false, status: AGENT_STATUS.DISABLED, mode: "notify-only", reason: "Agent 功能未启用" });
  let started = false;
  let probeCache = null; // {at, value} —— 避免面板重绘反复 spawn CLI

  /** 停止 / 未启动时的状态（stop 后必须回到它，不能残留上一次的 ready）。 */
  function disabledStatus(reason = "Agent 功能未启用") {
    return Object.freeze({ ok: false, status: AGENT_STATUS.DISABLED, mode: "notify-only", reason });
  }

  /** 探测（不占端口、不写文件）：给"入口灰显 + 原因"用。 */
  function probe() {
    const minInfo = resolveMinVersion(env);
    const detection = detectClaude({
      env,
      cwd: deps.cwd || process.cwd(),
      homeDir: deps.homeDir || os.homedir(),
      execPath: deps.execPath || process.execPath,
      fs: deps.fs,
      spawnSync: deps.spawnSync,
      execFileSync: deps.execFileSync,
      npmRoot: deps.npmRoot,
      platform: deps.platform,
      extraSettingsPaths: deps.extraSettingsPaths,
      probeTimeoutMs: deps.probeTimeoutMs,
      isExecutable: deps.isExecutable,
      realpath: deps.realpath
    });
    return { minInfo, detection };
  }

  return {
    /** 同步读当前状态（挂载方画 UI 用）。 */
    status() {
      return { ...status };
    },

    /**
     * 探测但不启动（"入口灰显"场景；不打端口、不写盘）。
     * 结果默认缓存 5 分钟（`DSH_AGENT_PROBE_CACHE_MS` 可调），避免面板重绘反复 spawn；
     * `probe({ force: true })` 强制重测（"我刚升级了/刚装好"）。
     */
    probe({ force = false } = {}) {
      const clock = typeof deps.now === "function" ? deps.now : Date.now;
      const maxAge = envInt(env, PROBE_CACHE_ENV, DEFAULT_PROBE_CACHE_MS);
      const at = clock();
      if (!force && probeCache && at - probeCache.at >= 0 && at - probeCache.at < maxAge) {
        return probeCache.value;
      }
      const { detection } = probe();
      const value = {
        ok: detection.ok,
        status: detection.status,
        mode: detection.mode,
        reason: detection.reason || "",
        claude: detection.cli || null,
        version: detection.version || null,
        gate: detection.gate || null,
        hooks: detection.hooks || null,
        warnings: detection.warnings || []
      };
      probeCache = { at, value };
      return value;
    },

    /**
     * 启动审批桥接。**永不抛错**：任何失败都转成 `{ok:false,status}`。
     * @returns {Promise<{ok:boolean,status:string,mode:string,reason?:string,
     *   launch?:{args:string[]},permission?:object,stop?:Function}>}
     */
    async start() {
      if (started && bridge) {
        return { ...status, stop: () => this.stop() };
      }

      // ① 默认关：连探测都不做（不占资源、不暴露能力）
      if (!isEnabled) {
        status = Object.freeze({
          ok: false,
          status: AGENT_STATUS.DISABLED,
          mode: "notify-only",
          reason: `Agent 功能未启用（设置 ${ENABLED_ENV}=1 或传入 { enabled: true }）`
        });
        return { ...status };
      }

      // ② 探测：找 CLI / 版本门禁 / 既有钩子
      let probed;
      try {
        probed = probe();
      } catch (err) {
        status = Object.freeze({
          ok: false,
          status: AGENT_STATUS.BRIDGE_ERROR,
          mode: "notify-only",
          reason: `能力探测异常: ${String(err?.message || err).slice(0, 200)}`
        });
        logger({ level: "error", event: "agent.probe-error", message: status.reason });
        return { ...status };
      }
      const { detection, minInfo } = probed;
      const base = {
        claude: detection.cli || null,
        version: detection.version || null,
        minVersion: minInfo.minText,
        hooks: detection.hooks || null
      };

      if (!detection.ok) {
        const mapped =
          detection.status === "existing-hooks"
            ? AGENT_STATUS.EXISTING_HOOKS
            : detection.status === "cli-missing"
              ? AGENT_STATUS.CLI_MISSING
              : detection.status === "version-unsupported"
                ? AGENT_STATUS.VERSION_UNSUPPORTED
                : detection.status === "version-unknown"
                  ? AGENT_STATUS.VERSION_UNKNOWN
                  : AGENT_STATUS.BRIDGE_ERROR;
        status = Object.freeze({
          ok: false,
          status: mapped,
          mode: "notify-only",
          reason: detection.reason || "",
          ...base,
          warnings: detection.warnings || []
        });
        logger({ level: mapped === AGENT_STATUS.BRIDGE_ERROR ? "error" : "warn", event: "agent.unavailable", status: mapped, reason: status.reason });
        // 让位模式（existing-hooks）将来要给"只通知"用：这里把 claude 信息也带出去，挂载方仍可启动 CLI（只是不注入钩子）
        return { ...status };
      }

      // ③ 强制只通知：不注入钩子，明确返回 mode
      if (notifyOnlyForced) {
        status = Object.freeze({
          ok: false,
          status: AGENT_STATUS.EXISTING_HOOKS,
          mode: "notify-only",
          reason: `已由 ${NOTIFY_ONLY_ENV} 强制只通知模式（不注入审批钩子）`,
          ...base
        });
        logger({ level: "info", event: "agent.notify-only", reason: "forced-by-env" });
        return { ...status };
      }

      // ④ 起桥接
      const ttlMs = envInt(env, TTL_ENV, DEFAULT_DECISION_TTL_MS);
      const hookTimeoutSec = envInt(env, HOOK_TIMEOUT_ENV, DEFAULT_HOOK_TIMEOUT_SEC);
      const port = envInt(env, PORT_ENV, 0);
      const settingsDir = String(env?.[SETTINGS_DIR_ENV] ?? "").trim() || undefined;

      try {
        bridge = createPermissionBridge({
          port,
          ttlMs,
          hookTimeoutSec,
          settingsDir,
          decide: decide || ((req) => {
            logger({ level: "warn", event: "agent.no-decider", requestId: req.requestId, toolName: req.toolName });
            // 没有决策来源 = fail-closed：立刻拒绝（不等 90s，用户侧无感但语义正确）
            return { decision: "deny", message: "远程审批通道未接入决策来源，已拒绝" };
          }),
          log: (e) => logger(e),
          timers: deps.timers,
          now: deps.now,
          fs: deps.bridgeFs,
          token: deps.token,
          maxPending: deps.maxPending,
          maxBodyBytes: deps.maxBodyBytes
        });
        const startedBridge = await bridge.start();
        started = true;
        status = Object.freeze({
          ok: true,
          status: AGENT_STATUS.READY,
          mode: "approval",
          reason: "",
          ...base,
          port: startedBridge.port,
          settingsPath: startedBridge.settingsPath,
          launch: {
            // 挂载方把这些参数追加到 claude CLI 调用里即可
            args: ["--permission-mode", "default", "--settings", startedBridge.settingsPath]
          },
          permission: {
            ttlMs,
            hookTimeoutSec,
            pendingCount: startedBridge.pendingCount,
            url: startedBridge.url
          }
        });
        logger({ level: "info", event: "agent.ready", port: startedBridge.port, version: base.version?.text || "" });
        return { ...status, stop: () => this.stop() };
      } catch (err) {
        // 端口被占/临时目录不可写等：**不启用**，退回只通知
        await this.stop().catch(() => {});
        status = Object.freeze({
          ok: false,
          status: AGENT_STATUS.BRIDGE_ERROR,
          mode: "notify-only",
          reason: `审批桥接启动失败: ${String(err?.message || err).slice(0, 200)}`,
          ...base
        });
        logger({ level: "error", event: "agent.bridge-error", message: status.reason });
        return { ...status };
      }
    },

    /** 停止：关端口、删临时 settings。幂等、永远不抛。 */
    async stop() {
      const b = bridge;
      bridge = null;
      started = false;
      status = disabledStatus("Agent 已停止");
      if (!b) return { ok: true };
      try {
        await b.stop();
        return { ok: true };
      } catch (err) {
        logger({ level: "warn", event: "agent.stop-error", message: String(err?.message || err).slice(0, 200) });
        return { ok: false, error: String(err?.message || err).slice(0, 200) };
      }
    }
  };
}

export { probeNpmRoot };
