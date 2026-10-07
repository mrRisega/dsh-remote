# dsh-remote × DeepSeek Harness 桌面端 —— 技术栈与兼容性调研

> 调研日期：2026-10-07
> 调研对象：DeepSeek Harness 桌面端 v0.2 预览（安装包实测版本 **0.2.0-rc.2**）
> 方法：官方源码（`deepseek-ai/deepseek-harness` `apps/desktop`、`apps/desktop-host`）+ 官方文档
> + **把 macOS 安装包下载并拆包实测**（未安装、未改动本机环境）
> 结论一句话：**架构上高度适配，不需要重写；有 3 个真实缺口 + 1 个「兼容声明与实际门禁不一致」的问题要处理。**

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 桌面端是什么技术栈？ | **Electron 薄壳 + 完整的 dsh Web Host**（就是同一个 `dsh web` 应用，以 `--no-open --port 0` 启动） |
| 现有远程访问代理适配度如何？ | **高**。bridge 的「本机 HTTP 上游 + 会话 Cookie 鉴权」模型在桌面端**依然成立**，且两个最难的点（随机端口、令牌鉴权）插件**早就已经实现**了 |
| 能不能适配下一版？ | **能**，且是「补适配点」而非「重写」。核心工作量在：Electron 子进程启动方式、无系统 Node 的机器、desktop profile 安装 |
| 会不会被 0.2 的版本门禁拦住？ | **不会**（已核实门禁只认 `peerDependencies`，本插件没有该字段）。但我们的 `engines.dsh` 声明与实际门禁不一致，需一并处理 |
| 功能能否保持一致？ | 能。桌面端与 Web 版**共用同一份前端 bundle**，手机端镜像的就是同一套 UI |

**最关键的一条**：桌面端的运行形态 = **随机端口 + 每进程令牌鉴权**。
而这两件事 dsh-remote 恰好都因为真实事故适配过了（0.6.15 随机端口事故、dsh web 0.1.2+ 令牌鉴权）。
所以桌面端不是「另一种物种」，而是**这两者的叠加**。

---

## 1. 桌面端技术栈（事实 + 证据）

### 1.1 发布事实

- 发布：2026-09-29，DeepSeek Harness **v0.2 预览版**，提供 macOS(arm64) 与 Windows(x64) 安装包
- 官网直链：
  - `https://download.deepseek.com/desktop/dsh-latest-macos-arm64.dmg`（352 MB）
  - `https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe`（276 MB）
- **实测安装包内版本 = `0.2.0-rc.2`**（与 npm 上 `@deepseek-ai/dsh` 的 `latest` 一致）
- 桌面端**是开源的**，源码在仓库的 `apps/desktop`（Electron 壳）与 `apps/desktop-host`（Host 启动器）

### 1.2 架构（来自官方 `apps/desktop/README.zh.md` 与源码）

```
┌─────────────────────────────────────────────┐
│ Electron 主进程（壳）                        │
│  · 单实例锁，独占 $DSH_HOME/profiles/desktop │
│  · 渲染页面从自定义协议 dsh-app://app/ 加载   │
│  · 把页面的 HTTP 请求「转发」给 Host          │
└───────────────┬─────────────────────────────┘
                │ IPC（url / injections / 生命周期）
                ▼
┌─────────────────────────────────────────────┐
│ Host = ELECTRON_RUN_AS_NODE 子进程           │
│  = 标准 dsh web app（web profile 模板的 bundle 列表）│
│  args: --no-open --port 0                    │
│  监听 127.0.0.1:<系统随机端口>                │
└─────────────────────────────────────────────┘
```

决定性源码（`apps/desktop-host/src/index.ts`）：

