# Changelog

All notable changes to dsh-remote are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [0.6.7-beta.4] - 2026-09-19

> **修「切换账号后设备没登记到新账号」**。现场（用户实测、本机复现）：退出账号 A（尾号 7541）→
> 登录账号 B（尾号 7193）后，**B 的设备列表里永远看不到这台 Mac**，而它在 A 那边仍显示在线。

### Fixed

- **换账号后旧 bridge 继续用旧账号跑（致命）**。bridge 的账号/密码是**进程启动时从环境变量固化**的，
  而 `dsh-setup run` 只在子进程**已退出**时才重新拉起它 —— 配置改了、账号换了，正在跑的进程不会换凭据。
  现在 watcher 每轮重读配置后比较**账号指纹**（账号/模式/设备身份），一变就结束子进程，
  下一轮用新凭据重新登记。
- **切换账号时那次「重启 bridge」其实一直失败（致命）**。插件只认 `gui/<uid>` 域，而安装器按 macOS 26
  的修复把作业装在 **`user/<uid>`** 域 → `Could not find service … in user gui: 501`，
  且面板从不看 `bridgeRestart` 的返回值 → **静默失败**，用户完全无感。
  现在插件与安装器用**同一条域阶梯**（user 优先、gui 兜底），`launchdStatus` 也逐域查询
  （旧实现会把 user 域里正在运行的作业看成"未运行"）；launchd 都托管不住时退化为脱离进程，
  与 Windows 走同一条路径。前端登录/注册落盘后会检查 `bridgeRestart`，失败给出可见提示。
- **旧账号的注册证据没被清理（致命）**。`.dsh-bridge-state.json` 里还留着旧 `device_id` 与
  `phase: online`，面板据此谎报「已连接」，自愈（只判"有没有 bridge 进程在跑"）永远不去纠正。
  现在：账号/模式变更与退出登录都会**停掉旧 bridge 并删除过期状态**；`composeConnect` 会判断
  "运行中的 bridge 是否属于当前账号"，不属于就报 `accountCurrent: false` 并自动重启（不再报 online）。
- **退出登录不停 bridge（安全）**。旧实现只删配置里的账号，bridge 仍用旧账号的隧道对外服务 ——
  用户以为"已退出登录"，实际手机端还能访问这台电脑。现在退出登录会停 bridge 并作废设备身份。
- **429 被误报成「密码错」**。服务端登录限流（每 IP 5 次失败 / 15 分钟）时，bridge 一律提示
  "请检查 DSH_BRIDGE_EMAIL / DSH_BRIDGE_PASSWORD"，把用户引去反复改密码（反而拖长窗口）。
  现在如实说明"是出口 IP 被临时限流、凭据无需修改"，并把最早可重试时刻落盘，watcher 在窗口内
  退避而不是每 10 秒空撞（登录成功即清除）。
- **测试隔离缺口**：`stopBridge()` 从不检查 `DSH_RELAY_SKIP_SERVICE`；而切换账号会调用它，
  于是用例会去 `launchctl bootout` 开发者本机上真实运行的 bridge。已补上隔离检查。

### Added

- **`test/account-switch-device.test.mjs`（9 个用例）**：锁死"旧账号的 online 状态不得当作注册证据"、
  "账号一致时行为不变（回归）"、"切换账号要停旧 bridge + 清过期状态"、"退出登录要作废身份"、
  "launchd 作业在 user 域时必须被认成运行中"（旧实现只看 gui）、以及 429 的如实报错与退避。
- 连接阶段与诊断信息新增 **`accountCurrent`**：面板/「复制诊断信息」会直接写出
  "bridge 账号: 当前账号 / ⚠️ 仍是上一个账号的身份"。

## [0.6.7-beta.3] - 2026-09-18

> **修两个「卸载把 dsh web 弄坏」的致命缺陷 + Windows 文件权限的如实交付**。
> beta.2 的挂载修复已在真机复测通过（链接形态正确、裸包名可解析、重启后正常启动）。

### Fixed

- **卸载后 `dsh web` 起不来（致命）**。`cordis.patch.yml` 被摘成**只剩注释**，而 dsh 要求该文件
  顶层是**数组**、纯注释文档的 YAML 解析结果是 `null`（不是空数组），于是启动直接失败：
  `Error: dsh: overlay …/cordis.patch.yml must be a top-level YAML array of loader patch entries`。
  官方空 profile 模板正是「注释 + `[]`」——占位符不能省。
  现在**所有 patch 写回路径**统一走 `writePatchDocument()`：只在「一个结构行都不剩」时补回 `[]`
  （不会把还有条目的文件写坏），并且卸载时同时摘掉**无标记的 `- insert:` 块**（旧版/其它工具写入的
  形式，只摘标记块会留下"目录已删但 patch 仍引用"→ 插件树加载失败）。
- **点卸载会让整个 dsh web 僵死（致命）**。旧实现把**慢的** `uninstallRuntime` 排在
  `uninstallSelf` 之前，且两者都是同步执行在 dsh web 的事件循环里：一次 `spawnSync` 卡住
  （Windows 沙箱拦 `schtasks`；`spawnSync` 的 timeout 在 Windows 上**并不可靠**，实测 18s+ 未返回）
  就同时造成 ①插件纹丝不动（用户以为卸载无效）②端口在听、连接建立、但永不响应。
  现在顺序是：**先卸插件（纯 fs、快）→ 立刻关掉自愈 → 立刻回响应 → 慢活交独立子进程**；
  子进程仍受同一套护栏约束（不删 profile、受 `DSH_RELAY_SKIP_SERVICE` 隔离）。
  助手起不来时才退回进程内清理，且**放在响应之后**执行。
- **`spawnSync("taskkill", …)` 缺 timeout**（生成的 Windows 助手与 dsh web 助手各一处）——补齐。
  但要清楚：timeout 不是设计依据，真正的修法是**不要在请求路径上做同步子进程调用**。
- **前端请求没有任何超时（中危）**：node 半一僵死，面板就对着永不结束的 spinner。
  现在 `api()` 默认 30s 超时（卸载 20s），超时给一句能照做的话（"这一步可能已在后台完成，刷新看看"）。

### Security

- **`{ mode: 0o600 }` 在 Windows 上是空操作（高危）**。Windows 用 ACL 而不是 POSIX 权限位，
  实测 `.dsh-config.json` 拿到的是用户目录的**默认继承 ACL** —— 也就是说文档里那句
  "0600 请妥善保护"会让 Windows 用户**误以为已经有这层保护**，而文件里是**明文账号密码**。
  风险不在"同机他人可读"（默认 ACL 下其实读不到），而在任何按文件复制的场景
  （备份/同步盘/杀软上报/支持包）都会连钥匙一起被带走。
  现在安装器、插件半、bridge 三处写入 `.dsh-config.json` / `.harness-cookie.json` 后都会调用
  `hardenFile()`：POSIX 上 `chmod 600`，Windows 上 `icacls <file> /inheritance:r /grant:r <当前用户>:F`；
  失败只告警一次、绝不影响主流程。README 也改成按平台分别说明（`.e2ee-state.json` 不含密钥，未做处理）。

