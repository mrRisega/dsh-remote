# 发版与插件市场发布规范

> 本文是**发版 + 上架/更新 DSH 插件市场**的规范。改动版本号、发布 npm、维护市场条目之前，
> 先读完本文对应小节。配套的自动化脚本与工作流都在本仓库内。

## 1. 版本号三处同步

一次版本升级必须同时改**四处**，缺一即为不一致：

| 位置 | 说明 |
|---|---|
| `package.json` → `version` | 根 CLI 包（`@mrrisega/dsh-remote`），一个命令安装器 |
| `packages/dsh-remote-web/package.json` → `version` | dsh web 插件包（市场条目指向它） |
| `packages/dsh-remote-web/lib/index.js` → `PLUGIN_VERSION` | 面板内「版本与更新」用它做自检/更新比较 |
| `package-lock.json` → `version` 与 `packages[""].version` | 锁文件记录根包版本；漏改会与 `package.json` 脱节 |

> 锁文件那一处最容易漏（0.6.6 发版时就漏了，锁文件停在 `0.6.6-beta.1`，直到 2026-09-17 才发现）。
> 一条命令即可对齐：`npm install --package-lock-only`。

旧名别名包 `dsh-remote-ui` **已退役**（仓库内已删除、npm 已 deprecate，见 §4）。

## 2. 发版步骤（顺序不能颠倒）

```bash
# 1) 改三处版本号 + 写 CHANGELOG（面向用户视角）
# 2) 先提交、再发布 —— 发布代码绝不能只留在工作区（0.6.0 曾因此没有版本库记录）
npm test && npm run check
git add -A && git commit -m "release(x.y.z): …" && git push origin main
# 3) 发布 npm（两个包都要发；本机 .npmrc 默认源是 npmmirror，必须显式官方源）
(cd packages/dsh-remote-web && npm publish --registry=https://registry.npmjs.org)
npm publish --registry=https://registry.npmjs.org
# 4) 出自定义市场预构建包（关键！见 §3）
bash scripts/release-tarballs.sh        # 或 npm run release:tarballs
```

## 3. 插件市场预构建包（tarball）铁律

市场条目用 `tarball:` 指向 GitHub Release 资产，让「一键安装」免源码构建。三条硬性规则：

1. **URL 只允许 `releases/latest/download/<常量名>.tgz`**
   ✅ `https://github.com/mrRisega/dsh-remote/releases/latest/download/dsh-remote-web.tgz`
   ❌ `…/releases/download/v0.6.0/dsh-remote-web.tgz` —— 钉死版本后，插件升到 0.6.2 市场仍装 0.6.0。
2. **资产名不带版本号**（`dsh-remote-web.tgz`）。`latest/download/` 只在请求时解析 `latest`，文件名照字面取；带版本号的名字必然在下次发版后 404。
3. **每次发版都必须挂上这两个同名资产**，否则 `latest/download` 会 404、市场安装失败。已自动化：
   - 手动：`npm run release:tarballs`（`scripts/release-tarballs.sh`：打包 → 校验包内版本 → 建/更新 `v<version>` Release → 校验 latest/download）
   - CI：`.github/workflows/release-tarballs.yml` —— 推 `v*` tag 或手动 `workflow_dispatch` 时自动完成同样的事

> 注意事项：GitHub 资产 CDN 有缓存，刚发布后立刻校验可能仍返回旧内容，带 `?cb=<时间戳>` 或等几分钟再验。

## 4. 旧名别名已退役（2026-09-15）

改名灰度期结束，别名包**已删除**，后续不再维护：

- 仓库里已移除：`packages/dsh-remote-ui/`、`scripts/sync-legacy-alias.mjs`、
  `npm run sync:alias` / `check:alias`（`npm run check` 不再包含别名校验）。
- npm 上的 `dsh-remote-ui` 已标记 **deprecated**（`latest` 会永久停在 0.6.5），
  安装/更新会看到迁移提示：改用 `@mrrisega/dsh-remote`（插件包 `dsh-remote-web`）。
