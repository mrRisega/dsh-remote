# 版本发布策略（2026-09 起生效）

面向用户的版本已进入推广期：**稳定通道与预发通道分离**，普通用户只拉稳定版，迭代先上预发。

## Dist-tag 约定
| tag | 含义 | 谁拉 |
|---|---|---|
| `latest` | 稳定版（当前 0.5.0） | 普通用户（npx 默认 / 插件「一键更新」/ 市场安装） |
| `beta` | 预发测试版（`0.6.0-beta.N`、`0.7.0-beta.N`…） | 作者 / 内测用户 |
| `alpha` | 内部开发版（`0.6.0-alpha.N`） | 仅作者 |

规则：日常迭代一律发 **alpha/beta**；验证稳定后**提升一个版本并发布到 `latest`**（如 `0.6.0-beta.3` 稳定 → 发 `0.6.0` 到 latest）。

## 发预发版
```bash
# 示例：切到 0.6.0-beta.0
npm version 0.6.0-beta.0 --no-git-tag-version
npm publish --registry=https://registry.npmjs.org --tag beta
# alpha 同理: --tag alpha（版本号 0.6.0-alpha.0）
```

## 转稳定
```bash
npm version 0.6.0 --no-git-tag-version
npm publish --registry=https://registry.npmjs.org            # 默认 tag = latest
# 若已发过 beta 且未发布正式: npm dist-tag add @mrrisega/dsh-remote@0.6.0 latest
```

## 客户端如何拉
- 普通用户：`npx @mrrisega/dsh-remote`（默认 latest）；插件面板「检查更新/一键更新」比较并安装 `latest`。
- 内测用户：`npx @mrrisega/dsh-remote@beta`；插件面板要走 beta 需让 dsh web 进程带 `DSH_UPDATE_TAG=beta` 环境变量（node 半读取），随后「检查更新/一键更新」自动切到 beta 通道。

## 发布前检查
1. `node --check` 相关 js/mjs；2. 跑全量测试（plugin/bridge/router/enterprise/admin）；3. 记录 CHANGELOG；
4. 镜像（npmmirror）同步滞后属正常，发布后如需立即验证请 `--registry=https://registry.npmjs.org`。
