// 「用户反馈」账号历史（浏览器半）回归：登录态(SaaS 且账号已配)打开「我的反馈」时
// 拉服务端 /api/feedback/mine 并与其本地 thread_token 列表去重合并；账号历史行单条
// 打开/回复走服务端(节点半自动附 JWT,无需本地 thread_token),匿名/本地行仍走原
// thread_token 路径。这些是 client.js 的源码级/结构断言（沿用 settings-entry.test.mjs 手法）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

test("登录态打开「我的反馈」拉账号历史：fbAccount 门槛 + /feedback/mine 请求(带翻页)", () => {
  // /mine 需要 JWT：仅 SaaS 且账号已配(cfg.phone)才发请求；自建/未登录不发（本地 thread_token 路径不变）
  assert.match(SOURCE, /var fbAccount = !!\s*\(cfg && cfg\.phone && fbAuth === "account"\);/);
  // 经 /dsh-remote/feedback/api 前缀代理 → 上游 {base}/api/feedback/mine?page&page_size
  assert.match(SOURCE, /fbApi\("\/feedback\/mine\?page=1&page_size=20"\)/);
  // 仅在账号态拉取：loadMine 第一行即兜底
  assert.match(SOURCE, /function loadMine\(\) \{\s*if \(!fbAccount\) return;/);
  // 打开「我的反馈」tab 时触发；useEffect 自动补拉但带错误/忙碌护栏（失败后点 tab 重试，不无限重试）
  assert.match(SOURCE, /if \(fbAccount && mineList === null\) loadMine\(\);/);
  assert.match(SOURCE, /if \(tab === "mine" && fbAccount && mineList === null && !mineErr && !mineBusy\) loadMine\(\);/);
  // 账号态提交成功后清空列表缓存 → 下次进「我的反馈」重新拉取(含本条)
  assert.match(SOURCE, /if \(fbAccount\) setMineList\(null\);\s*\/\/ 账号态提交成功 → 回「我的反馈」时重新拉取\(含本条\)/);
});

test("合并展示：服务端 mine 行在前、本机未同步 thread_token 行去重保留；字段映射到卡片渲染", () => {
  // mine 列表项(服务端 toPublic + reply_count)映射为展示行:status/category/title/created_at/reply_count
  assert.match(SOURCE, /function fbRows\(\) \{/);
  assert.match(SOURCE, /status: it\.status \|\| "", category: it\.category \|\| "", title: it\.title \|\| "",/);
  assert.match(SOURCE, /created_at: it\.created_at \|\| 0, reply_count: it\.reply_count \|\| 0,/);
  // 结构顺序：账号历史行先 push，本机行(去重)后 push
  const minePush = SOURCE.indexOf("it.reply_count || 0,");
  const localPush = SOURCE.indexOf("out.push({ id: t.id, acct: false");
  assert.ok(minePush !== -1 && localPush !== -1 && minePush < localPush, "账号历史行应先于本机行进入展示列表");
  // 去重：mine 已含的本地行跳过
  assert.match(SOURCE, /if \(seen\[t\.id\]\) return;/);
  // 卡片渲染路径：折叠态直接用服务端行字段(状态徽章/时间/回复数)，展开仍复用详情+回复结构
  assert.match(SOURCE, /fbStatusBadge\(st \|\| "open"\)/);
  assert.match(SOURCE, /new Date\(ts\)\.toLocaleString\(\)/);
  assert.match(SOURCE, /r\.acct && !open && r\.reply_count > 0 \? " · " \+ r\.reply_count \+ " 条回复"/);
  // 管理员回复/回复输入框保留
  assert.match(SOURCE, /reply\.author === "admin" \? "管理员回复" : "我"/);
  assert.match(SOURCE, /id: "dru-fb-reply-" \+ r\.id/);
});

test("账号历史行打开/回复走服务端(自动附 JWT)，本地/匿名行仍带 thread_token", () => {
  // 归属判断：mine 列表含该 id → 账号行
  assert.match(SOURCE, /function fbRowIsAccount\(id\)/);
  assert.match(SOURCE, /mineList && mineList\.some\(function \(x\) \{ return x\.id === id; \}\)/);
  // 单条加载：账号行不带 token(节点半登录态自动附 JWT,服务端按账号归属放行)；本地行带 token
  assert.match(SOURCE, /fbApi\("\/feedback\/" \+ id, accountRow \? \{\} : \{ token: t\.token \}\)/);
  // 回复同理：仅非账号行补充 thread_token
  assert.match(SOURCE, /var replyOpts = \{ method: "POST", body: JSON\.stringify\(\{ content: text \}\) \};/);
  assert.match(SOURCE, /if \(!accountRow\) \{\s*if \(!t\) return;\s*replyOpts\.token = t\.token;/);
  // 匿名/本地提交路径原样保留(thread 凭据仍只存本地 localStorage)
  assert.match(SOURCE, /fbRememberThread\(b\.feedback\.id, b\.thread_token\);/);
  assert.match(SOURCE, /var FB_THREADS_KEY = "dsh-feedback-threads";/);
});

test("错误与空态：401 → 提示重新登录；网络失败 → 可读；空态区分 账号/未登录", () => {
  // 拉列表 401(如 token 失效) → 重新登录提示
  assert.match(SOURCE, /账号登录已过期，请退出后重新登录，再查看账号全部历史/);
  // 单条 401 同样给重新登录提示
  assert.match(SOURCE, /if \(e && e\.status === 401\) setMsg\("err", "登录已过期，请退出后重新登录后再查看该反馈"\);/);
  // 网络/服务端错误 → 可读错误并保留本机记录说明
  assert.match(SOURCE, /账号历史拉取失败：" \+ \(\(eb && eb\.message\) \|\| \(e && e\.message\)\) \+ "（本机记录仍可查看）"/);
  // 账号态空列表 / 未登录空列表 两种文案
  assert.match(SOURCE, /暂无反馈，提交第一条？/);
  assert.match(SOURCE, /还没有提交过反馈。/);
  assert.match(SOURCE, /登录手机号账号后，可在任意设备查看账号全部历史。/);
});
