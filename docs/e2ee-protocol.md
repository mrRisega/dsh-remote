# dsh-remote 端到端加密（E2EE）协议设计规范 v0.1（评审稿）

> 状态：**设计评审稿（Draft for review）**。本文档只定义协议与集成方案，**不含任何代码改动**。
> 落地前需评审确认的点一律以 `[DECISION]` 标注；各端实现严格按本文档 §3–§7 的常量、帧结构与消息表对齐。
>
> 关联现状文件（本文引用、不改动）：
> `packages/relay-router/src/index.mjs`（router 帧协议/`/_bridge`/`/remote/`）、
> `clients/dsh-remote/dsh-bridge.mjs`（bridge 帧协议/认证/HTML 注入）、
> `packages/dsh-remote-web/lib/{index,client}.js`（插件 node/浏览器半；账号密码存 `.dsh-config.json` 0600）、
> `clients/dsh-web/native.html`（手机 PWA：登录/注册/扫码/设备选择）、`SECURITY.md`（现有 scrypt 参数）。

---

## 0. 阅读导览与一次性决策摘要

- 产品已定：**密钥 = 账号登录密码本身**，不新增口令字段；服务端只存 KDF verifier；内容级 AEAD 保护手机↔bridge 的请求/响应正文与 WS 消息；**必须兼容旧版**（无法协商即明文回退并明示加密状态）。
- 本规范的五个核心决策（评审重点）：
  1. **Verifier 与主密钥域分离**（§3.1）：verifier=scrypt（沿用 `SECURITY.md` N=2¹⁴,r=8,p=1），主密钥 MK 用**独立盐 + 独立 KDF profile**，DB 泄露不能直接得到加密密钥。
  2. **客户端 MK 派生采用 PBKDF2-SHA256(600k)**（§3.3），而非 scrypt：两端（Node bridge 与手机浏览器 WebCrypto）必须能算出**相同** MK，WebCrypto 无原生 scrypt；scrypt 保留给服务端 verifier（服务器 CPU 可负担）。profile 随参数下发改版，见 §3.3 说明。
  3. **E2EE 会话 = “隧道页 × 设备”的显式握手会话**（§5.1）：解锁（输密码）发生在被控 dsh web 的隧道页内；密钥**只存内存**，刷新/重启需重新解锁；与登录 cookie 的 30 天/2 小时存续完全解耦。
  4. **线缆形态 v2 = “信封即信号”**（§4.3）：请求带 `application/vnd.dsh.e2ee-v2` + `x-dsh-e2ee` 头即说明此请求已加密；没有该标记的请求走现有 v1 明文路径。router **几乎零协议改动**（透明转发 + 通道标记 + caps 透传），旧 bridge/旧手机天然明文回退。
  5. **路由元数据保持可见并如实告知**（§2.3）：路径前缀/方法/字节大小/时间/会话 id 为路由与配额所需；正文、头部明细、WS 消息内容不可见。
- 范围边界（诚实声明）：静态资源/HTML 外壳与首屏 bootstrap 明文（代码本身无用户内容且需先行加载加密 shim）；SSE/流式端点 v1 不加密（§4.5 策略表）；自建模式（无账号）v1 不启用 E2EE（§6.5）。

---

## 1. 术语、链路与目标

### 1.1 术语

| 术语 | 含义 |
|---|---|
| 手机端 / 隧道页 | 手机浏览器里、经隧道访问的 dsh web 页面（含官方前端 + 插件注入的移动端 UI）。本文 E2EE 的手机侧代理 = 该页面 document-start 注入的 **crypto shim** |
| bridge（电脑端） | `dsh-bridge.mjs` 守护进程，连 router `/_bridge`，持有账号密码（`.dsh-config.json` 0600 / env `DSH_BRIDGE_PASSWORD`），是把转发帧代理到 `127.0.0.1:3080` 的一端 |
| router / 中继 | `relay-router`，只转发不解析正文；对 E2EE 而言是**不可信的透明转发方** |
| enterprise | 闭源账号 API（`/relay-api`，端口 13446）：注册/登录/verifier 校验/`auth-key`/`mobile-sessions`/`devices` |
| MK | 主密钥 Master Key，两端从“密码+盐”独立派生，32B，永不落盘、永不出设备 |
| SHK | 会话握手密钥：MK 经 HKDF + 双方随机数派生，一次解锁会话一个 |
| 信封 / envelope | v2 线缆单位：AEAD 密文 + 元数据（版本/会话/计数/随机数） |
| 解锁 unlock | 用户在手机侧输入**账号密码**以派生 MK 并完成与 bridge 的握手确认 |

### 1.2 现状链路（E2EE 前）

```
手机浏览器
 ├─ /app/ (PWA native.html)：登录(密码/短信/扫码auth-key) → GET /_devices → 选设备 → 跳 "/"
 └─ /remote/<deviceId>/<path>（或 channel 形态 /remote/{api|sidebar|git|pet}/… + x-dsh-remote-device 头）
        │  HTTP 或 WS upgrade（nginx 终止 TLS）
   nginx(13443)
        ├─ /relay-api/* → enterprise；/_devices|_quota|_login → router
        └─ /remote/* /_bridge → router(13444)
             │  bridge WS 隧道，JSON 帧（http / ws-open / ws-msg / ws-close，超大帧 __chunk 信封）
        bridge（Mac）→ fetch / ws → 127.0.0.1:3080 (dsh web)
```

帧协议（现状，v1）：`{ id, type:"http", method, path, headers, body(base64), bodyBase64:true }`、
`{ id, type:"ws-open", path, headers }` / `ws-msg { data, binary }` / `ws-close`；无 type 的帧走旧协议。
`makeFrameReceiver`/`__chunk` 信封在 router 与 bridge 两端同构（见 router `index.mjs:224-258`、bridge `dsh-bridge.mjs:229-285`）。

### 1.3 设计目标（按优先级）

1. **保密性**：router/enterprise/网络侧窥探者在**不知密码**的情况下，读不到经隧道传输的用户内容（消息、工具执行、审批/凭据等 `/api`、`/sidebar`、`/git`、`/pet` 正文与 WS 消息）。
2. **端到端完整性**：中继篡改正文会被 AEAD 打开失败检出（§8 诚实说明“活跃攻击可做删除/阻断/降级”的边界）。
3. **兼容与灰度**：无 E2EE 能力/未解锁/协商失败的旧链路**完整可用**（明文回退 + 状态明示），不破坏现有配额、限速、错误页、扫码/授权、多设备逻辑。
4. **最小服务端改动**：router 只做“透传 + 能力通告”，enterprise 负责盐/verifier/参数/吊销。
5. 不给用户新增“额外口令”：解锁输入的就是登录密码。

