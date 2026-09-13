/**
 * 「patch 热加载激活」契约测试（node:test，零框架）。
 *
 * 背景：harness 的 web profile 是 `patchReload: "live"`，启动时加载 `@deepseek-ai/cordis-plugin-hmr`
 * 并监听 profile 的 `cordis.patch.yml` —— 存盘后约 1 秒重新 compose 并**动态装载**插件，
 * 不需要重启 dsh web（插件市场自己就用这套机制）。而 `dsh.profile.bundles` 只在启动时读、
 * 没有 watcher，所以「bundles 激活」必须重启 —— 这正是用户装完看不到「远程控制」面板的原因。
 *
 * 因此安装器改为：**激活点 = patch 行**（热加载），bundles 那条同时移除（单一激活点，
 * 否则 dsh web 启动即报「重复 ID」崩溃）。
 *
 * 这些用例在**临时 profile**（mkdtemp）里跑真实的 `dsh-setup.mjs plugin` 子进程，
 * 断言生成的文件产物；绝不触碰开发者真实的 ~/.dsh/profiles/**。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SETUP = join(ROOT, "dsh-setup.mjs");

const PLUGIN_BUNDLES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];

/** 造一个临时 profile（默认 patch 是新 profile 的空文档占位 `[]`）。 */
function makeProfile({ patch = "# dsh profile patch\n[]\n", bundles = PLUGIN_BUNDLES } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dshac-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "dsh-profile-web", private: true, dependencies: {},
    dsh: { profile: { bundles: [...bundles], patchReload: "live" } }
  }, null, 2) + "\n");
  writeFileSync(join(dir, "cordis.patch.yml"), patch);
  return dir;
}

/** 跑真实的 plugin 安装（子进程，指向临时 profile 与临时配置目录）。stdout+stderr 一并返回。 */
function installPluginWithStderr(profileDir, relayDir) {
  const r = spawnSync(process.execPath, [SETUP, "plugin", "--profile", profileDir], {
    encoding: "utf8",
    env: { ...process.env, DSH_RELAY_DIR: relayDir, DSH_RELAY_SKIP_SERVICE: "1" }
  });
  return { out: String(r.stdout || ""), err: String(r.stderr || ""), code: r.status };
}

/** 只要 stdout（正常路径够用）。 */
function installPlugin(profileDir, relayDir) {
  const r = installPluginWithStderr(profileDir, relayDir);
  assert.equal(r.code, 0, `安装子进程应成功退出，stderr=${r.err.slice(0, 200)}`);
  return r.out;
}

function cleanup(...dirs) {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}

const readBundles = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dsh.profile.bundles;
const readPatch = (dir) => readFileSync(join(dir, "cordis.patch.yml"), "utf8");

test("patch 激活：写入 insert 行（热加载形态），并从 bundles 移除该插件（单一激活点）", () => {
  const profile = makeProfile();
  const relay = join(profile, "relay");
  try {
    installPlugin(profile, relay);
    const patch = readPatch(profile);
    assert.match(patch, /- insert:/, "应写入 insert 块");
    assert.match(patch, /- id: dsh-remote-web/, "应写入本插件的 id 行");
    assert.match(patch, /name: 'dsh-remote-web'/, "name 必须是裸包名（加载器据此 import）");
    assert.ok(!patch.includes("[]"), "空文档占位 `[]` 必须被清掉（否则整份 patch 解析失败）");
    assert.deepEqual(readBundles(profile), PLUGIN_BUNDLES, "bundles 里不能再有本插件（两处激活=重复 ID 崩溃）");
  } finally { cleanup(profile); }
});

test("patch 激活：relayDir 写的是**配置目录**而不是插件安装目录", () => {
  const profile = makeProfile();
  const relay = join(profile, "relay-config");
  mkdirSync(relay, { recursive: true });
  try {
    installPlugin(profile, relay);
    const patch = readPatch(profile);
    const m = /relayDir: '([^']+)'/.exec(patch);
    assert.ok(m, "应带 relayDir 配置");
    // 面板要读的是该目录下的 .dsh-config.json；写成插件目录会让面板显示成"未登录/空配置"
    assert.equal(m[1], relay, "relayDir 必须是配置目录");
    assert.ok(!m[1].includes("dsh-remote-web-plugin"), "relayDir 不得指向插件源码目录");
  } finally { cleanup(profile); }
});

test("patch 激活：幂等 —— 重复安装不会写出第二个 id（否则重复 ID 崩溃）", () => {
  const profile = makeProfile();
  const relay = join(profile, "relay");
  try {
    installPlugin(profile, relay);
    const first = readPatch(profile);
    installPlugin(profile, relay);
    const second = readPatch(profile);
    assert.equal(second, first, "第二次安装不应再改 patch");
    const ids = second.match(/- id: dsh-remote-web/g) || [];
    assert.equal(ids.length, 1, `id 行必须恰好一条，实际 ${ids.length}`);
  } finally { cleanup(profile); }
});

