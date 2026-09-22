/**
 * 微信通道「档位来源」回归（分层功能的接线段）。
 *
 * 分层本身在 wechat-runtime 里可测；这里守的是**桥接侧喂给它的那个值对不对**：
 *   · 自建部署必须是最高档 —— 用户跑的是自己的服务器，不该被 SaaS 的会员分层卡住；
 *   · SaaS 走账号的**生效套餐**（free / pro / pro_max，试用期服务端已折算成 pro）；
 *   · 取不到时必须返回**空串**（让 runtime 沿用上次的档位），绝不能返回 "free" ——
 *     一次网络抖动就把付过钱的用户降级、还提示他去升级，比多给几分钟权限糟糕得多；
 *   · App 链接要从账号 API 地址推导出来（免费用户越界时的转化入口）。
 *
 * 这些分支在测试机上跑不到（要真账号 + 真网络），所以把函数从源码抠出来，
 * 注入假 process / resolveToken / fetch，把每条路真的执行一遍。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SRC = readFileSync(path.join(HERE, "..", "dsh-bridge.mjs"), "utf8");
const API_BASE = "https://api.example/relay-api";

function loadTierResolver({ localKey = "", token = "tok-1", status = 200, body = { user: { plan: "pro" } }, throws = false } = {}) {
  // 切片必须**带上 token 缓存那两个声明**（它们在函数之外，漏了就 ReferenceError →
  // 被函数内的 try/catch 吞成空串，测试会假绿）。
  const from = BRIDGE_SRC.indexOf("const WECHAT_TIER_TOKEN_TTL_MS");
  const to = BRIDGE_SRC.indexOf("function wechatAppUrl()");
  assert.ok(from > -1 && to > from, "未能从 dsh-bridge.mjs 切出 resolveWechatTier（锚点已漂移）");
  assert.ok(/async function resolveWechatTier\(\)/.test(BRIDGE_SRC.slice(from, to)),
    "切片必须同时包含 token 缓存声明与 resolveWechatTier");
  const calls = [];
  let tokenCalls = 0;
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (throws) throw new Error("network down");
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  const make = new Function("process", "resolveToken", "API_BASE", "fetch", "AbortSignal",
    `${BRIDGE_SRC.slice(from, to)}\nreturn resolveWechatTier;`);
  const env = localKey ? { DSH_BRIDGE_LOCAL_KEY: localKey } : {};
  const fn = make({ env }, async () => { tokenCalls += 1; return token; }, API_BASE, fakeFetch, AbortSignal);
  return { fn, calls, tokenCalls: () => tokenCalls };
}

function loadAppUrl(apiBase) {
  const from = BRIDGE_SRC.indexOf("function wechatAppUrl()");
  const to = BRIDGE_SRC.indexOf("let wechatRuntime = null;");
  assert.ok(from > -1 && to > from, "未能从 dsh-bridge.mjs 切出 wechatAppUrl（锚点已漂移）");
  const make = new Function("API_BASE", `${BRIDGE_SRC.slice(from, to)}\nreturn wechatAppUrl;`);
  return make(apiBase);
}

test("档位来源：SaaS 用账号的生效套餐，并带上 Bearer token 打 /api/me", async () => {
  for (const plan of ["free", "pro", "pro_max"]) {
    const { fn, calls } = loadTierResolver({ body: { user: { plan } } });
    assert.equal(await fn(), plan, `必须如实透传服务端的生效套餐 ${plan}`);
    assert.equal(calls.length, 1, "只应请求一次");
    assert.equal(calls[0].url, `${API_BASE}/api/me`, "应打账号 API 的 /api/me");
    assert.equal(calls[0].init.headers.authorization, "Bearer tok-1", "必须带 token");
    assert.ok(calls[0].init.signal, "必须有超时信号（不能把档位查询挂死）");
  }
});

test("★档位来源：自建部署直接给最高档，且**不去打账号 API**", async () => {
  // 自建用户跑的是自己的服务器，不存在"会员"这回事。
  // 而且必须**一次网络请求都不发** —— 自建环境常常连不上（也不该连）账号 API。
  const { fn, calls } = loadTierResolver({ localKey: "local-key-abc" });
  assert.equal(await fn(), "pro_max", "自建部署必须是最高档");
  assert.equal(calls.length, 0, "★自建模式不得请求账号 API");
});

test("★档位来源：取不到时返回空串（让上层沿用旧值），绝不返回 free 把付费用户降级", async () => {
  // 空串 = "这次没取到"，runtime 据此保留上次的档位；返回 "free" 则会把人降级。
  const http = loadTierResolver({ status: 503, body: {} });
  assert.equal(await http.fn(), "", "HTTP 失败 → 空串");
  const boom = loadTierResolver({ throws: true });
  assert.equal(await boom.fn(), "", "网络异常必须被吞掉并返回空串（档位不是关键路径，不能拖垮 bridge）");
  const noToken = loadTierResolver({ token: "" });
  assert.equal(await noToken.fn(), "", "拿不到 token → 空串");
  assert.equal(noToken.calls.length, 0, "没 token 就不该白跑一次请求");
  const weird = loadTierResolver({ body: { user: {} } });
  assert.equal(await weird.fn(), "", "服务端没给 plan → 空串（不是猜一个 free）");
});

test("★档位来源：token 必须自己缓存（否则免费用户连点几下就把自己打到登录限流）", async () => {
  // `resolveToken()` 在账号模式下**每调一次就重新 device-login 一次**，而 /api/device-login
  // 是按**出口 IP** 限流的（15 分钟 5 次）。档位会被反复查询（定时校准 + 免费用户每次被拒都重查），
  // 不缓存就是拿用户的登录额度去换一个只读字段。
  const { fn, calls, tokenCalls } = loadTierResolver({ body: { user: { plan: "free" } } });
  await fn();
  await fn();
  await fn();
  assert.equal(tokenCalls(), 1, "★多次查档位只应登录一次");
  assert.equal(calls.length, 3, "但 /api/me 每次都要查（档位本身要新鲜）");
});

test("★档位来源：token 失效(401/403)时丢掉缓存，下次重新登录而不是一直用坏 token", async () => {
  const bad = loadTierResolver({ status: 401, body: {} });
  assert.equal(await bad.fn(), "", "401 → 空串（沿用上层旧档位，不降级）");
  assert.equal(await bad.fn(), "", "仍然空串");
  assert.equal(bad.tokenCalls(), 2, "★401 之后必须重新登录一次（缓存已失效，不能一直拿坏 token 打）");
});

test("App 链接：由账号 API 地址推导，与插件半的 DEFAULT_APP_URL 同口径", () => {
  assert.equal(loadAppUrl(API_BASE)(), "https://api.example/app/");
  assert.equal(loadAppUrl("https://n.risegao.cn:13443/relay-api")(), "https://n.risegao.cn:13443/app/",
    "生产地址必须推导出真实可点的 App 入口");
  assert.equal(loadAppUrl("https://api.example/relay-api/")(), "https://api.example/app/",
    "结尾斜杠也要正确吃掉");
});
