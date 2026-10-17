#!/usr/bin/env node
/**
 * 安装/配对自检 + 配对备份/恢复（2026-10-17 真实事故，node/插件半）。
 *
 * 事故：用户本机 `~/.dsh-remote`（bridge 运行时 + **账号配对信息/设备密钥**）被误删 →
 *   · bridge 无法启动、设备离线；
 *   · 面板状态机只显示模糊的「未运行/准备中」，用户不知道该重新安装还是该重新登录。
 *
 * 本文件锁死（全部在 `mkdtemp` 临时 relayDir + 假 HOME 上，**绝不在真实 ~/.dsh-remote / ~/.dsh 上做任何写测试**）：
 *   ① 自检状态明确区分四种：全缺失 / 只缺运行时（clients/）/ 只缺配对（.dsh-config.json）/ 正常；
 *   ② 运行时缺失 → 复用既有 ensureRuntime 从插件自带 runtime/ 自愈补装（配对缺失必须用户登录，
 *      测试断言**绝不自填任何凭据** —— 补装后 .dsh-config.json 仍然不存在）；
 *   ③ 配对备份**双份**：`<relayDir>/backup/` + `<profile>/dsh-remote-web-data/config-backup/`
 *      （后者不随 relayDir 删除、也不随插件包升级消失），两处各自 600/700、各保留最近 3 份、失败静默；
 *   ④ 主配置缺失但**任一份**备份存在 → **不自动恢复**，状态提示「检测到历史配对备份（时间）」，
 *      name 带来源（`profile:<file>` / `relay:<file>`），写清「两份都在时默认优先哪份」；
 *   ⑤ 真机场景：**整个 relayDir 被删、profile 那份还在** → 状态仍提示可恢复，且能真的恢复回来；
 *   ⑥ 彻底卸载时 profile 数据目录里的第二份备份一起清掉（不把凭据副本留给"已卸载"的用户）；
 *   ⑦ 🔒 日志/状态/open API 里**绝不出现密码明文**（只出现文件名与时间）。
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// 必须在 import 之前：模块加载时就读取这些环境变量（与 test:plugin 脚本同一套隔离值）
process.env.DSH_PROFILE_DIR = "";
process.env.DSH_REMOTE_TELEMETRY = "0";
process.env.DSH_RELAY_DEFAULT_API = "http://127.0.0.1:1";
process.env.DSH_RELAY_SKIP_SERVICE = "1"; // 测试隔离：不做任何真实系统操作

const mod = await import("../lib/index.js");
const {
  apply,
  __setupStateOf: setupStateOf,
  __ensureConnection: ensureConnection,
  __backupConfigFile: backupConfigFile,
  __listConfigBackups: listConfigBackups,
  __listConfigBackupsIn: listConfigBackupsIn,
  __restoreConfigBackup: restoreConfigBackup,
  __configBackupDirOf: configBackupDirOf,
  __pluginProfileDir: pluginProfileDir,
  __uninstallSelf: uninstallSelf,
  __CONFIG_BACKUP_KEEP: BACKUP_KEEP,
  __CONFIG_BACKUP_DIR: BACKUP_DIR,
  __PROFILE_DATA_DIR: PROFILE_DATA_DIR,
  __PROFILE_BACKUP_SUBDIR: PROFILE_BACKUP_SUBDIR,
  __runtimeDirPresent: runtimeDirPresent,
  __pruneConfigBackups: pruneConfigBackups,
} = mod;

const PLUGIN_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

/** 假配对密码：任何日志/状态/open API 里出现这串都算泄漏。 */
const PW = "PW_SHOULD_NEVER_LEAK_9f3c7a";
const PHONE = "13800001111";
const PRIVATE_KEY = "PRIVATE_KEY_SHOULD_NOT_LEAK";

