#!/usr/bin/env node
/**
 * 目录选择器固定为「浏览器内实现」的契约测试。
 *
 * 用户实测（Windows）：镜像页点「添加工作区」**没反应**；同功能在 Mac 上正常。
 * 根因：官方 `directory-picker-auto` 只在**绑定非回环**时才改选 browse，否则 darwin/win32 一律挂
 * **原生**选择器 —— 那个对话框弹在**电脑那台机器的屏幕上**，拿手机的人看不到；
 * Windows 那条原生链路还要 koffi 原生模块 + worker 子进程（合成 Alt 抢前台），失败点更多。
 * 远程控制不能把"手机能不能选工作区"押在宿主的绑定地址上，所以插件主动把它钉成 browse。
 *
 * 这里守的是三条护栏（顺序错一条就会把用户的选择器搞没）：
 *   ① 已是 browse → 一根手指都不许动；
 *   ② **先建 browse、后摘 auto**：browse 建不起来时必须原样保留原生；
 *   ③ 全程不抛异常（插件绝不能把 dsh web 拖挂）。
 *
 * 用法: node --test test/picker-pin.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  __pinBrowseDirectoryPicker,
  __pickerPinState,
  __PICKER_AUTO_ENTRY_ID,
  __PICKER_BROWSE_PACKAGES
} from "../lib/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "lib", "index.js"), "utf8");

/** 假宿主：loader 记录 create/remove 的**调用顺序**，directoryPicker 报告当前 kind。 */
function fakeCtx({ kind = "native", failCreateOn = null } = {}) {
  const calls = [];
  const store = { [__PICKER_AUTO_ENTRY_ID]: { id: __PICKER_AUTO_ENTRY_ID } };
  const loader = {
    store,
    async create({ name }) {
      calls.push(`create:${name}`);
      if (failCreateOn && name === failCreateOn) throw new Error("browse 装不起来");
      const id = `dyn-${calls.length}`;
      store[id] = { id };
      return id;
    },
    async remove(id) {
      calls.push(`remove:${id}`);
      delete store[id];
    }
  };
  return {
    ctx: {
      get(name) {
        if (name === "loader") return loader;
        if (name === "directoryPicker") return { capability: () => ({ kind }) };
        return null;
      },
      logger: { info() {}, warn() {} }
    },
    calls,
    store
  };
}

const withEnv = async (value, fn) => {
  const prev = process.env.DSH_REMOTE_NATIVE_PICKER;
  if (value === undefined) delete process.env.DSH_REMOTE_NATIVE_PICKER;
  else process.env.DSH_REMOTE_NATIVE_PICKER = value;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.DSH_REMOTE_NATIVE_PICKER;
    else process.env.DSH_REMOTE_NATIVE_PICKER = prev;
  }
};

test("★ 原生(native)→ 换成 browse：先建 browse 那一对,再摘 auto 条目", async () => {
  const { ctx, calls, store } = fakeCtx({ kind: "native" });
  const state = await withEnv(undefined, () => __pinBrowseDirectoryPicker(ctx, { attempts: 1, gapMs: 1 }));

  assert.deepEqual(calls, [
    `create:${__PICKER_BROWSE_PACKAGES[0]}`,
    `create:${__PICKER_BROWSE_PACKAGES[1]}`,
    `remove:${__PICKER_AUTO_ENTRY_ID}`
  ], "顺序必须是「先建 browse、后摘 auto」——反过来一旦建失败,用户就没有选择器了");
  assert.equal(store[__PICKER_AUTO_ENTRY_ID], undefined, "auto 条目应被摘除（它的析构会卸掉 native 那对）");
  assert.equal(state.action, "pinned");
  assert.equal(state.kind, "browse");
  assert.match(state.detail, /远程/, "详情要写明为什么改（远程看不到原生对话框）");
});

