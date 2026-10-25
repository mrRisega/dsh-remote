/**
 * 渠道归因码（ref）的**唯一**解析规则。
 *
 * 契约见 dsh-relay-enterprise/docs/channel-referral-contract.md §1/§5：
 *   安装器 `npx @mrrisega/dsh-remote --ref bili`
 *     → 写 ~/.dsh-remote/.dsh-config.json 的 `ref_code`（字符串）
 *     → bridge `POST /api/devices`、插件 `POST /api/install-report` 都带 `ref_code`
 *     → 面板注册 `POST /api/register` 带 `channel_code`。
 * 服务端字段是**可选**的：非法值一律忽略，不报错、不阻断。
 *
 * 这里只做一件事：把任意输入归一化成「3~6 位数字的字符串」或空串。
 * ⚠️ 绝不抛错、绝不因为归因码非法而让安装/上报失败 —— 归因是锦上添花，
 *    主链路（装得上、连得上）永远优先。
 */

/**
 * 合法形态：3~12 位字母或数字（归一化后小写），与 channel_codes.code 契约一致。
 *
 * 业主 2026-10 口径：纯数字「368」太像渠道码，改用小写短词（bili/dsh/xhs8）更隐蔽。
 * 老数字码仍是合法子集；`BILI` / `ＢＩＬＩ` / ` Bili ` 统一归一化为 `bili`（与后端同口径）。
 */
export const REF_CODE_RE = /^[a-z0-9]{3,12}$/;

/**
 * 归一化 ref 码：合法返回字符串（保留前导零），否则返回 ""（调用方据此省略字段）。
 * 兼容配置文件里被手改成数字的情况（`"ref_code": 368`）。
 */
export function normalizeRefCode(raw) {
  let v = "";
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0) return "";
    v = String(raw);
  } else if (typeof raw === "string") {
    v = raw;
  } else {
    return "";
  }
  // NFKC：全角字母/数字 → 半角；再 trim + 小写（与后端 channel.js normalizeCode 一致）
  const normalized = v.normalize("NFKC").trim().toLowerCase();
  return REF_CODE_RE.test(normalized) ? normalized : "";
}

/**
 * 本次安装要写入的 ref_code：命令行 `--ref <code>` 优先，其次环境变量 `DSH_REF`。
 *
 * 「仅当命令行没给时」才用环境变量：命令行给了（即使是非法值）就按命令行来，
 * 非法 → 空串（忽略），**不会**悄悄回退到环境变量 —— 否则用户显式写错时会得到一个
 * 来路不明的归因码，比丢掉更难查。
 */
export function resolveRefCode(argv, env = process.env) {
  const list = Array.isArray(argv) ? argv.map(String) : [];
  const i = list.indexOf("--ref");
  if (i > -1) return normalizeRefCode(list[i + 1]);
  return normalizeRefCode(env && env.DSH_REF);
}

/**
 * 把本次安装解析到的 ref_code 合并进**已从磁盘读出的**配置对象。
 *
 * ⚠️ saveConfig() 是整对象覆盖写：必须先 loadConfig() 拿到旧对象，在这里合并，再整份写回。
 *    否则「升级时没带 --ref」会把上一次写入的 ref_code 清空（归因只在第一次安装时存在，
 *    之后就永久丢了）。本次没带/非法 → 原样保留配置里的旧值。
 */
export function applyRefCodeToConfig(cfg, argv, env = process.env) {
  const next = cfg && typeof cfg === "object" && !Array.isArray(cfg) ? { ...cfg } : {};
  const code = resolveRefCode(argv, env);
  if (code) next.ref_code = code;
  return next;
}