test("patch 激活：既有其它插件条目必须原样保留（不能吃掉别人的配置）", () => {
  const other = [
    "# dsh profile patch",
    "[]",
    "",
    "# --- mba-feishu managed block ---",
    "- insert:",
    "    - id: mba-feishu",
    "      name: 'mba-feishu'",
    "      config:",
    "        transport: stdio",
    "        args:",
    "          - 'mcp'",
    "# --- end mba-feishu managed block ---",
    ""
  ].join("\n");
  const profile = makeProfile({ patch: other });
  const relay = join(profile, "relay");
  try {
    installPlugin(profile, relay);
    const patch = readPatch(profile);
    assert.match(patch, /id: mba-feishu/, "其它插件的条目必须保留");
    assert.match(patch, /transport: stdio/, "其它插件的字段必须保留");
    assert.match(patch, /- 'mcp'/, "其它插件的嵌套列表必须保留");
    assert.match(patch, /# --- end mba-feishu managed block ---/, "注释块必须保留");
    assert.match(patch, /- id: dsh-remote-web/, "同时写入我们的条目");
    assert.equal((patch.match(/^- insert:/gm) || []).length, 2, "应有两个独立的 insert 块");
  } finally { cleanup(profile); }
});

test("安全护栏：patch 形态异常时**拒写**并回退 bundles（绝不把能用的 profile 弄坏）", () => {
  const broken = "# 坏 patch：顶层塞了非列表内容\nthis is not a list ===\n- insert:\n    - id: other\n      name: 'other'\n";
  const profile = makeProfile({ patch: broken });
  const relay = join(profile, "relay");
  try {
    const { out, err } = installPluginWithStderr(profile, relay);
    const all = out + err; // 警告走 stderr，必须一并检查
    assert.match(all, /无法写入 patch 激活行/, "应明确报告拒写");
    assert.match(all, /bundles 形态/, "应回退 bundles 保证功能可用");
    assert.equal(readPatch(profile), broken, "坏文件必须一字未改（拒写，不是先写再看）");
    assert.ok(readBundles(profile).includes("dsh-remote-web"), "回退时应把插件加进 bundles");
  } finally { cleanup(profile); }
});

test("安全护栏：基座含空文档占位 `[]` 时也要先清掉（否则整份 patch 解析失败）", () => {
  const profile = makeProfile({ patch: "[]\n" });
  const relay = join(profile, "relay");
  try {
    installPlugin(profile, relay);
    const patch = readPatch(profile);
    assert.ok(!/^\[\]$/m.test(patch), "占位 [] 必须被移除");
    assert.match(patch, /- id: dsh-remote-web/, "并写入我们的条目");
  } finally { cleanup(profile); }
});

test("安全护栏：原子写回 —— 不留 .tmp 残留，且末尾换行规范", () => {
  const profile = makeProfile();
  const relay = join(profile, "relay");
  try {
    installPlugin(profile, relay);
    assert.ok(!readPatch(profile).includes(".dsh-remote.tmp"), "不应把临时文件名写进内容");
    const leftovers = execFileSync("ls", ["-a", profile], { encoding: "utf8" })
      .split("\n").filter((f) => f.includes(".tmp"));
    assert.deepEqual(leftovers, [], `不应留下临时文件: ${leftovers.join(",")}`);
    assert.ok(readPatch(profile).endsWith("\n"), "文件应以换行结尾");
  } finally { cleanup(profile); }
});

test("回归护栏：plugin 子命令必须把激活结果 return 给 setup（否则热挂载验证被跳过）", () => {
  // 事故复盘：convergePluginActivation 已经返回 {hotPatch}，但 pluginCmd 没把它 return 出去，
  // 于是 setup() 拿不到激活形态 → 跳过热挂载验证 → 明明热挂载成功却仍报「需要重启」。
  const src = readFileSync(SETUP, "utf8");
  const call = src.match(/return convergePluginActivation\(profileDir[^\n]*/);
  assert.ok(call, "pluginCmd 必须 return convergePluginActivation(...) 的结果");
  // setup() 必须真的消费这个结果
  assert.match(src, /pluginResult = await pluginCmd\(\[\]\)/, "setup 应保存 pluginCmd 的返回值");
  assert.match(src, /pluginResult\.hotPatch/, "应据 hotPatch 判断是否走热挂载形态");
});

test("硬约束：插件已在 bundles 时**绝不**写 patch 行（两个激活点 = duplicate id 崩溃）", () => {
  // 事故复盘：patch 行与插件自带 bundle patch 同时生效时，dsh web 启动即
  //   TypeError: duplicate loader entry id: dsh-remote-web
  //   Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include)
  // 整个插件树加载失败（实测生产日志）。所以这两条激活路径必须互斥。
  const profile = makeProfile({ bundles: [...PLUGIN_BUNDLES, "dsh-remote-web"] });
  const relay = join(profile, "relay");
  try {
    const out = installPlugin(profile, relay);
    assert.match(out, /已由 dsh\.profile\.bundles 声明/, "应识别并保持 bundles 形态");
    assert.equal((readPatch(profile).match(/- id: dsh-remote-web/g) || []).length, 0,
      "bundles 已声明时不得再写 patch 行（否则重复 ID）");
    assert.ok(readBundles(profile).includes("dsh-remote-web"), "bundles 形态应保持");
  } finally { cleanup(profile); }
});

test("硬约束：写入 patch 行后 bundles 必须被清空（单一激活点双向收口）", () => {
  const profile = makeProfile({ bundles: [...PLUGIN_BUNDLES, "dsh-remote-web"] });
  const relay = join(profile, "relay");
  try {
    installPlugin(profile, relay);
    const patchRows = (readPatch(profile).match(/- id: dsh-remote-web/g) || []).length;
    const inBundles = readBundles(profile).filter((b) => b === "dsh-remote-web").length;
    assert.equal(patchRows + inBundles, 1, `激活点必须恰好一个：patch=${patchRows} bundles=${inBundles}`);
  } finally { cleanup(profile); }
});
