# 贡献指南

感谢你愿意为 dsh-remote 贡献代码!请遵循以下约定。

## 开发环境

- Node.js ≥ 20(纯原生模块,无第三方运行时依赖)
- 无需 `npm install`(dependencies 为空)

## 本地开发

```bash
git clone https://github.com/mrgaoang/dsh-remote.git
cd dsh-remote

# 用测试口令启动一个实例(指向本地 dsh web)
DSH_REMOTE_PASSWORD=dev-pass-123 node bin/dsh-remote.js start --port 3443
```

## 代码约定

- ESM 模块(`import`/`export`);
- 每个 `lib/` 文件有明确的职责注释;
- 新增功能请同步更新 README 与 CHANGELOG。

## 提交 Pull Request

1. Fork 本仓库并创建特性分支;
2. 修改代码并**保持零运行时依赖**;
3. 运行 `node --check <file>` 确保语法正确;
4. 在 CHANGELOG.md 的 [Unreleased] 下记录变更;
5. 提交 PR,描述变更动机与验证方式。

## 测试

暂未引入自动化测试框架;请在 PR 中说明你手动验证的路径
(登录 / 限流 / WebSocket / 特权方法 / 公网反代)。