/** 临时 relayDir + 假 HOME（绝不让任何写入落到真实用户目录）。 */
async function makeEnv() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-repair-backup-"));
  const fakeHome = path.join(root, "home");
  const relayDir = path.join(root, "relay");
  // 安全自证①：所有写操作都发生在 mkdtemp 临时目录里 —— 绝不在真实的 ~/.dsh-remote 上做写入测试
  assert.ok(relayDir.startsWith(os.tmpdir()), "测试 relayDir 必须是临时目录: " + relayDir);
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(relayDir, { recursive: true });
  const saved = {};
  for (const k of ["HOME", "DSH_RELAY_SKIP_SERVICE", "DSH_RELAY_BUNDLED_RUNTIME"]) saved[k] = process.env[k];
  process.env.HOME = fakeHome;
  process.env.DSH_RELAY_SKIP_SERVICE = "1";
  return {
    root, fakeHome, relayDir,
    /** 第二份备份目录（profile 下的独立数据目录；随假 HOME 落在临时目录）。 */
    profileBackup() { return configBackupDirOf(relayDir, "profile"); },
    relayBackup() { return configBackupDirOf(relayDir, "relay"); },
    async restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** 写一份"配对完成"的 .dsh-config.json（内容含明文密码 → 用于断言绝不泄漏）。 */
function writePairingConfig(relayDir, extra = {}) {
  const cfg = {
    phone: PHONE,
    password: PW,
    device_id: "dev-repair-backup",
    device_private_key: PRIVATE_KEY,
    api_url: "http://127.0.0.1:1",
    ...extra,
  };
  writeFileSync(path.join(relayDir, ".dsh-config.json"), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  chmodSync(path.join(relayDir, ".dsh-config.json"), 0o600);
  return cfg;
}

/** 造出"运行时存在"的最小现场（自检只看 clients/ 在不在；不需要可执行内容）。 */
function writeRuntimeDir(relayDir) {
  mkdirSync(path.join(relayDir, "clients", "dsh-remote"), { recursive: true });
  writeFileSync(path.join(relayDir, "dsh-setup.mjs"), "// runtime stub（自检只看文件是否齐全）\n");
}

/** 造出"插件自带运行环境"（自愈补装源）：ensureRuntime 会把它整份拷到 relayDir。 */
function writeBundledRuntime(dir) {
  mkdirSync(path.join(dir, "clients", "dsh-remote"), { recursive: true });
  writeFileSync(path.join(dir, "dsh-setup.mjs"), "// bundled runtime stub（测试用最小形态）\n");
  writeFileSync(path.join(dir, "clients", "dsh-remote", "dsh-bridge.mjs"), "// bridge stub\n");
}

/** 在一处备份目录里手工放一份历史备份（模拟"上次配对成功时留下的那一份"）。 */
function writeManualBackup(dir, file, cfg) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, file), JSON.stringify(cfg), { mode: 0o600 });
  chmodSync(path.join(dir, file), 0o600);
}

const readLog = (relayDir) => {
  try { return readFileSync(path.join(relayDir, ".dsh-setup-install.log"), "utf8"); } catch { return ""; }
};
const mainConfigOf = (relayDir) => JSON.parse(readFileSync(path.join(relayDir, ".dsh-config.json"), "utf8"));

// ══════════════════════════════════════════════════════════════════════════════
// ① 自检状态：四种状态必须明确、可区分
// ══════════════════════════════════════════════════════════════════════════════

test("自检·全缺失（~/.dsh-remote 被整目录删除）：同时说清「运行环境缺失」与「未配对」", async () => {
  const env = await makeEnv();
  try {
    const st = setupStateOf(env.relayDir);
    assert.equal(st.kind, "all_missing", "运行时与配对都不在 → all_missing");
    assert.equal(st.runtimePresent, false);
    assert.equal(st.configPresent, false);
    assert.match(st.text, /运行环境缺失：需要重新安装（应用内插件页重装或 npx @mrrisega\/dsh-remote@latest）/,
      "必须明确告诉用户「要重新安装」，并给出两条安装路径");
    assert.match(st.text, /未配对：需要在面板里登录一次（账号密码），登录后会自动重建运行环境并启动 bridge/,
      "必须明确告诉用户「要登录一次」");
    assert.equal(st.backup, null, "没有备份时不得给出恢复动作");
  } finally { await env.restore(); }
});

test("自检·只缺运行时（clients/ 不在，配对还在）：只说重新安装，不误导去登录", async () => {
  const env = await makeEnv();
  try {
    writePairingConfig(env.relayDir);
    const st = setupStateOf(env.relayDir);
    assert.equal(st.kind, "runtime_missing");
    assert.equal(st.runtimePresent, false);
    assert.equal(st.configPresent, true);
    assert.match(st.text, /运行环境缺失：需要重新安装/);
    assert.ok(!/未配对/.test(st.text), "配对还在时不得提示登录（会把人引到错误动作上）");
    assert.match(st.detail, /自动补装|重新安装/, "detail 要说明插件会先尝试自动补装");
  } finally { await env.restore(); }
});