### Added

- **`test/uninstall-safety.test.mjs`（13 个用例）**：断言对象落在**可用性**上 ——
  卸载后 patch 仍能被解析成顶层数组（用独立判据 + 纯注释反例对照）、别人的条目不受伤、
  清理助手真跑一遍会结束 pid 文件里的进程并清空配置目录、护栏命中时不删 profile、
  三处机密写入都有 ACL 收紧。
- 卸载响应新增 `runtimeCleanup`（`deferred` / `in-process`）与 `cleanupLog`（清理日志路径）字段。

## [0.6.7-beta.2] - 2026-09-18

> **修复 beta.1 引入/暴露的插件挂载缺陷（Windows 致命）**。beta.1 及更早版本在
> **Windows 非特权进程 + 开发者模式关闭**（= 普通用户默认状态）下安装，可能写出一份
> **起不来的 dsh web**：`node_modules/dsh-remote-web` 是个空壳，cordis 按裸包名解析不到，
> 整个插件树加载失败 → `dsh web` 完全无法启动，而设置面板与插件市场都在那个进程里，
> 用户**没有任何自助修复入口**。安装器与插件半的 Windows 修复见 beta.1 小节，本版修挂载。

### Fixed

- **插件挂载：不再相信"函数没抛错"**。`ensurePluginLinked` 原来用
  `fs.symlinkSync(target, path, "dir")`，并把 junction / 整目录拷贝两级兜底写在它的 `catch` 里。
  而在 Windows 非特权进程下，`'dir'` **既不抛错也产不出可用链接**（实测：用户目录下留一个空目录，
  `%TEMP%` 下什么都不留；同一位置两次运行一次报成功、一次抛 `UNKNOWN`），于是：
  报成功 → catch 不进入 → 两级兜底永不执行；报错 → 上一支已留空目录 → junction 撞 `EEXIST`
  只剩拷贝一支。三级兜底实际退化成一级，且**时灵时不灵**（重跑一次可能自愈，极难归因）。
  现在：Windows **首选 junction**（免特权、`realpath` 正确、裸包名解析正常），
  每支之后**验证落盘结果**（读得到 `package.json` 且 name 正确 + 读得到 `lib/index.js`），
  每支之前**清理上一支的残留**，全部失败则**抛错**。
- **调用方失败即中止，且写入前独立验收**。原来 `ensurePluginLinked` 的返回值被直接丢弃，
  patch 照写、还打印「✅ 插件已就绪」。现在顺序是「挂载 → 独立验收 → 才写依赖与激活行」，
  任何一步不过就 `process.exit(1)` —— 宁可不装，也不能写出一个起不来的 profile。
  独立验收复刻 dsh 的真实动作（从 profile 目录按**裸包名** `require.resolve`），
  与"文件在不在"是两道互不依赖的闸门。
- **验收探测改用独立子进程**。实测（Node 25）：同一进程里只要先失败过一次裸包名解析
  （例如"修复前诊断"那次），链接随后修好了，**同一个进程里的裸包名解析仍会持续失败**
  （子路径却正常）——进程内解析缓存会把假阴性一直带下去，让"修复后验收"误判成没修好。
  另起一个 node 进程探测同时也更忠实：dsh 启动时就是在一个全新进程里解析这些裸包名的。
- **`command -v pnpm` 在 Windows 上恒失效**（中危）：`sh()` 走 `execSync` → Windows 下是 `cmd.exe`，
  而 `command` 是 POSIX 内建 → 永远命中 `||` 分支 → **永远选 npm**。而 dsh profile 是 pnpm 管理的
  （`pnpm-workspace.yaml` + 虚拟 store），用 npm 改同一个 `node_modules` 会写出不同布局。
  现在按**声明文件**（pnpm-lock/pnpm-workspace → pnpm；package-lock → npm）识别，
  再用 `where`/`command -v` 探测可执行文件，兜底选 pnpm（选错方向的代价不对称）。

### Added

- **`dsh-remote repair`**：挂载坏掉时 dsh web 起不来、面板与市场都在那个进程里，
  用户只剩命令行。该命令**只碰 profile**（不联网、不碰运行环境/自启动），顺序刻意是
  「先保命（摘掉激活行让 dsh web 至少能启动）→ 再重建挂载 → 最后恢复激活」。
- **`dsh-remote status` 增加挂载诊断三行**：`[link]`（junction/符号链接/整目录拷贝/BROKEN）、
  `[resolve]`（裸包名解析结果）、`[client]`（`dsh.client.platform`）。报障时一眼区分
  "链接坏了"与"别的毛病"。
- **CI 增加 Windows 专项 job**（`windows-latest`，默认非提权 + 开发者模式关闭）：
  这个缺陷**只能在 Windows 上暴露**，而此前 CI 全是 ubuntu —— 这正是它出厂的原因。
  job 会先打印 `symlinkSync('dir')` / `symlinkSync('junction')` 的实测能力，再跑平台敏感用例。
- **新增 `test/plugin-link.test.mjs`（13 个用例）**：用注入式 fs 代理**复现**了 Windows 那种
  "不抛错但落盘是空壳"的形态，断言对象是**通过 `node_modules/<id>` 这条路径到底能不能读到东西**
  （而不是"函数没抛错/返回 true"——上一版正是因此漏测），并真起进程做端到端安装/自愈/中止/repair 验收。

## [0.6.7-beta.1] - 2026-09-18

> ⚠️ **本版已被 [0.6.7-beta.2] 取代，请勿使用**：它在 Windows 非特权进程下可能写出一份
> **起不来的 dsh web**（插件挂载空壳）。下面的 Windows 修复本身有效，缺陷在挂载环节，见 beta.2。

> **Windows 可用版（预发）**。0.6.6 及更早的插件半整套「服务状态 / 启停 / 重启」按 macOS/Linux 写死
> （launchctl / systemd / pgrep / ps / /bin/sh），在 Windows 上**安装一切正常、运行期必死**。
> 本轮由用户侧诊断报告定位、本地逐条复现后全部修掉，并补了 16 个 Windows 平台用例进测试套件。
>
> ⚠️ 本版先发 **npm `beta` 通道**（`latest` 仍停留在 0.6.6）：Windows 分支是在开发机上以
> `DSH_RELAY_PLATFORM=win32` 模拟跑通的，**真机验证**（`schtasks` 参数引号解析、PowerShell 输出结构、
> `taskkill /T /F`、登录任务的控制台窗口）还需要一位 Windows 用户确认后再转正式版。
> 安装预发版：`dsh plugin --profile web add dsh-remote-web@0.6.7-beta.1`（装完重启一次 dsh web）。

