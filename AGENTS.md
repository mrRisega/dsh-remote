# dsh-relay-open — 贡献与开发约定

> 本仓库是**开源版**：DSH 客户端插件（`packages/dsh-remote-web`）、桌面端桥（`clients/dsh-remote`）、
> 中继路由（`packages/relay-router`）。闭源服务端不在此仓库。
>
> 远端：`origin` 是公开主页（**按需推送**），日常推送用 `gitee`。

---

## 一、本机开发：让"本机实际在跑的东西"跟上仓库

```bash
npm run sync:local                   # 重打运行时 → 同步桥半 → 同步插件半 → 核验 → 重启桥
npm run sync:local -- --dry-run      # 只报告差异
npm run sync:local -- --no-restart   # 只同步，不动正在跑的桥
npm run sync:local -- --force-plugin # 桌面应用在运行时，强行写入插件半（默认会跳过，见下）
```

| 部件 | 本机位置 | 生效方式 |
|---|---|---|
| 桥半（运行环境） | `~/.dsh-remote/`（clients、node_modules/ws、dsh-setup.mjs、版本标记） | 需重启桥（脚本默认会做） |
| 插件半 | `~/.dsh/profiles/<profile>/dsh-remote-web-plugin/`（lib、runtime、package.json） | 宿主**热加载**；没生效就刷新窗口 |

这两处都**不在仓库里**：改了仓库 ≠ 本机在跑新代码。脚本收尾会逐字节核验，
避免"明明改了还是旧行为"。

---

## 二、不要手改 profile 的 `cordis.patch.yml`

它是宿主的 **live 重载**入口，手改会立刻触发重新组装，可能把工具面弄挂。
要改插件激活状态，走安装器或应用内的插件页：

```bash
npx @mrrisega/dsh-remote@beta plugin --profile desktop
```

---

## 三、发版（beta / 正式）

1. 版本号改**三处**：`package.json`、`packages/dsh-remote-web/package.json`、`package-lock.json`
   （插件版本由 package.json 派生，单一来源）。
2. 写 `CHANGELOG.md`：**面向用户**，只说"你会看到什么变化"，不列 commit、不写排查过程。
3. `npm run check && npm test` 全绿（当前基线：router 48 / plugin 429+ / bridge 450+）。
4. 提交 → `npm run sync:local`（本机生效）→ 发 npm（两个包都要，显式官方源 + `--tag beta`）→ 推送。
5. GitHub 远端按需推送，默认不推。

---

## 四、已知坑（改代码前先看，能省一整轮）

- **注入脚本里的反引号**：`clients/dsh-remote/mobile-adapter.mjs` 的注入体是**模板字符串**，
  注释/文案里出现反引号会提前闭合它，报错往往毫不相干。注入体内一律用「」。
- **测试里的假 DOM 不支持类选择器**：`querySelector(".txt")` 返回 null，断言容易"假通过"
  （空串上做否定断言恒真）。要么用 `innerHTML`，要么断言真实状态。
- **`~/.dsh-remote` 与插件自带的 `runtime/` 是两份**：插件靠自带 `runtime/` 自愈补装桥半，
  所以 `runtime/node_modules/ws` 不能丢（安装器拷贝曾把它整段剔除，已修 + 有用例锁住）。
- **宿主版本探测**：桌面端（Electron）的 `argv[1]` 是 `--expose-internals`（开关，不是路径），
  宿主根在 `argv[3]` —— 只读 `argv[1]` 永远取不到版本。
- **🔴 桌面应用运行时，不要改写 `~/.dsh/profiles/desktop/`**：应用独占该目录，
  运行中写入会让应用**自己退出/重启**。安装器与 `sync:local` 会检测并自动跳过
  （`--force` / `--force-plugin` 可强写）；正路是先完全退出应用，或在应用内「插件」页安装。
- **桌面端 profile 由应用独占**：npm 版 `dsh` 拒绝管理它，只能走安装器或应用内插件页。

---

## 五、测试

- 三套：`npm run test:router` / `test:plugin` / `test:bridge`，或一次 `npm test`。
- 小改动**只跑受影响用例**即可（例如只动插件浏览器半，就跑 `packages/dsh-remote-web/test/` 里相关的几个文件）；
  发版前跑全量。
