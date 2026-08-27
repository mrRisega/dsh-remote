/**
 * relay-router — 带宽限速(令牌桶)+ 月流量计量(内存 Map)
 *
 * 商业模式(2026-08 v2):
 *   限速:按生效套餐 maxBps 做令牌桶(free 1Mbps≈128KB/s / pro·pro_max 8Mbps≈1MB/s),桶按用户(sub)共享。
 *   限量:free 月流量 1GB(超限 402 + 百分比提示);pro / pro_max 会员期内不限流量(monthlyGb=0)。
 *   观测:同时按 deviceId 记录累计字节(多设备维度)。
 *
 * 说明:月流量当前为进程内存态,重启清零(可接受,正式接 DB 时替换 userUsage/deviceUsage)。
 * 配额来源优先级: DSH_ROUTER_QUOTA_* 环境变量 > enterprise public-config 轮询(后台可配) > 默认值。
 */

const GB = 1024 ** 3;

/** 默认配额(与 enterprise db.js DEFAULT_CONFIG 对齐)。monthlyGb=0 表示不限流量。 */
export const DEFAULT_QUOTA_BY_PLAN = {
  free: { maxBps: 128_000, monthlyGb: 1 },    // 1Mbps / 1GB(摩擦体验 + 防白嫖)
  pro: { maxBps: 1_000_000, monthlyGb: 0 },   // 8Mbps / 不限
  pro_max: { maxBps: 1_000_000, monthlyGb: 0 } // 8Mbps / 不限
};

const MBPS = 125_000; // 1Mbps = 125KB/s

/**
 * 简单令牌桶:按速率 refill,容量内允许突发。
 * take(n) 返回「需要等待的毫秒数」;0 表示立即可发送并已扣减。
 */
export class TokenBucket {
  /**
   * @param {number} rateBps 每秒补充字节数(maxBps)
   * @param {number} capacity 桶容量(突发字节);默认 max(rate, 64KB),保证页面首包不卡顿
   */
  constructor(rateBps, capacity) {
    this.rate = Math.max(1, rateBps);
    this.capacity = Math.max(1024, capacity ?? Math.max(this.rate, 64 * 1024));
    this.tokens = this.capacity;
    this.last = Date.now();
  }

  /** 请求 n 字节;返回等待毫秒(已把可用令牌扣光)。 */
  take(n) {
    if (n <= 0) return 0;
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens >= n) {
      this.tokens -= n;
      return 0;
    }
    const need = n - this.tokens;
    this.tokens = 0;
    const wait = Math.ceil((need / this.rate) * 1000);
    // 预扣:等待期间 refill 的令牌已在 wait 里体现,避免下一块又被免费补足(导致限速≈2x 偏快)
    this.last = now + wait;
    return wait;
  }
}

/** 当前月份键 'YYYY-MM'。 */
export function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * 创建配额管理器。
 * @param {object} [opts]
 * @param {object} [opts.quotaByPlan] 覆盖默认配额(env 注入,最高优先级),如 { free:{maxBps,monthlyGb}, pro:{...} }
 * @returns {{
 *   QUOTA_BY_PLAN: object,
 *   planFor(plan): {maxBps, monthlyGb},
 *   recordTraffic(deviceId: string, bytes: number, userId?: string|number): void,
 *   checkQuota(plan: string, userId: string|number): {ok, usedBytes, limitBytes, plan},
 *   bucketFor(plan: string, userId: string|number): TokenBucket,
 *   updateQuotaFromPublicConfig(pub: object): void,
 *   usageByUser: Map, usageByDevice: Map
 * }}
 */