```ts
const application = runProfile({
  profile: 'desktop',
  args: ['--no-open', '--port', '0'],          // ← 随机端口
})
...
const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`)
process.send?.({ type: 'ready', url, injections: ctx.webServer.collectIndexInjections() })
```

### 1.3 传输与鉴权（对 dsh-remote 最关键的两点）

1. **Host 就是一个真正的 HTTP 服务**：标准 web app bundle（含 `dsh-host-webserver`），监听回环地址。
   官方 README 原文：
   > 「Desktop 默认监听系统分配的端口，因此不会与 Web 的 `3080` 或系统预留端口冲突；
   > 可通过 `webserver.config.port` patch 覆盖。」

2. **鉴权与 `dsh web` 完全同一套**（`@deepseek-ai/dsh-client-connection`）：
   - 每个进程生成一个**随机启动令牌**
   - 带 `?token=` 访问 `GET /` 换取**绑定 authority 的签名 cookie**（`dsh-auth-*`）
   - 缺失/过期/authority 不匹配的 cookie → **401**
   - ⚠️ **不接受 Authorization header token**，也不在根路径交换之外接受 query token
   - Cookie：host-only、`Path=/`、`HttpOnly`、`SameSite=Strict`（回环 HTTP 故不设 `Secure`），默认 30 天
   - 转发时 Electron 会**丢弃** `set-cookie`（cookie 由壳持有），并带上自己那份

3. **桌面渲染层**：Electron 从 `dsh-app://app/` 加载打包 Web dist，HTTP 请求经 Electron 转发到 Host
   （`apps/desktop/src/web-document.ts` 的 `forwardWebRequest`）。

4. **对产品的含义（正面）**：桌面端**关闭窗口 ≠ 退出**（macOS 留在 Dock、Windows 留托盘，
   「页面和 Host 继续运行」）→ 意味着**桌面端关窗后远程访问依然可用**，
   这与 dsh-remote「人在外面用手机接管电脑上的会话」的场景天然契合。

### 1.4 插件与 profile 归属（安装侧的关键约束）

| 事实 | 说明 |
|---|---|
| 桌面独占 profile | `$DSH_HOME/profiles/desktop`，由 Electron 应用**自己初始化** |
| 与 Web 版共享数据 | 会话/设置/凭据/工作区/存储**共享**；但**可执行包、插件激活、锁文件彼此隔离** |
| 安装插件必须用桌面自带 CLI | `resources/runtime/cli/bin/dsh plugin --profile desktop add <pkg>` |
| **npm 的 dsh 不能管 desktop profile** | 见 `apps/cli`：`rejectElectronProfile()` → *"profile \"desktop\" is managed exclusively by the Electron application"* |
| 安装前置条件 | 必须先启动一次桌面端初始化 profile，然后**完全退出应用**（profile 有文件锁） |
| 官方也有插件管理页 | 桌面「插件」页走共享 Web 插件管理器 + 内置 pnpm，可在应用运行时装 |
| 版本兼容门禁 | profile 内插件受 `readProfileCompatibility` 校验（依据 `peerDependencies`），不兼容会**拒绝激活** |
| 自带运行时 | Node **24.18.1** + pnpm **11.7.0** + Python（装到 `~/.dsh/dsh-runtimes/dsh-primary-runtime`） |

已实测确认的路径（DMG 拆包）：

```bash
# 内置 CLI（带 manageDesktopProfile 权限的那个）
/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh
#   → ELECTRON_RUN_AS_NODE=1 exec ".../MacOS/DeepSeek Harness" --expose-internals \
#       ".../app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" "$@"
# 内置运行时版本
/Applications/DeepSeek Harness.app/Contents/Resources/runtime/versions.json
#   → {"schemaVersion":1,"node":"24.18.1","pnpm":"11.7.0"}
```

---

## 2. 兼容性逐项评估

