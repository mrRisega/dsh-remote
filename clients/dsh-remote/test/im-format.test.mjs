/**
 * im-format — 通道感知消息格式化单测（2026-11-08 业主反馈「企微/飞书推回来的表格都是乱的」）。
 *
 * 只测**纯函数**（不连网、不起进程）：表格→可读列表、标题/引用/分隔线/任务列表/嵌套列表、
 * 代码块原样保留、UTF-8 字节截断（4096，优先段落边界、绝不切坏中文）、各通道分支。
 *
 * 接入测（wecom-bot 发出的报文里没有裸表格）在 wecom-bot.test.mjs 里。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEL_CAPS,
  SUMMARY_MAX_CHARS,
  TRUNCATED_NOTE,
  buildTurnNotification,
  extractTurnSummary,
  convertMarkdownTable,
  displayWidth,
  formatForChannel,
  normalizeChannelName,
  splitTableRow,
  truncateUtf8Safe,
  utf8Bytes
} from "../im-format.mjs";

const fmt = (text, opts = {}) => formatForChannel("wecom", { text, ...opts });

/** 展示用：断言"没有裸表格"（分隔行 / 行首竖线表格）。 */
const hasRawTable = (s) => /\|\s*-{2,}/.test(s) || /^\s*\|.*\|\s*$/m.test(s);

// ─────────────────────────── 通道能力表 ───────────────────────────

test("CHANNEL_CAPS：企微/钉钉 markdown 无表格、飞书无 markdown、微信特殊格式、plain 兜底", () => {
  assert.deepEqual(CHANNEL_CAPS.wecom, { markdown: true, tables: false, card: true });
  assert.deepEqual(CHANNEL_CAPS.dingtalk, { markdown: true, tables: false, card: true });
  assert.deepEqual(CHANNEL_CAPS.feishu, { markdown: false, tables: false, card: true });
  assert.deepEqual(CHANNEL_CAPS.wechat, { markdown: false, special: true });
  assert.deepEqual(CHANNEL_CAPS.plain, { markdown: false });
  // 通道别名与未知通道
  assert.equal(normalizeChannelName("wxwork"), "wecom");
  assert.equal(normalizeChannelName("Lark"), "feishu");
  assert.equal(normalizeChannelName("dingding"), "dingtalk");
  assert.equal(normalizeChannelName("weixin"), "wechat");
  assert.equal(normalizeChannelName("something-else"), "plain");
  assert.equal(normalizeChannelName(""), "plain");
});

// ─────────────────────────── 表格 ───────────────────────────

test("★ 表格 → 可读列表（2 列中文）：不含 |---，每条记录一行「• 列：值」", () => {
  const md = [
    "查询结果如下：",
    "",
    "| 姓名 | 年龄 |",
    "|---|---|",
    "| 张三 | 30 |",
    "| 李四 | 25 |",
    "",
    "以上。"
  ].join("\n");
  const out = fmt(md);
  assert.ok(!out.includes("|---"), "★ 不得残留表格分隔行");
  assert.ok(!hasRawTable(out), "★ 不得残留裸表格");
  assert.match(out, /^• 姓名：张三 · 年龄：30$/m);
  assert.match(out, /^• 姓名：李四 · 年龄：25$/m);
  assert.match(out, /查询结果如下/);
  assert.match(out, /以上。/);
  // 表头只作为列名出现，不额外留一行"| 姓名 | 年龄 |"
  assert.ok(!out.includes("| 姓名 |"));
});

test("表格 1 列 / 3 列：1 列逐条「• 列：值」；3 列窄表仍单行", () => {
  const one = fmt("| 项目 |\n|---|\n| A |\n| B |");
  assert.deepEqual(one.split("\n"), ["• 项目：A", "• 项目：B"]);

  const three = fmt("| 名称 | 数量 | 价格 |\n|---|---|---|\n| 苹果 | 2 | 5 |");
  assert.match(three, /^• 名称：苹果 · 数量：2 · 价格：5$/m);
});