test("自检·只缺配对（.dsh-config.json 不在，运行时还在）：只说登录，不误导去重装", async () => {
  const env = await makeEnv();
  try {
    writeRuntimeDir(env.relayDir);
    const st = setupStateOf(env.relayDir);
    assert.equal(st.kind, "pairing_missing");
    assert.equal(st.runtimePresent, true);
    assert.equal(st.configPresent, false);
    assert.match(st.text, /未配对：需要在面板里登录一次（账号密码）/);
    assert.ok(!/运行环境缺失/.test(st.text), "运行时还在时不得提示重装");
    assert.match(st.detail, /绝不自动填入任何凭据/, "安全边界要写进状态说明");
  } finally { await env.restore(); }
});

test("自检·正常：kind=ok 且无任何提示文案（不制造噪音）", async () => {
  const env = await makeEnv();
  try {
    writeRuntimeDir(env.relayDir);
    writePairingConfig(env.relayDir);
    const st = setupStateOf(env.relayDir);
    assert.equal(st.kind, "ok");
    assert.equal(st.runtimePresent, true);
    assert.equal(st.configPresent, true);
    assert.equal(st.text, "");
    assert.equal(st.detail, "");
    assert.equal(st.backup, null);
  } finally { await env.restore(); }
});

// ══════════════════════════════════════════════════════════════════════════════
// ② 运行时自愈：复用既有 ensureRuntime（不动既有逻辑，只放宽"未登录也能补装"）
// ══════════════════════════════════════════════════════════════════════════════

test("自愈：全缺失时 ensureConnection 用插件自带 runtime/ 补回运行时；配对绝不自填任何凭据", async () => {
  const env = await makeEnv();
  try {
    const bundled = path.join(env.root, "bundled-runtime");
    writeBundledRuntime(bundled);
    process.env.DSH_RELAY_BUNDLED_RUNTIME = bundled;
    delete process.env.DSH_RELAY_SKIP_SERVICE; // 走真实分支（只做本地拷贝，不联网）
    assert.equal(runtimeDirPresent(env.relayDir), false, "前提：运行时缺失");

    const r = ensureConnection(env.relayDir);
    assert.equal(r && r.action, "provision", "未登录 + 运行时缺失 → 先自愈补装运行环境（旧实现会直接 return null）");

    assert.equal(runtimeDirPresent(env.relayDir), true, "运行时目录应被补回");
    assert.ok(existsSync(path.join(env.relayDir, "clients", "dsh-remote", "dsh-bridge.mjs")), "bridge 本体应就位");
    assert.equal(readFileSync(path.join(env.relayDir, ".dsh-setup-version"), "utf8").trim(), PLUGIN_VERSION,
      "运行时版本标记应等于插件版本");
    // ★ 安全红线：配对缺失必须由用户登录 —— 补装绝不创建/写入任何凭据
    assert.equal(existsSync(path.join(env.relayDir, ".dsh-config.json")), false,
      "自愈补装绝不能自动创建配对配置（那等于伪造账号）");
    assert.equal(setupStateOf(env.relayDir).kind, "pairing_missing",
      "补装完成后仍应如实报告「未配对」，引导用户登录");
  } finally { await env.restore(); }
});

// ══════════════════════════════════════════════════════════════════════════════
// ③ 配对备份（双份）：600/700、各保留 3 份、失败静默、日志绝不写内容
// ══════════════════════════════════════════════════════════════════════════════