| # | 关注点 | 桌面端行为 | dsh-remote 现状 | 判定 |
|---|---|---|---|---|
| 1 | 上游 HTTP 服务 | Host 监听 `127.0.0.1:<随机端口>` | bridge 以 HTTP/WS 代理到本机上游 | ✅ **模型成立** |
| 2 | 端口发现 | `--port 0`，端口随机 | 插件读 `ctx.webServer.port` 并落盘 `.dsh-upstream`；bridge 优先读该文件 | ✅ **已适配** |
| 3 | 会话鉴权 | 随机令牌 → `dsh-auth-*` cookie，无 cookie 401 | 插件已用 `ctx.connection.authenticatedUrl()` 换 cookie 落 `.harness-cookie.json`，bridge 自动携带 + 401 自愈 | ✅ **已适配** |
| 4 | 路由注册 | `ctx.webServer.register` / `registerUpgrade` | 插件用同一 API | ✅ |
| 5 | 前端与移动端适配 | 同一份 web 前端 bundle（v0.2 UI） | bridge 注入 `mobile-adapter` + `e2ee-shim` | ✅ 应可用（需回归） |
| 6 | 运行时补装 | 桌面无系统 Node 也能用 | 插件包**自带 `runtime/`**，补装退化为本地拷贝（无需 npx） | ✅ |
| 7 | 插件版本门禁 | 0.2.0-rc.2 会校验 `peerDependencies` 中的 `@deepseek-ai/dsh*` | 插件**没有 `peerDependencies`** → 门禁不触发；但声明了 `engines.dsh: <0.2.0-0`（该字段**无任何 DSH 代码读取**） | ⚠️ **声明不一致** |
| 8 | **子进程启动方式** | `process.execPath` 是 **Electron 二进制** | 插件全程 `spawn(process.execPath, [script])`，**未设 `ELECTRON_RUN_AS_NODE`** | 🔴 **缺口** |
| 9 | **无系统 Node 的机器** | 自带 Node 但**不进 PATH** | `preferredNode()` 探 Homebrew node@20，找不到回落 `process.execPath`（=Electron） | 🔴 **缺口** |
| 10 | **安装落点** | `profiles/desktop`，Electron 独占 + 文件锁 + 需桌面自带 CLI | 安装器默认 `profiles/web`，走 npm dsh / npx | 🟠 **缺口** |
| 11 | 「重启 dsh web」 | Host 由 Electron 托管，杀掉会触发**原生致命恢复弹窗** | 面板提供「重启 DeepSeek harness」按钮 | 🟠 **需改语义** |
| 12 | 插件激活 / HMR | 共享 web 插件管理器 | 已用 `dsh.profile.bundles` 单点激活 | ⚠️ 待回归 |

### 2.1 关于 #7（兼容声明）的细节 —— 门禁是 `peerDependencies`，不是 `engines.dsh`

**先纠正一个容易踩的误解**：`engines.dsh` 看起来像版本门禁，实际上
**DSH 全部官方包中没有任何代码读取它**（已逐个包 grep 核实：`dsh-app-boot`、`dsh-plugin-manager`、
`dsh-cli` 均无）。真正生效的门禁在 `@deepseek-ai/dsh-app-boot` 的
`evaluatePluginCompatibility()`：

```js
function evaluatePluginCompatibility(manifest, exemptions = {}, runtimeVersion) {
  if (!Object.hasOwn(fields, "peerDependencies")) return void 0;        // ← 没有该字段 = 不检查
  for (const [name, range] of Object.entries(dependencies)) {
    if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;  // 只认 @deepseek-ai/dsh*
    if (!semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })) peers[name] = range;
  }
  ...
}
```

本插件的现状：

```jsonc
// packages/dsh-remote-web/package.json
"engines": { "dsh": ">=0.1.0-rc.6 <0.2.0-0" }   // ← 无人读取（装饰性）
// 没有任何 peerDependencies 键                              // ← 因此门禁不触发
```

**推论（两条，方向相反）**：

1. ✅ **好消息**：桌面端（0.2.0-rc.2）**不会拒绝安装/激活**本插件。
   我最初以为 `engines.dsh` 会拦，实测核实后推翻了这个判断。
2. ⚠️ **坏消息**：我们**自称不支持 0.2，却没有任何机制保护自己**。
   如果 0.2 上真的出现不兼容，用户不会收到任何警告，直接踩坑（官方文案口径：*可能崩溃或数据丢失*）。
   同时，官方插件管理器/市场做兼容性展示时也读不到我们的声明。

**处置建议**：0.2 回归通过后，二选一（推荐后者）：