export function createQuotaManager({ quotaByPlan = {} } = {}) {
  const QUOTA_BY_PLAN = {
    free: { ...DEFAULT_QUOTA_BY_PLAN.free, ...(quotaByPlan.free || {}) },
    pro: { ...DEFAULT_QUOTA_BY_PLAN.pro, ...(quotaByPlan.pro || {}) },
    pro_max: { ...DEFAULT_QUOTA_BY_PLAN.pro_max, ...(quotaByPlan.pro_max || {}) }
  };
  /** env 显式覆盖的套餐键(public-config 轮询不得覆盖 env)。 */
  const envOverridden = new Set(Object.keys(quotaByPlan));

  /** 用户月流量: sub -> { month, bytes } */
  const usageByUser = new Map();
  /** 设备月流量: deviceId -> { month, bytes } */
  const usageByDevice = new Map();
  /** 用户令牌桶: sub -> TokenBucket */
  const buckets = new Map();

  function planFor(plan) {
    return QUOTA_BY_PLAN[plan] || QUOTA_BY_PLAN.free; // 未知套餐一律按 free(安全默认)
  }

  /** 取(或初始化)月度计数;跨月自动清零。 */
  function ensureUsage(map, key) {
    const m = monthKey();
    let rec = map.get(key);
    if (!rec || rec.month !== m) {
      rec = { month: m, bytes: 0 };
      map.set(key, rec);
    }
    return rec;
  }

  /**
   * 记录流量(双向字节)。按用户累计用于限额,按设备累计用于观测。
   * @param {string} deviceId
   * @param {number} bytes 本方向实际字节数(>0)
   * @param {string|number} [userId] 用户 id;缺省则只记设备维度
   */
  function recordTraffic(deviceId, bytes, userId) {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    if (deviceId) ensureUsage(usageByDevice, deviceId).bytes += bytes;
    if (userId !== undefined && userId !== null) ensureUsage(usageByUser, String(userId)).bytes += bytes;
  }

  /**
   * 校验月流量配额。
   * @param {string} plan free | pro | pro_max
   * @param {string|number} userId
   * @returns {{ok: boolean, usedBytes: number, limitBytes: number, plan: string}}
   *          limitBytes=0 表示不限流量(pro/pro_max)
   */
  function checkQuota(plan, userId) {
    const q = planFor(plan);
    const limitBytes = q.monthlyGb > 0 ? Math.round(q.monthlyGb * GB) : 0;
    const rec = ensureUsage(usageByUser, String(userId));
    return {
      ok: limitBytes === 0 || rec.bytes < limitBytes,
      usedBytes: rec.bytes,
      limitBytes,
      plan: QUOTA_BY_PLAN[plan] ? plan : "free"
    };
  }

  /** 取用户令牌桶(按套餐速率,懒创建;套餐或后台配置变化导致速率不一致时自动重建)。 */
  function bucketFor(plan, userId) {
    const q = planFor(plan);
    const key = String(userId);
    let b = buckets.get(key);
    if (!b || b.rate !== q.maxBps) {
      // 桶速率在创建时固化会导致套餐变更(如 free→pro)后限速不生效;
      // 每次调用都与当前生效速率比对,不一致就重建(新桶满容量,可直接突发)。
      b = new TokenBucket(q.maxBps);
      buckets.set(key, b);
    }
    return b;
  }

  /**
   * 从 enterprise public-config 刷新套餐配额(后台配置生效;env 显式覆盖优先)。
   * pub.plans: { free: {max_mbps, monthly_gb}, pro: {max_mbps}, pro_max: {max_mbps, monthly_gb?} }
   */
  function updateQuotaFromPublicConfig(pub) {
    if (!pub || !pub.plans) return;
    for (const [plan, cfg] of Object.entries(pub.plans)) {
      if (envOverridden.has(plan) || !QUOTA_BY_PLAN[plan]) continue;
      const maxMbps = Number(cfg.max_mbps);
      const monthlyGb = cfg.monthly_gb !== undefined ? Number(cfg.monthly_gb) : undefined;
      const patch = {};
      if (Number.isFinite(maxMbps) && maxMbps > 0) patch.maxBps = Math.round(maxMbps * MBPS);
      if (monthlyGb !== undefined && Number.isFinite(monthlyGb) && monthlyGb >= 0) patch.monthlyGb = monthlyGb;
      if (Object.keys(patch).length) Object.assign(QUOTA_BY_PLAN[plan], patch);
    }
  }

  /** 观测:当前已连接设备的实时用量快照。 */
  function snapshot() {
    const devs = {};
    for (const [id, rec] of usageByDevice) devs[id] = { month: rec.month, bytes: rec.bytes };
    return { users: usageByUser.size, devices: devs };
  }

  return { QUOTA_BY_PLAN, planFor, recordTraffic, checkQuota, bucketFor, updateQuotaFromPublicConfig, usageByUser, usageByDevice, snapshot };
}