test("★ 表格 5 列（超宽）：拆成「• 记录 N」+ 每列一行，避免客户端折行成乱码", () => {
  const md = [
    "| 序号 | 模块 | 状态 | 负责人 | 备注 |",
    "|---|---|---|---|---|",
    "| 1 | 登录 | 完成 | 张三 | 已经上线验证过了 |",
    "| 2 | 支付 | 进行中 | 李四 | 等第三方回调 |"
  ].join("\n");
  const out = fmt(md);
  assert.ok(!hasRawTable(out));
  assert.match(out, /^• 记录 1$/m);
  assert.match(out, /^ {2}序号：1$/m);
  assert.match(out, /^ {2}模块：登录$/m);
  assert.match(out, /^ {2}负责人：张三$/m);
  assert.match(out, /^• 记录 2$/m);
  // 每行都不该太宽（拆开是为了可读；阈值 60 显示列 + 列名余量）
  for (const line of out.split("\n")) {
    assert.ok(displayWidth(line) <= 80, `行太宽（${displayWidth(line)}）：${line}`);
  }
});

test("表格转义竖线：`\\|` 是单元格内容，不是分隔符", () => {
  assert.deepEqual(splitTableRow("| a \\| b | c |"), ["a | b", "c"]);
  const out = fmt("| 表达式 | 值 |\n|---|---|\n| a \\| b | 真 |");
  assert.match(out, /• 表达式：a \| b · 值：真/);
  assert.ok(!hasRawTable(out));
});

test("无分隔行 / 无表头 / 空单元格：不崩、不生造列", () => {
  // 没有 |---| 分隔行的两行表：第一行当表头
  const out = fmt("| k | v |\n| a | 1 |");
  assert.match(out, /^• k：a · v：1$/m);
  // 单元格为空 → 该列不输出
  const sparse = convertMarkdownTable(["| a | b | c |", "|---|---|---|", "| 1 |  | 3 |"]);
  assert.deepEqual(sparse, ["• a：1 · c：3"]);
  // 全空行表 → 空数组（不要留空壳）
  assert.deepEqual(convertMarkdownTable(["| a | b |", "|---|---|"]), []);
  assert.deepEqual(convertMarkdownTable([]), []);
});

// ─────────────────────────── 标题 / 引用 / 分隔线 / 列表 ───────────────────────────

test("★ 标题→加粗、引用→›、分隔线→空行、任务列表→☐/☑、嵌套列表压平一层、代码块原样保留", () => {
  const md = [
    "# 一级标题",
    "## 二级标题",
    "> 引用一句话",
    "",
    "---",
    "",
    "- [ ] 待办事项",
    "- [x] 已完成",
    "- 父项",
    "  - 子项",
    "    - 孙项",
    "",
    "```js",
    "const a = 1; // 代码块里 # 和 | 都不该被转换",
    "| not | a | table |",
    "```"
  ].join("\n");
  const out = fmt(md);
  assert.match(out, /^\*\*一级标题\*\*$/m, "标题 → 加粗");
  assert.match(out, /^\*\*二级标题\*\*$/m);
  assert.match(out, /^› 引用一句话$/m, "引用 → ›");
  assert.ok(!/^-{3,}$/m.test(out), "★ 分隔线不得残留");
  assert.match(out, /^- ☐ 待办事项$/m, "未完成 → ☐");
  assert.match(out, /^- ☑ 已完成$/m, "已完成 → ☑");
  assert.match(out, /^- 父项$/m);
  assert.match(out, /^ {2}· 子项$/m, "嵌套压平成一层 ·");
  assert.match(out, /^ {2}· 孙项$/m, "第三层也压到同一层");
  assert.ok(out.includes("```js"), "★ 代码块围栏必须保留");
  assert.ok(out.includes("const a = 1;"), "代码内容保留");
  assert.ok(out.includes("| not | a | table |"), "★ 代码块里的表格语法不得被转换");
});

test("inline code / 加粗 / 链接保留（企微 markdown 支持）", () => {
  const out = fmt("用 `npm test` 跑一下，**注意**看 [文档](https://example.com/x)。");
  assert.equal(out, "用 `npm test` 跑一下，**注意**看 [文档](https://example.com/x)。");
});

test("非 markdown 通道（plain/feishu）降级：去掉 ** 与 `，列表换 •，代码围栏去掉", () => {
  const md = "# 标题\n\n**重点** 和 `code`\n\n- 条目\n\n```\nplain code\n```";
  const plain = formatForChannel("plain", { text: md });
  assert.ok(!plain.includes("**"), "plain 不得保留加粗标记");
  assert.ok(!plain.includes("`code`"), "plain 不得保留 inline code 标记");
  assert.match(plain, /^• 条目$/m);
  assert.ok(!plain.includes("```"), "plain 去掉代码围栏");
  assert.ok(plain.includes("plain code"), "代码内容保留");
  // feishu：markdown=false，走同一套降级
  const feishu = formatForChannel("feishu", { text: md });
  assert.ok(!feishu.includes("**"));
});

