# Changelog

All notable changes to dsh-remote are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [0.6.2] - 2026-09-11

> 稳定版（`latest`）。主题：**插件市场安装即可用**（补齐桌面运行环境 + 修复自愈停摆 + 首次安装重启引导）。

### Fixed

- **插件市场安装后 bridge 起不来、且永远不自愈**（本机实测复现并修复）。只装插件半（市场/`dsh plugin add`）
  的用户，桌面运行环境 `~/.dsh-remote/dsh-setup.mjs` 从未被补齐，而登录/「启动 bridge」会直接写 plist 并
  `launchctl bootstrap` → 指向不存在的脚本 → launchd KeepAlive 无限重拉（实测 `runs = 23`、
  `last exit code = 1`、日志 20+ 次 `MODULE_NOT_FOUND`）。三处根因一并修掉：
  1. **`startBridge()` 不再在运行环境缺失时 bootstrap**：改为拒绝启动并转入后台补装，不再生成指向空路径的
     自启动项（这类 plist 是崩溃循环的唯一来源）。
  2. **`launchdStatus()` 不再把崩溃循环谎报为「运行中」**：`launchctl print` 能打印时以它的 `state` 为准，
     绝不回退 `launchctl list`——崩溃循环里 list 的 PID 列会闪现**已死**的 pid（实测 `40213 1` 而
     `ps -p 40213` 为空），旧实现据此报 `running: true`，直接导致第 3 条的自愈停摆。
  3. **自愈顺序修正**：`scheduleRuntime` 把「运行环境是否就绪」提到最前，先于「账号是否登录」与
     「服务是否在跑」判断；并主动摘除指向不存在脚本的失效自启动（`bootout` + 删 plist），止住崩溃循环。
  另：插件加载（`apply`）即开始后台补装运行环境，不再等用户先登录；自启动 plist 增加 `ThrottleInterval`，
  崩溃时不再空转重拉。

### Added

- **首次安装/更新后引导重启 DeepSeek harness**：dsh web 的插件（宿主半 + 浏览器半）都在进程启动时装载，
  市场安装只是把文件写进 profile，必须重启才生效。现在：
  - 「设置 → 远程访问」**顶部醒目提示**「首次安装需要重启 DeepSeek harness」+「重启」按钮；
  - 面板**最底部常驻**「🔄 重启 DeepSeek harness」按钮（随时可达）；
  - 面板内一键重启：优先交回监管者（`launchctl kickstart -k` 精确匹配承载本插件的作业 / `systemctl --user
    restart`），无监管者时用原命令行自拉起；重启期间页面自动轮询并在服务恢复后刷新，无需手动操作；
  - 「待重启」状态持久化并跨进程结清：真重启后提示自动消失，同一进程内（仅刷新页面）不会误撤。
- `GET /dsh-remote/status` 新增 `service.runtimeReady` 与 `restart`（`pending/kind/reason`），面板据此
  区分「运行环境没装（自动补装中）」与「装了但没跑」，并把崩溃循环如实显示为「启动失败（已自动转入修复）」。

### Changed

- `npm run test:plugin` 默认置位 `DSH_RELAY_SKIP_SERVICE=1`（测试隔离）：插件加载不再在用例里触发真实
  npx 补装 / launchctl / 重启 harness；需要真实分支的用例显式 unset。

## [0.6.1] - 2026-09-10

> 稳定版（`latest`）。内容 = 预发版 `0.6.1-beta.1`（首次安装登录体验修复）+ 交流群二维码。

### Added

- **交流群二维码（后台可配，四处展示）**：管理后台「推广」页新增「交流群二维码」上传卡片，上传后即时生效于
  ① 官网落地页、② 付费页（`/app/promo`）底部、③ 电脑端「设置 → 远程访问 → 关于 dsh-remote」的
  **「💬 加入交流群」按钮**（点击弹出二维码大图）、④ 用户反馈页底部；未上传时这几处一律不展示入口，
  图片加载失败也自动隐藏（不留空壳）。配置经公开配置 `community.qrcode` 下发，插件侧由
  `/dsh-remote/community` 转发并把相对路径拼成企业端绝对地址。
