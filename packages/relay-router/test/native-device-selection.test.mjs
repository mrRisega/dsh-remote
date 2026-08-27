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
  // 点选设备才是唯一进入途径
  assert.match(APP, /el\.onclick = \(\) => enterDevice/);
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