### 1.4 非目标（本文不承诺）

- 隐藏路由元数据（§2.3）；对抗流量分析（大小/时间模式）。
- 抵抗“**主动作恶的账号服务方**”（enterprise 天然在登录/改密时接触密码；可假冒任意会话）。可选加固方向（PAKE/OPAQUE、设备密钥认证）见 §8.5，v1 不实现。
- 服务端内容存储加密（服务端**不存用户内容**；无“恢复旧密文”能力）。
- 浏览器原生不可绕过性（XSS/恶意扩展可窃取页面内存密钥，与 dsh web 本身同风险面）。

---

## 2. 威胁模型与信任声明

### 2.1 威胁模型（服务端不可信但需要路由）

| 威胁者 | 能力 | E2EE 后的效果 |
|---|---|---|
| 网络窃听者（TLS 之外/内网嗅探/上游 DNS 劫持等） | 看流量 | 仅见元数据 + 密文（TLS 已挡大部分；E2EE 纵深） |
| 中继 operator / router / nginx 被攻破或“好奇管理员” | 能读全部转发流量的明文帧；能改帧；能删/拒流量 | 正文不可读；篡改正文 → AEAD 打开失败被检出；**仍可见路径/大小/时间/是否加密，可做 DoS/降级** |
| enterprise DB 泄露 | 拿到 verifier/auth_salt/e2ee_salt/JWT 密钥 | verifier 与 MK **域分离**：无法直接算出 MK；只能对密码做离线猜测（成本 = scrypt 或 §3.3 profile 的 KDF 成本） |
| 密码离线猜测 | 拿到任意密文或握手 transcript | 每个猜测需执行客户端 KDF（PBKDF2-600k）→ 弱密码仍可破（§8 风险 3） |
| 盗取本机（用户 Mac） | 读 `.dsh-config.json`（0600） | 得到**账号密码本身** → 可派生 MK 解密历史/后续内容（§3.5 信任边界，如实告知） |
| 旧版客户端 | 无 E2EE | 明文回退，状态明示（§7） |

### 2.2 关键边界：谁“必须知道密码”，为什么

- **手机侧**：用户在登录/扫码授权后进入设备时输入账号密码（§5.1 解锁），用于派生 MK。密码只在本次页面会话内存中参与派生，**不写入 localStorage/不发送给 router**；账号登录本身（`/api/login`）仍照旧经 TLS 发给 enterprise 校验 verifier——这是登录协议既有行为，E2EE 不改变它（§8 风险 6）。
  - **例外（§5.4 桌面授权引导）**：扫码/一次性链接等「本会话从未输入密码」的进入方式，不再强制要求输密码——手机端会请求电脑端 bridge 下发一次性派生 MK（经同账号授权通道），自动完成同一握手。信任边界、安全窗口与降级见 §5.4。
- **bridge 侧**：bridge 进程从本机 `.dsh-config.json`/env 读取账号密码（现状已如此，用于 `device-login` 换取 JWT），**新增**用它派生相同 MK。信任边界：bridge 运行在**用户本人机器**、密码落盘 0600（现状），能读到该文件 = 能拿到该账号密码与全部内容；请用户在“电脑端可被他人使用”时主动退出登录/加密开关并保护本机。
- **enterprise**：存 verifier 与盐，不存密码明文；verifier 经 §3.1 域分离后不等于 MK。

### 2.3 能见 / 不可见边界（中继视角）——必须如实告知用户

| 中继（router/nginx/enterprise 转发层）可见 | 中继不可见 |
|---|---|
| 账号/JWT 关系、设备列表与在线状态（既有） | 所有被包裹正文（请求体/响应体、WS 消息载荷） |
| 目标路径前缀与方法（路由/配额需要）：如 `/api/session/…`、`/remote/<dev>/…` | 被包裹的头部明细（`x-…`、原始 content-type 等放信封密文内） |
| 字节大小、时间/频次、是否启用 E2EE（`x-dsh-e2ee` 标记）、会话/流 id | 消息内容语义、用户输入、凭据、文件内容 |
| 配额用量（密文长度与明文基本一致，见 §4.7） | 解密后的任何内容 |

**信任文案（用户可见，中文）**——三处：

1. **手机注册/登录页**（`native.html`：登录密码框 `#login-pass` 下、注册 `#reg-pass2` 下；与文案区同一风格）：
   > 🔐 **你的密码也是端到端加密密钥。** 服务端只保存密码经 KDF 派生的不可逆校验值，不存明文、无法解密经中继转发的远程内容。请务必牢记密码；**忘记并重置密码后，旧的加密会话无法恢复**（服务端不保存你的内容，无法代为解密）。
2. **手机“解锁”弹层**（§5.1 首次进设备时）：
   > 请输入账号密码以开启 🔒 端到端加密。密码仅在本页内存中参与密钥派生，不会发送给中继，也不被保存；刷新或重开页面需再次输入。若暂不输入，将**明文**连接并显示“未加密”标识。
3. **电脑端插件面板**（`client.js` 现有“🔒 安全与通道 / 🛡 端到端流量保护”文案行替换）与 **README「安全与隐私」小节**：
   > 🔒 端到端加密（可选开启）：开启后，手机与你的电脑之间的**消息内容**（会话消息、工具执行、审批、凭据、文件等正文与 WebSocket 消息）在离开手机前加密、进入电脑后解密，中继服务只能看到路由所需的信息（目标路径、数据大小与时间），无法读取内容。**服务端不保存你的密码明文与内容**。注意：电脑端本机配置保存你的账号密码（用于自动登录），请保护好你的电脑与配置文件。

### 2.4 加密/状态指示

页面固定注入一枚状态徽标（复用 mobile-adapter 的注入通道，视觉风格一致）：
`🔒 端到端加密已开启`（绿）/ `⚠ 未加密：<原因>`（黄，原因取 §7.3 枚举：未解锁/旧版 bridge/自建模式/手动关闭/参数不可用）。

---

## 3. 密钥派生与验证

### 3.1 双盐域分离（Verifier ≠ MK）

服务端为用户保存 **两个独立随机盐**（各 16B，注册/设置密码时生成，base64url 存 enterprise DB）：

