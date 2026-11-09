/** 测试共用的能力集夹具（与 wechat-runtime 的 WECHAT_CAPABILITY_TABLE 对齐，避免各测试各抄一份）。 */
export function freeCaps() {
  return ["notify", "approve", "status", "stop", "assign.continue"];
}

export function paidCaps() {
  return ["notify", "approve", "status", "stop", "assign", "sessions", "summary", "steer", "attach", "multi"];
}