test("双份备份：relay + profile 两处都生成 600 文件（目录 700），内容与配置一致，日志只写文件名", async () => {
  const env = await makeEnv();
  try {
    const cfg = writePairingConfig(env.relayDir);
    const r = backupConfigFile(env.relayDir);
    assert.equal(r.ok, true, "有配置时必须备份成功");
    assert.ok(r.sources && r.sources.relay, "应写入配置目录那一份");
    assert.ok(r.sources && r.sources.profile, "应**同时**写入 profile 持久目录那一份（这次事故的核心：relayDir 可能整个被删）");
    for (const [source, file] of [["relay", r.sources.relay], ["profile", r.sources.profile]]) {
      const dir = configBackupDirOf(env.relayDir, source);
      const filePath = path.join(dir, file);
      assert.ok(existsSync(filePath), `${source} 备份文件应存在: ${filePath}`);
      const dirMode = statSync(dir).mode & 0o777;
      assert.equal(dirMode & 0o077, 0, `${source} 备份目录权限必须是 700（含明文密码/设备私钥），实际 ${dirMode.toString(8)}`);
      const fileMode = statSync(filePath).mode & 0o777;
      assert.equal(fileMode & 0o077, 0, `${source} 备份文件权限必须是 600，实际 ${fileMode.toString(8)}`);
      assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")), cfg, `${source} 备份内容必须与当时配置一致（可恢复）`);
    }
    assert.equal(r.name, `profile:${r.sources.profile}`, "默认恢复应优先 profile 那份（name 带来源，可区分）");
    // 日志里只有文件名与时间，绝无内容
    const log = readLog(env.relayDir);
    assert.ok(log.includes(`relay:${r.sources.relay}`), "日志应记录配置目录那份文件名（便于排查）");
    assert.ok(log.includes(`profile:${r.sources.profile}`), "日志应记录持久目录那份文件名");
    assert.ok(!log.includes(PW), "🔒 日志绝不能出现密码明文");
    assert.ok(!log.includes(PRIVATE_KEY), "🔒 日志绝不能出现设备私钥");
    assert.ok(!log.includes(PHONE), "日志不得记录明文手机号");
  } finally { await env.restore(); }
});

test("双份备份：每处各保留最近 3 份（更老的自动清理，两个目录都成立）", async () => {
  const env = await makeEnv();
  try {
    writePairingConfig(env.relayDir);
    for (let i = 0; i < 5; i += 1) {
      writePairingConfig(env.relayDir, { device_id: "dev-repair-backup-" + i });
      const r = backupConfigFile(env.relayDir);
      assert.equal(r.ok, true);
      await new Promise((res) => setTimeout(res, 2)); // 拉开 mtime，模拟真实时间线
    }
    pruneConfigBackups(env.relayDir); // 幂等：重复清理不报错
    assert.equal(BACKUP_KEEP, 3, "保留份数常量应为 3");
    for (const source of ["relay", "profile"]) {
      const kept = listConfigBackupsIn(env.relayDir, source);
      assert.equal(kept.length, 3, `${source} 目录只保留最近 3 份，实际：${kept.map((b) => b.name).join(",")}`);
    }
    const merged = listConfigBackups(env.relayDir);
    assert.equal(merged.length, 6, "两份来源合并后共 6 条（每份各 3）");
    // 两份来源的 name 都可区分
    const names = merged.map((b) => b.name);
    assert.equal(new Set(names).size, names.length, "同名文件在两份来源里也要靠 name 前缀区分");
    // 每份来源的最新一份都在（按 mtime 最新那条必须属于最后写入的那批）
    for (const source of ["relay", "profile"]) {
      const newest = listConfigBackupsIn(env.relayDir, source)[0];
      assert.ok(newest && newest.name.startsWith(source + ":"), `${source} 最新一份应存在且带来源前缀`);
    }
  } finally { await env.restore(); }
});

test("备份失败静默：单点失败不影响另一份；两处都失败也不抛异常（不影响安装/登录）", async () => {
  const env = await makeEnv();
  try {
    writePairingConfig(env.relayDir);
    // 情形一：配置目录那份写不了（BACKUP_DIR 被占成普通文件）→ profile 那份仍应成功
    writeFileSync(env.relayBackup(), "not a directory");
    let partial;
    assert.doesNotThrow(() => { partial = backupConfigFile(env.relayDir); }, "单点失败不得抛异常");
    assert.equal(partial.ok, true, "两份里成功一份就算成功（另一份坏掉不应让整个备份失败）");
    assert.ok(partial.sources.profile, "profile 那份应写成");
    assert.equal(partial.sources.relay, undefined, "配置目录那份应如实报告未写成");

    // 情形二：两处都失败 → 静默返回 ok:false（绝不抛）
    const env2 = await makeEnv();
    try {
      writePairingConfig(env2.relayDir);
      writeFileSync(env2.relayBackup(), "not a directory");
      mkdirSync(path.join(pluginProfileDir(), PROFILE_DATA_DIR), { recursive: true });
      writeFileSync(path.join(pluginProfileDir(), PROFILE_DATA_DIR, PROFILE_BACKUP_SUBDIR), "not a directory");
      let all;
      assert.doesNotThrow(() => { all = backupConfigFile(env2.relayDir); }, "两份都失败也必须静默");
      assert.equal(all.ok, false);
      assert.equal(all.reason, "failed");
      // 还没有配置时也是静默 no-op（不建目录、不抛错）
      const none = backupConfigFile(path.join(env.root, "empty-relay-dir"));
      assert.equal(none.ok, false);
      assert.equal(none.reason, "no-config", "还没配对：无可备份（静默跳过）");
    } finally { await env2.restore(); }
  } finally { await env.restore(); }
});

