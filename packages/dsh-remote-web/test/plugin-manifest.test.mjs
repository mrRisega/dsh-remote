/**
 * 插件清单与「一键更新静默失败」契约测试（node:test，零框架）。
 *
 * 事故背景（2026-09-15 生产反馈）：
 *  A. 用户扫码后报「fail to load plugin / DeepSeek client collection」。
 *     排查发现 package.json 的 dsh.client.inject 声明了 `@deepseek-ai/dsh-client-runtime`，
 *     而该包在 harness 安装树里**根本不存在**（harness 只有 dsh-client-ui-* 等真包）。
 *     inject 取不到图行时该插件永不 arrive（面板不出现），且清单与真实依赖不符 ——
 *     一旦 harness 侧改为严格校验，就会直接变成启动期加载失败。
 *  B. 用户报「桌面运行环境缺失 + 一键修复点了没反应」。
 *     根因链：spawn 是异步的，npx 解析失败时同步分支仍返回 ok:true；错误只写进日志；
 *     前端看到 ok:true 显示"更新已开始"，2 秒后轮询到 marker 被清便显示"已完成"——
 *     版本没变、环境仍缺，界面零反馈。另：残留 marker 会让点击被永久拒绝。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const INDEX = join(HERE, "..", "lib", "index.js");
const CLIENT = join(HERE, "..", "lib", "client.js");

const indexSrc = readFileSync(INDEX, "utf8");
const clientSrc = readFileSync(CLIENT, "utf8");

test("清单：dsh.client 不得声明不存在的宿主包（幻影 inject 会让插件永不装载）", () => {
  // 注：旧名别名包 dsh-remote-ui 已于 2026-09-15 退役并从仓库删除（npm 上已 deprecate），
  // 因此这里只校验当前插件包 dsh-remote-web。
  const pkg = "packages/dsh-remote-web/package.json";
  const manifest = JSON.parse(readFileSync(join(REPO, pkg), "utf8"));
  const client = manifest.dsh && manifest.dsh.client;
  assert.ok(client, `${pkg} 应有 dsh.client`);
  assert.equal(client.platform, "web");
  const inject = client.inject || [];
  assert.deepEqual(inject, [], `${pkg} 的 inject 必须为空：我们的浏览器半只 require("react")，不需要任何宿主包`);
  for (const name of inject) {
    assert.ok(!/dsh-client-runtime|dsh-client-collection/.test(name), `inject 里不得出现不存在的包名：${name}`);
  }
});

test("旧名别名包确已退役：目录/同步脚本/发布步骤都不应再存在", () => {
  assert.ok(!existsSync(join(REPO, "packages", "dsh-remote-ui")), "别名目录应已删除");
  assert.ok(!existsSync(join(REPO, "scripts", "sync-legacy-alias.mjs")), "别名同步脚本应已删除");
  const root = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  for (const k of ["sync:alias", "check:alias"]) {
    assert.ok(!(k in root.scripts), `package.json 不应再有 ${k}`);
  }
  assert.ok(!/check:alias/.test(root.scripts.check || ""), "check 不应再引用别名校验");
  // 但**旧名清理/迁移逻辑必须保留**：老用户升级依赖它
  const setup = readFileSync(join(REPO, "dsh-setup.mjs"), "utf8");
  assert.match(setup, /PLUGIN_LEGACY_IDS/, "安装器必须保留旧名清理（老用户升级路径）");
  assert.match(setup, /dsh-remote-ui/, "旧名清理里应仍认得 dsh-remote-ui");
});

test("清单：浏览器半只依赖 shell 提供的 react（不 require 宿主客户端包）", () => {
  const requires = [...clientSrc.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(requires)], ["react"], `实际 require: ${[...new Set(requires)].join(",")}`);
  // exports["./client"] 必须存在，否则 harness 报 "declares dsh.client but exports no ./client bundle"
  const manifest = JSON.parse(readFileSync(join(REPO, "packages/dsh-remote-web/package.json"), "utf8"));
  assert.ok(manifest.exports && manifest.exports["./client"], "必须声明 exports['./client']");
  assert.ok(existsSync(join(HERE, "..", "lib", "client.js")), "client bundle 文件必须存在");
});

test("一键更新：spawn 失败不得同步返回 ok:true（否则界面显示已开始、却什么也没发生）", () => {
  assert.match(indexSrc, /if \(!child \|\| !child\.pid\)/, "pid 缺失时必须返回失败");
  assert.match(indexSrc, /noteUpdateFailure\(relayDir/, "失败原因要进可查询状态，不能只写日志");
  assert.match(indexSrc, /recentUpdateFailure\(relayDir\)/, "应能查出最近的失败");
});

test("一键更新：残留 marker 必须有过期判定（否则点击被永久拒绝、界面只转圈）", () => {
  assert.match(indexSrc, /10 \* 60 \* 1000/, "应有 10 分钟陈旧判定");
  assert.match(indexSrc, /清理超过 10 分钟的陈旧 in-progress 标记/, "应真的清理陈旧 marker");
});

test("一键更新：前端在进程结束但没成功时必须报错，而不是显示已完成", () => {
  assert.match(clientSrc, /if \(b\.failure && b\.failure\.detail\)/, "前端应消费 failure");
  assert.match(clientSrc, /"更新失败：" \+ b\.failure\.detail/, "应把失败原因显示出来");
  // update-log 端点要下发 failure
  assert.match(indexSrc, /failure: failure \? \{ detail: failure\.detail/, "update-log 应下发 failure");
});

test("补装失败退避：Windows 的失败风暴不再每轮重试", () => {
  assert.match(indexSrc, /PROVISION_RETRY_BACKOFF_MS\s*=\s*\[30_000, 120_000, 600_000\]/, "应有 30s→2m→10m 退避");
  assert.match(indexSrc, /function provisionRetryGate/, "应有退避闸门");
  assert.match(indexSrc, /noteProvisionFailure\(relayDir\)/, "失败要记退避");
  assert.match(indexSrc, /noteProvisionSuccess\(relayDir\)/, "成功要清退避");
});

test("失败归因：Windows 真实错误不再全部落到 unknown（1659 次无法定位的教训）", () => {
  const codes = ["npx_cmd_unavailable", "registry_timeout", "install_script_missing", "npx_exit_nonzero", "npx_output_encoding"];
  for (const c of codes) {
    assert.ok(indexSrc.includes(`"${c}"`), `客户端归因应包含 ${c}`);
  }
  // 与服务端白名单保持一致（服务端不认的码会被静默丢弃 → 又变成 unknown）
  const server = join(REPO, "..", "dsh-relay-enterprise", "relay-enterprise", "src", "api.js");
  if (existsSync(server)) {
    const apiSrc = readFileSync(server, "utf8");
    for (const c of codes) {
      assert.ok(apiSrc.includes(`"${c}"`), `服务端 TELEMETRY_FAIL_CODES 必须接受 ${c}（否则上报被丢弃）`);
    }
  }
});

test("失败归因：逐条映射真实日志（不联网、不起进程）", () => {
  const mod = JSON.parse(execFileSync(process.execPath, ["-e", `
    import("${INDEX}").then((m) => {
      const f = m.__telemetryInternals.failCodeFromText;
      console.log(JSON.stringify([
        ["'npx.cmd' 不是内部或外部命令", f("'npx.cmd' 不是内部或外部命令，也不是可运行的程序")],
        ["spawn EINVAL", f("spawn npx.cmd EINVAL")],
        ["404", f("npm ERR! 404 Not Found - GET https://registry.npmjs.org/@mrrisega%2fdsh-remote")],
        ["ETIMEDOUT", f("npm error code ETIMEDOUT")],
        ["EACCES", f("npm ERR! EACCES: permission denied")],
        ["engine", f("Unsupported engine: wanted node >=22.13.0")],
        ["other", f("something unfamiliar")]
      ]));
    });
  `], { encoding: "utf8" }).trim());
  const map = new Map(mod);
  assert.equal(map.get("'npx.cmd' 不是内部或外部命令"), "npx_cmd_unavailable");
  assert.equal(map.get("spawn EINVAL"), "npx_cmd_unavailable");
  assert.equal(map.get("404"), "install_script_missing");
  assert.equal(map.get("ETIMEDOUT"), "registry_timeout");
  assert.equal(map.get("EACCES"), "npm_eacces");
  assert.equal(map.get("engine"), "node_too_old");
  assert.equal(map.get("other"), "npx_exit_nonzero", "兜底不得再是 unknown");
});