### Fixed

- **Windows：`/dsh-remote/status` 与 `/bridge-status` 双双 500 → 面板永久卡在「查询中…」**。
  `launchTarget()` 无条件调用 `process.getuid()`，而 Windows **没有这个函数**（不是返回 undefined，
  是 typeof !== "function"）→ 所有读状态的接口都抛错；前端又静默吞掉 `bridge-status` 的失败，
  于是只显示红字「读取状态失败: process.getuid is not a function」并永久转圈。
  现在 uid 取不到一律返回 null，非 macOS 平台直接短路 launchd 查询（也不再白调一次不存在的 launchctl）。
- **Windows：运行环境永远补不上（`npx_cmd_unavailable`）**。Windows 的 npx 是 `npx.cmd`，
  而 Node ≥20.12（CVE-2024-27980 的修复）起 `spawn("npx.cmd")` 不带 shell 会**同步抛 EINVAL**。
  现在优先用**当前 node 直接跑 npm 自带的 `npx-cli.js`**（完全不经过 cmd.exe，无空格/中文路径陷阱），
  找不到才退回 `npx.cmd` + `shell: true`。
- **Windows：点「重启 DeepSeek harness」会把 dsh web 打挂且不自恢复**。旧实现生成 `#!/bin/sh`
  脚本再 `spawn("/bin/sh")`（Windows 无 /bin/sh → ENOENT），而那个 ChildProcess **没有 `'error'` 监听**
  → 未捕获异常直接终止宿主进程；更糟的是代码先把「已调度重启」写进日志并返回成功。
  现在 Windows 改用 **node 跑的 `.mjs` 助手**（不经过任何 shell），且**先校验 node/入口/工作目录存在再动旧进程**
  （宁可重启失败，也不把自己杀掉却起不来）；重启必须等 `spawn` 真正成功才报成功。
- **Windows：bridge 永远显示「已停止」**。进程发现原来只用 `pgrep`/`ps`，Windows 上恒为空。
  现在 `dsh-setup run` 会落 `.dsh-watcher.pid` / `.dsh-bridge.pid`，插件读文件 + `process.kill(pid,0)` 判活，
  并用 PowerShell（`-EncodedCommand`，免引号地狱）扫描 node 进程兜底。
- **Windows：插件不会自己拉起 bridge**。`startBridge` 原来只认 plist（非 macOS 直接返回「仅支持 macOS」）。
  现在 Windows 由插件把 `dsh-setup.mjs run` 作为**脱离进程**拉起（与 `dsh-remote run` 同一条代码路径，
  含 pid 追踪、幂等去重、停止时结束进程树），并做「登录任务 + 插件自愈」双路径下的重复实例防护。
- **Windows：安装器直接 TypeError 中断**。`restartDshWeb()` 在函数首行无条件 `process.getuid()`。
  现在 getuid 收进 darwin 分支；Windows 走 PowerShell 取命令行 + node 助手自拉起（拿不到命令行时如实拒绝，
  绝不「杀掉却起不来」）。
- **PATH 拼错**：子进程 env 的 PATH 原来写死 `":"` 分隔符与 POSIX 目录，在 Windows 上会拼成一个不存在的路径
  （node/npx 全找不到）。现在按平台用 `path.delimiter`。
- **`execSync("sleep 1")`**：Windows 没有 `sleep` 命令。改用 `Atomics.wait` 的 `sleepSync`。
- **`dsh-setup.mjs` 其余 Windows 分支**：`dshWebPid()` 原来只用 lsof/pgrep（Windows 恒为 null），
  现在用 `netstat -ano`；插件目录链接在无管理员/开发者模式时退回 **junction**（不需要特权）而不是整目录拷贝。
- **面板文案**：不再把 Windows 说成「自启动服务未安装（启动时自动创建）」或沿用 macOS 专属措辞；
  卸载说明写明 Windows 会删掉任务计划条目。

### Added

- **Windows 自启动**：安装器在**任务计划程序**注册登录任务 `dsh-remote-bridge`
  （`schtasks /SC ONLOGON /DELAY 0000:15`，非管理员即可为当前用户创建、不存密码），
  彻底卸载时一并删除。已知限制：ONLOGON 任务在用户会话里运行，登录时会有一个控制台窗口
  （要彻底隐藏需要存密码/S4U 或第三方隐藏器）；**由插件自愈拉起的那条路径是隐藏的**，
  所以日常使用不会看到窗口。macOS/Linux 的 launchd/systemd 行为完全不变。
- **测试**：新增 `packages/dsh-remote-web/test/windows-compat.test.mjs`（15 个用例）。插件支持
  `DSH_RELAY_PLATFORM=win32` 显式覆盖平台，于是 Windows 分支可以在 macOS/Linux 开发机上
  **真正跑一遍**，而不是只看源码像不像：接口不再 500、不调 launchctl、npx 走 node+CLI、
  重启助手语法合法且带「先校验再杀」、pid 文件进程发现、卸载删任务、前端失败可见等全部有断言。
- **前端**：`bridge-status` 轮询连续失败 3 次即把失败原因摆到连接卡上（原先静默 catch，
  用户只看到无限「查询中…」），成功即清零，避免一次抖动就把面板染红。

## [0.6.6] - 2026-09-16

> **正式版**（发表于 npm `latest`）。预发版 beta.1 ~ beta.4 到此收束，内容与 beta.4 一致。
> 本轮主要修 0.6.5 推广后社群反馈的三类问题，并新增手机端字号档位。

### Fixed

- **手机端整屏阴影、点哪都没反应（只有左侧栏能点）**：遮罩是手机端适配层的全屏 scrim，
  判定「侧栏是否展开」只看属性是否存在（官方若用带值写法就永久误判）+ 判定为展开时会隐藏菜单按钮，
  唯一关闭路径失效形成死局。现在按**值**判断、菜单按钮始终可见可开可关、点遮罩可自救，
  且遮罩只在侧栏**真的滑进视口**时才拦截点击。
- **手机端左上角菜单按钮点不开抽屉**（beta.3 引入的回归）：几何判定曾直接否决展开状态
  （动画未开始就被摘掉）+ 按钮 z-index 低于遮罩。现在用户意图优先、按钮层级提到遮罩之上。
- **扫码后「fail to load plugin」**：插件清单声明了一个 harness 里**不存在**的客户端包
  （inject 边永远等不到 → 面板不出现），我们只依赖 shell 提供的 react，已移除该声明。
- **「桌面运行环境缺失」+「一键修复」点了没反应**：`spawn` 是异步的而接口同步返回成功、
  错误只写本地日志，前端因此显示「已开始」→ 随后「已完成」而实际什么都没变；
  残留的进行中标记还会永久拒绝点击。现在失败原因可查询并在面板**如实报错**、陈旧标记自动清理。
