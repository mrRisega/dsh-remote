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

/** 可控时钟:切片里的 `Date.now()` 是唯一的取时点,替掉它就能确定性验 5 分钟缓存。 */
function fakeDate(nowFn) {
  return class FakeDate extends Date {
    static now() { return nowFn(); }
  };
}

function loadTierResolver({ localKey = "", token = "tok-1", status = 200, body = { user: { plan: "pro" } }, throws = false, now = null } = {}) {
  // 切片必须**带上 token 缓存那两个声明**（它们在函数之外，漏了就 ReferenceError →
  // 被函数内的 try/catch 吞成空串，测试会假绿）。
  const from = BRIDGE_SRC.indexOf("const WECHAT_TIER_TOKEN_TTL_MS");
  const to = BRIDGE_SRC.indexOf("function wechatAppUrl()");
  assert.ok(from > -1 && to > from, "未能从 dsh-bridge.mjs 切出 resolveWechatTier（锚点已漂移）");
  assert.ok(/async function resolveWechatTier\(\)/.test(BRIDGE_SRC.slice(from, to)),
    "切片必须同时包含 token 缓存声明与 resolveWechatTier");
  const calls = [];
  let tokenCalls = 0;
  // body 允许传函数：这样能在**同一个实例**里改变服务端响应，验"这次没给 user 时快照不被覆盖"。
  const bodyFor = typeof body === "function" ? body : () => body;
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (throws) throw new Error("network down");
    return { ok: status >= 200 && status < 300, status, json: async () => bodyFor() };
  };
  // 多出口两个"内部状态"的只读探针 —— 否则"token 缓存被清空""快照不因缺 user 被覆盖"
  // 这两条只能用间接行为猜,抓不住回归(它们都在闭包里)。
  const make = new Function("process", "resolveToken", "API_BASE", "fetch", "AbortSignal", "Date",
    `${BRIDGE_SRC.slice(from, to)}
return {
  fn: resolveWechatTier,
  tokenCache: () => WECHAT_TIER_TOKEN,
  snapshot: () => WECHAT_ACCOUNT_SNAPSHOT
};`);
  const env = localKey ? { DSH_BRIDGE_LOCAL_KEY: localKey } : {};
  const api = make(
    { env },
    async () => { tokenCalls += 1; return token; },
    API_BASE,
    fakeFetch,
    AbortSignal,
    now ? fakeDate(now) : Date
  );
  return {
    fn: api.fn,
    calls,
    tokenCache: api.tokenCache,
    snapshot: api.snapshot,
    tokenCalls: () => tokenCalls
  };
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

test("★档位来源：启动时必须复用桥接刚拿到的 JWT（否则每次启动多花一份登录额度）", () => {
  // 真机日志实测：同一个桥接启动里出现两条并发的 device-login —— 一条是隧道登录，
  // 另一条是档位校准。而 device-login 按出口 IP 限流，每次启动多花一份额度没有道理。
  const i = BRIDGE_SRC.indexOf("async function runTunnel()");
  assert.ok(i > -1, "应能找到 runTunnel");
  const body = BRIDGE_SRC.slice(i, BRIDGE_SRC.indexOf("async function main()"));
  assert.ok(body.length > 0, "切片边界应正确");
  const seedAt = body.indexOf("WECHAT_TIER_TOKEN = { value: token");
  const startAt = body.indexOf("startWeChat()");
  assert.ok(seedAt > -1, "runTunnel 必须把刚拿到的 token 喂给档位缓存");
  assert.ok(startAt > -1, "runTunnel 应调用 startWeChat()");
  assert.ok(seedAt < startAt, "★必须在 startWeChat() **之前**喂，否则档位校准仍会再登录一次");
});

test("App 链接：由账号 API 地址推导，与插件半的 DEFAULT_APP_URL 同口径", () => {
  assert.equal(loadAppUrl(API_BASE)(), "https://api.example/app/");
  assert.equal(loadAppUrl("https://n.risegao.cn:13443/relay-api")(), "https://n.risegao.cn:13443/app/",
    "生产地址必须推导出真实可点的 App 入口");
  assert.equal(loadAppUrl("https://api.example/relay-api/")(), "https://api.example/app/",
    "结尾斜杠也要正确吃掉");
});