| 名称 | 用途 | 谁可见 | 存哪 | 何时轮换 |
|---|---|---|---|---|
| `auth_salt` | 登录 verifier 派生 | 仅 enterprise | users 表 | 改密/找回 |
| `e2ee_salt` | 客户端 MK 派生 | **公开**（无秘密） | users 表 + `GET /api/e2ee-params` 下发 | 改密/找回（同步轮换） |

理由：若 verifier 与 MK 同盐同参，DB 泄露 = 直接得到加密密钥；分离后，即使拿到 verifier 也只能对密码做离线猜测，且 verifier（scrypt）与 MK（PBKDF2）的猜测成本都被显式声明（§8）。

### 3.2 服务端 verifier（沿用 SECURITY.md，不改密码语义）

- 算法：**scrypt**，参数 `N=16384（=2¹⁴）, r=8, p=1, dkLen=64`（约 16 MiB 内存、单核 ~50–100ms）。
- 输入：`NFKC(password)` 的 UTF-8 字节。
- 存储格式（自描述，便于将来升参并**登录时懒重哈希**）：
  `scrypt$N=16384,r=8,p=1$<auth_salt_b64>$<hash_b64>`
- 校验时机（不变更语义，仅记录）：`POST /api/login`、`POST /api/device-login`、改密时的旧密码校验；恒定时间比较（现实现已如此）。
- **不存明文、不存可逆材料**；verifier 不可逆出 MK（域分离 + 单向 KDF）。

### 3.3 客户端主密钥 MK（两端口径必须一致）

两端（bridge 的 node `crypto`、手机浏览器 **WebCrypto**）必须算出一致 MK。WebCrypto 无原生 scrypt，因此：

```
kdfInput = "dsh-e2ee/v1/mk\x00" ‖ e2ee_salt          // 域标签 + 公开盐
MK(32B)  = PBKDF2-HMAC-SHA256(
             password = NFKC(password) UTF-8,
             salt     = kdfInput,
             iterations = 600000, dkLen = 32)        // profile "pbkdf2-sha256-600k"
```

- 参数由 enterprise `GET /api/e2ee-params` 下发（字段见 §6.1），实现必须**按参数执行**而非写死；v1 固定 `profile:"pbkdf2-sha256-600k"`。
- 选型理由与限制：PBKDF2 对 GPU/ASIC 并行破解弱于内存困难型 KDF；600k 迭代 ≈ 手机 150–400ms、桌面 ~50–150ms（每次解锁一次，可接受）。`[DECISION]` 若产品要求更高离线成本，升级路径：新增 `profile:"scrypt-16384"`（bridge 原生支持；手机端引入 WASM scrypt 后同样支持），参数经同一端点下发并**升 profile 版本**，旧会话兼容（§7.2）。
- 密码归一化：两端统一 `NFKC`；服务端注册限制 ≥8 字符、≤128（防 DoS，现状 ≥8 保留）。

### 3.4 e2ee 参数端点

`GET /relay-api/api/e2ee-params`（Bearer JWT，登录态可用）→

```json
{ "e2ee": {
    "enabled": true,                     // 账号级开关（admin/服务商控制）
    "profile": "pbkdf2-sha256-600k",
    "kdf": { "alg": "pbkdf2-sha256", "iter": 600000, "dkLen": 32, "hash": "sha256" },
    "salt": "<e2ee_salt_b64>",
    "epoch": 3 } }                        // 盐轮换计数（仅状态展示/调试）
```

- 401/404/`enabled:false` → 该链路不启用 E2EE（明文回退，状态提示“未启用/服务端不支持”）。
- 手机在解锁时以当前登录态请求一次；bridge 启动后以其 device-login JWT 请求一次并缓存 MK 于内存（bridge 重启重取；MK 不落盘）。

### 3.5 bridge 本机持有密码的信任边界（成文）

- 现状：bridge 配置 `.dsh-config.json`（0600，gitignored）已存 `phone/password`，用于 `device-login`；`PROJECT-ENV.md §3/§4` 亦注明“含密码，勿入仓库/日志”。
- E2EE 新增：bridge 进程内派生并持有 MK（内存）。文档需在 README/面板明示：**该文件即“该账号内容的解密权”**；安装器/面板应继续以 0600 保存、提供“退出登录清空账号密码”入口（插件 `/dsh-remote/logout` 已清 `cfg.password`）。
- 改密后 bridge 侧旧密码失效 → 握手 `e2ee_bad_key`（§5.2），提示用户在面板重新登录该账号更新本机密码后重启 bridge。

---

## 4. 会话密钥、AEAD 与帧/信封格式（协议 v2）

### 4.1 密钥调度（一图流）

```
MK(32B) ──HKDF(salt=H(a‖b), info="dsh-e2ee/v1/shk")──▶ SHK(32B)      // 每解锁会话
SHK ──HKDF(info="…/ctrl-p2b"|"…/ctrl-b2p")──▶ 控制通道 AEAD 键(probe 用)
SHK ──HKDF(info="…/ws|" + wsLabel + "|p2b")──▶ 每条 WS 流收发密钥（独立，防跨流重放）
SHK ──HKDF(info="…/http|" + reqNonce + "|p2b"|"b2p")──▶ 每个 HTTP 请求/响应密钥
```
- HKDF-SHA256：`extract(salt=…)` 的 salt 取 `H(a‖b)`（a/b 为 32B 随机数，§5.2）；info 字符串域分离方向/流/用途，杜绝跨用途重放。
- v1 AEAD：**AES-256-GCM**（WebCrypto 与 node `crypto` 均原生；`[DECISION]` chacha20-poly1305 作为 profile 化备选，供非浏览器客户端，见 §8.5）。
  - 随机 nonce 96-bit/条消息；tag 128-bit；AAD = `域字符串 ‖ sessId ‖ 方向 ‖ 计数/随机数`。
  - 每 (会话, 流) 密钥 + 96-bit 随机 nonce：碰撞概率 ~2⁻⁴⁸，安全；计数防重放。

### 4.2 信封（Envelope）统一字段

所有 E2EE 线缆单位是**同一 JSON 信封**（文本；超大走既有 `__chunk` 帧信封——信封本身仍是一个普通帧体，分块机制不变）：

```json
{ "v": 2, "k": "http|http-resp|w|ctrl", "s": "<sessId:32hex>", "c": 0,
  "n": "<nonce_b64:16B>", "t": 0, "d": "<b64(ciphertext ‖ tag)>" }
```