test("已经是 browse → 完全不干预（自建部署 / 绑了 0.0.0.0 的场景）", async () => {
  const { ctx, calls } = fakeCtx({ kind: "browse" });
  const state = await withEnv(undefined, () => __pinBrowseDirectoryPicker(ctx, { attempts: 1, gapMs: 1 }));
  assert.deepEqual(calls, [], "不得创建、也不得摘除任何条目");
  assert.equal(state.action, "none");
});

test("★ browse 装不起来 → 原样保留原生(宁可原生可用,也不能让选择器消失)", async () => {
  const { ctx, calls, store } = fakeCtx({ kind: "native", failCreateOn: __PICKER_BROWSE_PACKAGES[0] });
  const state = await withEnv(undefined, () => __pinBrowseDirectoryPicker(ctx, { attempts: 1, gapMs: 1 }));
  assert.ok(!calls.some((c) => c.startsWith(`remove:${__PICKER_AUTO_ENTRY_ID}`)), "摘 auto 必须发生在 browse 建成之后");
  assert.ok(store[__PICKER_AUTO_ENTRY_ID], "auto 条目必须还在");
  assert.equal(state.action, "kept_native");
  assert.match(state.detail, /保留原生/);
});

test("第二个 browse 包失败 → 回滚已建的那个,并保留原生", async () => {
  const { ctx, calls, store } = fakeCtx({ kind: "native", failCreateOn: __PICKER_BROWSE_PACKAGES[1] });
  const state = await withEnv(undefined, () => __pinBrowseDirectoryPicker(ctx, { attempts: 1, gapMs: 1 }));
  assert.equal(calls[0], `create:${__PICKER_BROWSE_PACKAGES[0]}`);
  assert.equal(calls[1], `create:${__PICKER_BROWSE_PACKAGES[1]}`);
  assert.ok(calls[2] && calls[2].startsWith("remove:"), "失败后必须回滚刚建的宿主");
  assert.ok(store[__PICKER_AUTO_ENTRY_ID], "auto 条目必须还在");
  assert.equal(state.action, "kept_native");
});

test("DSH_REMOTE_NATIVE_PICKER=1 → 整体退出，保留系统原生对话框", async () => {
  const { ctx, calls } = fakeCtx({ kind: "native" });
  const state = await withEnv("1", () => __pinBrowseDirectoryPicker(ctx, { attempts: 1, gapMs: 1 }));
  assert.deepEqual(calls, []);
  assert.equal(state.action, "skipped");
  assert.match(state.detail, /DSH_REMOTE_NATIVE_PICKER/);
});

test("服务还没挂上(kind 未知)→ 不抛错、按 skipped 收尾", async () => {
  const { ctx, calls } = fakeCtx({ kind: "" });
  const state = await withEnv(undefined, () => __pinBrowseDirectoryPicker(ctx, { attempts: 1, gapMs: 1 }));
  assert.deepEqual(calls, []);
  assert.equal(state.action, "skipped");
});

test("没有 loader 服务 / ctx.get 抛错 → 静默跳过（绝不把宿主拖挂）", async () => {
  const noLoader = { get: () => null, logger: { info() {}, warn() {} } };
  const throwing = { get() { throw new Error("ctx destroyed"); }, logger: {} };
  const a = await __pinBrowseDirectoryPicker(noLoader, { attempts: 1, gapMs: 1 });
  const b = await __pinBrowseDirectoryPicker(throwing, { attempts: 1, gapMs: 1 });
  assert.equal(a.action, "skipped");
  assert.equal(b.action, "skipped");
});

test("诊断面板必须显示目录选择器状态(这类'按钮没反应'才能一眼定位)", () => {
  assert.match(SRC, /`目录选择器: \$\{/, "诊断行缺失");
  assert.match(SRC, /系统原生（远程时对话框弹在电脑那台机器上/, "原生时要给出可操作的解释");
});

test("接线:apply 里挂了选择器固定（eff/effect），并且是 fire-and-forget 不阻塞装载", () => {
  assert.match(SRC, /ctx\.effect\(\(\) => \{[\s\S]{0,200}?pinBrowseDirectoryPicker\(ctx\)[\s\S]{0,120}?\}, "dsh-remote-web: pin browser directory picker"\);/);
});