// ── 权益包（服务端 /api/me 新增的 entitlements 字段，契约 §5/§6.1） ──────────

const FREE_ENT = Object.freeze({
  plan: "free",
  caps: ["notify", "approve", "status", "stop", "assign.continue"],
  limits: { messages_per_month: 20 },
  rev: "a1b2c3d4",
  source: "configured"
});

test("★权益包：/api/me 带 entitlements 时返回对象，caps/limits/rev 原样透传", async () => {
  // 为什么必须**原样**：服务端是权限的唯一真相源（契约 §0）。桥接侧任何"本地过滤/补齐"
  // 都会让后台配置失效（红线 §8.1「话术与权限一致」直接建立在"下发什么就是什么"上）。
  const { fn } = loadTierResolver({ body: { user: { plan: "free" }, entitlements: FREE_ENT } });
  const got = await fn();
  assert.equal(typeof got, "object", "有权益包就必须返回对象（runtime 才能以它为准判定）");
  assert.equal(got.plan, "free");
  assert.deepEqual(got.caps, FREE_ENT.caps);
  assert.equal(got.caps, FREE_ENT.caps, "★caps 必须原样透传（连数组都不重建，杜绝二次加工）");
  assert.deepEqual(got.limits, { messages_per_month: 20 });
  assert.equal(got.limits, FREE_ENT.limits, "★limits 同样原样透传");
  assert.equal(got.rev, "a1b2c3d4", "rev 要带上（客户端据此判断包变没变）");
});

test("★权益包：没有 entitlements 时保持今天的字符串契约（新旧服务端都能跑）", async () => {
  // 灰度期：服务端没发版 → 只给 {user}。这时绝不能返回对象（缺 caps 会让 runtime 判不出档位），
  // 必须退回字符串，让 runtime 按内置表解析 —— 与改动前**逐字一致**的行为。
  for (const plan of ["free", "pro", "pro_max"]) {
    const { fn } = loadTierResolver({ body: { user: { plan } } });
    const got = await fn();
    assert.equal(typeof got, "string", `旧服务端必须走字符串契约（plan=${plan}）`);
    assert.equal(got, plan);
  }
});

test("★权益包：caps 为**数组**(含空数组)就走对象契约;不是数组/缺字段才退回字符串", async () => {
  // 2026-09-23 修正:原先这里要求"caps 必须非空",把 `caps: []` 也挡在对象契约之外 ——
  // 那是个 **fail-open**:后台「明确清空某档」(契约 §4.1)下发 `caps: []`,
  // 桥接当"没给"退回字符串 → runtime 沿用上次那份包(或回退**内置表**)→
  // 本该"什么都不能做"的档位拿回一整套能力,比后台意图**更多**权限。
  // 正确语义:数组 = 权威(空数组就是"空");不是数组/缺字段 = 这次没拿到 → 沿用上次。
  const bad = [
    { entitlements: { plan: "free", caps: null, limits: { messages_per_month: 20 }, rev: "r" } },
    { entitlements: { plan: "free", limits: { messages_per_month: 20 }, rev: "r" } },
    { entitlements: { plan: "free", caps: "assign.new", rev: "r" } } // 字符串不是数组
  ];
  for (const body of bad) {
    const { fn } = loadTierResolver({ body: { user: { plan: "free" }, ...body } });
    assert.equal(await fn(), "free", `坏权益包必须退回字符串契约：${JSON.stringify(body.entitlements)}`);
  }

  // ★ 空数组 = 权威的"这一档什么都不能做",必须原样作为对象返回
  const { fn } = loadTierResolver({
    body: { user: { plan: "pro" }, entitlements: { plan: "pro", caps: [], limits: { messages_per_month: 0 }, rev: "r9" } }
  });
  const got = await fn();
  assert.equal(typeof got, "object", "★caps: [] 必须是有效的权益包,不能退回字符串(否则清空会静默失效)");
  assert.deepEqual([...got.caps], [], "空数组要原样透传,不能被换成别的");
  assert.equal(got.plan, "pro");
  assert.equal(got.rev, "r9");
});