- **升级后修复到不了用户**：bridge 发的注入脚本只按版本号覆盖，且装新版时会被判成「已是最新」而不装；
  现在按**内容**同步脚本、按**版本比较**决定装不装（本地更新才装，绝不降级）。
- **「刷新后横幅还在」/「更新提示」**：提示判断改为版本号比较（同版本重写不再误报），
  更新提示用语义化比较（预设版低于同号正式版）。
- **Windows 上补装失败的风暴**：单机曾 12 秒一次、累计 606 次。现在失败按 30s → 2m → 10m 退避，
  用户点「一键修复」仍立即重试；失败归因从「全是 unknown」拆成 5 类可定位形态（只上报枚举）。

### Added

- **手机端显示字号档位**：右下角「字」按钮 → 滑块，四档（最小/中/大/超大），
  选择本地记住；**只作用于手机端，电脑端不受影响**。

### Changed

- **旧名别名包 `dsh-remote-ui` 退役**：仓库删除该目录与同步脚本，npm 上标记 deprecated；
  安装器仍保留旧名清理逻辑，保证老用户平滑升级。

## [0.6.6-beta.4] - 2026-09-16

> 预发版。修掉 beta.3 引入的**抽屉打不开**回归，并新增**手机端字号档位**。

### Fixed

- **手机端左上角菜单按钮点不开抽屉（beta.3 引入的回归）**。beta.3 把"几何判定"直接作用在
  展开状态上，等于「侧栏还没滑进视口就不许展开」：点菜单按钮加 class → 动画未开始、rect 仍在屏外
  → 立刻被摘掉 → 抽屉永远打不开。同时菜单按钮的 `z-index` 是 260、低于遮罩的 290，
  抽屉一展开就被遮罩盖住、更点不动。现在：**用户意图优先**（点按钮/点遮罩登记意图，几何判定不再否决
  它），几何只用来决定「遮罩能否拦截点击」；菜单按钮 `z-index` 提到 320（始终在遮罩之上）；
  并补了"点菜单按钮真能打开、再点能关"的运行时用例。
- 字号样式里 `body { font-size: calc(1rem * scale) }` 会把放大**平方**（1.32 → 1.74）
  并连累所有子元素，已移除（html 字号已含缩放，`-webkit-text-size-adjust` 负责文本整体缩放）。

### Added

- **手机端显示字号档位（4 档 + 滑块）**：右下角「字」按钮 → 面板内滑块，档位为
  **最小（当前大小）/ 中 / 大 / 超大**；选择记在 localStorage，重开页面仍生效。
  只作用于手机端（样式整体在 `@media (max-width:820px)` 内，**PC 完全不受影响**）。
  实现上叠加三种手段：根字号（rem 处生效）、`-webkit-text-size-adjust`（移动端文本整体缩放）、
  以及同步官方聊天正文变量 `--dsh-content-font-size`（保证正文一定跟着变）。

## [0.6.6-beta.3] - 2026-09-15

> 预发版。补上两个「修了也白修」的坑 —— 这才是手机端问题反复出现的真正原因。

### Fixed

- **运行时副本按内容同步（否则手机端修复永远到不了用户）**。bridge 会把配置目录里的
  `clients/dsh-remote/mobile-adapter.mjs` 注入官方页面后发给手机，而装置器此前**只在版本号变化时**
  才覆盖这份副本 —— 于是出现过：改了、发了版、用户也升级了，手机端拿到的仍是旧脚本，
  修复完全不生效（本机实测：运行时副本停留在 9-14，而仓库里是含修复的新版）。
  现在按**内容**比对，只要与装置器手里的不一致就覆盖；仓库开发形态同样同步（否则本地测试
  拿到的是陈旧副本）。**注意**：该脚本是 bridge 启动时 import 的，所以升级后
  **bridge 需要重启一次**才会把新脚本发给手机（面板上的 bridge 重启/下一次启动即可）。
- **装置器不再把「本地更新的包」判成"已是最新"而不装**。升级到预设版时，profile 里市场装的
  稳定版会被误判成"已是最新"，于是什么都不做（实测输出「✅ 插件包已是市场最新版（0.6.5）」，
  而手上明明是 0.6.6-beta.x）。现在比较**本地包 vs profile 已装包**的版本：
  本地更新 → 落本地包并把激活点转成 patch 行（热加载）；相等 → 不动；本地更旧 → 绝不降级。
- **客户端 fail_code 白名单与服务端同步**：上一版新增了 5 个归因码，但客户端白名单没同步 ——
  构造事件时白名单外的码会被**清成空串**，等于归因白做（1659 次 Windows 失败仍只会显示 unknown）。
  现在两侧集合级一致，并有行为级用例锁死（断言事件 payload 里真的带上了新码）。

## [0.6.6-beta.2] - 2026-09-15

> 预发版。**旧名别名包正式退役**（改名早已完成，不需要再维护第二个包）。

### Changed

- **删除 `packages/dsh-remote-ui/` 别名包与它的同步脚本**（`npm run sync:alias` / `check:alias`），
  发布步骤与文档同步更新。npm 上的 `dsh-remote-ui` 已标记 **deprecated**，
  `latest` 永久停在 0.6.5，安装/更新会看到迁移提示：改用 `@mrrisega/dsh-remote`（插件包 `dsh-remote-web`）。
- **但安装器与插件的旧名清理逻辑（`PLUGIN_LEGACY_IDS`）保留**：曾经装过 `dsh-remote-ui` 的机器
  升级时会自动移除旧名的依赖 / bundles 条目 / 本地目录与链接，避免残留导致「重复 ID」崩溃。
  这是老用户平滑升级的保证，不要删。

## [0.6.6-beta.1] - 2026-09-15

> 预发版。针对 0.6.5 推广后社群集中反馈的三类问题（手机端整屏阴影点不动、扫码后插件加载失败、
> 桌面运行环境缺失且「一键修复」没反应）做的修复。**待验证后再决定是否推 latest。**

### Fixed

- **手机端整屏阴影、点哪都没反应（只有左侧栏能点）**。遮罩是手机端适配层自己创建的全屏 scrim
  （`div.dsh-ma-scrim`，z-index 290；左侧栏 300，所以只有它能点）。两个缺陷叠加成死局：
  ① 判断「侧栏是否展开」只用 `hasAttribute`，官方若用带值写法（`=false`）就被永久判定为展开，
  遮罩常亮并拦截整屏点击；② 判定为展开时还会把菜单按钮隐藏，用户连入口都没有，
  而唯一的关闭路径是「点遮罩 → 点官方 toggle」，找不到 toggle 就彻底卡死。现在：
  属性改**按值判断**（两种写法都兼容）；**只有侧栏真的滑进视口**（`getBoundingClientRect`）才允许
  遮罩拦截点击；菜单按钮**始终可见**且可开可关；点遮罩找不到官方 toggle 时直接摘掉遮挡（自救）。
  并为适配层补上**真正的运行时用例**（此前只有注入纯函数测试，这个 bug 没被任何测试拦住）。