- 最小改动：把 `engines.dsh` 上界放宽到覆盖 0.2.x。**注意这只是文档性声明，不产生任何保护。**
- 对齐官方口径（推荐）：改用官方唯一识别的字段声明兼容范围，从而获得
  「安装前拦截 + `allow-version` 豁免通道 + 管理器内可见的兼容性」三件事：

  ```jsonc
  "peerDependencies": { "@deepseek-ai/dsh": ">=0.1.0-rc.6 <0.3.0-0" }
  ```

  ⚠️ 代价：范围写错会**真的拦住安装**，所以必须先完成 0.2 回归再定区间。

- 逃生口（仅供开发/应急，**不应作为产品路径**——等于让用户替我们背书风险）：

  ```bash
  dsh plugin --profile desktop allow-version dsh-remote-web@<version> \
    --dsh-version 0.2.0-rc.2 --accept-risk
  ```

### 2.2 关于 #8 / #9（Electron 子进程）的细节

插件用 `process.execPath` 拉起 bridge / watcher / 安装器（`lib/index.js` 多处）：

```js
const NODE_BIN = preferredNode()            // ← 探 /opt/homebrew/opt/node@20/bin/node …
// 回落：resolveExecutable(process.execPath) || process.execPath
```

- 在 `dsh web`（真 Node）下 ✅
- 在桌面端 Host（Electron）下，`process.execPath` = `/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness`
  → 直接 `spawn(execPath, [script])` **不是跑脚本**，而是**又拉起一个 Electron 应用实例**
  （还会撞单实例锁）
  → 必须补 `ELECTRON_RUN_AS_NODE=1`（官方自己也正是这么做的）

具体缺口的集中点就是 `spawnEnv()` ——它已有「把 node 目录补进 PATH」的机制，
最适合在这里按宿主形态补 `ELECTRON_RUN_AS_NODE`。

### 2.3 为什么适配度其实很高（关键洞察）

插件此前为两类**真实线上事故**做过适配，而这两件事**正是桌面端的形态**：

| 事故 | 促成的能力 | 桌面端是否复用 |
|---|---|---|
| 0.6.15 飞牛 fnOS 用户 dsh web 在 2298 端口，面板永远「不可达」 | 「上游端口必须**问出来**，不是猜出来」+ 主动发现 + `.dsh-upstream` | ✅ 桌面随机端口直接用 |
| dsh web 0.1.2+ 引入浏览器令牌鉴权，手机端白页 | 插件**代持会话 Cookie** + 401 自愈标记 | ✅ 桌面令牌鉴权直接用 |

桌面端 = 随机端口 **+** 令牌鉴权。这两套机制已经在生产跑，因此**不需要重写**。

---

## 3. 适配方案（下一版）

### A. 版本与兼容声明（不阻塞安装，但必须处理）

1. 在 0.2.0-rc.2 上跑通回归（见 D），确认无破坏性变更。
2. 按 §2.1 结论处理声明：**推荐改用 `peerDependencies: { "@deepseek-ai/dsh": "..." }`**
   拿到官方门禁的保护与可见性；若暂不采用，至少把无效的 `engines.dsh` 上界放宽或删除，
   避免留下「自称不支持」却无保护的误导性声明。
3. 同步更新 CHANGELOG（业主口径：简洁、只写用户可感知价值）。

### B. 运行期适配（Electron 子进程 + 无系统 Node）

1. `spawnEnv()`：检测 `process.versions.electron`，为所有 `process.execPath` 派生的
   子进程补 `ELECTRON_RUN_AS_NODE=1`（并避免 `--expose-internals` 之类误伤）。
2. `preferredNode()`：在桌面端优先用**桌面自带的 Node**
   （`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/`），
   或直接以 `ELECTRON_RUN_AS_NODE` 复用 Host 的 Electron 可执行文件。
3. 自启动服务（launchd `com.dshremote.bridge` / systemd / schtasks）里的 node 路径
   必须指向**长期存在**的解释器：桌面端卸载/更新后 `.app` 路径会变，需在服务定义里
   记「桌面端路径 + 回退到系统 node」，并在桌面端缺失时优雅降级（不注册自启动，仅随会话运行）。