test("★权益包：limits 缺失时给 null 而不是 {}（补 {} 会被 runtime 读成「不限」=放权）", async () => {
  // runtime 里 `limits` 只要是对象就生效，而 `{}` 的 messages_per_month 读成 0 = 不限。
  // 于是"服务端这次没给 limits"会静默把免费用户变成无限额度 —— 缺字段必须 fail-closed。
  const { fn } = loadTierResolver({
    body: { user: { plan: "free" }, entitlements: { plan: "free", caps: ["notify"], rev: "r1" } }
  });
  const got = await fn();
  assert.equal(typeof got, "object");
  assert.equal(got.limits, null, "★缺 limits 必须是 null（runtime 据此沿用上次 / 回退内置表）");
  assert.equal(got.rev, "r1");
});

test("★权益包：401/403 丢弃 token 缓存、返回空串（沿用旧值，绝不降级）", async () => {
  // 「空串 = 这次没取到」是整条不降级链路的起点：retrurn "free" 会把付过钱的用户降级，
  // 而"缓存没清"会让下一次查询继续拿坏 token 打（用户永远恢复不了）。两条都要证明。
  for (const status of [401, 403]) {
    const r = loadTierResolver({ status, body: { user: { plan: "free" }, entitlements: FREE_ENT } });
    const got = await r.fn();
    assert.equal(got, "", `${status} 必须返回空串（上层沿用缓存，不降级）`);
    assert.equal(r.tokenCache().value, "", `★${status} 之后 token 缓存必须被清空`);
    assert.equal(r.tokenCache().at, 0, "缓存时间戳也要归零（否则被当成「刚取过」继续用）");
    await r.fn();
    assert.equal(r.tokenCalls(), 2, "★清空后必须重新登录，而不是一直拿坏 token 打");
  }
});

test("★权益包：token 的 5 分钟缓存原样保留（device-login 是按出口 IP 限流的）", () => {
  // /api/device-login 限流是**按出口 IP**的（15 分钟 5 次），连累的不只是这个用户。
  // 所以档位查询自己缓存 token 的逻辑一个字都不能动 —— 这里把 TTL 与行为都锁死。
  assert.match(BRIDGE_SRC, /const WECHAT_TIER_TOKEN_TTL_MS = 5 \* 60_000;/,
    "★TTL 必须还是 5 分钟（改动它就是改限流预算）");
});

test("★权益包：TTL 内不重复登录，超过 TTL 才重新登录", async () => {
  let t = 1_700_000_000_000;
  const r = loadTierResolver({ body: { user: { plan: "free" }, entitlements: FREE_ENT }, now: () => t });
  await r.fn();
  assert.equal(r.tokenCalls(), 1);

  t += 4 * 60_000; // TTL 内
  await r.fn();
  assert.equal(r.tokenCalls(), 1, "TTL 内不得重新登录（每 10 分钟一次的档位校准必须被缓存挡住）");

  t += 2 * 60_000; // 累计 6 分钟 > 5 分钟
  await r.fn();
  assert.equal(r.tokenCalls(), 2, "超过 TTL 才重新登录");
});

test("★权益包：账号快照只在真拿到 user 时覆盖（到期提醒的数据源）", async () => {
  // 到期提醒复用这次 /api/me 的结果（不额外打网络）。所以"这次没给 user"时**必须保持上次** ——
  // 否则一次抖动就会让到期提醒凭空消失（或拿 null 去算到期日）。
  let body = { user: { plan: "pro", plan_ends_at: 1_800_000_000_000 }, entitlements: { ...FREE_ENT, plan: "pro" } };
  const r = loadTierResolver({ body: () => body });

  await r.fn();
  assert.equal(r.snapshot().plan_ends_at, 1_800_000_000_000, "拿到 user 时要记快照");

  // 服务端这次只发了权益包、没有 user → 快照必须保持上次的值，而权益包照常返回
  body = { entitlements: FREE_ENT };
  const got = await r.fn();
  assert.equal(typeof got, "object", "没有 user 也要照常返回权益包（两者互不依赖）");
  assert.equal(r.snapshot().plan_ends_at, 1_800_000_000_000,
    "★没有 user 时不得覆盖/清空快照（一次抖动不该让到期提醒消失）");

  // 从没拿到过 user → 快照就是 null，不许凭空造一个
  const fresh = loadTierResolver({ body: { entitlements: FREE_ENT } });
  await fresh.fn();
  assert.equal(fresh.snapshot(), null, "没取到过 user 就该是 null（上层据此什么都不发）");
});

