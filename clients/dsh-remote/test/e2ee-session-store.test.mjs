#!/usr/bin/env node
/**
 * E2EE 会话库（加密落盘 / 重启恢复 / 失效路径）回归（2026-10-23）。
 *
 * 生产事故（手机反复撞死票，主因链 #2）：
 *   e2ee-client.mjs 的 sessions 只是内存 Map（24h 滑动 TTL）。bridge 重启/崩一次，
 *   手机端保存的 sessId 就全成死票：HTTP 502 unknown_session、数据 WS 1008
 *   e2ee_session_locked，用户必须回设备列表重新解锁（实测某设备 3964 次）。
 *
 * 方案（本文件锁住）：
 *   ① 会话材料用 MK 派生的 storeKey 做 AES-256-GCM 加密后落 relay 数据目录
 *      `.e2ee-sessions.enc`（0600、原子写）；文件里**没有** MK/SHK 明文/密码；
 *   ② bridge 重启后恢复会话（含 verified 与 ctrl 防重放计数），手机旧票继续可用；
 *   ③ 解不开（改密/MK 变）/文件损坏/参数变化 → 丢弃文件并清空内存，返回 discarded 原因
 *      （上层据此给手机 retryable=rehandshake 信号，而不是让手机反复撞）；
 *   ④ 24h 滑动 TTL 仍生效：过期会话不恢复。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  E2eeService,
  E2eeSession,
  SESSION_STORE_FILE,
  SESSION_STORE_VERSION,
  SESSION_TTL_MS,
  clearSessionStore,
  decryptSessionStore,
  deriveSessionStoreKey,
  deriveShk,
  loadSessionStore,
  newSessId,
  randomB64,
  saveSessionStore,
  sessionStorePath
} from "../e2ee-client.mjs";

const DIRS = [];
function tmpDir() {
  const d = mkdtempSync(path.join(os.tmpdir(), "dsh-e2ee-store-"));
  DIRS.push(d);
  return d;
}
test.after(() => {
  for (const d of DIRS) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
});

const MK = Buffer.alloc(32, 9);
const SALT = "salt-store-test";
const PROFILE = "pbkdf2-sha256-600k";
const mkSvc = () => new E2eeService({ enabled: true, mk: MK, profile: PROFILE, salt: SALT, epoch: 1 });

/** 建一个"已解锁且探测通过"的会话（手机侧也留一份，便于断言加解密仍可用）。 */
function unlock(svc) {
  const sessId = newSessId();
  const a = randomB64(32);
  const { session, ack } = svc.handleHello({ v: 2, type: "e2ee-hello", role: "phone", s: sessId, a: a, salt: SALT, profile: PROFILE });
  const { shk, saltH } = deriveShk(MK, a, ack.b);
  const client = new E2eeSession({ sessId, shk, saltH, profile: PROFILE, epoch: 1 });
  const probe = client.seal({ kind: "ctrl", dir: "p2b", counter: 0, data: JSON.stringify({ p: "dsh-e2ee-probe-v1", t: 1, c: 0 }) });
  svc.handleProbe(sessId, probe);
  assert.equal(session.verified, true);
  return { sessId, client, session };
}

test("① 加密落盘：文件里没有 MK/SHK/salt 明文，权限 0600，格式可自描述", () => {
  const dir = tmpDir();
  const svc = mkSvc();
  const { sessId } = unlock(svc);
  svc.attachStore(dir, { flushMs: 0 }); // unlock 时已即时落盘；attach 再恢复一次（空目录）
  const r = svc.flushStore();
  assert.equal(r.ok, true, "落盘应成功");
  const file = sessionStorePath(dir);
  assert.equal(path.basename(file), SESSION_STORE_FILE);
  assert.ok(existsSync(file), "会话库文件应存在");
  const raw = readFileSync(file, "utf8");
  const shkB64 = svc.sessions.get(sessId).shk.toString("base64url");
  assert.ok(!raw.includes(shkB64), "★ 文件里不得出现 SHK 明文");
  assert.ok(!raw.includes(MK.toString("base64url")), "★ 文件里不得出现 MK 明文");
  assert.ok(!raw.includes(SALT), "文件里不该有 salt 明文");
  const blob = JSON.parse(raw);
  assert.equal(blob.v, SESSION_STORE_VERSION);
  assert.equal(blob.alg, "aes-256-gcm");
  assert.ok(blob.iv && blob.tag && blob.ct, "iv/tag/ct 三件套齐全");
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600, "文件权限必须是 0600");
  }
  // 解密得回 payload（密钥只由 MK 派生）
  const payload = decryptSessionStore(MK, blob);
  assert.equal(payload.salt, SALT);
  assert.equal(payload.sessions.length, 1);
  assert.equal(payload.sessions[0].s, sessId);
  // 用错误 MK 解密必须失败（信任边界：拿到文件也解不开）
  assert.throws(() => decryptSessionStore(Buffer.alloc(32, 1), blob), /store_auth_failed|无法解密/);
  svc.disposeStore();
});