4. 重启桥接与 Host 的关系重新界定：bridge 是**独立进程**，重启 Host（桌面应用）不影响它。

### C. 安装与生命周期（desktop profile）

1. **宿主形态检测**：`process.versions.electron` 有值 ⇒ 桌面端 Host。
2. 安装器支持目标 profile：
   - 默认仍 `~/.dsh/profiles/web`
   - 新增 `--desktop`（或自动探测 `~/.dsh/profiles/desktop` 存在）
   - ⚠️ **不能**用 npm 版 `dsh` 装 desktop profile —— 必须走
     `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`
     （Windows 为 `resources\runtime\cli\bin\dsh.cmd`），且要求**应用已完全退出**
   - 更推荐的主路径：引导用户走**桌面端「插件」页**安装 `dsh-remote-web`
     （共享插件管理器 + 内置 pnpm，无需退出应用）
3. 「重启 DeepSeek harness」按钮在桌面端改为：
   **不杀 Host**，改为提示「请重启 DeepSeek Harness 应用」（避免触发原生致命恢复弹窗）。
   优先依赖已有的 profile patch HMR 热加载路径。
4. 自启动与「彻底卸载」逻辑在桌面端走同一套（服务名不变，node 路径按 B3 处理）。

### D. 双端一致性回归

| 项 | 验证方式 |
|---|---|
| 插件在 0.2.0-rc.2 能激活 | 桌面端「插件」页安装 / 内置 CLI `plugin --profile desktop add` |
| 端口能被问出来 | 面板「上游」显示 `127.0.0.1:<随机端口>` 且可达 |
| Cookie 代持生效 | 手机端不白页；杀掉 Host 重启后 401 自愈 |
| mobile-adapter 注入 | v0.2 新 UI（Office/PDF 预览、插件页）下布局不破 |
| bridge 在无系统 Node 机器可跑 | 临时把 PATH 去掉 node/npx 验证 |
| 桌面端与 Web 版功能一致 | 同一份 checklist 跑两遍（发消息/工具执行/审批/设置/凭据/特权操作） |
| 不回归 | `npm test`（router + plugin + bridge）全绿 |

---

## 4. 风险与未决项

| 风险 | 说明 | 处置 |
|---|---|---|
| **无门禁保护** | 插件不声明 `peerDependencies`，0.2 上若真不兼容不会有任何警告 | §2.1：回归后改用官方字段 |
| 0.2.x 前端结构性变更 | 0.2 新增了插件页、Office/PDF 预览、Subagent 侧栏等，移动端适配层可能需要跟着调 | D 阶段回归，必要时只调 `mobile-adapter.mjs` |
| Electron 下 `ctx.get("connection")` 行为 | 插件已有 `try` 兜底，但桌面端 Host 是 Electron Node 模式 | 实测确认 |
| 桌面端更新会换 `.app` 路径 | 自启动服务里的绝对路径会失效 | B3 |
| 无系统 Node 的「开箱即用」用户 | 桌面端主打开箱即用，这类用户没有 node/npx | B2 + 自带 runtime 已可覆盖 |
| 双 profile 并存 | 用户可能 Web 版与桌面端都开 | 共享 `$DSH_HOME`，但 profile 隔离；插件需按当前 Host 自适应，不互相干扰 |

---

## 5. 参考来源

- 桌面端架构文档（官方）：`apps/desktop/README.zh.md`
- 桌面 Host 启动器源码：`apps/desktop-host/src/index.ts`
- 桌面 Web 文档与转发：`apps/desktop/src/web-document.ts`
- 浏览器鉴权与信任栅栏：`@deepseek-ai/dsh-client-connection` README
- 路由注册与 Electron 说明：`@deepseek-ai/dsh-host-webserver` README
- profile 模板与 `desktop` profile 拒绝逻辑：`@deepseek-ai/dsh-app-boot`、`@deepseek-ai/dsh`(apps/cli)
- 插件版本门禁：`@deepseek-ai/dsh-plugin-manager`
- 官网：https://www.deepseek.com/harness/ ｜ 文档：https://deepseek-harness.github.io/deepseek-harness/

