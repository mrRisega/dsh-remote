# dsh-relay-open — 项目规则（本仓库特有，优先级高于工作区 AGENTS.md）

> 开源仓库（`origin` = GitHub，**按需推**；日常推 `gitee`）。
> 服务端代码不在这里（在 `../dsh-relay-enterprise`）。

---

## 🔴 一、每轮开发收尾：本机必须是最新代码 + 最新插件（业主口径 2026-10-10）

> 原话：「开发完每次让本地是最新代码和插件」

**一条命令**：

```bash
npm run sync:local          # 重打运行时 → 同步桥半 → 同步插件半 → 核验 → 重启桥
npm run sync:local -- --dry-run     # 只报告差异
npm run sync:local -- --no-restart  # 只同步，不动正在跑的桥
```

它做四件事，并在最后**逐字节核验**：

| 部件 | 位置 | 生效方式 |
|---|---|---|
| 桥半（运行环境） | `~/.dsh-remote/`（clients + node_modules/ws + dsh-setup.mjs + 版本标记） | 需重启桥（脚本默认会做） |
| 插件半 | `~/.dsh/profiles/<profile>/dsh-remote-web-plugin/`（lib + runtime + package.json） | 宿主**热加载**；没生效就刷新窗口/重启 App |

**为什么必须固化**：这两处都**不是**仓库里的文件 —— 改了仓库 ≠ 本机在跑新代码，
手工同步一次就漏一次（漏掉那次的表现是「我明明改好了，怎么还是旧行为」）。

**脚本绝不做的事**：不碰 profile 的 `cordis.patch.yml`（见下）。

---

## 🔴 二、不要手改 `~/.dsh/profiles/<profile>/cordis.patch.yml`

那是宿主的 **live 重载**入口：手改会立刻触发重新组装，把**工具面打挂**（业主明确警告过）。
要改插件激活状态，走安装器：

```bash
npx @mrrisega/dsh-remote@beta plugin --profile desktop
```

---

## 三、发版（beta/正式）固定动作

1. 版本号**三处**：`package.json`、`packages/dsh-remote-web/package.json`、`package-lock.json`
   （`PLUGIN_VERSION` 由 package.json 派生，**单一来源**，不要手改）。
2. 写 `CHANGELOG.md`（面向用户视角，说"你会看到什么变化"，不是列 commit）。
3. `npm run check && npm test` 必须全绿（当前基线：router 48 / plugin 414+ / bridge 450+）。
4. 提交 → `npm run sync:local`（本机生效）→ 发 npm（两个包都要，显式官方源 + `--tag beta`）
   → `git push gitee main`。
5. **GitHub 一律按需推**（业主规则），默认不推。

---

## 四、踩过的坑（改代码前先看，能省一整轮）

- **注入脚本里的反引号**：`clients/dsh-remote/mobile-adapter.mjs` 的注入体是**模板字符串**，
  注释/文案里出现反引号会提前闭合它，报错往往长得毫不相干（如 `xxx is not defined`）。
  在那个文件的注入体（`const SCRIPT = ...` 之内）里，一律用「」而不是反引号。
- **测试文件里的断言别"假通过"**：该仓库的假 DOM **不支持类选择器**（`querySelector(".txt")`
  返回 null）. 断言菜单文案时若取到空串，`assert.ok(!/xx/.test(""))` 恒真 —— 要么用
  `innerHTML`，要么断言真实状态（如采样器计数）。
- **`~/.dsh-remote` 与插件自带的 `runtime/` 是两份**：插件半靠 `runtime/` 自愈补装桥半，
  所以 `runtime/node_modules/ws` **不能丢**（安装器拷贝曾把任何 `node_modules` 段整段剔除，
  已修 + 有用例锁住）。
- **宿主版本探测**：桌面端（Electron）的 `argv[1]` 是 `--expose-internals`（开关，不是路径），
  宿主根在 `argv[3]`（`…/app.asar/dsh`）—— 只读 `argv[1]` 会永远取不到版本。
- **🔴 桌面应用运行时，绝不要改写 `~/.dsh/profiles/desktop/`**（安装/更新插件都会写）：
  应用独占该目录，运行中被改写会**自己退出/重启**（业主原话："怎么又触发了 dsh 的关闭"）。
  `npm run sync:local` 与安装器现在都会检测并**自动跳过**（`--force-plugin` / `--force` 可强写），
  正路是：先完全退出应用，或在应用内「插件」页安装。
- **桌面端 profile 由 App 独占**：npm 版 `dsh` 拒绝管理它，只能走安装器或 App 内「插件」页。

---

## 五、跨仓库提醒

- 管理后台/服务端在 `../dsh-relay-enterprise`（闭源，**只推 Gitee**），
  它的 `relay-enterprise/package.json` 测试清单是**显式文件列表**：新增测试文件必须手工登记，否则永远不跑。
- 生产部署：`../dsh-relay-internal/scripts/` 下有按轮次的部署脚本（备份 → 上传 → 重启 → 核验 → 逐字节比对）。