test("② 重启恢复：新 E2eeService 只凭 MK + 目录恢复 verified 会话 + ctrl 计数，旧票可直接用", () => {
  const dir = tmpDir();
  const svc1 = mkSvc();
  const { sessId, client } = unlock(svc1);
  svc1.attachStore(dir, { flushMs: 0 });
  svc1.ctrlCounters.get(sessId).p2b.last = 3; // 模拟解锁后又跑过探测
  svc1.flushStore();
  svc1.disposeStore();

  // "重启"：全新服务实例，只凭 MK + 同一目录恢复
  const svc2 = mkSvc();
  const restored = svc2.attachStore(dir, { flushMs: 0 });
  assert.equal(restored.restored, 1);
  assert.equal(restored.discarded, "", "没有作废");
  const session = svc2.sessionOf(sessId);
  assert.ok(session, "★ 旧 sessId 必须仍可用（这正是持久化的目的）");
  assert.equal(session.verified, true, "verified 也要恢复（否则数据 WS 仍被判 locked）");
  assert.equal(svc2.ctrlCounters.get(sessId).p2b.last, 3, "ctrl 防重放计数必须恢复（重启不能重置）");
  // 恢复的会话密钥仍能正确解密手机端的信封（HTTP 请求）
  const plain = Buffer.from(JSON.stringify({ m: "GET", p: "/x", h: {}, b: "" }), "utf8");
  const env = client.seal({ kind: "http", dir: "p2b", counter: 1, data: plain });
  assert.doesNotThrow(() => svc2.guardHttpRequest(sessId, env), "恢复后的会话必须能过 guardHttpRequest");
  const opened = session.open({ kind: "http", dir: "p2b", env, counter: env.c });
  assert.equal(JSON.parse(opened.data.toString("utf8")).p, "/x");
  svc2.disposeStore();
});

test("③ 失效路径：MK 变了（改密）→ 丢弃文件 + 清空内存 + 返回 key_mismatch", () => {
  const dir = tmpDir();
  const svc1 = mkSvc();
  unlock(svc1);
  svc1.attachStore(dir, { flushMs: 0 });
  svc1.flushStore();
  svc1.disposeStore();

  const svc2 = new E2eeService({ enabled: true, mk: Buffer.alloc(32, 1), profile: PROFILE, salt: SALT, epoch: 1 });
  const r = svc2.attachStore(dir, { flushMs: 0 });
  assert.equal(r.restored, 0);
  assert.equal(r.discarded, "key_mismatch", "必须报告失效原因（上层据此给手机 rehandshake 信号）");
  assert.equal(svc2.sessions.size, 0, "不得把解不开的旧会话当活会话");
  assert.equal(existsSync(sessionStorePath(dir)), false, "坏文件必须删掉，别让下次继续撞");
  svc2.disposeStore();
});

test("④ 失效路径：salt 变化 → params_changed 丢弃；磁盘损坏 → corrupt/key_mismatch 丢弃", () => {
  const dir = tmpDir();
  const svc1 = mkSvc();
  unlock(svc1);
  svc1.attachStore(dir, { flushMs: 0 });
  svc1.flushStore();
  svc1.disposeStore();

  // salt 变了（服务端参数更换）→ 即便 MK 碰巧能解开也不能复用（MK 域不同）
  const svc2 = new E2eeService({ enabled: true, mk: MK, profile: PROFILE, salt: "salt-CHANGED", epoch: 1 });
  const r2 = svc2.attachStore(dir, { flushMs: 0 });
  assert.equal(r2.discarded, "params_changed");
  assert.equal(svc2.sessions.size, 0);
  assert.equal(existsSync(sessionStorePath(dir)), false);
  svc2.disposeStore();

  // 损坏文件（半截写 / 手工改）：认证失败 → 丢弃
  const dir2 = tmpDir();
  saveSessionStore(dir2, MK, { v: SESSION_STORE_VERSION, salt: SALT, profile: PROFILE, epoch: 1, sessions: [] });
  const file = sessionStorePath(dir2);
  const blob = JSON.parse(readFileSync(file, "utf8"));
  blob.ct = `${blob.ct.slice(0, 8)}${blob.ct.slice(8).replace(/[A-Za-z]/g, "Z")}`;
  writeFileSync(file, JSON.stringify(blob));
  const svc3 = mkSvc();
  const r3 = svc3.attachStore(dir2, { flushMs: 0 });
  assert.equal(r3.restored, 0);
  assert.ok(["corrupt", "key_mismatch"].includes(r3.discarded), `损坏文件必须被丢弃（实际 ${r3.discarded}）`);
  assert.equal(svc3.sessions.size, 0);
  svc3.disposeStore();

  // 完全不是 JSON
  const dir3 = tmpDir();
  writeFileSync(sessionStorePath(dir3), "not-json");
  const svc4 = mkSvc();
  assert.equal(svc4.attachStore(dir3, { flushMs: 0 }).discarded, "corrupt");
  svc4.disposeStore();
});