| 字段 | 说明 |
|---|---|
| `v` | 协议版本 = 2 |
| `k` | kind：`http`(手机→bridge 请求)、`http-resp`、`w`(WS 消息)、`ctrl`(控制，明文元数据帧) |
| `s` | 会话 id（解锁时生成，128-bit hex） |
| `c` | 方向计数（WS 流内单调；HTTP 请求为序号，仅日志/调试，重放防护靠 nonce 缓存 §4.4） |
| `n` | 96-bit 随机 nonce（base64） |
| `t` | `0`=文本载荷 `1`=二进制（`d` 内为原始字节再 base64） |
| `d` | AEAD 密文 ‖ tag（base64） |

控制帧（`k:"ctrl"`）为**明文 JSON 元数据**（不含用户内容；仅会话建立/错误），字段不加密但不可离线验证（§8 风险 4 已述：与任意密文同等猜测面）。

### 4.3 HTTP 信封（请求/响应正文加密）

**手机 → router → bridge（请求）**：shim 把符合条件的请求改写为——外 HTTP 头 `content-type: application/vnd.dsh.e2ee-v2`、
`x-dsh-e2ee: v=2;s=<sessId>;k=http`（路径/方法/查询**不变**，router 照常路由/配额/剥离 cookie）；原请求的方法、路径、剥离 hop-by-hop 后的头部、正文放入**信封明文**：

```
plaintext(http 请求) = { "m":"POST", "p":"/api/session/x/messages", "h":{...原头部, 去 cookie/host/content-length/encoding...},
                         "b":"<base64 正文>" }
密文 = AES-256-GCM( key=HKDF(SHK,"…/http|"+n+"|p2b"), nonce=n, AAD=…, pt=JSON(plaintext) )
```

bridge 收到带该标记的 `http` 帧：解密 → 还原 method/path/headers → 附加既有 `harness cookie`/Host 围栏逻辑 → 照旧 `fetch(UPSTREAM + p)`。

**响应（bridge → router → 手机）**：bridge 先做既有响应处理（解压、`mobile-adapter` 仅对**明文 HTML 壳**生效，见 §4.5），可压缩正文先 gzip（压缩在加密前，中继看不到明文也不得再压密文）→ 加密进信封 → 外 HTTP 一律 `200` + `content-type: application/vnd.dsh.e2ee-v2` + `x-dsh-e2ee`：

```
plaintext(http 响应) = { "st":200, "h":{...原响应头, 去 content-length/content-encoding/transfer-encoding...},
                         "enc":"gzip|", "b":"<base64 正文>" }
```

手机 shim 解密后重建真实 status/headers/body 交给被 patch 的 fetch/XHR。
**router 层的真实错误不隐藏**：401/403/402/502/504 等由 router 直接产出（无信封标记），shim 透传并保留配额/升级引导语义不变。

**AAD 绑定**：AAD 含路径与查询串摘要，防止“同一密文被改贴到另一路径”的转发层花招（路径篡改本就会破坏路由，此为纵深）。

### 4.4 防重放与顺序

| 载体 | 策略 |
|---|---|
| WS 流（有序、单流单收发） | 每 (会话,流,方向) 计数 `c` 单调 +1；收到 `c ≤ last` 丢弃（重复/乱序不可能，TCP+router FIFO）；会话内计数溢出（2⁶⁴）→ 新流 |
| HTTP（可并行/多 TCP 连接，天然乱序） | **不依赖顺序**；防重放 = 接收方对 `(sess, n)` 做 5 分钟滑动窗口缓存（每会话上限如 4096 条，LRU） |
| 计数/流 key | 每条 WS 流、每个 HTTP 请求用**独立子密钥**（info 含 wsLabel/reqNonce），跨流/跨请求重放即解密失败 |

### 4.5 明文/密文路由策略表（两端同一张静态表，版本随 `v` 常数固化）

| 上游路径前缀 | v1 E2EE | 原因 |
|---|---|---|
| `/api/*`（**排除** SSE/流式标记：`/api/…/events*`、`text/event-stream` 目标）、`/sidebar*`、`/git*`、`/pet*`、及 channel 形态 `/remote/{api|sidebar|git|pet}/*` | 🔒 加密 | 会话/消息/工具/凭据/文件等**用户内容** |
| `/_e2ee/*`（控制通道，§5.2） | 明文 JSON（无用户内容） | 会话引导 |
| 其余（HTML 壳、静态资源 `/assets`、`/plugins`、`/favicon` 等） | 明文 | 公开代码；**必须先行加载才能跑 shim**（bootstrap），见 §8 风险 2 |
| SSE/流式响应 | v1 明文（若误入加密流由 bridge 检测 `content-type` 拒绝加密并降级） | 流式不可整体包裹；`[DECISION]` 后续版本可为 SSE 定义逐事件信封 |

信封标记（请求头）即信号：**有标记 = 加密，无标记 = 明文**，bridge 按标记处理，策略表仅用于 shim 决定“要不要包”。

### 4.6 WebSocket 帧 v2（双向逐消息信封）

现状 `ws-open/ws-msg/ws-close` 帧结构与 router/bridge 的搬运**不变**；E2EE 只改变 WS **载荷内容**：

1. **数据 WS 连接标识**：shim 打开发送方 URL 时附加 `&e2ee=<sessId>&w=<8B 随机hex>`（仅标识，router 透传；bridge `handleWsOpen` 解析并**剥离**后才向上游建连，避免污染上游路径）。
2. **每条 WS 消息** = `k:"w"` 信封（§4.2，`t` 区分文本/二进制；上游二进制原样进 `t:1`）。bridge 对标记流：解密 → 原文（文本或二进制）`ws.send` 上游；上游消息 → 加密 → `ws-msg` 回手机。未标记流照旧透传（明文回退）。
3. **流密钥** = HKDF(SHK, info 含 `wsLabel = 剥离后 path+query ‖ w`)，两端一致；bridge 端到端确认（§5.2 探针）后才把该流当加密流处理，**探针失败不向该流转发任何上游数据**。
4. `ws-close` 语义不变；加密流中途 AEAD 失败 → 手机侧以 `1008` 关闭并提示重试/检查密码。

**帧/信封分块**：信封 JSON 超过既有 `CHUNK_SIZE`(200KB) 时，沿用 `__chunk` 信封重装——两端现有代码不变。

### 4.7 对配额/限速的影响

- router 按月流量/令牌桶计量的对象是**帧体字节**（现状）。密文长度 ≈ 明文 + 28B（tag/nonce 摊销）→ 用量口径基本不变，仅需在文档注明“计量含 AEAD 开销”。
- bridge 现有响应 gzip（隧道省带宽）迁移到“压缩先于加密”，中继仍只见不可压缩密文——带宽收益在 phone↔bridge 的**解密后**由 shim 解压还原，逻辑等价。
- `content-encoding` 等实体头进入信封密文，**外层不再携带**（shim 解密后重建），router/nginx 不会对密文误判 gzip。