// ─────────────────────────── 截断 ───────────────────────────

test("★ wecom 4096 字节截断：中文按字节算、优先段落边界、末尾带截断提示、不切坏 UTF-8", () => {
  const para1 = "第一段：" + "甲".repeat(600) + "。"; // 1800+ 字节
  const para2 = "第二段：" + "乙".repeat(600) + "。";
  const para3 = "第三段：" + "丙".repeat(600) + "。";
  const md = [para1, para2, para3].join("\n\n");
  assert.ok(utf8Bytes(md) > 4096, "输入必须超过 4096 字节");
  const out = fmt(md);
  assert.ok(utf8Bytes(out) <= 4096, `输出必须 ≤4096 字节（实际 ${utf8Bytes(out)}）`);
  assert.ok(out.endsWith(TRUNCATED_NOTE), "必须带「…(已截断，完整内容看电脑)」");
  assert.ok(out.startsWith("第一段："), "保留开头");
  assert.ok(!out.includes("第三段："), "后面的段落被截掉");
  // 不切在 UTF-8 中间：字符串往返必须一致（出现 U+FFFD 说明切坏了）
  assert.equal(Buffer.from(out, "utf8").toString("utf8"), out);
  assert.ok(!out.includes("\uFFFD"));
});

test("截断：段落太大时退到行边界；单行超长时按码点切（不破坏代理对/中文）", () => {
  // 每行都很短但整体超限 → 在行边界截断（不会出现半行）
  const manyLines = Array.from({ length: 400 }, (_, i) => `第 ${i} 行：数据`).join("\n");
  const out = fmt(manyLines, { maxBytes: 300 });
  assert.ok(utf8Bytes(out) <= 300);
  assert.ok(out.endsWith(TRUNCATED_NOTE));
  assert.equal(Buffer.from(out, "utf8").toString("utf8"), out);
  // 单行超长（含 emoji 4 字节）→ 逐码点截断，不产生 U+FFFD
  const huge = "😀".repeat(2000);
  const cut = truncateUtf8Safe(huge, { maxBytes: 100 });
  assert.ok(utf8Bytes(cut) <= 100);
  assert.equal(Buffer.from(cut, "utf8").toString("utf8"), cut);
  assert.ok(!cut.includes("\uFFFD"));
});

test("maxChars 与「调用方已截断」去重：不会出现两个「已截断」", () => {
  const out = fmt("甲".repeat(1000), { maxChars: 100 });
  assert.ok([...out].length <= 100, "字符上限生效");
  assert.equal((out.match(/已截断/g) || []).length, 1);
  // 调用方自带 suffix（回答回传先按字符截 1500 + 本提示）：模块不得重复追加
  const pre = `${"乙".repeat(1500)}${TRUNCATED_NOTE}`;
  const out2 = fmt(pre);
  assert.equal((out2.match(/已截断/g) || []).length, 1, "★ 不得出现两个截断提示");
  assert.ok(out2.endsWith(TRUNCATED_NOTE));
  // 自带 suffix 且其实没超限 → 保留原提示
  const shortPre = `短内容${TRUNCATED_NOTE}`;
  assert.equal(fmt(shortPre), shortPre);
});

// ─────────────────────────── wechat / 未知通道 ───────────────────────────

test("wechat 分支：走现有特殊格式（本模块只做 plain 兜底、不截断）", () => {
  const big = "| a | b |\n|---|---|\n| 1 | 2 |\n" + "内容".repeat(5000);
  const out = formatForChannel("wechat", { text: big });
  assert.ok(!hasRawTable(out), "兜底也不留裸表格");
  assert.ok(!out.endsWith(TRUNCATED_NOTE), "wechat 不在这里截断（由微信通道自己管长度/格式）");
  // 未知通道 → plain（fail-safe，不发坏 markdown）
  const unknown = formatForChannel("mystery-channel", { text: "# 标题\n\n**粗**" });
  assert.ok(!unknown.includes("**"));
  assert.equal(unknown, "标题\n\n粗");
});

// ─────────────────────────── 任务总结（turn_done/turn_error 通知带正文）───────────────────────────