- **扫码后「fail to load plugin」**。插件清单里 `dsh.client.inject` 声明了一个
  **在 harness 安装树里根本不存在的包**（`@deepseek-ai/dsh-client-runtime`）：inject 边永远
  arrive 不了（面板不出现），清单也与真实依赖不符——一旦宿主侧改为严格校验就会变成启动期加载失败。
  我们的浏览器半只 `require("react")`（shell 提供），不需要任何宿主包，故直接移除该 inject。
- **「桌面运行环境缺失」+「一键修复」点了没反应**。此前 spawn 是异步的，`npx` 解析失败时
  同步分支仍返回 `ok:true`；错误只写进本地日志；前端看到 `ok:true` 显示「更新已开始」，
  2 秒后轮询到进程结束便显示「已更新完成」——版本没变、环境仍缺，界面零反馈。现在：
  失败原因进可查询状态并在面板**如实报错**；`pid` 缺失时不再谎报成功；残留的
  in-progress 标记超过 10 分钟自动清理（此前会**永久**拒绝点击并一直转圈）。
- **Windows 装机失败风暴**：补装失败时自愈调度每轮都重试，生产遥测里单机 12 秒一次、
  累计 **606 次**（1659 次 `install_failed` 全部来自 Windows）。现在按 **30s → 2m → 10m** 退避，
  用户点「一键修复」仍会立即重试。
- **失败归因不再全是 `unknown`**：1659 次失败因为归因覆盖不到真实错误而无法定位。
  现在把真实形态拆开（`npx.cmd` 不可用 / 注册表超时 / 包或安装脚本缺失 / 退出码非零 /
  输出乱码），只上报枚举、原始错误文本仍不出机器；客户端与服务端白名单已同步扩展。

## [0.6.5] - 2026-09-13

### Fixed

- **面板「一键更新」在市场装法（npm / 插件市场安装）下不再空转**。此前该路径只清理由历史
  include、不动插件包，命令 exit 0、界面显示"安装完成"，插件却始终停在旧版本（实测：装的是
  0.6.3，更新后仍是 0.6.3，日志写着"已保持市场管理的源码不变"）。现在会按包管理器**主动把插件包
  升级到最新**，并如实报告三种结果之一：已升级（x.y.z → x.y.z）/ 已是市场最新版 / 升级失败并给出
  可手动执行的命令。
- 插件包升级成功后明确提示需要**重启一次 dsh web** —— 市场装法经 `dsh.profile.bundles` 激活，
  该文件只在启动时读取（与"首次安装可热挂载"的边界一致，见 0.6.4 说明）。

## [0.6.4] - 2026-09-13

> **正式版**。本轮的预发版（beta.1 ~ beta.11）到此收束：安装体验、macOS 26 自启动、
> 插件激活方式与匿名统计都已在生产环境验证过。

### Added

- **插件热加载**：安装插件改为写 profile 的 `cordis.patch.yml`（HMR 监听该文件），
  **首次安装装完只需刷新页面、不必重启 dsh web**。实测：进程 pid 不变、安装耗时约 1.3 秒、面板接口立刻可用。
  边界（实测）：HMR 只认 **patch 文件的变化**，而加载器按 URL 缓存模块 —— 所以
  **同一插件升级到新版本时 patch 行内容没变，热加载不生效，仍需重启一次 dsh web**；
  安装器会按版本号核对并如实提示，不会谎报成功。
- **匿名装机统计**：只上报「装机/连接是否成功」这类事件（12 个白名单事件 + 11 个白名单失败码），
  不含账号、手机号、会话或文件内容、主机名、路径、设备指纹与 IP；标识是本机随机 ID（重装即变）。
  环境变量 `DSH_REMOTE_TELEMETRY=0` 可完全关闭。披露文档见 [docs/telemetry.md](docs/telemetry.md)。
- **macOS 26 自启动修复**：macOS 26 把 `gui/<uid>` 会话域置为 on-demand-only（`RunAtLoad`/`KeepAlive`
  失效、只登记不启动），现在优先用 `user/<uid>` 域（实测崩溃后 launchd 自动重建），
  失败才回退 `gui/<uid>` + `kickstart`（如实告知不支持自愈），再不行退化为后台进程。

### Changed

- **安装输出精简**：多阶段重复播报收敛成结尾一份汇总。
- **面板不再要求「重启 DeepSeek harness」**：插件热加载 + bridge 是独立 launchd 进程，
  装插件/在线更新都不需要重启；只有「磁盘插件版本与运行版本不同」时才提示**刷新页面**，
  且不再自动重启（刷新零风险，重启会打断你的会话）。

### Fixed

- **`duplicate loader entry id` 崩溃**：patch 行与插件自带 bundle patch 同时生效会让 dsh web
  启动即报 `plugin tree failed to load`。现在两条激活路径互斥：bundles 已声明就不写 patch 行；
  写完 patch 行再复核 bundles 已清空，没清掉就回滚。
- **「刷新后横幅还在」**：提示判断从"文件时间戳"改为"版本号比较" —— 补装把同一版本重写一遍
  不再误报。
- **更新提示的版本比较**：改为语义化比较（预设版低于同号正式版），装预发版的人不会被误判成落后。
- `~/Library/LaunchAgents` 不存在时自动创建；服务 PATH 补 `/usr/sbin`、`/sbin`（修 `ioreg: command not found`）。
- **热加载探测改为按版本判断**：此前只检查面板接口是否 200（旧版本本来就有这个接口），
  于是「profile 已更新到新版本、运行中仍是旧版本」会被误报成"热加载成功"。现在比对运行中版本与
  本次安装版本，不一致就如实提示需要重启 dsh web。
- 安装器的配置目录统一为 `~/.dsh-remote`（修掉「面板读不到配置 / 运行状态文件散落进仓库」）。
- **测试污染**：`harness-restart` 用例会覆盖开发者真实的 `~/Library/LaunchAgents`，已加 HOME 隔离与静态护栏。

## [0.6.4-beta.11] - 2026-09-13

> 预发版。堵死「两个激活点并存」→ `duplicate loader entry id` 的崩溃。

### Fixed

- **插件已由 `dsh.profile.bundles` 声明时，绝不再写入 patch 激活行**。两者同时生效会让
  dsh web 启动即报
  `TypeError: duplicate loader entry id: dsh-remote-web` /
  `dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include)`
  —— 整个插件树加载失败（实测生产日志）。
  现在安装器先检查 bundles：已在里面就保持 bundles 形态（这条等价于插件市场形态，需要重启一次），
  并且**在写入 patch 行之后再次复核 bundles 是否已清空；若没清掉就回滚 patch 行**，
  宁可退回 bundles 也绝不留「两处激活」。新增两条硬约束用例双向锁死。