---

## 5. 首次建立、刷新、改密与失效

### 5.1 解锁与会话生命周期（手机侧）

- 触发：登录态下（密码登录/短信登录/扫码 auth-key 均可）首次点选设备进入**被控 dsh web 隧道页**，或该页冷启动且无内存密钥。
- 流程：
  1. 页面注入的 shim 检测：账号 e2ee 启用（`/api/e2ee-params`）**且**设备 bridge 声明能力（`/_devices` 携带 `caps:["e2ee-v2"]`，见 §6.2）→ **先尝试免输密码建立加密会话**：密码登录/注册（本页内存留有密码）→ 静默自动解锁；扫码/一次性链接/短信登录（无密码）→ 先走 §5.4 桌面授权引导。两者都不行才弹解锁层人工输入密码；服务端/设备不支持 → 直接明文并显示原因徽标。
  2. 解锁 = 输入账号密码 → WebCrypto 派生 MK（§3.3，~200–400ms）→ 打开**控制 WS** `/remote/<deviceId>/_e2ee/ctrl`（channel 形态 `/_e2ee/ctrl` + 设备头亦可）→ §5.2 握手；§5.4 引导路径等价——手机已持有一次性派生 MK，走同一 §5.2 握手（双方 MK 一致仍由探针确认）。
  3. 成功后：`sessId`、SHK、子密钥与各流计数**只存本页面 JS 内存**（模块闭包/WeakMap），不写 sessionStorage/IndexedDB。
     - `[DECISION-2026-09-2 用户决策]` 持久化例外：为让「刷新后仍保持加密」，手机端在解锁/引导成功后把**派生 MK**（≈“记住本机密码”）写入 localStorage（与镜像页同源共用）——/app 刷新后点设备自动解锁；镜像页刷新且无交接单时，shim 会用该 MK + 同账号登录态自动重建加密会话。风险如实告知：localStorage 与同源页面脚本等价可读（≈“记住密码”的常规暴露面），退出登录即清除，用浏览器无痕可避免；SHK/会话密钥仍不落盘。
- **刷新/重开页面/浏览器重启 → 内存会话清空**（与登录 cookie 存续无关）。默认开启「记住本机」后：/app 点设备自动解锁、镜像页自动恢复加密，**刷新不再回明文**；未记住/电脑端离线/已退出登录 → 回落密码输入或明文提示。退出登录会清除 localStorage 中的 MK。
- 会话 TTL：SHK 建议 24h 上限（滑动），过期要求重新解锁（重新派生 MK 成本低，强制周期解锁可限制“一次密码内存驻留”窗口）。
- 同一账号多设备/多标签：每“隧道页 × 设备”独立会话、独立握手（密钥互不共享，页面间不传递密钥材料）。

> `[DECISION]` 产品所述“30 天会话”：30 天指的是**登录态/移动会话**（若放开）与 bridge 设备绑定关系；**E2EE 会话密钥不随登录态持久化**。免输密码/跨刷新持久化的现实实现见 §5.1-3 与下方补充：v1 采用“派生 MK 写 localStorage（记住本机）”，WebAuthn/系统凭据封存仍是“更安全、跨冷启动持久”的升级路线（vNext，§8.5）。
> `[DECISION-2026-09 补充]` 免输密码路径：(a) 密码登录/注册**本页内存自动解锁**；(b) **§5.4 桌面授权引导**（扫码/一次性链接等无密码路径）；(c) **[2026-09-2] 记住本机**：派生 MK 写 localStorage，刷新/重开 /app 与镜像页自动恢复加密，退出登录清除。

### 5.2 控制通道握手消息（`/_e2ee/ctrl`，明文元数据）

| # | 方向 | 消息 | 字段 |
|---|---|---|---|
| 1 | 手机→bridge | `e2ee-hello` | `{v:2,type:"e2ee-hello",role:"phone",s, a:<32B随机b64>, salt, profile, ts}` |
| 2 | bridge→手机 | `e2ee-hello-ack` | `{v:2,type:"e2ee-hello-ack",s, b:<32B随机b64>, caps:["e2ee-v2"]}` |
| 3 | 双方 | 计算 | `SHK=HKDF(MK, salt=sha256(a‖b), info="dsh-e2ee/v1/shk")` |
| 4 | 手机→bridge | `e2ee-probe`（AEAD） | 密文 = `{"p":"dsh-e2ee-probe-v1","t":<ms>,"c":0}`，key 由 `SHK→ctrl-p2b` |
| 5 | bridge→手机 | `e2ee-probe-ok`（AEAD） | 同上反向；成功即确认**双方 MK 一致** |
| – | bridge→手机 | `e2ee-error`（明文） | `{code}`：`bad_key`(探针解密失败=密码不一致)/`no_cap`/`disabled`/`params`/`busy` |

- 桥端行为：bridge 不提前把控制 WS 的后续内容当用户数据；**探针通过前，任何数据 WS 不向上游转发**；探针失败则明文回复 `e2ee-error bad_key`（手机提示“电脑端保存的账号密码与本次输入不一致，请在电脑端面板重新登录该账号”）。
- 每次控制握手都是**新随机数** → 新 SHK；旧 SHK 一旦过期/解锁结束即不可用。
- 中继视角的离线猜测面：任何密文/探针都可被用于以 MK 派生成本离线猜密码（§8 风险 4），v1 不引入 PAKE（如实声明），仅在 §8.5 给升级路径。

### 5.3 密码修改 → 旧会话失效机制（复用既有基建）

改密/找回密码（enterprise）：

1. 校验旧密码（或短信）→ 生成**新 `auth_salt` + 新 `e2ee_salt`** → 重算 scrypt verifier → 单事务落库（enterprise 既有 SQLite 纪律：备份 → integrity → 单事务）。
2. **吊销全部既有会话**：复用既有 `jwt_blacklist`（jti 加入黑名单）与 `mobile_sessions` revoke 基建——该用户全部手机端会话与“已授权设备”记录置 revoked → 手机需重新登录/重新扫码授权。
3. bridge 端：bridge 配置中的密码已过期 → 下次 `device-login` 401 → 面板提示重新登录；即便 bridge 仍在线，旧 MK 与新盐不匹配 → 握手 `bad_key`/解密失败，双重失效。
4. **预期管理（用户文案）**：“重置密码后，所有已授权设备需重新登录，旧的加密会话立即失效。由于内容只存在于你与你的电脑之间、服务端不保存，**不存在‘找回旧密钥解密历史’的途径**；本地如有加密缓存同样不可恢复。”

