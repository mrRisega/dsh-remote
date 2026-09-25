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
 * ★ 0.6.15 修正：`native` 与 `browse` 两个后端注册的是**同一个服务名** `ctx.directoryPicker`
 *   （seam 文档：one implementation per context, loading a second throws）。所以 0.6.14 的
 *   "先建 browse、后摘 auto"**必然**抛 duplicate-service，用户看到的是插件装载报错
 *   `service "directoryPicker" has been registered`。唯一可行的顺序是**先摘 auto 再建 browse**，
 *   并在建不起来时把 auto 按原 id 装回去（回滚）。
 *
 * 这里守的是四条护栏：
 *   ① 已是 browse → 一根手指都不许动；
 *   ② **先摘 auto、后建 browse**（服务名互斥，并存不可能）；
 *   ③ browse 建不起来 → 回滚：卸掉半成品 + 把 auto 原样装回来（宁可原生可用，不能让选择器消失）；
 *   ④ 全程不抛异常（插件绝不能把 dsh web 拖挂）。
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
  __PICKER_AUTO_PACKAGE,
  __PICKER_BROWSE_PACKAGES
} from "../lib/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "lib", "index.js"), "utf8");

/**
 * 假宿主：loader 记录 create/remove 的**调用顺序**，并像真 cordis 一样维护
 * 「谁注册了 directoryPicker」——这正是 0.6.14 踩坑的地方，模型必须能复现 duplicate-service。
 */
