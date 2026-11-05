/**
 * Claude Code 版本门禁 —— 判断"这台机器上的 CLI 能不能接受远程审批"。
 *
 * ## 为什么需要它（M2 第 1 周实测结论，报告 §2.2）
 *
 * 我们靠 `--settings` 注入一个 `PermissionRequest` 钩子来接管审批。实测：
 *   · Claude Code **2.1.318**：钩子被调用、决策被采纳（debug 日志 `executePermissionRequestHooks`）；
 *   · Claude Code **2.1.195**：`permissions.ask` 规则生效、动作被拒，但 **`PermissionRequest`
 *     钩子一次都没有被咨询**（`--debug hooks` 里零次 `executePermissionRequestHooks`）。
 *
 * 也就是说：旧版本上动作仍会被 Claude Code 自己拒绝，**但我们的手机端永远收不到审批请求** ——
 * 这是**静默失败**，比"明确不可用"危险得多（用户会以为"没消息=没风险"）。
 *
 * 因此策略是：**版本不够就不启动桥接、不渲染"可审批"入口**，并把原因如实返回给上层。
 *
 * ## 阈值为什么默认 2.1.318
 *
 * 实测只确定了 `2.1.195 < 门槛 ≤ 2.1.318`。默认取**已验证可用**的一端（2.1.318）是保守选择：
 * 宁可多挡一些用户（提示它升级），也不能让旧版本静默丢审批。
 * 阈值可用 `DSH_AGENT_MIN_CLAUDE_VERSION` 覆盖（业主/CI 二分版本时用），见 README。
 */

/** 默认最低支持版本：M2 实测唯一确认可用的版本（见报告 §2.3）。 */
export const DEFAULT_MIN_CLAUDE_VERSION = "2.1.318";

/** 版本门禁的环境变量名（可覆盖阈值；用于版本二分与灰度）。 */
export const MIN_VERSION_ENV = "DSH_AGENT_MIN_CLAUDE_VERSION";

/**
 * 从 `claude --version` 的输出里解析版本。
 *
 * 实测输出形如 `2.1.195 (Claude Code)`；也兼容 `claude 2.1.318`、纯 `2.1.318`。
 * 解析失败**不抛错**（返回 null）—— 调用方要把它当成"未知版本"走保守分支，
 * 因为抛错会让 bridge 启动路径多出一个崩溃面。
 *
 * @param {string} text CLI 输出
 * @returns {{major:number,minor:number,patch:number,prerelease:string,raw:string}|null}
 */
export function parseClaudeVersion(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  // 取第一个 "x.y.z"（可能带 -beta.1 之类的预发布后缀）
  const m = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(raw);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] || "",
    raw
  };
}

/**
 * 语义化版本比较：a<b → -1，a==b → 0，a>b → 1。
 *
 * 只比较数字段；同一数字段下**预发布 < 正式版**（2.1.318-beta < 2.1.318）。
 * 非法输入按"最低"处理（返回 -1 对待），由门禁层决定怎么报错。
 *
 * @param {object|null} a
 * @param {object|null} b
 */
export function compareVersions(a, b) {
  const aa = a || { major: 0, minor: 0, patch: 0, prerelease: "" };
  const bb = b || { major: 0, minor: 0, patch: 0, prerelease: "" };
  for (const k of ["major", "minor", "patch"]) {
    if (aa[k] !== bb[k]) return aa[k] < bb[k] ? -1 : 1;
  }
  const pa = String(aa.prerelease || "");
  const pb = String(bb.prerelease || "");
  if (pa === pb) return 0;
  if (!pa) return 1; // 正式版 > 预发布
  if (!pb) return -1;
  return pa < pb ? -1 : 1;
}

/**
 * 通用别名：`parseClaudeVersion` 本质是"从任意 CLI 输出里抓第一个 x.y.z"，
 * Codex（`codex-cli 0.150.1`）等其它 harness 也直接复用，避免各写一套解析。
 */
export const parseVersion = parseClaudeVersion;

/** 把版本对象格式化成 `2.1.318`（预发布保留后缀）。 */
export function formatVersion(v) {
  if (!v) return "";
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease ? `${base}-${v.prerelease}` : base;
}

/**
 * 解析阈值（env 可覆盖）。非法值**回落到默认值**并给出 warning ——
 * 门禁的配置写错时，宁可挡用户（默认保守）也不能放行。
 *
 * @param {Record<string,string|undefined>} env
 * @returns {{min:object,minText:string,source:"env"|"default",warning?:string}}
 */
export function resolveMinVersion(env = {}) {
  const def = parseClaudeVersion(DEFAULT_MIN_CLAUDE_VERSION);
  const raw = String(env?.[MIN_VERSION_ENV] ?? "").trim();
  if (!raw) return { min: def, minText: DEFAULT_MIN_CLAUDE_VERSION, source: "default" };
  const parsed = parseClaudeVersion(raw);
  if (!parsed) {
    return {
      min: def,
      minText: DEFAULT_MIN_CLAUDE_VERSION,
      source: "default",
      warning: `${MIN_VERSION_ENV}=${raw} 不是合法版本号，已回落到默认阈值 ${DEFAULT_MIN_CLAUDE_VERSION}`
    };
  }
  return { min: parsed, minText: formatVersion(parsed), source: "env" };
}

/**
 * 版本门禁判定。
 *
 * status 取值（上层 UI 直接映射文案）：
 *   · `ok`                    —— 版本达标，可启用审批
 *   · `version-unsupported`   —— 版本低于阈值，**不启用**（明确原因）
 *   · `version-unknown`       —— 解析不出/拿不到版本，**不启用**（保守）
 *
 * @param {{version:object|null, min:object, minText?:string, versionText?:string}} input
 */
export function checkVersionGate({ version, min, minText, versionText } = {}) {
  if (!version) {
    return {
      ok: false,
      status: "version-unknown",
      reason: "无法解析 Claude Code 版本（`claude --version` 输出不认识或探测失败）",
      minText: minText || formatVersion(min)
    };
  }
  const cmp = compareVersions(version, min);
  if (cmp < 0) {
    return {
      ok: false,
      status: "version-unsupported",
      reason: `Claude Code ${versionText || formatVersion(version)} 低于最低支持版本 ${minText || formatVersion(min)}，远程审批不可用`,
      required: minText || formatVersion(min),
      actual: versionText || formatVersion(version)
    };
  }
  return {
    ok: true,
    status: "ok",
    required: minText || formatVersion(min),
    actual: versionText || formatVersion(version)
  };
}