### 5.4 桌面授权引导（desktop-intro）：扫码/无密码路径免输入

背景：扫码（一次性 auth-key）与短信登录等路径下，手机侧从未输入过账号密码，按 §5.1 会强制弹解锁层要求输密码（“必须知密码”语义）。为消除该体验断层，引入**桌面授权引导**（用户 2026-09 决策，方案 A）：

- 前置：账号 e2ee 启用 ∧ 设备 bridge 在线且 `caps:["e2ee-v2"]`；手机当前为同一账号登录态（`dsh_token` cookie 已由 router 校验）。
- 消息（新增本地端点，不连上游；device 形态 `/remote/<deviceId>/_e2ee/intro`，channel 形态 `/remote/_e2ee/intro` + 设备头亦归一）：

| # | 方向 | 消息 | 字段 |
|---|---|---|---|
| 1 | 手机→bridge | `POST /_e2ee/intro`（明文 JSON） | `{v:2,grant:"desktop-intro",ts}`；router 同账号授权后到达 |
| 2 | bridge→手机 | `200 {ok:true,v:2,mk:<派生MK base64url>,profile,epoch}` 或 `409 {ok:false,error:{code,message}}` | MK 仅当桥端 `e2ee.enabled` |

- 手机侧流程（`e2eeMaybeGateThenEnter`）：无内存密码 → `e2eeRequestIntro` → `e2eeIntroUnlockDevice`（把引导 MK 直接喂给同一 §5.2 握手 `hello→hello-ack→probe`）→ 成功后与人工解锁完全同构（会话仅存内存、`enterDevice` 写一次性交接单进镜像页）；引导不可达/被拒/旧 bridge → 降级弹 §5.1 解锁层（人工输密码）。
- 服务端视角：MK 仍不落任何服务端；`/_e2ee/intro` 只是同账号授权通道上的一次明文应答（转发层可见“存在一次引导”，看不到内容语义之外的东西）。
- 引导生命周期：手机刷新/冷启动后内存清空 → 再次进入会**自动重新引导**（bridge 在线即可），全程免输密码；bridge 重启 / 会话 24h TTL / 账号改密（epoch 轮换，旧 MK 失效）同样触发重新引导或降级人工解锁。

> `[DECISION]` 信任边界（用户 2026-09 决策）：引导瞬间以“持有效扫码/登录会话 = 账号本人”为准——若二维码/链接被转发给他人，等同把该账号与 E2EE 授权交给对方（与所有“扫码登录”产品的泄露语义一致）；中继理论上存在“引导瞬间主动冒充电脑端”的主动攻击窗口（此时可下发自己的 MK 副本），但无法事后读取引导前/后未捕获的会话。该模型不适用于“中继连引导瞬间都不可信”的场景——后者请用 §5.1 人工密码解锁或 vNext PAKE/WebAuthn（§8.5）。须在“手机端扫码/一次性链接进入”与电脑端面板文案中如实告知（至少一句：扫码后由你的电脑自动开启加密；请勿将二维码/链接转发他人）。

---

## 6. 服务端与各端集成点（改动清单，本稿不改代码）

### 6.1 enterprise（闭源，需新增/调整——评审重点）

| 项 | 改动 |
|---|---|
| users 表 | 新列：`e2ee_salt`(b64)、`auth_salt`(若未按用户存盐则补)、`e2ee_epoch`(int)、`e2ee_enabled`(bool, 默认按灰度/后台开关写) |
| 注册/设密 | 生成两盐、算 scrypt verifier、`e2ee_epoch=1` |
| `POST /api/login`、`/api/device-login` | verifier 校验不变；响应 user 对象附 `e2ee:{enabled,…}`（供 PWA/面板显示） |
| **新增** `GET /api/e2ee-params` | Bearer → §3.4 JSON（salt/profile/epoch/enabled） |
| **新增** `POST /api/password/change`（或扩展现有改密） | 双盐轮换 + verifier 重算 + `epoch+1` + jwt_blacklist + mobile_sessions revoke + 设备强制重授权（一条事务） |
| admin / public-config | 全局灰度开关 `e2ee.enabled`（默认 false → 灰度 true）；admin 用户详情可单账号禁用/启用 |
| 安全 | verifier 比较恒定时间（已有）；记录 e2ee 参数下发审计（可选） |

> verifier 相关现状引用：`SECURITY.md` 已声明 scrypt `N=16384,r=8,p=1,keyLen=64`、恒定时间比较。本设计不改该行语义，只新增域分离盐与参数端点。

### 6.2 relay-router（open 仓库，最小改动）

| 文件/点 | 改动 |
|---|---|
| `index.mjs` 注册通道 | `tunnel-register` 帧新增可选 `caps`（bridge 上报 `["e2ee-v2"]`），router 原样记录 |
| `GET /_devices` | 条目附加 `caps`（手机据此判断“可加密”）——**纯透传，不校验不解释** |
| `resolveRoute` 的 `CHANNEL_MARKERS` | 加入 `"_e2ee"`（控制通道 channel 形态 `/remote/_e2ee/ctrl` + 设备头） |
| 转发逻辑 | **无正文改动**：http/ws-* 帧、`__chunk`、配额、402/502 错误页全部照旧；信封密文就是普通帧体 |
| 头处理 | 外层 `x-dsh-e2ee`、`content-type: application/vnd.dsh.e2ee-v2` 属透传头：确认不被 `STRIP_*` 剥除、不误判 gzip |
| 文档/注释 | 顶部帧协议注释标注 v2 信封为“body/data 载荷形态”，透明转发语义不变 |

### 6.3 bridge（open 仓库，`dsh-bridge.mjs` + `mobile-adapter` 同族注入）