test("★ extractTurnSummary：订阅器正文优先 → 事件字段降级 → 取不到为空（不报错）", async () => {
  // ① 订阅器有正文
  const sub = { lastAssistantText: async () => ({ ok: true, text: "订阅器里的总结" }) };
  const a = await extractTurnSummary({ node: { kind: "turn-end", sessionId: "session-x" }, subscriber: sub, sessionId: "session-x" });
  assert.deepEqual(a, { text: "订阅器里的总结", source: "assistant" });
  // ② 订阅器取不到 → 事件字段（summary/message/detail/text）
  const b = await extractTurnSummary({ node: { kind: "turn-end", sessionId: "session-x", message: "事件里的错误摘要" }, subscriber: { lastAssistantText: async () => ({ ok: false, code: "page-failed" }) }, sessionId: "session-x" });
  assert.deepEqual(b, { text: "事件里的错误摘要", source: "node" });
  // ③ 都没有 → 空（调用方降级仅标题）
  const c = await extractTurnSummary({ node: { kind: "turn-end", sessionId: "session-x" }, subscriber: null });
  assert.equal(c.text, "");
  assert.equal(c.source, "none");
  // ④ 订阅器抛错也不崩，继续降级
  const d = await extractTurnSummary({ node: { kind: "turn-end", summary: "兜底" }, subscriber: { lastAssistantText: async () => { throw new Error("boom"); } }, sessionId: "s" });
  assert.deepEqual(d, { text: "兜底", source: "node" });
  // ⑤ 重试：ok 但空 → 第二次拿到（turn/end 瞬间正文可能还没落库）
  let n = 0;
  const retried = await extractTurnSummary({
    node: { kind: "turn-end", sessionId: "s" },
    subscriber: { lastAssistantText: async () => { n += 1; return n === 1 ? { ok: true, text: "" } : { ok: true, text: "重试后的总结" }; } },
    sessionId: "s",
    retryDelays: [0, 5]
  });
  assert.equal(retried.text, "重试后的总结");
  assert.equal(n, 2);
});

test("★ buildTurnNotification：标题行 + 正文（1500 字上限/通道格式化/缺正文降级）；审批类返回 null", () => {
  // completed：✅ 任务完成｜标题 + 正文
  const done = buildTurnNotification({ node: { kind: "turn-end", reason: "completed" }, channel: "wecom", summary: "改了三个文件", sessionTitle: "修端口" });
  assert.equal(done, "✅ 任务完成｜修端口\n\n改了三个文件");
  // error / blocked / aborted
  assert.match(buildTurnNotification({ node: { kind: "turn-end", reason: "error" }, channel: "wecom", summary: "报错摘要" }), /^❌ 出错了\n\n报错摘要$/);
  assert.match(buildTurnNotification({ node: { kind: "turn-end", reason: "blocked" }, channel: "wecom", summary: "被拦原因" }), /^⛔ 被拦下了\n\n被拦原因$/);
  assert.match(buildTurnNotification({ node: { kind: "turn-end", reason: "aborted" }, channel: "wecom" }), /^⏹ 已停止$/);
  // session-error 也用 ❌ 出错了
  assert.match(buildTurnNotification({ node: { kind: "session-error", message: "x" }, channel: "wecom" }), /^❌ 出错了/);
  // 缺正文 → 仅标题（不留多余空段）
  assert.equal(buildTurnNotification({ node: { kind: "turn-end", reason: "completed" }, channel: "wecom", summary: "" }), "✅ 任务完成");
  // 审批类不混入总结（返回 null，仍走卡片）
  assert.equal(buildTurnNotification({ node: { kind: "approval-request", toolName: "Bash" }, channel: "wecom", summary: "不该出现" }), null);
  // 表格按通道转换（企微不支持表格 → 可读列表）
  const table = "| 文件 | 改动 |\n|---|---|\n| a.mjs | 修端口 |";
  const withTable = buildTurnNotification({ node: { kind: "turn-end", reason: "completed" }, channel: "wecom", summary: table });
  assert.ok(!/\|\s*-{2,}/.test(withTable), "★ 通知里不得有裸表格分隔行");
  assert.match(withTable, /• 文件：a\.mjs · 改动：修端口/);
  // 1500 字上限（长正文截断 + 注明）
  const long = "开头" + "长".repeat(3000);
  const longNotice = buildTurnNotification({ node: { kind: "turn-end", reason: "completed" }, channel: "feishu", summary: long });
  const body = longNotice.split("\n\n").slice(1).join("\n\n");
  assert.ok(body.endsWith(TRUNCATED_NOTE), "超长正文要带截断提示");
  assert.ok(Array.from(body).length <= SUMMARY_MAX_CHARS + Array.from(TRUNCATED_NOTE).length + 2, "正文不超过 1500 字（+提示）");
  assert.ok(!body.includes("长".repeat(2000)), "明显截断");
});