// ══════════════════════════════════════════════════════════════════════════════
// ④ 有备份、主配置缺失：不自动恢复 + 状态提示 + 一键恢复（恢复前先备份当前状态）
// ══════════════════════════════════════════════════════════════════════════════

test("有备份、主配置缺失：**不自动恢复**，状态里提示备份时间/来源并给出恢复动作", async () => {
  const env = await makeEnv();
  try {
    writeRuntimeDir(env.relayDir);
    // 手工造一份历史备份（模拟"上次配对成功时留下的备份"）
    const oldCfg = { phone: PHONE, password: PW, device_id: "dev-old-account", api_url: "http://127.0.0.1:1" };
    const name = "dsh-config-2026-10-17T09-30-00-000Z.json";
    writeManualBackup(env.relayBackup(), name, oldCfg);

    const st = setupStateOf(env.relayDir);
    assert.equal(st.kind, "pairing_missing", "主配置不在 → 未配对");
    assert.ok(st.backup && st.backup.available, "应检测到历史配对备份");
    assert.equal(st.backup.source, "relay", "这份来自配置目录");
    assert.equal(st.backup.name, `relay:${name}`, "name 必须带来源前缀（profile:/relay:），可区分");
    assert.match(st.backup.text, /检测到历史配对备份（/, "提示里要带「检测到历史配对备份（时间）」");
    assert.match(st.backup.text, /可一键恢复/, "提示要明确可一键恢复");
    assert.equal(st.backup.action.kind, "restore_config");
    assert.equal(st.backup.action.method, "POST");
    assert.equal(st.backup.action.path, "/dsh-remote/config/restore", "恢复动作必须指向真实路由");
    assert.deepEqual(st.backup.action.body, { backup: `relay:${name}` });

    // ★ 关键：只是"检测到"，绝不自动恢复
    assert.equal(existsSync(path.join(env.relayDir, ".dsh-config.json")), false,
      "发现备份时**不得自动恢复**（旧账号可能是别人的/已失效，误用会把设备绑到错误账号）");
    // 🔒 状态对象里不得带任何凭据内容
    const json = JSON.stringify(st);
    assert.ok(!json.includes(PW), "🔒 状态里绝不能出现密码明文");
    assert.ok(!json.includes(PRIVATE_KEY), "🔒 状态里绝不能出现设备私钥");
  } finally { await env.restore(); }
});

test("一键恢复：内容回到主配置、权限 600；恢复前先把当前状态再备份一份（双份都可回滚）", async () => {
  const env = await makeEnv();
  try {
    writeRuntimeDir(env.relayDir);
    const oldCfg = { phone: PHONE, password: PW, device_id: "dev-old-account", api_url: "http://127.0.0.1:1" };
    const name = "dsh-config-2026-10-17T09-30-00-000Z.json";
    writeManualBackup(env.relayBackup(), name, oldCfg);
    await new Promise((res) => setTimeout(res, 2));
    // 主配置是"新状态"（比如用户后来重新登录后写的）→ 恢复前必须能找回它
    const newCfg = writePairingConfig(env.relayDir, { device_id: "dev-new-account" });

    const r = restoreConfigBackup(env.relayDir, name); // 裸文件名（兼容旧状态）也要能恢复
    assert.equal(r.ok, true, "恢复应成功");
    assert.equal(r.restored, `relay:${name}`);
    assert.equal(r.source, "relay");
    assert.deepEqual(mainConfigOf(env.relayDir), oldCfg, "主配置内容应恢复为备份内容");
    const mode = statSync(path.join(env.relayDir, ".dsh-config.json")).mode & 0o777;
    assert.equal(mode & 0o077, 0, `恢复后的主配置权限必须是 600，实际 ${mode.toString(8)}`);

    // 恢复前把当前状态再备份了一份 —— 两个目录里都应能找到（回滚点）
    for (const source of ["relay", "profile"]) {
      const found = listConfigBackupsIn(env.relayDir, source).find((b) => {
        try {
          return JSON.stringify(JSON.parse(readFileSync(path.join(configBackupDirOf(env.relayDir, source), b.file), "utf8"))) === JSON.stringify(newCfg);
        } catch { return false; }
      });
      assert.ok(found, `${source} 目录里应能找到「恢复前的当前状态」以便回滚`);
    }
    const log = readLog(env.relayDir);
    assert.match(log, /一键恢复配对配置/, "恢复动作应留痕（只写文件名/时间/来源）");
    assert.ok(log.includes(`relay:${name}`), "日志应写恢复源的 name");
    assert.ok(!log.includes(PW), "🔒 恢复日志绝不能出现密码明文");
  } finally { await env.restore(); }
});