| 点 | 改动 |
|---|---|
| 配置/启动 | E2EE 启用条件：账号模式（非 `DSH_BRIDGE_LOCAL_KEY`）且服务端 `e2ee.enabled`；启动时用 device-login JWT 拉 `e2ee-params` → 内存派生 MK（失败静默禁用该能力） |
| 注册 | `tunnel-register` 携带 `caps:["e2ee-v2"]` |
| 控制通道 | 识别 `/remote/<dev>/_e2ee/ctrl`（及 channel 形态）ws-open：**不连上游**，跑 §5.2 握手 |
| 数据 WS | `handleWsOpen` 解析并剥离 `e2ee`/`w` 查询参数；标记流解密→上游、上游→加密；探针通过前不转发 |
| HTTP | `handleHttpFrame` 检测 `content-type: application/vnd.dsh.e2ee-v2` → 解密还原请求；响应压缩先于加密；AEAD 失败返回明文 `502 + x-dsh-e2ee-error` |
| HTML 注入 | 复用现有 text/html 注入管线（mobile-adapter 同机制）注入 **crypto shim 引导脚本**（先于官方 bundles 执行；含解锁 UI 与状态徽标）与“本机已保存密码用于自动登录/加密”提示 |
| 日志 | 禁止记录密码/MK/明文正文（现状纪律延续） |

### 6.4 手机侧：PWA（`native.html`）+ 隧道页 shim + 插件浏览器半（`client.js`）

| 面 | 改动 |
|---|---|
| 注册/登录页 | §2.3 信任文案；注册密码框规则不变（≥8） |
| 设备选择页 | 按 `/_devices` 的 `caps` 显示设备“🔒 可加密”徽标；点选设备时若账号启用 E2EE 则**先经解锁页**再跳转（或跳转后由 shim 在隧道页内解锁，二选一，实现建议：隧道页内解锁，PWA 只提示） |
| 隧道页 shim | fetch/XHR/WebSocket 传输 patch（document-start，早于官方模块）；§4.5 策略表决定包裹；信封加/解密、探针、计数/重放、状态徽标、解锁 UI、错误处理（§5.1） |
| 插件浏览器半（Mac 面板） | “🔒 通道加密”卡片：显示本机 bridge 能力、账号 e2ee 状态、启停/重新登录入口；替换 §2.3 占位文案 |
| 文案 | 登录/解锁/重置密码三类文案按 §2.3/§5.3 落地 |

### 6.5 复用 v7 `auth-key` / `mobile-sessions` / `jwt_blacklist` / `revoke` 的映射

| 场景 | 复用映射 |
|---|---|
| 扫码授权后进设备 | `POST /api/auth-key/exchange`（现状）获得登录态 → 解锁（输密码）→ E2EE 会话与 auth-key 解耦，auth-key 仍只管登录 |
| 已授权设备列表/取消配对 | `mobile-sessions`（GET 列表/`POST :id/revoke`，插件已代理）：改密/找回时服务端**批量 revoke 全部**；取消配对后该手机下次需重新授权 + 重新解锁 |
| 会话失效 | `jwt_blacklist`：改密后旧 JWT（含 bridge 的 device-login JWT）进黑名单 → bridge 自动重登失败 → 面板提示更新密码；手机端 token 失效 → 回到登录页（现状 logout/401 处理复用） |
| 设备登记 | `POST /api/devices`（含 ed25519 `pub_key`）**不动**；未来若引入设备签名握手（§8.5）可直接用该公钥做配对校验 |

### 6.6 自建（self-hosted）模式

- 无账号/无密码体系 → **v1 不启用 E2EE**（bridge `local_key` 模式不声明 `caps`，PWA 本地密钥登录不显示加密徽标）；文档与面板如实说明“自建模式流量由你的部署与 TLS 保护，不提供账号密码级端到端加密”。
- `[DECISION]` 若未来要对“公共自建中继 + 自己的访问密钥”做 E2EE：可把 MK 改为由访问密钥派生（用户两端都持有该密钥），复用同一信封协议，仅换 §3.3 的 KDF 输入；列为 vNext。

---

## 7. 兼容、灰度、开关与禁用/重置

### 7.1 能力协商矩阵（信封标记 + caps 双信号）

| 手机 | bridge | 结果 |
|---|---|---|
| 新（有 shim） | 新（caps `e2ee-v2`） | 账号启用且解锁 → **加密**；未解锁/用户关闭 → 明文 + 徽标 |
| 新 | 旧（无 caps） | 明文回退；徽标“电脑端版本过旧，未加密”（bridge 提示升级） |
| 旧（无 shim） | 新 | 明文回退（bridge 不主动加密，被动等标记）；bridge 日志提示 |
| 自建（双旧逻辑） | 任意 | 明文（§6.6） |

握手本身带重试与超时（控制 WS 20s 对齐 `WS_OPEN_TIMEOUT_MS`）：超时/错误 → 明文回退 + 明确原因徽标，**绝不静默**。

### 7.2 版本号与协议演进

- 信封 `v:2`；帧协议版本概念：帧不加全局版本字段（现状无），用“信封标记 + 参数端点 profile”表达；旧帧类型永不删除（现状 `handleLegacyFrame` 已兼容无 type 帧，保持）。
- 参数/算法变更 = 升 `profile`（§3.3），新会话按新 profile 握手；旧会话自然过期；**不做同会话内换参**。
- 灰度：enterprise `public-config e2ee.enabled`（默认 false）→ 按比例/白名单开启 → 全量；每用户 `e2ee_enabled` 可后台单独关。

### 7.3 用户开关与状态提示

- 手机：解锁页“本次连接不加密（明文）”明确二次确认；状态徽标常驻（§2.4）。
- 电脑面板：通道加密卡片开关 = 影响“是否声明 caps + 是否在解锁时接受”（bridge 被动方；关闭后不再应答 `e2ee-hello`）。
- 服务端：账号级禁用（admin）→ `e2ee-params.enabled=false` → 手机不再弹解锁。

### 7.4 忘记密码 / 重置（预期管理成文）

1. 找回流程（短信/后台重置）→ 双盐轮换 + verifier 重算 + 全量 revoke（§5.3）。
2. **服务端无历史内容可恢复**；所有旧会话/授权作废。
3. 用户需要：手机重新登录并解锁（新密码）、电脑端面板更新账号密码 → bridge 重启。
4. UI 明示（§5.3 文案），README/SECURITY 同步说明“E2EE 下不存在服务端密码重置后仍可解密旧会话的机制”。

---

## 8. 风险与限制清单

