# 发版与插件市场发布规范

> 本文是**发版 + 上架/更新 DSH 插件市场**的强制规范。改动版本号、发布 npm、维护市场条目之前，
> 先读完本文对应小节。配套的自动化脚本与工作流在本仓库内，配套的运行手册见本机 skill
> `dsh-plugin-market-publish`（含各市场收录方式、催办话术、每日核对）。

## 1. 版本号三处同步

一次版本升级必须同时改三处，缺一即为不一致：

| 位置 | 说明 |
|---|---|
| `package.json` → `version` | 根 CLI 包（`@mrrisega/dsh-remote`），一个命令安装器 |
| `packages/dsh-remote-web/package.json` → `version` | dsh web 插件包（市场条目指向它） |
| `packages/dsh-remote-web/lib/index.js` → `PLUGIN_VERSION` | 面板内「版本与更新」用它做自检/更新比较 |

兼容别名包 `packages/dsh-remote-ui/` 由脚本生成，**不要手改**（见 §4）。

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
2. **资产名不带版本号**（`dsh-remote-web.tgz` / `dsh-remote-ui.tgz`）。`latest/download/` 只在请求时解析 `latest`，文件名照字面取；带版本号的名字必然在下次发版后 404。
3. **每次发版都必须挂上这两个同名资产**，否则 `latest/download` 会 404、市场安装失败。已自动化：
   - 手动：`npm run release:tarballs`（`scripts/release-tarballs.sh`：打包 → 校验包内版本 → 建/更新 `v<version>` Release → 校验 latest/download）
   - CI：`.github/workflows/release-tarballs.yml` —— 推 `v*` tag 或手动 `workflow_dispatch` 时自动完成同样的事

> 注意事项：GitHub 资产 CDN 有缓存，刚发布后立刻校验可能仍返回旧内容，带 `?cb=<时间戳>` 或等几分钟再验。

## 4. 旧名兼容别名（灰度改名）

改名会让**已上线的旧条目 URL 直接 404**（市场安装按钮当场失效），而新条目审核需要时间，因此改名必须灰度：

- 保留 `packages/dsh-remote-ui/` 作为**自动生成的别名包**（自包含副本，包名/插件 id/浏览器 id 全部回到旧名），
  由 `bash scripts/sync-legacy-alias.mjs` 从 `packages/dsh-remote-web/` 生成；`npm run check` 内含漂移校验
  （`check:alias`），改源包后必须重新生成，否则 CI 失败。
- 旧名同时发布到 npm（`dsh-remote-ui`），既让旧条目可走 npm 快装，也防止名字被抢注。
- **新条目合并后再退役**：删除别名目录 → `npm deprecate dsh-remote-ui "renamed to dsh-remote-web"` →
  提交旧条目移除 PR。**审核通过前绝不删除旧路径。**

## 5. 市场条目提交规则（awesome-dsh-plugin / deepseek1024 / 其它）

- **术语**：文案里写「亮点 / highlights」，**不要写"卖点 / 营销"**等商业化措辞；描述必须事实准确、可对码核对。
- **只动自己的条目**：PR 只含自己的文件；更新别人条目一律不做。
- **改数据必须重生成 README**：任何 `data/plugins/*.yml` 的增删改（含删除条目）后跑
  `node scripts/generate-readme.mjs` 并提交结果，否则 CI 报 "READMEs match data/plugins"。
- **提交前自查（避免"红盘进审核"）**：PR 的 files 列表只含预期文件（历史上曾因重建分支残留一个
  「指向仓库根」的多余条目文件，导致 Submission gate 必红）；自己可控的检查全绿后再催办。
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
| `scripts/sync-legacy-alias.mjs`（`npm run sync:alias` / `check:alias`） | 生成/校验旧名别名包 |
| `scripts/release-tarballs.sh`（`npm run release:tarballs`） | 打包 + 建/更新 Release + 校验 latest/download |
| `.github/workflows/release-tarballs.yml` | 打 tag 或手动触发时自动出包 |