- README 增加「企微交流群」章节（含二维码图片），方便用户扫码入群。

### Fixed

- **首次安装后立即登录 → 二维码与已授权设备列表报「尚未登录」红字**（需要刷新页面才恢复）：
  根因是企业端 `POST /api/device-login` 强制校验共享密钥 `x-dsh-bridge-secret`，而该字段原本
  只有一键安装器（`npx @mrrisega/dsh-remote` → `dsh-setup.mjs`）会写入配置；**只装插件**的路径
  （`dsh plugin add` / 插件市场安装）没有这一步，插件侧 `device-login` 便一直缺密钥 → 拿不到
  token → 面板把「中继未就绪」误报成「尚未登录」。现在插件侧补上同一份自愈：缺密钥即向
  `/api/public-config` 取一次、落盘并缓存（服务端轮换密钥时自动重取），bridge 若已在运行则后台
  重启一次使其带上密钥。
- **面板不再需要手动刷新页面**：登录成功（含换账号）与 bridge 拉起/重启都会立即重取二维码与设备
  列表；中继握手未就绪类失败（可重试）按 1.2s / 3s / 6s 退避自动重试，成功即自动清除提示，
  红字旁常驻「立即重试」入口。bridge 重启/中继短时抖动不再需要用户手动刷新。

### Changed

- 错误文案不再一律谎报「尚未登录」：区分「未登录（去登录）」、`relogin_required`（本机密码已失效，
  提示用新密码重新登录）与 `relay_not_ready` / `relay_unreachable`（中继未就绪或不可达，可重试，
  返回 HTTP 503 + `retryable: true`），并保留上游原因便于排查。
- 服务端取 token 增加一次退避重试（网络抖动/5xx/连接被断）与共享密钥轮换重取，减少首次登录的
  偶发失败面。

### Tests

- 新增 `packages/dsh-remote-web/test/first-login-selfheal.test.mjs`（node 半：缺密钥自愈/落盘、
  5xx 与网络失败重试、密钥轮换、503+retryable 语义、账号密码失效、自建模式不取设备密钥）。
- 新增 `packages/dsh-remote-web/test/login-selfheal-ui.test.mjs`（浏览器半：真实 `useEffect` +
  假定时器驱动登录 → 首次失败 → 退避自动重试 → 二维码与设备列表恢复，无需刷新页面）。
- 新增 `packages/dsh-remote-web/test/community-qr-ui.test.mjs`（node 半拼址 + 设置面板按钮/弹窗渲染 +
  未配置不展示 + 反馈页展示）与付费页交流群卡片源码级契约。

## [0.6.0] - 2026-09-09

> 本版只记录**面向用户**的变化（管理后台/服务端后台更新不在此列）。稳定通道仍为
> `latest`（0.5.0），本版走 `beta` 预发通道。

### Added

- **扫码/无密码路径免输 E2EE 密码（桌面授权引入）**：用电脑端二维码或一次性链接进入后，
  由电脑自动授权开启端到端加密；短信/扫码登录不再要求“再输一次密码”。
- **记住本机（刷新不掉回明文）**：解锁一次后派生密钥安全保存于本机浏览器，手机 App 刷新、
  镜像页刷新都自动恢复加密；退出登录即清除（浏览器无痕可不用）。
- 电脑端侧栏新增 **「📱 远程访问」快捷按钮**（与官方「设置」共存、不遮挡），首次带引导红点。

### Changed

- 移动端体验：选中会话后侧栏抽屉自动收起；E2EE 状态徽标展示几秒后自动缩成小 🔒。
- 修复移动端“Settings are unavailable”/模型提供方目录加载失败（设置页在镜像环境可正常使用）。

### Security

- E2EE 依旧：服务端只保存密码的不可逆校验值，不存密码明文与内容；“记住本机”将派生密钥
  存于本机浏览器（等同网页端“记住密码”的暴露面），退出登录即清除——详见
  `docs/e2ee-protocol.md` §5.1/§5.4。

## [0.5.0] - 2026-09-08

### Changed