test("⑤ 24h 滑动 TTL 仍生效：过期会话不恢复，未过期的保留", () => {
  const dir = tmpDir();
  const now = Date.now();
  const row = (sessId, usedAt) => ({
    s: sessId,
    shk: Buffer.alloc(32, 5).toString("base64url"),
    saltH: Buffer.alloc(32, 6).toString("base64url"),
    profile: PROFILE,
    epoch: 1,
    verified: true,
    createdAt: usedAt - 1000,
    usedAt,
    p2b: -1,
    b2p: -1
  });
  const fresh = newSessId();
  const stale = newSessId();
  const nearBoundary = newSessId();
  saveSessionStore(dir, MK, {
    v: SESSION_STORE_VERSION,
    salt: SALT,
    profile: PROFILE,
    epoch: 1,
    at: now,
    sessions: [row(fresh, now - 60_000), row(stale, now - SESSION_TTL_MS - 5_000), row(nearBoundary, now - SESSION_TTL_MS + 60_000)]
  });
  const svc = mkSvc();
  const r = svc.attachStore(dir, { flushMs: 0 });
  assert.equal(r.restored, 2, "过期的那条必须被丢掉");
  assert.ok(svc.sessionOf(fresh));
  assert.ok(svc.sessionOf(nearBoundary), "TTL 内（哪怕接近边界）都要保留");
  assert.equal(svc.sessionOf(stale), null);
  svc.disposeStore();
});

test("⑥ 未启用 / 未给目录 / 目录不可写 → 静默降级（绝不因为会话库把隧道拖挂）", () => {
  const dir = tmpDir();
  const disabled = new E2eeService({ enabled: false, reason: "no_password" });
  assert.equal(disabled.attachStore(dir).skipped, "e2ee_disabled");
  assert.equal(existsSync(sessionStorePath(dir)), false, "未启用时不得写文件");

  const svc = mkSvc();
  assert.equal(svc.attachStore("").skipped, "no_dir");
  assert.deepEqual(svc.flushStore(), { ok: false, skipped: true });

  // 目录不可写（拿一个普通文件当目录）→ flush 返回 ok:false，但绝不抛
  const fileAsDir = path.join(tmpDir(), "not-a-dir");
  writeFileSync(fileAsDir, "x");
  svc.attachStore(fileAsDir, { flushMs: 0 });
  const r = svc.flushStore();
  assert.equal(r.ok, false, "写失败只返回失败，不抛");
  svc.disposeStore();
});

test("⑦ 原语契约：save→load→clear 往返；版本/AAD 域隔离；storeKey 确定性", () => {
  const dir = tmpDir();
  const payload = { v: SESSION_STORE_VERSION, salt: SALT, profile: PROFILE, epoch: 1, sessions: [{ s: newSessId(), usedAt: Date.now() }] };
  assert.equal(saveSessionStore(dir, MK, payload).ok, true);
  const loaded = loadSessionStore(dir, MK);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.payload.sessions.length, 1);
  // 换版本号 → 解不开（旧格式不能冒名顶替）
  const blob = JSON.parse(readFileSync(sessionStorePath(dir), "utf8"));
  assert.throws(() => decryptSessionStore(MK, { ...blob, v: 2 }), /会话库版本|bad_store/);
  // clear 后读回 absent
  assert.equal(clearSessionStore(dir), true);
  assert.equal(loadSessionStore(dir, MK).reason, "absent");
  // storeKey：同一个 MK 确定性一致；MK 非法直接拒绝（不静默）
  assert.deepEqual(deriveSessionStoreKey(MK), deriveSessionStoreKey(MK));
  assert.notDeepEqual(deriveSessionStoreKey(MK), deriveSessionStoreKey(Buffer.alloc(32, 1)));
  assert.throws(() => deriveSessionStoreKey(Buffer.alloc(16)), /MK 非法/);
});