- **安装器仍保留旧名清理逻辑**（`PLUGIN_LEGACY_IDS`）：老用户升级时会自动移除 profile 里
  旧名（`dsh-remote-ui`）的依赖 / bundles 条目 / 本地目录与链接，避免残留导致重复激活。
  这部分**不要删**，它是老用户能从旧版平滑升上来的保证。
- 不要再往 npm 发 `dsh-remote-ui`；旧条目若仍存在于某个市场（已过时、已改名），删除即可。

## 5. 市场条目提交规则（awesome-dsh-plugin / deepseek1024 / 其它）

- **术语**：文案里写「亮点 / highlights」，**不要写"卖点 / 营销"**等商业化措辞；描述必须事实准确、可对码核对。
- **只动自己的条目**：PR 只含自己的文件；更新别人条目一律不做。
- **改数据必须重生成 README**：任何 `data/plugins/*.yml` 的增删改（含删除条目）后跑
  `node scripts/generate-readme.mjs` 并提交结果，否则 CI 报 "READMEs match data/plugins"。
- **提交前自查（避免"红盘进审核"）**：PR 的 files 列表只含预期文件（历史上曾因重建分支残留一个
  「指向仓库根」的多余条目文件，导致 Submission gate 必红）；确认自己可控的检查全绿后再提交。
- **monorepo 必须声明 tarball**：某些市场按仓库推导 `github:owner/repo` 安装，会装到根包（无 `dsh.bundle`）
  而无法激活；声明 `tarball:` 后市场优先使用预构建包。
- **分支卫生**：不要删除 PR 的 head 分支（GitHub 会自动关闭该 PR，且 reopen 常失败）；fork 与上游分叉后
  用 `PATCH /repos/{fork}/git/refs/heads/main -F force=true` 强制对齐，再建分支。

## 6. 市场数据展示机制（排障用）

| 字段 | 来源 | 何时更新 |
|---|---|---|
| `stars` | GitHub 仓库 star（上游 `probe-stars.mjs` → `data/stars.json` → `build-site.mjs`） | 探针每日刷新，但**只有站点 build 成功才写进 plugins.json** |
| `downloads` | **npm 包最近 30 天**下载量（`probe-downloads.mjs`，`api.npmjs.org last-month`） | 仅覆盖已映射到 npm 的条目 |
| `npm` / `version` | `probe-npm.mjs` 读**条目子目录** `package.json.name` → registry；要求该包 `repository` 指回被收录仓库 | 探针周期内 |

推论：条目指向 404 子目录或名字未发 npm → 三个字段全空；上游站点 build 失败期间 plugins.json 整体冻结，
stars/条目/下载量全部停更（先看他们的 build 工作流，再怀疑自己）。市场显示的数字**不是市场安装数**。

## 7. 相关脚本

| 脚本 | 用途 |
|---|---|
| `scripts/release-tarballs.sh`（`npm run release:tarballs`） | 打包 + 建/更新 Release + 校验 latest/download |
| `.github/workflows/release-tarballs.yml` | 打 tag 或手动触发时自动出包 |

## 8. 公开内容纪律（CHANGELOG 与提交信息）

> 2026-09-19 用户要求：「推代码时，changelog 里一些我们内部的事情不要公开（比如修了这那个
> bug 等乱七八糟的内容，不是开源社区需要关注的）。前期 log 不要往公开的里面乱放了，
> **公开的内容一定要精简**。」

本仓库及其 GitHub / Gitee 镜像是**公开**的。`CHANGELOG.md` 与提交信息都是写给
**使用者**看的，不是内部复盘文档。改之前先问一句：**"用户会在意这一条吗？"**

### 写什么

- 用户能感知到的变化：功能、体验、行为改变，以及**他们反馈过的问题是否解决**。
- 用用户视角描述**结果**，不描述**过程**。

