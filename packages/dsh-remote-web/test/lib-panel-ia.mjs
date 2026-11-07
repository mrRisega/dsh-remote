/**
 * 面板 IA（2026-11-07 重做）在**测试脚手架**里的公共导航工具。
 *
 * 背景：重做后主面板 = 状态头 + 入口网格 + 弹层。旧用例大量直接断言「卡片里的内容」，
 * 而这些内容现在都在弹层里（打开后才渲染）。与其在每个用例里复制一段"点开弹层"的代码，
 * 不如把"按真实用户路径打开弹层"收敛成这里的小工具：
 *   · openEntry(tree, kind)    点入口卡上的按钮（mobile / channel / devices / account）；
 *   · clickChannelRow(tree, t) 在通道弹层里点某一行（如「微信机器人（扫码绑定）」）；
 *   · textOf(node)             节点子树里的全部文本（拼接）。
 * 这些函数只读 fake tree（{type,props,children}），不依赖具体测试文件的 react stub。
 */

/** 先序遍历。 */
export function walk(node, visit) {
  if (node == null) return;
  if (Array.isArray(node)) { for (const item of node) walk(item, visit); return; }
  if (typeof node !== "object") return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

export function find(tree, predicate) {
  let match;
  walk(tree, (node) => { if (!match && predicate(node)) match = node; });
  return match;
}

export function findAll(tree, predicate) {
  const out = [];
  walk(tree, (node) => { if (predicate(node)) out.push(node); });
  return out;
}

/** 节点子树里的全部文本（拼接；用于"卡片标题/按钮文案"这类断言）。 */
export function textOf(node) {
  let out = "";
  walk(node, (n) => {
    for (const c of n.children || []) if (typeof c === "string") out += c;
  });
  return out;
}

/** 卡的标题文本（入口网格里的那张卡）。 */
function cardTitle(cardEl) {
  const t = find(cardEl, (n) => String(n.props && n.props.className || "").split(/\s+/).includes("dru-ia-card-title"));
  return t ? textOf(t) : "";
}

/** 入口卡的按钮（.dru-ia-card-actions 里的第一个 button）。 */
function cardButton(cardEl) {
  return find(cardEl, (n) => n.type === "button");
}

const ENTRY_TITLE = {
  mobile: "手机访问",
  channel: "通知与消息通道",
  devices: "已授权设备",
  account: "账号",
};

/**
 * 按真实用户路径点开某个入口弹层。
 * @returns {boolean} 是否点到了（false = 结构没找到，用例应显式失败而不是静默通过）
 */
export function openEntry(tree, kind) {
  const title = ENTRY_TITLE[kind];
  if (!title) return false;
  const card = find(tree, (n) => {
    const cls = String((n.props && n.props.className) || "");
    if (!cls.split(/\s+/).includes("dru-ia-card")) return false;
    return cardTitle(n) === title;
  });
  if (!card) return false;
  const btn = cardButton(card);
  if (!btn || typeof btn.props?.onClick !== "function") return false;
  btn.props.onClick();
  return true;
}

/** 在通道弹层的平台列表里点某一行（按标题匹配，如「微信机器人（扫码绑定）」）。 */
export function clickChannelRow(tree, titleIncludes) {
  const row = find(tree, (n) => {
    const cls = String((n.props && n.props.className) || "");
    if (!cls.split(/\s+/).includes("dru-ia-row")) return false;
    const t = find(n, (x) => String((x.props && x.props.className) || "").split(/\s+/).includes("dru-ia-row-title"));
    return !!t && textOf(t).includes(titleIncludes);
  });
  if (!row || typeof row.props?.onClick !== "function") return false;
  row.props.onClick();
  return true;
}

/** 弹层是否在树里（role=dialog + .dru-ia-dialog）。 */
export function findDialog(tree) {
  return find(tree, (n) => String((n.props && n.props.className) || "").split(/\s+/).includes("dru-ia-dialog"));
}

export function dialogIsOpen(tree) { return !!findDialog(tree); }