1. **元数据可见（如实告知）**：路径/方法/大小/时间/是否加密对中继可见（路由配额所需），存在流量分析面（§2.3）。v1 不加密静态壳与 SSE（§4.5）。
2. **引导代码明文**：加密 shim 随被控 dsh web 的 HTML 壳下发；**主动作恶的中继**可改写该页移除 shim（降级攻击）。检出手段：AEAD 打开失败/徽标缺失提示用户；根治需“代码先于中继可信交付”（原生 App/内容签名），vNext。
3. **密码强度直接决定安全性**：密钥=密码，弱密码可被离线猜测（猜测成本=§3.3 KDF 成本；服务端另有 scrypt verifier）。注册策略保留 ≥8 位，面板/登录页提示高强度密码；不承诺对弱密码的绝对保护。
4. **离线猜测面**：任何捕获密文/探针都可做密码离线验证（代价=客户端 KDF 一次）。v1 采用 PBKDF2-600k（浏览器可算），与 verifier（scrypt）为两套成本面；升级路径=内存困难 profile / PAKE / OPAQUE（§8.5）。
5. **本地存储安全**：会话密钥仅内存（页面/进程）；密码明文仅存 bridge 本机 0600 配置（现状）——本机被攻破=内容可解密（§3.5）；页面 XSS 可读内存密钥（与 dsh web 同风险面）。`[DECISION-2026-09-2]` 手机端“记住本机”会把**派生 MK** 写 localStorage（等同“记住密码”，XSS 可读 → 该账号全部内容可解密），用户已按产品决策知情接受；退出登录清除、无痕浏览可避免；日志仍绝不记录 MK/密码。若后期切换到 WebAuthn 封存（§8.5）可将 MK 落盘暴露降到最低。
6. **登录服务器天然可见密码**（一次）：enterprise 必须在登录/改密时收到密码做 verifier 校验——这是既有登录协议，E2EE 只防“内容”不防“登录”本身；运营方可假冒任意会话（§2.1）。如需服务端不可见密码的登录，需引入 PAKE/OPAQUE（服务端只存 verifier 参与协议），列 vNext。
7. **配额/计量口径**：密文长度=明文+AEAD 开销，用量计量含开销（影响可忽略），gzip 迁移到加密前（§4.7）。
8. **监管/合规一句话**：端到端加密与“服务端不存内容”意味着**依法协助调查无法提供用户内容**（与主流 E2EE 产品一致），请在服务条款/隐私政策明示；本设计不提供任何后门/主密钥托管，用户内容恢复责任在用户侧。
9. **会话吊销的残余窗口**：改密 revoke 到手机下次校验之间 ≤1 次 JWT 生命周期；bridge 长连在 `bad_key`/401 前可能短暂存续（其内存 MK 随旧盐无法解密新流量，不扩大泄露）。

### 8.5 已记录的可选加固（vNext，不阻塞 v1）

- chacha20-poly1305 profile（非浏览器端）；scrypt/WASM 客户端 profile 提高离线成本。
- PAKE（SPAKE2+/OPAQUE）替换 §5.2 密码派生握手 → 中继不可离线猜密码、enterprise 可不接触明文密码。
- 设备 ed25519（`/api/devices` pub_key 已有）签名握手：防中继冒充 bridge（配合 auth-key 首次配对的指纹核对）。
- 内容签名/子资源完整性 + 原生客户端承载 shim，缓解风险 2。
- 浏览器免重输解锁（WebAuthn/系统凭据封存 MK 包装）。

---

## 9. 附录

### 9.1 常量总表（实现对齐用）

| 常量 | 值 |
|---|---|
| 域字符串 | `dsh-e2ee/v1`（所有 HKDF info / KDF 标签前缀） |
| 盐长 | `e2ee_salt`/`auth_salt` 各 16B 随机 |
| verifier | scrypt `N=16384,r=8,p=1,dkLen=64`（`SECURITY.md` 一致） |
| MK | PBKDF2-HMAC-SHA256, iter=600000, dkLen=32, salt=`"dsh-e2ee/v1/mk\0"‖e2ee_salt` |
| AEAD | AES-256-GCM，nonce 96-bit 随机，tag 128-bit |
| 会话 id / 随机数 | 128-bit hex（sessId）；32B（a/b 握手）；8B（w 流标识） |
| 计数 | 每 (会话,流,方向) u64；HTTP 防重放缓存 5min/4096 条 |
| 握手超时 | 20s（对齐 `WS_OPEN_TIMEOUT_MS`） |
| SHK TTL | 24h 滑动（超时重新解锁） |

### 9.2 现行 v1 帧 ↔ v2 信封对应示例

请求（手机→bridge，HTTP 语义）：

```jsonc
// 现状 v1 帧（router 发出；body 为密文时原样搬运）
{ "id":"r2x", "type":"http", "method":"POST",
  "path":"/api/session/s1/messages",
  "headers":{ "content-type":"application/vnd.dsh.e2ee-v2",
              "x-dsh-e2ee":"v=2;s=…32hex;c=1",
              "accept-encoding":"gzip" },
  "body":"<信封JSON(base64)>", "bodyBase64":true }

// 信封（=帧体内容，解密前）
{ "v":2,"k":"http","s":"…","c":1,"n":"<nonce_b64>","t":0,
  "d":"<b64(AES-GCM(JSON{ m,p,h,b }) ‖ tag)>" }
```

响应（bridge→router→手机）信封内明文：`{"st":200,"h":{…},"enc":"gzip","b":"<b64>"}`。

WS 消息帧（现状帧结构不变，载荷=信封或原文）：`{ "id":"…","type":"ws-msg","data":"<信封JSON或原文>","binary":false }`。

### 9.3 实现里程碑（供排期，非本文改动）

1. enterprise：盐列/参数端点/改密轮换+revoke（§6.1）→ 2. bridge：MK+握手+信封收发+HTML 注入（§6.3）→ 3. router：caps/_e2ee 标记（§6.2）→ 4. 手机 shim+PWA 文案（§6.4）→ 5. 灰度与回归（旧 bridge/旧手机/自建/配额/错误页）。

### 9.4 本文不影响（不改动）的现有接口清单

- router：`/_login`、`/_devices`、`/_quota`、`/remote/`、`/_bridge` 帧协议、`__chunk`、配额桶（除 §6.2 增量）；错误页 401/403/402/502/504 语义不变。
- bridge：注册/心跳/重连、`handleLegacyFrame`、gzip/移动适配管线、device 登记、`.dsh-config.json` 0600。
- PWA：登录/注册/短信/扫码 auth-key、`/_devices` 选设备、退出清理、promo 页。
- 插件：`/dsh-remote/*` 代理、access-key/mobile-sessions revoke、自管理/更新/卸载。
- enterprise（除 §6.1 新增列与端点）：login/register/devices/auth-key/mobile-sessions/jwt_blacklist 语义与响应字段保持兼容（新增字段须向后兼容）。

---

*（完）——本文件仅新增于 `docs/`，未修改任何代码或既有文档。评审意见请以 [DECISION] 标记逐条给出。*
