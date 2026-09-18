/**
 * 测试期网络护栏（NODE_OPTIONS=--require 注入，见 package.json 的 test 脚本）。
 *
 * 为什么必须有（2026-09-19 实测事故）：
 *   有测试用例在 profile 配置里写了**假账号**（phone/password）却没覆盖 `api_url`，
 *   于是插件按默认地址去请求**生产中继** `https://n.risegao.cn:…`。其中
 *   `/api/device-login` 带着假密码必然失败，而服务端的登录限流是**按出口 IP**
 *   统计「5 次失败 / 15 分钟」——结果是：
 *     · 生产审计日志被测试污染；
 *     · **本机自己的 bridge 被连坐**：限流窗口内它拿不到 JWT（429），
 *       真机表现为「切换账号后设备一直登记不上去」，排查方向被彻底带偏。
 *
 * 现在的行为：测试期**一律阻断**任何非本地请求（throw ENETUNREACH），
 * 并在进程退出时把被拦下的地址打印出来，提醒用例作者去补 `api_url`。
 * 这既不改变用例结论（需要断网的分支照常走失败路径），又保证测试永远碰不到外部服务。
 */
const realFetch = globalThis.fetch;
const blocked = new Set();

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0|::1)(:\d+)?$/i;

function hostOf(input) {
  try {
    const url = typeof input === "string" ? input : input && input.url ? input.url : String(input);
    return new URL(url).host;
  } catch {
    return "";
  }
}

globalThis.fetch = function guardedFetch(input, init) {
  const host = hostOf(input);
  if (host && !LOCAL_HOST.test(host)) {
    const raw = typeof input === "string" ? input : (input && input.url) || "";
    blocked.add(String(raw).replace(/(token|password|secret)=[^&]*/gi, "$1=***").slice(0, 160));
    const err = new Error(`test-net-guard: 测试期禁止访问外部地址 ${host}（请在用例里把 api_url 指向本地假服务）`);
    err.code = "ENETUNREACH";
    return Promise.reject(err);
  }
  return realFetch.call(this, input, init);
};

// 子进程（安装器 / 清理助手等）继承 NODE_OPTIONS，也要能看到告警
process.on("exit", () => {
  if (!blocked.size) return;
  process.stderr.write(
    `\n[test-net-guard] ⚠️ 有 ${blocked.size} 个外部请求被拦下（用例应改用本地假服务，别打生产）：\n  `
    + [...blocked].join("\n  ") + "\n\n");
});
