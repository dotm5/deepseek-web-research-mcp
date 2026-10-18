# 仓库设置清单

本文件记录 GitHub 仓库的公开元数据与合并策略。目标仓库为 `dotm5/deepseek-web-research-mcp`，按此表配置。

## 描述

`Local stdio MCP server for DeepSeek Search/Fetch with credential vault, site discovery and SQLite-backed research.`

## Topics

`deepseek`、`mcp`、`model-context-protocol`、`typescript`、`nodejs`、`web-search`、`web-fetch`、`sqlite`、`credential-vault`、`ssrf-protection`

## 功能开关

| 功能 | 设置 |
| --- | --- |
| Issues | 开启 |
| Discussions | 开启 |
| Wiki | 关闭；文档位于仓库内 |
| Projects | 按需开启 |

## 合并策略

| 项 | 设置 |
| --- | --- |
| Squash merge | 开启 |
| Rebase merge | 开启 |
| Merge commit | 关闭 |
| 合并后删除分支 | 开启 |
| Auto-merge | 开启 |

## 安全

| 项 | 设置 |
| --- | --- |
| Secret scanning | 开启 |
| Push protection | 开启 |
| Private vulnerability reporting | 开启 |
| Dependency alerts | 开启 |

## 社区文件

- `README.md` 与 `README.en.md`，顶部语言切换行。
- `LICENSE`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`。
- `.github/ISSUE_TEMPLATE/` 与 `.github/pull_request_template.md`。
- `.github/workflows/ci.yml`；远程地址确定后把 CI 徽章加入两份 README。

## 相关文档

- [README](../README.md)
- [贡献指南](../CONTRIBUTING.md)
- [安全策略](../SECURITY.md)