| ✅ 这样写 | ❌ 不要这样写 |
|---|---|
| 微信语音输入不再误发半句话 | 修 IME 时序：捕获阶段 `stopPropagation`、`compositionend` 后 60ms 尾窗 |
| 左侧列表展开后点不动的问题已修复 | `isDrawer()` 四边相交判定 + 抽屉 `z-index:310` |
| 深色界面下不再是白板 | 引入 `--dru-*` 令牌层，160 处硬编码 hex 替换 |
| "更新中"不会再长时间无响应 | 加无输出看门狗，判据从标记年龄换成日志 mtime |

### 不写什么

- 内部函数名 / 类名 / CSS 选择器 / 行号 / `z-index` 等实现细节；
- 内部事故复盘、根因分析、严重级别（P1 / P2 / F2）、"自引入的回归"这类自我检讨；
- 内部指标与商业化措辞（装机数、转化、埋点、渠道、定价策略）；
- 未发布的计划、内部时间表、协作过程（谁在哪个分支改了什么）。

### 细节放哪里

1. **闭源仓库 `dsh-relay-enterprise` 的对应提交**（工程复盘、内部成因）；
2. 仓库外的 `../dsh-relay-internal/release-notes-internal/`（诊断/复盘类产物一律不入库）；
3. **代码注释** —— 改到哪一行，注释就在那一行旁边，这是最自然的落点。

### 长度

- 一个版本段控制在**一屏以内**；同一轮迭代的预览版（`-beta.1` / `-beta.2` / `-beta.3`）
  **合并成一条正式版号**发布，不逐条罗列。
- 每条 ≤ 2 行：先说结论（用户会看到什么变化），必要时补一句原因。

### 发版前自检

- [ ] `grep -nE "z-index|选择器|行号|P[0-9]|回归|埋点|装机|根因" CHANGELOG.md` 无命中？
- [ ] 每一条非开发的用户都能读懂？
- [ ] 内部复盘已经移到 `../dsh-relay-internal/` 或闭源仓库？
- [ ] 提交信息是否也只说"用户能感知到什么 + 为什么"，而不是实现过程？

## 9. `beta` 与 `latest` 的约定（转正流程）

> 2026-09-19 用户定：「我所谓的『把它推成 latest』，就是把 beta 版本的内容**直接放成
> latest 版本，后面不要接 `beta` 这个关键词**。**beta 永远是我们内部预览通道。**」

### 两个通道的定位

| 标签 | 定位 | 版本号写法 |
|---|---|---|
| `beta` | **内部预览通道**。小范围验证用，用户不应长期停留在这里 | `0.6.9-beta.1` 这类带 `-beta` 的号 |
| `latest` | **正式发布**。所有用户的默认更新目标 | **不带 `-beta`** 的正式号，如 `0.6.9` |

### 为什么不能把 `latest` 直接指向 `-beta.x`

版本号里的 `-` **是有语义的**：插件的更新通道由 `PLUGIN_VERSION` 是否含 `-` 决定
（含 → 跟随 `beta`；不含 → 跟随 `latest`，见 `packages/dsh-remote-web/lib/index.js` 的
`updateChannel()`）。把 `latest` 指到一个 `-beta.x` 上，会同时踩两件事：

1. 用户在面板上看到"当前版本"是预览版号，而它其实是正式发布；
2. 通道与标签互相错位，后续判断"谁该更新到什么"容易出错。

### 转正怎么做（"推成 latest" 的标准动作）

1. **用同一份代码**把五处版本号改成正式号（§1）——去掉 `-beta.x`，**内容一字不改**；
2. `CHANGELOG.md` 里该条已经是正式版号（预览版的条目按 §8 并进来，不单列）；
3. `npm publish` 两个包（默认就是 `--tag latest`，不要加 `--tag beta`）；
4. `npm dist-tag` 确认：`latest` = 正式号，`beta` 仍停在最后一个预览版；
5. 面向用户的公告按 `../dsh-remote-marketing/0.6.9-用户升级日志.md` 的格式写。

> 不需要额外做"让 beta 用户迁移"的动作：`pickBestTag()` 会拿 `latest` 与当前通道比大小，
> 正式号高于预览号时会自动改用 `latest`，停留在预览通道的用户下次检查更新即自动收敛。