- **Plugin renamed `dsh-remote-ui` → `dsh-remote-web`** (repo dir
  `packages/dsh-remote-web`, npm `dsh-remote-web`): the package is dsh-remote's
  dsh web plugin half (remote-control host plugin + settings panel), so `-web`
  matches what it is; `-ui` read as a pure UI/skin plugin. Installers and the
  panel's self-uninstall now migrate/clean the legacy name (≤0.4.9
  `dsh-remote-ui`, `dsh-remote-ui-plugin`, `node_modules/dsh-remote-ui`)
  alongside the new one, so upgrades and uninstalls leave no double-activation
  residue.
- Root CLI bumped to 0.5.0 to ship the renamed plugin and the migration in
  `dsh-setup.mjs` (dependency key, bundles entry, local copy dir and
  `node_modules` link all use `dsh-remote-web`; legacy keys are removed).

## [0.3.1] - 2026-08-30

### Changed

- Feedback captcha is now optional: anonymous users (including self-hosted
  deployments without a phone account) can submit feedback and satisfaction
  ratings directly; the server still records the device IP and enforces
  per-identity/IP/global rate limits. A captcha is validated when provided.
- Payment modal shows a prominent announcement block from the server config
  (`upgrade_announcement`, `{wechat}` substituted with the configured WeChat
  id); admin console textarea enlarged for editing it.
- README: added screenshot gallery (phone mirror view, device list,
  self-hosted settings).

## [0.3.0] - 2026-08-28

### Changed

- **Project renamed to `dsh-remote`** — package, binaries, docs and commands
  now use `dsh-remote` (`npx @mrrisega/dsh-remote`). The old npm package
  `@mrrisega/dsh-relay` is deprecated.

### Fixed

- Feedback: logged-in users (SaaS account or self-hosted key) no longer need a
  captcha — the plugin's node half attaches the account JWT automatically, and
  the panel/popup hide the captcha field accordingly. Anonymous submissions
  keep the captcha requirement.
- Satisfaction popup: submit no longer blocks on a hidden captcha when
  anonymous users cannot load it; captcha is loaded on demand and errors are
  actionable.

## [0.2.1] - 2026-08-28

### Fixed

- `setup` / settings page now fetch the server-issued `bridge_secret` from
  `public-config` automatically, so a fresh one-command install can sign in to
  the cloud service without manual configuration.
- Bridge no longer misreports `device_limit_exceeded` (409) as "device bound to
  another account"; it now prints the server's actual message with guidance to
  remove the old device first.

## [0.2.0] - 2026-08-27

First public release of the tunnel-mode architecture.

### Added

- One-command client install via npm: `npx @mrrisega/dsh-remote`
  (installs bridge + dsh web plugin + autostart in one shot; login happens in
  the local settings page afterwards).
  Self-hosted mode: `npx @mrrisega/dsh-remote setup --server wss://… --key …`.
- Self-hosted mode: `relay-router` local authentication
  (`DSH_LOCAL_ACCESS_KEYS` → `POST /_login` → short-lived local JWT),
  with zero dependency on the closed-source account system.
- Router: real-time device list (`GET /_devices`), quota status (`GET /_quota`),
  per-plan token-bucket bandwidth limiting and monthly traffic caps, gzip
  pass-through for tunneled responses.
- Bridge: tunnel-only daemon with heartbeat-based half-open detection and
  exponential-backoff reconnect; gzip compression for compressible upstream
  responses.
- dsh web plugin (`dsh-remote-ui`): settings-page panel with connection-mode
  switching (cloud / self-hosted), account login & registration, invite links,
  plan status, user feedback card, and bridge lifecycle control.
- Docker deployment for self-hosting: `Dockerfile` + `docker-compose.yml`.
- CI: Node 20/22 test matrix, syntax checks, dependency audit.

### Removed

- WebRTC / P2P / signaling / STUN / TURN stack (and all related packages and
  endpoints) — replaced by the tunnel-mode architecture.

## License

PolyForm Noncommercial 1.0.0 — free for personal, research and non-commercial
use; commercial use requires a license (see `COMMERCIAL-LICENSE.md`).