function fakeCtx({ kind = "native", failCreateOn = null, failRemove = false } = {}) {
  const calls = [];
  const store = { [__PICKER_AUTO_ENTRY_ID]: { id: __PICKER_AUTO_ENTRY_ID, options: { id: __PICKER_AUTO_ENTRY_ID, name: __PICKER_AUTO_PACKAGE } } };
  let live = kind; // 当前挂着哪一路（服务名互斥：非空即"已注册"）
  // 只有**宿主后端**包才注册 ctx.directoryPicker；`dsh-client-ui-*-browse` 是界面半边，不占服务名。
  const isHostBackend = (name) => String(name || "").includes("dsh-host-directory-picker");
  const loader = {
    store,
    async create(options) {
      const name = options?.name || "";
      calls.push(`create:${name}`);
      if (failCreateOn && name === failCreateOn) throw new Error("browse 装不起来");
      if (isHostBackend(name) && live) throw new Error(`service "directoryPicker" has been registered`);
      const id = options?.id || `dyn-${calls.length}`;
      store[id] = { id, options: { ...options, id } };
      if (isHostBackend(name)) live = name.includes("-browse") ? "browse" : "native";
      return id;
    },
    async remove(id) {
      calls.push(`remove:${id}`);
      if (failRemove && id === __PICKER_AUTO_ENTRY_ID) throw new Error("摘不掉");
      const wasHost = isHostBackend(store[id]?.options?.name);
      delete store[id];
      if (wasHost) live = ""; // 服务名随宿主后端条目析构一起释放
    }
  };
  return {
    ctx: {
      get(name) {
        if (name === "loader") return loader;
        if (name === "directoryPicker") return live ? { capability: () => ({ kind: live }) } : null;
        return null;
      },
      logger: { info() {}, warn() {} }
    },
    calls,
    store,
    liveOf: () => live
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

test("★ 原生(native)→ 换成 browse：**先摘 auto**（释放服务名）、再建 browse 那一对", async () => {
  const { ctx, calls, store, liveOf } = fakeCtx({ kind: "native" });
  const state = await withEnv(undefined, () => __pinBrowseDirectoryPicker(ctx, { attempts: 1, gapMs: 1 }));

  assert.deepEqual(calls, [
    `remove:${__PICKER_AUTO_ENTRY_ID}`,
    `create:${__PICKER_BROWSE_PACKAGES[0]}`,
    `create:${__PICKER_BROWSE_PACKAGES[1]}`
  ], "顺序必须是「先摘 auto、后建 browse」——两个后端抢同一个 directoryPicker 服务名，反过来必抛 duplicate-service");
  assert.equal(store[__PICKER_AUTO_ENTRY_ID], undefined, "auto 条目应被摘除（它的析构会卸掉 native 那对，并释放服务名）");
  assert.equal(liveOf(), "browse", "最终挂着的必须是 browse");
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

test("★ browse 宿主装不起来 → 回滚：把 auto **按原 id** 装回来（宁可原生可用，也不能让选择器消失）", async () => {
  const { ctx, calls, store, liveOf } = fakeCtx({ kind: "native", failCreateOn: __PICKER_BROWSE_PACKAGES[0] });
  const state = await withEnv(undefined, () => __pinBrowseDirectoryPicker(ctx, { attempts: 1, gapMs: 1 }));
  assert.deepEqual(calls, [
    `remove:${__PICKER_AUTO_ENTRY_ID}`,
    `create:${__PICKER_BROWSE_PACKAGES[0]}`,
    `create:${__PICKER_AUTO_PACKAGE}`
  ], "摘了 auto 却建不起 browse 时，必须把 auto 原样装回来");
  assert.ok(store[__PICKER_AUTO_ENTRY_ID], "auto 条目必须按原 id 还原");
  assert.equal(liveOf(), "native", "还原后用户手上还有原生选择器");
  assert.equal(state.action, "kept_native");
  assert.match(state.detail, /还原原生/);
});

test("第二个 browse 包失败 → 卸掉已建的那个 + 还原 auto", async () => {
  const { ctx, calls, store, liveOf } = fakeCtx({ kind: "native", failCreateOn: __PICKER_BROWSE_PACKAGES[1] });
  const state = await withEnv(undefined, () => __pinBrowseDirectoryPicker(ctx, { attempts: 1, gapMs: 1 }));
  assert.equal(calls[0], `remove:${__PICKER_AUTO_ENTRY_ID}`);
  assert.equal(calls[1], `create:${__PICKER_BROWSE_PACKAGES[0]}`);
  assert.equal(calls[2], `create:${__PICKER_BROWSE_PACKAGES[1]}`);
  assert.ok(calls.some((c) => c.startsWith("remove:dyn-")), "失败后必须回滚刚建的宿主");
  assert.ok(store[__PICKER_AUTO_ENTRY_ID], "auto 条目必须还原");
  assert.equal(liveOf(), "native");
  assert.equal(state.action, "kept_native");
});

test("★ auto 摘不掉 → 一根手指都不许再动（不得去建 browse 撞服务名）", async () => {
  const { ctx, calls, store } = fakeCtx({ kind: "native", failRemove: true });
  const state = await withEnv(undefined, () => __pinBrowseDirectoryPicker(ctx, { attempts: 1, gapMs: 1 }));
  assert.deepEqual(calls, [`remove:${__PICKER_AUTO_ENTRY_ID}`], "摘不掉就停手，绝不继续建 browse");
  assert.ok(store[__PICKER_AUTO_ENTRY_ID], "auto 条目必须还在");
  assert.equal(state.action, "kept_native");
  assert.match(state.detail, /保留原生/);
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

test("只有 create、没有 remove 的 loader → 不许动手（半套 API 会摘了建不回来）", async () => {
  const halfLoader = { store: {}, async create() { throw new Error("不该被调用"); }, ctx: {} };
  const ctx = { get: (n) => (n === "loader" ? halfLoader : n === "directoryPicker" ? { capability: () => ({ kind: "native" }) } : null), logger: {} };
  const state = await __pinBrowseDirectoryPicker(ctx, { attempts: 1, gapMs: 1 });
  assert.equal(state.action, "skipped");
});

test("诊断面板必须显示目录选择器状态(这类'按钮没反应'才能一眼定位)", () => {
  assert.match(SRC, /`目录选择器: \$\{/, "诊断行缺失");
  assert.match(SRC, /系统原生（远程时对话框弹在电脑那台机器上/, "原生时要给出可操作的解释");
});

test("接线:apply 里挂了选择器固定（eff/effect），并且是 fire-and-forget 不阻塞装载", () => {
  assert.match(SRC, /ctx\.effect\(\(\) => \{[\s\S]{0,200}?pinBrowseDirectoryPicker\(ctx\)[\s\S]{0,120}?\}, "dsh-remote-web: pin browser directory picker"\);/);
});

test("回归锁:源码里不得再出现「先建 browse、后摘 auto」的顺序（0.6.14 的坏版本）", () => {
  const swap = SRC.slice(SRC.indexOf("async function swapAutoToBrowse"), SRC.indexOf("async function pinBrowseDirectoryPicker"));
  const iRemove = swap.indexOf("loader.remove(PICKER_AUTO_ENTRY_ID)");
  const iCreate = swap.indexOf("loader.create({ name })");
  assert.ok(iRemove > 0 && iCreate > 0, "找不到摘/建两个动作");
  assert.ok(iRemove < iCreate, "必须先摘 auto 再建 browse（两个后端注册同一个服务名）");
});
