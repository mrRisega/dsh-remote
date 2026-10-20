#!/usr/bin/env node
/**
 * C9（2026-10-20 诊断）：**文案必须与实现一致**。
 *
 * 现场（03-加载卡住与打不开.md §2.4 D3）：「远程控制」面板硬编码「会话密钥只存在本机内存里，
 * 刷新即失效」，而实现早已把派生 MK 写 localStorage、交接单同时写 sessionStorage + localStorage，
 * 镜像页 `_boot()` 会从 localStorage 恢复（e2ee-shim-script.js 的「本机记忆恢复」分支）。
 * 照着旧文案，客服与用户会做出**错误动作**（以为刷新必丢密钥 / 以为没加密就不能用）。
 *
 * 本文件锁三件事：
 *   ① 旧说法必须从注入体里消失（它是事实错误，不是"措辞问题"）；
 *   ② 新说法必须同时讲清三条路径：已记住本机（刷新自动恢复）/ 提示失效时回列表重新解锁 / 明文可用但不加密；
 *   ③ 这句话是**客服话术**的唯一来源之一，措辞里必须带可执行动作（「返回设备列表重新解锁」）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { injectMobileAdapter } from "../mobile-adapter.mjs";

function adapterScript() {
  const { html } = injectMobileAdapter("<!doctype html><html><head></head><body></body></html>");
  const m = /<script id="[^"]*-js"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "应能从注入结果里取出脚本");
  return m[1];
}

/** 取出菜单底部那句「返回设备列表 / 加密说明」的原文。 */
function menuNote() {
  const script = adapterScript();
  const m = /dsh-ma-menu-note"?>([\s\S]*?)<\/div>/.exec(script);
  assert.ok(m, "应能找到菜单里的说明行（dsh-ma-menu-note）");
  return m[1].replace(/' \+/g, "").replace(/["']/g, "");
}

test("★ 注入体里不得再出现「只存在本机内存里 / 刷新即失效」这类与实现不符的说法", () => {
  const script = adapterScript();
  assert.equal(script.includes("刷新即失效"), false,
    "实现会从 localStorage 恢复加密会话 —— 说「刷新即失效」是事实错误，会让用户做出错误动作");
  assert.equal(script.includes("只存在本机内存里"), false, "会话密钥里「会持久化的解锁材料」与「只存内存的会话密钥」必须分清");
});

test("★ 新文案讲清三条路径：已记住本机自动恢复 / 提示失效→回列表重新解锁 / 明文可用但不加密", () => {
  const note = menuNote();
  assert.match(note, /记住本机/, "必须说明已记住本机（这是实现的事实，也是刷新后仍加密的原因）");
  assert.match(note, /刷新[^。]*自动恢复/, "必须说明刷新会自动恢复加密（不是重新输入密码）");
  assert.match(note, /加密会话已失效/, "必须点名那个提示语（用户看到的原话，客服才能对上）");
  assert.match(note, /返回设备列表重新解锁/, "必须给出**可执行动作**（客服话术的核心）");
  assert.match(note, /明文模式下功能可用/, "必须说明明文也能用（否则用户以为没加密=没得用）");
  assert.match(note, /不经端到端加密|不加密/, "必须明说明文不加密（安全边界不能含糊）");
});

test("C9 客服话术与 UI 文案同源：返回设备列表 / 重新解锁 的措辞一致", () => {
  const note = menuNote();
  // 客服话术（发给 lead 的交付说明）就是这句：
  // 「端到端加密已记住本机，刷新会自动恢复；若提示『加密会话已失效』，回设备列表重新点选设备解锁即可；不想解锁也能用，只是明文不加密。」
  assert.match(note, /返回设备列表重新解锁/, "UI 与客服话术必须用同一个动作短语（避免用户理解成两个操作）");
});