---

## 6. 【2026-10-08 实测补充】mobile-adapter 的 DOM 契约在 0.2 上**未破坏**

### 6.1 方法（含一次被自己证伪的错误方法，务必照这个来）

`mobile-adapter.mjs` 靠**官方混淆类名**（`.pI_x6G_frame` 这类）与 `data-*` 布局状态属性定位元素。
这些名字来自官方构建，**换版本可能变**；一旦变了，适配层会**静默失效** —— 页面照常打开，
只是手机端布局全坏，**只有真机才看得出来**。

| 方法 | 结果 | 判定 |
|---|---|---|
| ❌ HTTP 抓首屏 HTML + 其引用的资源再搜锚点 | 0.2"缺 11/12"、0.1.5 对照也"缺 12/12" | **假阴性，已证伪**：锚点在懒加载 chunk / 别的包里，首屏抓不到 |
| ✅ **直接 grep 框架树里的构建产物** | 见 6.3 | 可信 |

**教训**：任何"锚点消失"的结论，必须先在**当前线上版本**上跑同一命令做对照 ——
线上也缺同样几项，就说明是历史遗留而非本次升级引入。

### 6.2 工具

```bash
# 线上树（对照基准）
node scripts/check-ui-anchors.mjs /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
# 新版树（如 0.2）
node scripts/check-ui-anchors.mjs ~/.npm/_npx/<hash>/node_modules/@deepseek-ai
```
锚点清单**从 `mobile-adapter.mjs` 自动抽取**（含过滤规则），不另抄一份，避免清单漂移。
每次 DSH 升级都应各跑一次并比对两列。

### 6.3 结果（0.1.5-rc.2 线上 vs 0.2.0-rc.2）

| | 线上 0.1.5 | 新 0.2.0 |
|---|---|---|
| 官方类名 | **14 / 14** | **14 / 14** |
| `data-*` 属性 | 9 / 12 | **9 / 12（缺的完全相同）** |

缺失的 3 个：`data-details-collapsed`、`data-sidebar-open`、`data-rtt`。
其中 `data-rtt` 是**适配层自己设在自有 FAB 上**的（抽取器的无害误报）；
另外两个在 **0.1.5 上就已经缺失**，属历史遗留，与 0.2 无关。

**结论：0.2 相对线上 0.1.5 零新增破坏，mobile-adapter 不需要为 0.2 改动。**
D 阶段该项目的风险由"未知"降为"已核销"；真机仍需做视觉确认，但已无契约层面的隐患。

### 6.4 本轮一并核销的其它桌面端项

| D 阶段项 | 结论与证据 |
|---|---|
| 插件在 0.2 能激活 | ✅ 影子加载 + **官方桌面端 CLI `plugin --profile desktop add`** 真装成功，登记进 `dsh.profile.bundles`，**安装期兼容门未拦** |
| 端口能被问出来 | ✅ 0.2 随机端口被自动探到（`upstreamSource = dsh web 实际监听端口`） |
| Cookie 代持生效 | ✅ 启动令牌 → `dsh-auth-*` cookie，随后 `/dsh-remote/*` 全部 200 |
| 桌面端宿主形态 | ✅ **用官方 Electron 二进制 + DMG 自带 0.2.0-rc.2 runtime 实跑 Host**：`desktopHost=true`、`restartSupported=false`；重启接口返回 `desktop-managed` 且不杀 Host |
| Electron 子进程路线 | ✅ 官方 CLI shim 自身即 `ELECTRON_RUN_AS_NODE=1 exec <Electron>`，与本插件实现同源 |
| 自带 node 布局 | ✅ 实测 `primary-runtime/dependencies/node/bin/node`（Node v24.21.0）；`DSH_DESKTOP_NODE_EXECUTABLE` 为应用自报路径 |
| 未核销 | 真机视觉确认（需手机）、Windows 真机（需 Windows 机器） |