test("一键恢复：不存在的文件名 / 路径穿越（含 profile:relay: 前缀形态）必须被拒绝", async () => {
  const env = await makeEnv();
  try {
    writeRuntimeDir(env.relayDir);
    const name = "dsh-config-2026-10-17T09-30-00-000Z.json";
    writeManualBackup(env.relayBackup(), name, { phone: PHONE });

    for (const bad of [
      "../../../etc/passwd",
      "profile:../../../etc/passwd",
      "relay:../../etc/passwd",
      "profile:" + name.replace(/\.json$/, "-nope.json"),
      "relay:/etc/passwd",
    ]) {
      const r = restoreConfigBackup(env.relayDir, bad);
      assert.equal(r.ok, false, "非法备份引用必须被拒绝: " + bad);
      assert.equal(r.reason, "no-such-backup", "应报 no-such-backup: " + bad);
    }
    assert.equal(existsSync(path.join(env.relayDir, ".dsh-config.json")), false, "拒绝时不得写主配置");
    // 一份备份都没有时
    const env2 = await makeEnv();
    try {
      const none = restoreConfigBackup(env2.relayDir);
      assert.equal(none.ok, false);
      assert.equal(none.reason, "no-backup");
    } finally { await env2.restore(); }
  } finally { await env.restore(); }
});

// ══════════════════════════════════════════════════════════════════════════════
// ⑤ 真机事故的核心场景：**整个 relayDir 被删，profile 那份还在**
// ══════════════════════════════════════════════════════════════════════════════

test("★ 整个 ~/.dsh-remote 被删（relayDir 没了）→ profile 持久目录那份仍在：状态提示可恢复且能真的恢复", async () => {
  const env = await makeEnv();
  try {
    writeRuntimeDir(env.relayDir);
    const cfg = writePairingConfig(env.relayDir);
    const r = backupConfigFile(env.relayDir);
    assert.ok(r.sources.profile, "前提：profile 持久目录那份已写好");
    const profileFile = path.join(configBackupDirOf(env.relayDir, "profile"), r.sources.profile);
    assert.ok(existsSync(profileFile));

    // —— 真机事故：用户把整个配置目录（运行时 + 配对 + relayDir 内备份）一起删掉 ——
    rmSync(env.relayDir, { recursive: true, force: true });
    assert.equal(existsSync(env.relayDir), false, "前提：整个 relayDir 已不存在");

    const st = setupStateOf(env.relayDir);
    assert.equal(st.kind, "all_missing", "运行时与配对都随目录消失");
    assert.ok(st.backup && st.backup.available,
      "★ 整个 relayDir 被删后仍必须能从 profile 持久目录发现备份（这正是本次加固要解决的边界）");
    assert.equal(st.backup.source, "profile");
    assert.match(st.backup.name, /^profile:dsh-config-/, "name 必须标明来源 profile");
    assert.match(st.backup.text, /插件持久目录/, "提示里要说明这份来自插件持久目录");
    assert.equal(st.backup.action.body.backup, st.backup.name, "恢复动作要带上这份的具体 name");

    // 状态查询本身绝不自动恢复
    assert.equal(existsSync(path.join(env.relayDir, ".dsh-config.json")), false);

    // 一键恢复：relayDir 会被重建，配对信息回来，权限 600
    const restored = restoreConfigBackup(env.relayDir);
    assert.equal(restored.ok, true, "★ 必须能真的从 profile 那份恢复回来");
    assert.equal(restored.source, "profile");
    assert.deepEqual(mainConfigOf(env.relayDir), cfg, "恢复出的配对信息必须与备份一致");
    const mode = statSync(path.join(env.relayDir, ".dsh-config.json")).mode & 0o777;
    assert.equal(mode & 0o077, 0, "恢复后的主配置权限必须是 600");
    assert.ok(existsSync(profileFile), "恢复不应消耗/删除那份备份（还能再回滚）");
    assert.equal(setupStateOf(env.relayDir).backup, null, "主配置回来后不再提示恢复（configPresent=true）");
  } finally { await env.restore(); }
});

