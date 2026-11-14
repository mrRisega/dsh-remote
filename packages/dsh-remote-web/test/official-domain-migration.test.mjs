/**
 * 官方域名迁移契约（2026-11-14 企业域名迁移：n.risegao.cn → dsh.ruichengai.com）
 *
 * 为什么必须钉住：
 *   ① 默认值散在三处（插件半 lib/index.js、桥半 dsh-bridge.mjs、安装器 dsh-setup.mjs），
 *      只改一处就会出现"新装用新域名、却把用户带去旧域名"的半吊子状态；
 *   ② 存量用户配置里写的是旧域名，只改默认值等于**老用户永远不迁移**；
 *   ③ 迁移只允许动「官方旧域名」，自建地址一旦被顺手改写，用户会直接连不上自己的服务器。
 *
 * 因此这里同时钉：纯函数行为、三处默认值一致、以及 apply() 里确实调用了装载期迁移。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { migrateOfficialUrl } from "../lib/index.js";

const NEW = "dsh.ruichengai.com";

test("旧官方域名 → 新域名：端口/路径/查询串原样保留", () => {
  assert.equal(
    migrateOfficialUrl("https://n.risegao.cn:13443/relay-api"),
    `https://${NEW}:13443/relay-api`
  );
  assert.equal(migrateOfficialUrl("https://n.risegao.cn:13443"), `https://${NEW}:13443`);
  assert.equal(
    migrateOfficialUrl("https://n.risegao.cn/relay-api?x=1"),
    `https://${NEW}/relay-api?x=1`
  );
});

test("幂等：已经是新域名时再迁移不变", () => {
  const once = migrateOfficialUrl("https://n.risegao.cn:13443/relay-api");
  assert.equal(migrateOfficialUrl(once), once);
});

test("自建/自定义地址一律原样返回（绝不能顺手改写用户自己的服务器）", () => {
  for (const u of [
    `https://${NEW}:13443/relay-api`,
    "https://relay.example.com/relay-api",
    "https://relay.example.com:8443/relay-api",
    "http://127.0.0.1:1/relay-api",
    // 相似但不同的 host：必须不被当成官方旧域名
    "https://n.risegao.cn.evil.com/relay-api",
    "https://evil-n.risegao.cn/relay-api",
  ]) {
    assert.equal(migrateOfficialUrl(u), u, `${u} 不该被改写`);
  }
});

test("空值/非法值原样返回，不抛错（迁移失败绝不能拖垮装载）", () => {
  for (const v of [null, undefined, "", "   ", "not a url", "n.risegao.cn:13443"]) {
    assert.doesNotThrow(() => migrateOfficialUrl(v));
  }
  assert.equal(migrateOfficialUrl(""), "");
  assert.equal(migrateOfficialUrl("not a url"), "not a url");
});

test("跨文件不变量：插件半/桥半/安装器的默认云端地址必须一致且是新域名", async () => {
  const root = new URL("../../../", import.meta.url);
  const files = {
    插件半: new URL("packages/dsh-remote-web/lib/index.js", root),
    桥半: new URL("clients/dsh-remote/dsh-bridge.mjs", root),
    安装器: new URL("dsh-setup.mjs", root),
  };
  for (const [label, url] of Object.entries(files)) {
    const src = await readFile(url, "utf8");
    assert.ok(
      src.includes(`https://${NEW}:13443/relay-api`),
      `${label} 的默认 relay-api 必须指向 ${NEW}`
    );
    assert.ok(
      !src.includes('|| "https://n.risegao.cn:13443/relay-api"'),
      `${label} 不得再把旧域名当默认值`
    );
  }
});

test("装载期迁移确实接在 apply() 上（否则老用户永远不迁移）", async () => {
  const root = new URL("../../../", import.meta.url);
  const src = await readFile(new URL("packages/dsh-remote-web/lib/index.js", root), "utf8");
  assert.match(src, /migrateLegacyConfigAtBoot\(relayDir, ctx\)/, "apply() 必须调用装载期迁移");
  assert.match(src, /OFFICIAL_HOST_MIGRATION = new Map\(\[\s*\["n\.risegao\.cn", "dsh\.ruichengai\.com"\]/, "迁移映射必须存在");
  // 自建模式不能被动：有 local_key 时必须直接返回
  assert.match(src, /if \(!cfg \|\| !cfg\.api_url \|\| cfg\.local_key\) return false;/, "自建模式必须跳过迁移");
});
