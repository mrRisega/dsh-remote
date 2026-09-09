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
  // 支付二维码弹层 + 挽留弹层(先挽留再关闭)
  assert.match(APP, /qr-modal/);
  assert.match(APP, /retain-modal/);
  assert.match(APP, /我再想想/);
  assert.match(APP, /残忍离开/);
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
  // 内存会话(同页已解锁 → 直接进入,不重复弹层)
  assert.match(APP, /e2eeClient\.sessions\.has\(deviceId\)/);
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