test("两份都在：name 可区分（profile:/relay:）、清单都可见；默认恢复优先 profile，显式 relay: 仍可恢复指定那份", async () => {
  const env = await makeEnv();
  try {
    writeRuntimeDir(env.relayDir);
    const cfg = writePairingConfig(env.relayDir);
    const r = backupConfigFile(env.relayDir);
    const relayFile = r.sources.relay;
    const profileFile = r.sources.profile;
    assert.equal(relayFile, profileFile, "同一次写入，两处文件名相同（时间戳一致）");

    // 让两份内容不同：把 relay 那份改成"另一个历史状态"（模拟旧版只写 relay / 手工恢复过的历史）
    const relayVariant = { phone: PHONE, password: PW, device_id: "dev-relay-only-variant", api_url: "http://127.0.0.1:1" };
    const relayPath = path.join(configBackupDirOf(env.relayDir, "relay"), relayFile);
    writeFileSync(relayPath, JSON.stringify(relayVariant));
    // 恢复原 mtime，保证"两份时间相同"→ 默认优先级由来源决定（profile 胜）
    utimesSync(relayPath, new Date(r.at), new Date(r.at));
    rmSync(path.join(env.relayDir, ".dsh-config.json")); // 让 backup 提示出现

    const st = setupStateOf(env.relayDir);
    assert.equal(st.backup.name, `profile:${profileFile}`, "两份都在时默认选中 profile 那份");
    assert.equal(st.backup.source, "profile");
    assert.ok(Array.isArray(st.backup.sources) && st.backup.sources.length === 2, "状态里应能看到两份清单");
    assert.deepEqual(st.backup.sources.map((s) => s.name).sort(),
      [`profile:${profileFile}`, `relay:${relayFile}`].sort(), "两份 name 必须可区分");

    // 默认恢复（不带 name）→ profile 内容（不是 relay variant）
    const dflt = restoreConfigBackup(env.relayDir);
    assert.equal(dflt.ok, true);
    assert.equal(dflt.source, "profile");
    assert.deepEqual(mainConfigOf(env.relayDir), cfg, "默认恢复必须用 profile 那份（时间相同时 profile 优先：抗整目录删除）");

    // 显式指定 relay: 前缀 → 恢复 relay variant
    const byRelay = restoreConfigBackup(env.relayDir, `relay:${relayFile}`);
    assert.equal(byRelay.ok, true, "显式 relay: 也必须能恢复（用户可能明确要另一份）");
    assert.equal(byRelay.source, "relay");
    assert.equal(byRelay.restored, `relay:${relayFile}`);
    assert.deepEqual(mainConfigOf(env.relayDir), relayVariant, "显式 relay: 应恢复到 relay 那份内容");
  } finally { await env.restore(); }
});

// ══════════════════════════════════════════════════════════════════════════════
// ⑥ 卸载：profile 数据目录里的第二份配对备份必须一起清掉
// ══════════════════════════════════════════════════════════════════════════════

test("★ 彻底卸载：profile 数据目录里的第二份配对备份一起删（不把账号密钥副本留给已卸载的用户）", async () => {
  const env = await makeEnv();
  try {
    const profileDir = pluginProfileDir();
    assert.ok(profileDir.startsWith(env.fakeHome), "安全自证②：profile 目录必须落在假 HOME 里，实际 " + profileDir);
    const dataDir = path.join(profileDir, PROFILE_DATA_DIR, PROFILE_BACKUP_SUBDIR);
    writeManualBackup(dataDir, "dsh-config-2026-10-17T09-30-00-000Z.json", { phone: PHONE, password: PW });
    mkdirSync(path.join(profileDir, "dsh-remote-web-plugin"), { recursive: true });

    const out = uninstallSelf(
      env.relayDir, profileDir,
      path.join(profileDir, "cordis.patch.yml"),
      path.join(profileDir, "package.json"),
    );
    assert.equal(out.removedDir, true);
    assert.equal(existsSync(path.join(profileDir, "dsh-remote-web-plugin")), false, "插件目录应被移除");
    assert.equal(existsSync(path.join(profileDir, PROFILE_DATA_DIR)), false,
      "★ 彻底卸载必须清掉 profile 数据目录（里面是账号密码/设备私钥的第二份备份）");
  } finally { await env.restore(); }
});

