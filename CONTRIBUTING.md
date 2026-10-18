# 贡献指南

## 环境

要求 Node.js 24 LTS。

```sh
npm ci
npm run typecheck
npm test
npm run build
node tools/check-links.mjs
node tools/check-docs.mjs
```

真实网络与 API 采样需要已登录的 Vault；核心测试使用 fixture 与内存 SQLite。

## 修改范围

- 一个提交一个逻辑变更。
- 只暂存明确相关的路径；提交前查看 `git diff --cached`。
- 新增工具参数时同步更新 `src/tools/index.ts`、README 与测试。
- 文档结论只写一处；其他位置使用相对链接。
- 公开文档去除本地绝对路径、用户名、凭据与私有数据。

## 提交信息

标题用英文祈使句，正文列要点。示例：

```text
Harden SQLite token timestamps across blocked transactions
```

作者邮箱使用 GitHub noreply 地址，并写入仓库级配置：

```sh
git config user.email "<id>+<login>@users.noreply.github.com"
```

## 拉取请求

- 说明变更、验证命令与结果。
- CI 覆盖 typecheck、Vitest、构建、每个 CLI 的 `--help`、相对链接、文档规范与无密钥 smoke。
- 合并策略为 Squash 或 Rebase；分支合并后删除。