- 回退到 bundles 形态时会先把插件条目写进 bundles（否则插件会失去激活点而完全不生效）。

## [0.6.4-beta.10] - 2026-09-13

> 预发版。修掉「刷新后横幅还在、要点重启才消失」的误报。

### Fixed

- **补装/更新把**同一个版本**的插件重写一遍时，不再误报「需要重启/刷新」**。
  旧实现判断「要不要提示用户」只看插件文件的修改时间：安装器（npx）与插件自愈补装都会把
  profile 里的插件目录整目录重写一遍 —— 即使是同一个版本 —— 时间戳就变新了，于是被当成
  「磁盘上有新插件要装载」，弹出横幅；用户刷新后横幅还在（第二次补装又写了一遍），
  最后只能靠重启 dsh web 才消失（用户实测踩到）。
  现在改为**比较版本号**：只有「磁盘上的插件版本 ≠ 本进程装载的版本」才提示，
  同一个版本无论被重写多少次都不提示。

## [0.6.4-beta.9] - 2026-09-13

> 预发版。**去掉那条误导人的「首次安装需要重启 DeepSeek harness」**：能热加载之后，它已经没有存在理由了。

### Changed

- **「首次安装需要重启 DeepSeek harness」提示已移除**。它原本的理由是「插件本体与面板在 harness 启动时
  装载」——但现在：① 插件走 profile patch **热加载**（HMR 监听，存盘约 1 秒即装载）；
  ② 桌面运行环境（bridge）是**独立 launchd 进程**，与 harness 生命周期无关。所以装完插件、
  在线更新完成后都**不需要重启**，这条横幅纯属误导。
- **唯一还需要用户动一下的情形改说「刷新页面」**：只有当磁盘上的插件文件比当前进程新
  （= 运行中被市场安装/在线更新改写）时才提示，文案为「插件已更新，刷新页面即可生效」，
  主按钮变成**「刷新页面」**；并且这种情况**不再自动重启** —— 刷新是零风险动作，
  重启 dsh web 会打断你正在进行的会话，不该替你决定。
- **底部常驻按钮保留但改准**：「🔄 重启 dsh web」，说明也改为「仅在刷新页面后仍看不到面板时才需要」。

### Fixed

- **在线更新成功后发了一个白名单外的事件**（`update_done`）→ 服务端会静默丢弃。
  成功不再发事件（`update_started` 已发过，失败才发 `update_failed`）。
- 回归测试同步更新：`harness-restart` / `auto-restart` 断言新的「刷新」语义，
  并新增用例锁死「运行环境补齐**不再**提示重启」「插件被运行时改写 → 提示刷新且不自动重启」。

## [0.6.4-beta.8] - 2026-09-13

> 预发版。热加载这条链路的三个缺陷修完并**端到端实测**：装完只需刷新页面。

### Fixed

- **热挂载验证被跳过**：`convergePluginActivation` 已经返回激活形态，但 `pluginCmd` 没有把它
  `return` 出去 → `setup()` 拿不到「走的是 patch 热加载」这一信息 → 跳过热挂载验证，
  明明热加载成功却仍然报「需要重启 dsh web」。已改为 return 并加回归护栏。
- **热挂载探测窗口太短**：HMR 本身约 1 秒完成，但插件节点半还要起服务、注册路由，
  机器繁忙时会到十几秒；探测窗口从约 12 秒放宽到约 30 秒。
- **探测超时不再误报「需要重启」**：patch 行已写入而探测窗口内没等到接口时，
  只说「等几秒刷新页面；仍未出现再重启」，不再把成功的热加载报成失败。

### Verified

- 冷装端到端实测（本机 macOS，真实 profile）：卸载到冷状态（接口 404）→ 执行安装 →
  **dsh web 进程 pid 未变**、安装耗时 **1268ms**、`/dsh-remote/status` 立刻 200，
  输出「插件已热加载（无需重启 dsh web）——刷新一下浏览器页面」。

## [0.6.4-beta.7] - 2026-09-13

> 预发版。**装完不用再重启 dsh web 了** —— 插件改走热加载装载，刷新页面即可。

### Changed

- **安装插件改为「热加载」装载，不再要求重启 dsh web。** 此前插件是写进 `dsh.profile.bundles` 激活的，
  而那个清单**只在 dsh web 启动时读一次**；装完插件后运行中的进程里既没有 `/dsh-remote/*` 路由，
  也没有「设置 → 远程控制」面板项，用户必须自己想办法重启（这正是「装完没有界面」的原因）。
  现在改为写 profile 的 `cordis.patch.yml` 一行 `insert`：harness 的 web profile 是
  `patchReload: "live"`，会加载 `@deepseek-ai/cordis-plugin-hmr` 监听该文件，**存盘后约 1 秒重新
  compose 并动态装载**（插件市场用的也是这套机制）。安装结束会**验证热加载确实生效**，
  然后提示「刷新页面即可」；万一热加载不生效，才退回原来的重启阶梯。

### Fixed

- **只保留一个激活点**：写 patch 行的同时把 `dsh.profile.bundles` 里的同名条目移除。
  两处并存会让 dsh web 启动即报「重复 ID」崩溃（历史问题），所以两个方向都要收口。
- **`relayDir` 写错**：激活行里必须写**配置目录**（`~/.dsh-remote`，面板要从那里读 `.dsh-config.json`），
  之前会写成插件安装目录 → 面板显示成「未登录 / 空配置」。现在还会**自我修正**：已有激活行的
  relayDir 与当前配置目录不一致时自动改写。
- **仓库开发形态的配置目录与插件默认值不一致**：安装器在仓库模式下把配置目录当成仓库根，而插件默认
  是 `~/.dsh-remote` → 面板读不到安装器写的配置，运行状态文件还会散落进仓库工作区。两者统一为
  `~/.dsh-remote`（需要隔离时用 `DSH_RELAY_DIR` 覆盖）。
- **`~/Library/LaunchAgents` 不存在时自动创建**，写入失败只提示不中断安装。
- **patch 文件写入全程加护栏**：写前校验基座形态（含 `[]` 占位会被清掉、异常行**拒写**）、
  原子写回（同目录临时文件 + rename）、**写后重新解析校验**，不合法立即回滚。
  宁可回退到 bundles 形态（需重启），也绝不把一份能用的 profile 弄坏。
- **测试隔离**：`harness-restart` 用例会 unset 测试隔离开关走真实分支却没伪造 `HOME`，
  把指向测试临时目录的 plist 覆盖到开发者真实的 `~/Library/LaunchAgents`（临时目录随即删除 →
  真实自启动失效）。已加 HOME 隔离 + 静态护栏：凡 unset 开关的用例必须伪造 `HOME`。

### Added

