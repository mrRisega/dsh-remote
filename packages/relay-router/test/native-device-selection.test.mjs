#!/usr/bin/env node
/**
 * native.html 设备选择/退出契约测试(源码级,防回归):
 *   App 必须从 Router 实时 /_devices 选设备,显式退出必须先清状态再渲染,
 *   首屏必须先显示读取态,Router 错误页必须带显式退出意图。
 *
 * 用法: node --test test/native-device-selection.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APP = readFileSync(path.join(ROOT, "clients/dsh-web/native.html"), "utf8");
const ROUTER = readFileSync(path.join(ROOT, "packages/relay-router/src/index.mjs"), "utf8");

test("App 登录/注册/会话恢复统一走 Router 实时设备列表 /_devices", () => {
  assert.match(APP, /\/_devices/);
});

test("首屏为读取态,会话判定完成前不渲染登录或设备界面", () => {
  assert.match(APP, /正在读取登录状态/);
  assert.match(APP, /view-boot/);
});

test("logout=1 显式退出:先清状态再渲染,并清理地址栏参数", () => {
  assert.match(APP, /logout=1/);
  assert.match(APP, /history\.replaceState/);
});

test("0/1/多设备统一进设备选择页:不按台数自动跳转,由用户点选进入", () => {
  assert.match(APP, /devices\.length === 0/);
  // 单台不再写 dsh_device 自动进入:enterMirror 内不允许出现 devices[0] 直跳
  assert.doesNotMatch(APP, /enterDevice\(devices\[0\]\.id\)/);
  // 点选设备(行级 onclick,读取 data-device)才是唯一进入途径;离线行不会触发 enter。
  // 在线行先经 E2EE 门控(e2eeMaybeGateThenEnter):未启用/无能力时内部照旧 enterDevice。
  assert.match(APP, /e2eeMaybeGateThenEnter\(el\.dataset\.device/);
});

test("仅用户点选设备才写 dsh_device 并跳根路径(enterDevice)", () => {
  assert.match(APP, /function enterDevice/);
  assert.match(APP, /dsh_device=/);
});

test("设备选择不再使用旧 P2P 探测与账号设备表兜底", () => {
  assert.doesNotMatch(APP, /fetchOnlineDevices/);
});

test("推广页:月付/年付 Tab、版本对比表、两层购买意愿上报与二维码/挽留弹层", () => {
  // 月付/年付 Tab(样式复用 .auth-tab)
  assert.match(APP, /promo-tab-monthly/);
  assert.match(APP, /promo-tab-yearly/);
  // 版本纵向对比表(数据来自 public-config,不写死)
  assert.match(APP, /promo-compare/);
  assert.match(APP, /monthly_resets/);
  assert.match(APP, /不限速/);
  // 年付价格:优先 prices.{key}_yearly,缺失按 9 折兜底
  assert.match(APP, /_yearly/);
  // 两层购买意愿上报:进页 promo_open + 点购买 buy_click
  assert.match(APP, /api\/upgrade-intent/);
  assert.match(APP, /promo_open/);
  assert.match(APP, /buy_click/);
  // 立即购买按钮(PRO 与 Pro Max 各一个)
  assert.match(APP, /立即购买 PRO/);
  assert.match(APP, /立即购买 Pro Max/);
  // 支付二维码弹层 + 关闭后的“支付状态确认”(支付完成/取消支付,原挽留弹窗已移除)
  assert.match(APP, /qr-modal/);
  assert.match(APP, /payask-done/);
  assert.match(APP, /payask-cancel/);
  assert.match(APP, /payask-result/);
  assert.match(APP, /支付完成/);
  assert.match(APP, /取消支付/);
  assert.match(APP, /稍后再说/);
  assert.doesNotMatch(APP, /我再想想/);
  assert.doesNotMatch(APP, /残忍离开/);
});

test("登录卡片已登录区移除「切换账号」按钮,保留「退出登录」", () => {
  assert.doesNotMatch(APP, /btn-switch-account/);
  assert.match(APP, /btn-logout-inline/);
});

test("Router 错误页「返回登录」带显式退出意图 /app/?logout=1", () => {
  assert.match(ROUTER, /\/app\/\?logout=1/);
});

test("推广页 /app/promo?auth= 快捷登录:promo 路由消费 auth → exchange,成功停留刷新已登录态", () => {
  // boot 判定 promo 页(pathname endsWith /promo)
  assert.match(APP, /endsWith\("\/promo"\)/);
  // promo 分支同样解析 ?auth= 并复用同一 exchange 端点(设备页 auth 分支不受影响)
  assert.match(APP, /\/api\/auth-key\/exchange/);
  assert.match(APP, /stayOnPromo:\s*true/);
  // 交换进行中/失败的可读提示常驻区(banner)
  assert.match(APP, /promo-auth-banner/);
  // 成功路径:停留 promo 页、写 cookie 并重渲染为已登录内容(不跳设备页)
  assert.match(APP, /void renderPromo\(\)/);
  // 失败可读提示 + 隐去地址栏 auth 明文
  assert.match(APP, /链接已失效/);
  assert.match(APP, /返回电脑端/);
  assert.match(APP, /history\.replaceState/);
});

test("忘记密码(短信重置):登录卡入口 + 重置表单字段与端点契约字段齐备", () => {
  // 登录卡「忘记密码?」入口
  assert.match(APP, /btn-forgot-pass/);
  assert.match(APP, /忘记密码/);
  // 重置小表单:手机号 + 图形验证码 + 短信验证码 + 新密码
  assert.match(APP, /reset-phone/);
  assert.match(APP, /reset-captcha-img/);
  assert.match(APP, /reset-sms-code/);
  assert.match(APP, /reset-pass/);
  // 提示:重置后所有已授权设备/会话将失效,需重新登录与解锁
  assert.match(APP, /所有已授权设备\/会话将失效/);
  assert.match(APP, /重新登录与解锁/);
  // 端点与契约字段(body {phone,sms_code,new_password} → 200 {ok:true})
  assert.match(APP, /\/api\/password\/reset/);
  assert.match(APP, /new_password/);
  assert.match(APP, /sms_code/);
  // 成功后清本地 token/cookie/threads,并提示用新密码登录
  assert.match(APP, /dsh-feedback-threads/);
  assert.match(APP, /请用新密码登录/);
});

test("注册请求上报 reg_source=remoteweb_register(注册来源归因;字段可选,不传安装来源)", () => {
  // 端点与调用形态不变:POST /api/register,payload 由 doRegister 构造
  assert.match(APP, /api\("\/api\/register", payload\)/);
  // 来源值精确匹配服务端白名单(panel_register / remoteweb_register / api_unknown)
  assert.match(APP, /reg_source:\s*"remoteweb_register"/);
  // 断言 reg_source 确实落在注册 payload 字面量里(防被挪到别处或写成别的值)
  const callIdx = APP.indexOf('api("/api/register", payload)');
  assert.ok(callIdx > 0, "应有 POST /api/register 且以 payload 为 body 的调用");
  const before = APP.slice(Math.max(0, callIdx - 800), callIdx);
  assert.match(before, /const payload = \{[^}]*\bphone\b[^}]*sms_code[^}]*password[^}]*\}/);
  assert.match(before, /const payload = \{[^}]*reg_source:\s*"remoteweb_register"[^}]*\}/);
  // 注册流程字段零回归:短信验证码与邀请码仍在同一 payload
  assert.match(before, /sms_code: sms/);
  assert.match(before, /payload\.invite_code = window\.__inviteCode/);
  // 手机端不是安装方:不臆造安装来源字段
  assert.doesNotMatch(before, /install_source|install_version/);
});

// ============================================================
// E2EE Phase-3 源码级契约(native.html 手机端客户端;docs/e2ee-protocol.md §2.3/§3.4/§5/§6.4)
// ============================================================

test("E2EE 信任文案:解锁层文案按 §2.3-2,强调密码=密钥/仅内存/不发给中继/刷新重输", () => {
  assert.match(APP, /请输入账号密码以开启/);
  assert.match(APP, /端到端加密/);
  assert.match(APP, /密码仅在本页内存中参与密钥派生/);
  assert.match(APP, /不会发送给中继/);
  assert.match(APP, /不(被|会)保存/);
  assert.match(APP, /刷新或重开页面需再次输入/);
  // 明文跳过必须明确二次确认(§7.3「本次连接不加密(明文)」)
  assert.match(APP, /暂不加密/);
  assert.match(APP, /明文/);
  // 密钥不落 localStorage:不得把 e2ee 材料写入本地存储(协议 §5.1/§8 风险 5)
  assert.doesNotMatch(APP, /localStorage\.(set|get|remove)Item\(\s*["'][^"']*e2ee/i);
});

test("E2EE 接入点字段:params 端点 / 控制通道 / 信封标记 / 握手消息齐备", () => {
  // §3.4 参数端点(拉取:服务端 enabled=false → 明文回退)
  assert.match(APP, /api\/e2ee-params/);
  assert.match(APP, /server_disabled/);
  // §5.2 控制通道 device 形态 {origin}/remote/<deviceId>/_e2ee/ctrl
  assert.match(APP, /\/remote\/.*_e2ee\/ctrl/);
  assert.match(APP, /e2ee-hello/);
  assert.match(APP, /dsh-e2ee-probe-v1/);
  assert.match(APP, /dsh-e2ee-probe-ok/);
  // §4.3 信封即信号:content-type 与 x-dsh-e2ee 标记
  assert.match(APP, /application\/vnd\.dsh\.e2ee-v2/);
  assert.match(APP, /x-dsh-e2ee/);
  // 可读错误码文案映射(bad_key 等)
  assert.match(APP, /bad_key/);
  assert.match(APP, /电脑端保存的账号密码与本次输入不一致/);
});

test("E2EE 门控:仅「账号 enabled ∧ 设备 caps=e2ee-v2」才走解锁流程;否则原明文进入不变", () => {
  assert.match(APP, /e2eeCapable\(/);
  assert.match(APP, /e2eeMaybeGateThenEnter/);
  // 能力判定必须同时看服务端开关与 /_devices 透传的 caps(Phase-2 §6.2)
  assert.match(APP, /caps\.includes/);
  assert.match(APP, /WC_E2EE_CAP|["']e2ee-v2["']/);
  // 门控不满足 → 直接原进入路径(明文回退,回归保护)
  assert.match(APP, /if \(!e2eeCapable\(params, caps\)\)/);
  assert.match(APP, /enterDevice\(deviceId\)/);
  // 设备行渲染须携带 caps(供门控读取;离线行不可进入)
  assert.match(APP, /data-caps=/);
  assert.match(APP, /class="device off"/);
  // 内存会话(同页已解锁且 24h 内 → 直接进入,不重复弹层;过期则删除走重新解锁)
  assert.match(APP, /e2eeClient\.sessions\.get\(deviceId\)/);
  assert.match(APP, /24 \* 3600 \* 1000/);
  // 免二次输密码候选:内存密码 / 记住本机(localStorage MK)/ 桌面授权引导 → 失败才落解锁层
  assert.match(APP, /e2eePendingPassword/);
  assert.match(APP, /e2eeStoredMk/);
  assert.match(APP, /e2eeRequestIntro\(deviceId\)/);
});

test("E2EE 状态字段(Phase-4 约定):徽标/状态取自 e2eeStateFor 命名", () => {
  assert.match(APP, /function e2eeStateFor/);
  assert.match(APP, /supported:/);
  assert.match(APP, /enabled:/);
  assert.match(APP, /unlocked:/);
  assert.match(APP, /deviceId:/);
  assert.match(APP, /sessId:/);
  assert.match(APP, /profile:/);
  assert.match(APP, /epoch:/);
  // header 徽标 id(dsh-e2ee-badge)+ 状态文案
  assert.match(APP, /dsh-e2ee-badge/);
  assert.match(APP, /🔒 已解锁/);
});

test("E2EE WebCrypto 核心与纯浏览器 API 对齐(供 node 抽取对拍的原语区间)", () => {
  assert.match(APP, /DSH-E2EE-WC-CORE-START/);
  assert.match(APP, /crypto\.subtle/);
  assert.match(APP, /importKey/);
  assert.match(APP, /deriveBits/);
  assert.match(APP, /AES-GCM/);
  assert.match(APP, /PBKDF2/);
  assert.match(APP, /HKDF/);
});

// 交流群二维码(运营配置;源码级契约):付费页底部展示、数据取自 public-config.community.qrcode,
// 未配置/图片加载失败时整块隐藏(不留空壳卡片)。
test("付费页底部「加入交流群」卡片:取 public-config.community.qrcode,相对路径拼 API_BASE,未配置/失败即隐藏", () => {
  assert.match(APP, /id="promo-community-card"/, "推广页应有交流群卡片容器");
  assert.match(APP, /id="promo-community-qr"/, "推广页应有交流群二维码容器");
  assert.match(APP, /function renderPromoCommunity\(\)/, "应有独立的交流群渲染函数");
  // 数据源与拼址约定(与收款码一致):/^https?:/ 直用,否则 API_BASE + qr
  assert.match(APP, /\(\(pubConfig && pubConfig\.community\) \|\| \{\}\)\.qrcode/);
  assert.match(APP, /const src = \/\^https\?:\/i\.test\(qr\) \? qr : API_BASE \+ qr;/);
  // 未配置 → 隐藏;图片 onerror → 隐藏
  assert.match(APP, /if \(!qr\) \{ card\.classList\.add\("hidden"\);/);
  assert.match(APP, /img\.onerror = \(\) => \{ card\.classList\.add\("hidden"\); \}/);
  // 每次刷新配置都会重新评估(renderPromoPlans 末尾调用)
  assert.match(APP, /  renderPromoCommunity\(\);\n\}/);
});

// 首装漏斗修复(2026-09-13 诊断):手机端空设备态不再让用户"等不到就算了"。
// 生产证据:11 个真实用户(id 42~52)中 6 人只注册了手机端、电脑端从未安装(面板活动为 0),
// 原因是引导只给了「装 Node.js + 终端跑 npx」这一条技术路径;剩下多人在空列表前反复轮询后流失。
test("空设备态:安装引导改为「插件市场安装」优先,终端命令收进进阶折叠", () => {
  assert.match(APP, /插件市场/, "引导必须给出插件市场安装路径(零终端)");
  assert.match(APP, /搜索 <code>dsh-remote<\/code>/, "市场路径要能照着做(搜索 dsh-remote)");
  assert.match(APP, /如果你有「插件市场」入口/, "市场路径必须标明前提(DSH 本身没有内置市场,入口来自第三方市场插件)");
  assert.match(APP, /没有市场入口\?用这条命令/, "必须给没有市场入口的用户一条可执行兜底路径");
  assert.match(APP, /两条路走完后都一样/, "两条路径要收敛到同一段「登录 + 自动出现」指引");
  assert.match(APP, /不需要刷新页面|无需刷新本页/, "要明确告诉用户不用手动刷新");
  // 终端路径保留但降级:必须包在 <details> 进阶折叠里,且仍可一键复制命令
  // 模板里用的是 `${esc(cmdInstall)}`,故按区间断言(折叠段内必须有命令块且引用 cmdInstall)
  const from = APP.indexOf('<details class="guide-more">');
  const more = APP.slice(from, APP.indexOf("</details>", from));
  assert.ok(from > 0, "应有进阶折叠 <details class=\"guide-more\">");
  assert.ok(/Node\.js 22\+/.test(more) && more.includes("settings"), "折叠区应讲「缺 Node 怎么办」与「settings 手动控制」，不重复主路径命令");
  assert.match(APP, /data-guide-copy="\$\{esc\(cmdInstall\)\}"/, "终端命令保留复制按钮");
  // 后台配置仍可整体覆盖
  assert.match(APP, /const custom = pubConfig && pubConfig\.app_install_guide;\s*\n\s*if \(custom\) return custom;/);
});

test("空设备态:自动等待电脑上线(轻量探测 + 退避 + 前台恢复),不必点刷新", () => {
  assert.match(APP, /let devicePollTimer = null;/, "需要模块级轮询句柄");
  assert.match(APP, /let lastOnlineCount = 0;/, "需要记录在线设备数决定是否继续等待");
  assert.match(APP, /function scheduleDevicePoll\(\)/, "需要调度函数");
  assert.match(APP, /function cancelDevicePoll\(\)/, "需要取消函数(离页/隐藏时停)");
  // 轻量探测只打 Router 实时接口(不写账号库、不污染活跃统计)
  assert.match(APP, /async function probeOnlineDevices\(\)[\s\S]{0,400}?fetch\("\/_devices", \{ cache: "no-store" \}\)/);
  assert.match(APP, /ids\.length > 0 && ids\.length !== lastOnlineCount/, "发现设备才走完整刷新");
  // 首装最急的一分钟 5s,之后退到 20s;隐藏时暂停
  assert.match(APP, /devicePollTicks < 10 \? 5000 : 20000/);
  assert.match(APP, /if \(document\.hidden\) return;\s*\/\/ 页面不可见/);
  assert.match(APP, /document\.addEventListener\("visibilitychange"/, "回前台立即探测");
  // 各渲染分支都要安排/停止轮询
  assert.match(APP, /lastOnlineCount = online\.length;[\s\S]{0,400}?scheduleDevicePoll\(\); \/\/ 全部离线时继续自动等上线/);
  assert.match(APP, /lastOnlineCount = 0;[\s\S]{0,600}?scheduleDevicePoll\(\);\s*\n\s*return;/);
  // 手动刷新按钮重置退避
  assert.match(APP, /\$\("btn-refresh"\)\.onclick = \(\) => \{ resetDevicePoll\(\); void refreshDevices\(\); \};/);
  // 等待提示文案
  assert.match(APP, /正在自动检测:电脑装好后会自己出现在这里,无需刷新本页/);
});

test("推广页安装引导同样市场优先(与空设备态一致,避免两条引导自相矛盾)", () => {
  assert.match(APP, /电脑端安装 · 二选一/, "推广页引导应同时给出市场与命令两条路");
  const from = APP.indexOf('"promo-install").innerHTML');
  const block = APP.slice(from, APP.indexOf("btn-copy-install", from) + 200);
  assert.ok(/插件市场[\s\S]{0,300}?npx @mrrisega\/dsh-remote[\s\S]{0,200}?复制/.test(block), "市场路径在前、终端命令在后(保留复制按钮)");
});

test("盲区补齐:空设备态展示引导时上报「看到引导」(只报一次、失败静默)", () => {
  assert.match(APP, /function reportGuideShown\(\)/, "应有独立上报函数");
  assert.match(APP, /api\("\/api\/guide-shown", \{\}, "POST"\)\.catch\(\(\) => \{\}\);/, "失败必须静默");
  assert.match(APP, /if \(!state\.token\) return;/, "未登录不报(服务端要求登录态)");
  assert.match(APP, /localStorage\.getItem\("dsh-guide-shown"\) === "1"/, "本机去重,避免重复请求");
  // 触发点在渲染空设备引导的分支里
  const from = APP.indexOf("const emptyText = boundOk");
  const branch = APP.slice(from, APP.indexOf("lastOnlineCount = 0;", from));
  assert.ok(branch.includes("installGuideHTML()") && branch.includes("reportGuideShown()"), "展示引导时同步上报");
});
