#!/usr/bin/env node
/**
 * quotas.mjs 配额令牌桶契约测试(防回归):
 *   桶速率必须跟随套餐/后台配置变化,而不是在首次创建时固化。
 *   修复前:free 试用期创建的桶速率 128KB/s 永远不升级,pro 用户实际被限在 free 档。
 *
 * 用法: node --test test/quotas.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createQuotaManager } from "../src/quotas.mjs";

const MBPS = 125_000; // 1Mbps = 125KB/s

test("bucketFor('free', 1) 速率 = 128_000(free 档 1Mbps)", () => {
  const m = createQuotaManager();
  assert.equal(m.bucketFor("free", 1).rate, 128_000);
});

test("同一用户套餐 free → pro 后桶速率跟随升级为 1_000_000(修复:不再固化首建速率)", () => {
  const m = createQuotaManager();
  const free = m.bucketFor("free", 1);
  assert.equal(free.rate, 128_000);

  const pro = m.bucketFor("pro", 1);
  assert.equal(pro.rate, 1_000_000);
  assert.notEqual(pro, free); // 是重建的新桶
  assert.equal(pro.tokens, pro.capacity); // 新桶满容量,可直接突发
});

test("后台 public-config 改限速(套餐名不变)后桶速率跟随刷新", () => {
  const m = createQuotaManager();
  const before = m.bucketFor("pro", 1);
  assert.equal(before.rate, 1_000_000);

  m.updateQuotaFromPublicConfig({ plans: { pro: { max_mbps: 4 } } });
  const after = m.bucketFor("pro", 1);
  assert.equal(after.rate, 4 * MBPS); // 4Mbps = 500KB/s
  assert.notEqual(after, before); // 是重建的新桶
});

test("不同用户桶互不影响(各自独立)", () => {
  const m = createQuotaManager();
  const u1 = m.bucketFor("free", 1);
  const u2 = m.bucketFor("pro", 2);
  assert.notEqual(u1, u2);
  assert.equal(u1.rate, 128_000);
  assert.equal(u2.rate, 1_000_000);

  // 用户 1 升级重建自己的桶,不影响用户 2 的桶实例
  const u1b = m.bucketFor("pro", 1);
  assert.notEqual(u1b, u1);
  assert.equal(u1b.rate, 1_000_000);
  assert.equal(m.bucketFor("pro", 2), u2);
});