- `dsh-remote install --no-restart`：连「需要时的自动重启」也跳过，改为打印可照抄的手动命令。

## [0.6.4-beta.6] - 2026-09-13

> 预发版。修一个 macOS 26 上的自启动死角（服务登记了却永远不被启动），
> 并顺手修掉一个会破坏开发者本机自启动的测试污染问题。

### Fixed

- **macOS 26：自启动服务登记后永远不启动（`runs = 0`）**。macOS 26 会把 `gui/<uid>` 会话域
  置于 **on-demand-only** 模式，该模式下 launchd 拒绝一切非按需派生，`RunAtLoad` 与 `KeepAlive`
  全部失效——只登记、不启动，安装脚本于是报「自启动服务启动失败：服务未在运行」。
  现在改为按**阶梯**启动：① 优先 `user/<uid>` 域（该域在 macOS 26 下仍支持自启动与崩溃自愈，
  实测 `kill -9` 后 launchd 自动重建）；② 失败则回退 `gui/<uid>` 并用 `launchctl kickstart`
  强制拉起一次（能起来，但进程退出后不会自动重建——这种情况会**如实告知**，不再假装完全成功）；
  ③ 两者都不行则退化为后台进程（现在能用，但无自启/自愈，同样明确说明）。
- **plist 补上 `LimitLoadToSessionType`**：这是 `user/<uid>` 域的必需项——缺它时
  `launchctl bootstrap user/<uid>` 会直接失败（实测 `rc=5 Input/output error`），
  也是恢复派生行为的条件。
- **不再「问一次就判定失败」**：launchd 派生是异步的，旧实现 `bootstrap` 后立刻 `print` 一次，
  必然看到 `state = not running` 而误报失败。现在改为轮询等待（约 8 秒），并能识别
  `pended nondemand spawn` / `on-demand-only` 这一「登记了但从未派生」的特征，据此给出正确结论。
- **自启动服务的 PATH 补上 `/usr/sbin`、`/sbin`**：bridge 会调用 `ioreg` 等系统命令，
  缺这两个目录时服务日志会一直刷 `ioreg: command not found`。
- **`~/Library/LaunchAgents` 不存在时不再直接报错中断安装**：改为自动创建目录，
  失败时也只提示而不打断（全新账户 / 精简系统上会出现该目录缺失）。
- **测试污染（会破坏你本机自启动）**：`harness-restart` 用例会 unset 测试隔离开关去走真实分支，
  却没有伪造 `HOME`，而插件写 plist 用的是 `join(homedir(), "Library/LaunchAgents/…")`——
  于是它把**指向测试临时目录**的 plist 覆盖到开发者真实的 `~/Library/LaunchAgents`，临时目录随即被删，
  真实 bridge 自启动就彻底失效了。已为该用例加上 HOME 隔离，并新增静态护栏：
  任何 unset 系统操作开关的用例都必须同时伪造 `HOME`。

### Changed

- **插件「关于」卡片不再堆文档链接**：移除「隐私说明：README「匿名装机统计与隐私」 ·
  完整字段清单 docs/telemetry.md」那一行。匿名统计的采集/不采集/如何关闭仍写在卡片里，
  完整字段清单在仓库 `docs/telemetry.md`（README 有链接）。

- **`--no-autostart`（或平台不支持自启动）时不再自相矛盾地显示「✅ 运行中」**：以前这一行会同时
  打出「(当前平台不支持) — ✅ 运行中」，并继续承诺「打开 dsh web 后 bridge 会自动启动」——可自启动
  服务根本没装，没有东西会去启动它。现在明确区分三态：**运行中** / **未运行（原因）** /
  **未安装（本次显式跳过 或 当前平台不支持）**，未安装时改为提示用 `dsh-remote run` 手动运行。
- **安装时 dsh web 没在运行，不再显示让人误解的「服务启动失败」**：bridge 依赖 dsh web 才能工作，
  dsh web 没开时 bridge 起来也会立刻退出——这是**正常状态**，不是安装出错。现在安装结束会如实说明
  「检测到 dsh web 当前没有运行，所以 bridge 还没接上（正常，不是安装出错）；打开 dsh web 后
  bridge 会自动启动，无需任何命令」，并补一句「如果 dsh web 已经开着但看不到本机，先重启 dsh web
  让插件生效」。dsh web 确实开着却仍起不来时，才提示具体的 bridge 失败原因与日志路径。

### Changed

- **安装输出大幅精简**：同一段引导此前会在多个阶段重复打印（运行时固化、创建自启动服务、
  服务已加载……），现在收敛成**结尾一份汇总**——远程控制地址 / 自启动服务路径与状态 / 下一步做什么，
  一眼就能看完；自启动服务不再单独重复播报一次。

### Added

- **匿名装机统计可以一键关掉**：`export DSH_REMOTE_TELEMETRY=0` 即完全关闭（不生成随机 ID、
  不落任何文件、不发任何请求，也不影响面板、bridge 与连接）；不想改环境变量也可以在中继 /
  Nginx / 防火墙里直接丢弃 `POST /api/telemetry/events`。采集/不采集的完整清单与自行核实方法见
  [docs/telemetry.md](docs/telemetry.md)，README 新增「数据与隐私」一节说明**统计的粒度**
  （装机漏斗统计建立在审计日志之上，只统计注册 / 新增设备 / 真实登录 / 首次打通这类事件条数，
  重复登记不记为新增）以及自建模式下数据只落在你自己的服务器。

## [0.6.4-beta.3] - 2026-09-13

> 预发版。把「首次安装需要重启 DeepSeek harness」这一步**做成自动完成**，并补齐一个埋点盲区。

### Added

- **装机最后一步自动化：待重启时面板自动重启 DeepSeek harness，用户不需要点任何按钮。**
  插件本体与浏览器半是在 harness 启动时装载的，所以首次安装/在线更新后必须重启一次才生效 ——
  此前需要用户自己看懂提示并点按钮（对非技术用户就是一道坎）。现在面板发现「待重启」后：
  15 秒倒计时自动重启，重启完成后**页面自动恢复**（复用既有 waitHarnessBack：轮询到 harness 回来即刷新），
  接着继续跑「连接中 → 已连接」流程。四条安全阀：① 面板不可见（用户没在看）→ 计时暂停，绝不在用户看不到时
  重启进程；② 15 秒内可一键「取消自动重启」，取消标记按本次事件持久化（刷新也生效，下次安装/更新重新触发）；
  ③ 面板上有其他操作在跑时暂停计时，不打断用户；④ 每事件只重启一次。
- **手机端上报「看到了安装引导」**（`POST /api/guide-shown`，只记首次）。生产诊断里 11 个新用户有 6 人
  **从未在电脑端安装**，但此前没有任何数据能证明"他看到了引导"；现在「看到引导 → 真正装上」的转化可量化
  （管理后台用户详情新增「看到安装引导」时间）。