// ══════════════════════════════════════════════════════════════════════════════
// ⑦ 对外状态（open API）：/status 与 /bridge-status 下发 setup；恢复走真实路由
// ══════════════════════════════════════════════════════════════════════════════

/** 装载插件路由（收集 disposer，避免自愈定时器跨用例继续跑）。 */
function boot(relayDir) {
  const routes = new Map();
  const disposers = [];
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { const d = register(); if (typeof d === "function") disposers.push(d); return d; },
    logger: { info() {}, warn() {} },
  }, { relayDir });
  routes.dispose = () => { for (const d of disposers) { try { d(); } catch { /* 忽略 */ } } };
  return routes;
}

async function serve(routes) {
  const host = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, "http://x").pathname);
    (handler || ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  return { host, base: `http://127.0.0.1:${host.address().port}` };
}

test("open API：/status 与 /bridge-status 都下发 setup；只有 profile 那份备份时，恢复路由照样能把配对救回来", async () => {
  const env = await makeEnv();
  try {
    // 现场：relayDir 里既没运行时也没配对，**只有 profile 持久目录那份历史备份**
    const name = "dsh-config-2026-10-17T09-30-00-000Z.json";
    const oldCfg = { phone: PHONE, password: PW, device_id: "dev-old", api_url: "http://127.0.0.1:1" };
    writeManualBackup(configBackupDirOf(env.relayDir, "profile"), name, oldCfg);
    assert.equal(existsSync(env.relayDir), true, "relayDir 壳还在（但里面空）");
    assert.equal(existsSync(path.join(env.relayDir, "clients")), false);

    const routes = boot(env.relayDir);
    const srv = await serve(routes);
    try {
      const st = await (await fetch(`${srv.base}/dsh-remote/status`)).json();
      assert.equal(st.ok, true);
      assert.ok(st.setup, "/status 必须下发 setup（面板据此显示「需要重新安装/登录」）");
      assert.equal(st.setup.kind, "all_missing", "运行时与配对都不在");
      assert.match(st.setup.text, /运行环境缺失/);
      assert.match(st.setup.text, /未配对/);
      assert.equal(st.setup.backup.available, true, "仅 profile 有备份时也必须 available");
      assert.equal(st.setup.backup.source, "profile");
      assert.equal(st.setup.backup.name, `profile:${name}`);
      assert.equal(existsSync(path.join(env.relayDir, ".dsh-config.json")), false, "查询状态绝不自动恢复备份");

      const bs = await (await fetch(`${srv.base}/dsh-remote/bridge-status`)).json();
      assert.equal(bs.ok, true);
      assert.ok(bs.connect.setup, "/bridge-status 也要下发同一份 setup（2~3s 短轮询可以看到）");
      assert.equal(bs.connect.setup.kind, "all_missing");
      assert.match(String(bs.connect.detail), /运行环境缺失/, "需要用户动手的结论要前置到 detail（旧客户端也看得到）");
      assert.ok(!JSON.stringify(bs).includes(PW), "🔒 open API 响应绝不能出现密码明文");

      // 按状态里下发的 action 一字不改地调真实路由
      const action = st.setup.backup.action;
      const res = await fetch(`${srv.base}${action.path}`, {
        method: action.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action.body),
      });
      assert.equal(res.status, 200, "有备份时恢复路由应成功");
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.restored, `profile:${name}`);
      assert.deepEqual(JSON.parse(readFileSync(path.join(env.relayDir, ".dsh-config.json"), "utf8")), oldCfg,
        "真实路由恢复后主配置应等于 profile 那份备份内容");
      assert.equal(body.setup.configPresent, true, "恢复后 configPresent 应为 true");
      assert.equal(body.setup.kind, "runtime_missing",
        "恢复后 setup 应刷新：配对已回来、运行时仍缺失 → 明确提示重新安装（而不是继续说未配对）");
      assert.ok(!JSON.stringify(body).includes(PW), "🔒 恢复响应也绝不能出现密码明文");
    } finally {
      srv.host.close();
      routes.dispose();
    }
  } finally { await env.restore(); }
});
