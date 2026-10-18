# 验证证据

本目录保存各轮验证的原始 JSON 报告。报告已去除本地用户名与工作区绝对路径（统一记为 `<home>`、`<project>`、`<data-dir>`、`<node>`），保留请求参数摘要、结果计数、截断状态、注册路径占位符与错误分类。

| 文件 | 版本 | 内容 |
| --- | --- | --- |
| `LIVE-RESULTS.json` | 0.4.0 | 真实 stdio 握手、Search、双 URL Extract 与 schema |
| `UNIT-RESULTS.json` | 0.4.1 | Vitest 汇总：25 通过、1 跳过 |
| `DOCTOR-RESULTS.json` | 0.4.0 | 凭据、真实 API、代理与 Harness 注册状态 |
| `SETUP-RESULTS.json` | 0.4.0 | Claude/Codex user scope 注册与备份 |
| `HARNESS-RESULTS.json` | 0.4.0 | Claude 与 Codex 工具调用记录 |
| `NETWORK-RESULTS.json` | 0.4.1 | 系统 DNS、DoH 公网地址、三路径代理与私网拒绝 |
| `NPX-RESULTS.json` | 0.4.1 | 本地 tarball 的 npx 离线诊断 |
| `ADVANCED-AUTO-RESULTS.json` | 0.4.1 | Claude 高级工具 12 项检查 |
| `ADVANCED-SOCKS-RESULTS.json` | 0.4.1 | SOCKS5 路径 5 项检查 |
| `ADVANCED-DIRECT-RESULTS.json` | 0.4.1 | direct/TUN 路径 5 项检查 |
| `ADVANCED-SETUP-RESULTS.json` | 0.4.1 | 高级验收所用稳定入口与注册状态 |
| `LOAD-BEFORE-FIX.json` | 0.4.1 | 首轮压力测试原始记录 |
| `LOAD-RESULTS.json` | 0.4.1 | 修复后压力测试复测 |
| `FINAL-CLAUDE-RESULTS.json` | 0.4.1 | 最终安装包的 Claude Map/Code/Research 调用 |
| `INSTALLED-DOCTOR-RESULTS.json` | 0.4.1 | 安装包离线 doctor |
| `INSTALLED-SCHEMA-RESULTS.json` | 0.4.1 | 安装包默认/全量 schema 与非法参数拒绝 |
| `BUILD-RESULTS.json` | 0.4.1 | 源码、运行时、锁文件与 tarball 哈希 |
| `SECURITY-RESULTS.json` | 0.4.1 | 交付目录明文凭据扫描 |

轮次说明见 [轮次记录](../docs/ROUNDS.md)，结论见 [验证结论](../VALIDATION.md)。

公开发行准备另见 [release-preparation.json](release-preparation.json)。历史报告中的包名、哈希与测试数保留测量时的值。当前复现命令输出新的报告；运行本地脚本生成的文件在提交前执行路径与凭据检查。

首次提交前的完整候选文件扫描见 [git-secret-scan.json](git-secret-scan.json)。扫描覆盖所有本地 Git 对象（包括未引用对象）、暂存区与候选文件；已知凭据仅在内存中比对，报告不包含匹配值。提交后、推送前继续扫描完整历史。