### Tests

- 新增 `packages/dsh-remote-web/test/auto-restart.test.mjs`（4 例，真实 `useEffect` + 假定时器 +
  可控 `document.hidden`：15 秒自动重启且只一次、取消后不重启且标记跨刷新生效、隐藏时暂停、无待重启零请求）。
- relay-router 新增「看到引导即上报」契约用例。`test:router` 29 / `test:plugin` 116 / `test:bridge` 85 全绿。

## [0.6.4-beta.2] - 2026-09-13

> 预发版。修一个**真实用户反馈**的手机端阻塞：`dsh web authentication required; reopen the URL printed by dsh web`。

### Fixed

- **手机端白页 / 401「dsh web authentication required」可以自愈了，用户无需任何操作**：
  成因是 dsh web 每次重启都会更换浏览器会话签名密钥，插件用 `?token=` 换来的 Cookie 立即失效
  —— 而这条提示（"reopen the URL printed by dsh web"）**对手机用户不可执行**（他们打不开电脑上打印的 URL）。
  旧实现只在插件启动后重试 20 次（约 60 秒）就放弃、之后 6 小时才刷新一次；一旦启动那一刻 dsh web
  的 connection 服务还没就绪，Cookie 就会长时间不可用，用户只能自己重启/重扫（有真实用户就是遇到这个）。现在四处叠加，把恢复时间压到秒级、且不需要用户做任何事：
  1. 插件启动后**持续重试 10 分钟**（不再 60 秒后放弃），并改为**每 30 分钟主动刷新**；
  2. 面板每次查状态（`/dsh-remote/status` 与 `/dsh-remote/bridge-status`，2.5~30 秒一次）都会**按需补齐** Cookie（5 秒限频 + 并发去重，不拖慢接口）；
  3. bridge 撞到该 401 时写 `.harness-cookie-revoked` 标记，插件下一次查状态立刻重换；
  4. bridge 发现 Cookie 已被换成新的，**用新 Cookie 立刻重试一次** —— 这一条能让用户连错误页都看不到
     （回归用例：上游 401 → 自愈后手机端拿到 200）。

### Tests

- 新增 `clients/dsh-remote/test/harness-cookie-selfheal.test.mjs`（3 例，走真实 `handleHttpFrame/doHttp` 全链路：
  401 自愈重试拿到 200、标记落盘、bridge 与插件的标记名/端点接线一致）。`test:bridge` 85 全绿。

## [0.6.4-beta.1] - 2026-09-13

> 预发版（`beta` 通道，`latest` 仍为 0.6.3）。主题：**首次安装不再卡**。
> 生产诊断显示 11 个新注册用户里只有 3 个把设备连上来，本轮针对两类流失分别修复。

### Fixed

- **电脑端装好后 bridge 不自动启动 → 手机永远看不到设备**：面板在账号登录后自动
  「补运行环境 → 拉起 bridge → 跟踪到中继注册成功」，并把过程做成**阶段化状态**：
  `正在准备运行环境（首次约 1~2 分钟）… → 正在启动 Bridge… → 正在连接中继… → 已连接 ✅`；
  非 `online` 阶段每 2.5 秒自动推进、`online` 后退避到 15 秒，页面隐藏时完全停发请求、回到前台立即补一次。
  **用户全程零操作、零刷新**；进入「已连接」后二维码与「已授权设备」列表也会自动刷新。
  严格区分 `starting`（bridge 进程在跑）与 `online`（设备已在中继注册成功、手机真的能用）。
  失败时给可读原因 + 自动重试倒计时（2s/4s/8s/16s/30s/60s，用尽后继续按 60s 重试）+ 「重试」按钮 +
  一键「复制诊断信息」（版本 / relayDir / 阶段 / 进程与 launchd 状态 / 日志路径），不留死胡同。
- **手机端空设备列表只能干等**：现在是**自动等待**——轻量探测中继在线设备（不写账号库、不污染统计），
  5 秒一次共 10 次后转 20 秒，页面隐藏暂停、回前台立即探测；电脑一上线设备自动出现，不用点「刷新」。
- **安装引导只有终端命令**（非技术用户走不到）：空设备态改为「① 在电脑上打开 DeepSeek Harness →
  ② 有插件市场入口就搜索 `dsh-remote` 安装；没有就复制那条命令 → ③ 登录后稍等，电脑会自己出现」，
  折叠区只留排错与手动控制；付费推广页同步改为「市场 / 命令」二选一。
- **阶段轮询放大认证请求**：新增 relay token 60 秒缓存（按账号/模式/服务端为键，并发合并，
  401/403 立即失效），状态轮询不再每次都打 `device-login`。

### Added

- **首次安装来源与版本采集**（用于定位"哪个版本在哪类机器上装不上"，不含任何隐私内容）：
  面板注册上报 `reg_source=panel_register`、手机端网页注册上报 `remoteweb_register`；
  bridge 设备登记与 `POST /api/install-report` 上报 `install_source`（`npx` / `plugin_market`）、
  `install_version`、`host_os`、`host_arch`；一键安装器在 plist / systemd unit / 子进程三处注入安装来源与版本。
- 面板新增 `GET /dsh-remote/bridge-status`（返回前先推进闭环）与 `POST /dsh-remote/connect/retry`（手动立即重试），
  `/dsh-remote/status` 增加 `connect` 字段；bridge 新增本机状态文件 `.dsh-bridge-state.json`。
- relay-router 新增**设备在线态权威上报**（注册→在线、断开→离线、每 60 秒心跳），
  解决服务端「在线设备」长期失真的问题（该修复同时让管理后台的在线数与活跃设备数可信）。

### Tests

- 插件新增 `connect-loop.test.mjs`（14 例，node 半闭环/阶段判定/退避/诊断/埋点/认证缓存）与
  `connect-ui.test.mjs`（6 例，浏览器半真实 `useEffect` + 假定时器：自动推进、hidden 暂停、error 可重试）；
  relay-router 新增 `presence-report.test.mjs`（3 例，含真实 HTTP 上报形状与失败静默）。
  合计 `test:router` 28 / `test:plugin` 112 / `test:bridge` 82 全绿。

## [0.6.3] - 2026-09-12

### Added

- **插件清单声明宿主要求**（`engines.dsh: ">=0.1.0-rc.6 <0.2.0-0"`）：插件市场详情页不再提示
  "未声明宿主要求"，并可据此按 DSH 版本筛选适配插件。
- **发版说明自动化**：每个版本的 GitHub Release 正文由 CHANGELOG 对应小节自动生成，
  插件市场的「更新说明」因此显示真实条目（此前为空/通用文案）。

### Changed

- 市场预构建包地址改为 `releases/latest/download/`（资产名不带版本号）——
  一键安装始终跟随最新版本；此前钉在 v0.6.0，导致市场长期安装旧版。

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
