# v0.4.1 验证结论

日期：2026-10-18。环境：Windows 当前用户；构建 Node 24.22.0，系统 Node 24.13.1；Claude Code 2.1.248；Codex 0.162.1。

## 公开发行准备

公开包为 `deepseek-web-research-mcp`，保留 MCP 注册名 `deepseek-search`。当前公开目录的核心测试为 31 通过、1 项外部联网测试默认跳过；以下 25 项测试与 API/压力数据属于改名前的历史基线。新增安装验收覆盖隔离 npx 安装、Windows DPAPI 登录、doctor、重复 setup 与缓存删除后的握手，真实登录一轮 15 项检查通过、API 2 次。新增密钥扫描回归覆盖未引用 Git 对象、暂存区与未跟踪文件，扫描报告不包含密钥值。

- [公开发行准备记录](evidence/release-preparation.json)
- [历史轮次](docs/ROUNDS.md)

## 结论

- 核心测试：25 项通过，0 失败；1 项联网测试默认跳过，并在单独运行中通过。
- 类型与构建：`tsc --noEmit` 与 `tsup` 通过；源码构建、安装运行时与 tarball 的 SHA256 一致。
- Schema 与 stdio：默认 3 工具、全量 10 工具；JSON Schema 通过 AJV 2020-12 编译；非法参数被拒绝。
- 真实 API：Search 与双 URL Extract 通过，含 `need_content`、`site:`、`after:`、正文截断与缓存命中。
- Claude Code 高级工具：auto 模式 12 项检查全部通过；SOCKS 与 direct 模式各 5 项通过。
- 最终安装包：Claude Code 实际调用 Map、Code Context 与 Research 分页读取；引用 URL 与原始 Search 结果关联一致。
- 多进程压力：修复后 270 次业务调用、270 次 API 尝试全部成功；首轮 330 次调用、332 次尝试中 329 次成功、1 次网络超时。
- 凭据与分发：Windows DPAPI 存取与擦除通过；51 个交付文件的明文 Key 精确匹配为空；本地 tarball 可由 npx 执行。

## 测量

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 工具链 | TypeScript 7.0.2、tsup 9.0.0、Vitest 5.0.5、Zod 4.6.7、MCP 2.3.1；依赖由 lockfile 固定 | [BUILD-RESULTS.json](evidence/BUILD-RESULTS.json) |
| 核心测试 | 25 passed、1 skipped；覆盖 AES-GCM 篡改/身份隔离、回退后端、DPAPI 存取、脱敏、查询拆分、Hostname 边界、缓存/Singleflight/LRU、共享限流、429/401、Extract 部分失败、Markdown 块、3/10 Schema、原 Host 保留、SSRF、TOML 保留、BFS/Research/Code 工作流 | [UNIT-RESULTS.json](evidence/UNIT-RESULTS.json) |
| stdio / Schema | 默认 3 工具、全量 10 工具；AJV 编译通过；`query.maxLength=128`；`count=51` 被拒绝 | [LIVE-RESULTS.json](evidence/LIVE-RESULTS.json) |
| 真实 Search/Extract | Search 1 次、双 URL Extract 2 次成功；正文截断与空 `failed_results` 记录在案 | [LIVE-RESULTS.json](evidence/LIVE-RESULTS.json) |
| 凭据 | 临时 Key 经 stdin 输入，1 次真实 Search 验证后写入 DPAPI；回读一致；`auth status` 只显示掩码 | [DOCTOR-RESULTS.json](evidence/DOCTOR-RESULTS.json) |
| doctor | 真实 Search 成功；识别 HTTP 代理 `127.0.0.1:7897`；Claude/Codex 均为 detected/registered/keyless/current | [DOCTOR-RESULTS.json](evidence/DOCTOR-RESULTS.json) |
| Harness 注册 | Claude 与 Codex user scope 注册完成；备份路径与稳定入口在案；Codex 条目为 stdio、无 env | [SETUP-RESULTS.json](evidence/SETUP-RESULTS.json) |
| Claude 模型调用 | 原生 Claude Code 当前 OpenCode Go 路由；调用 Search 与 Extract 各 1 次，实际 API 1 次、缓存命中 1 次；无权限拒绝 | [HARNESS-RESULTS.json](evidence/HARNESS-RESULTS.json) |
| Codex 模型调用 | 原生 `codex exec` 读取用户配置；Search 与 Extract 各 1 次，均命中缓存 | [HARNESS-RESULTS.json](evidence/HARNESS-RESULTS.json) |
| 代理 / Fake-IP | 系统 DNS 返回 198.18.1.56 与 `fdfe:dcba:9876::136`；HTTP、SOCKS5、direct/TUN 三路径经 DoH 获得公网 43.169.32.32，保留 Host/SNI 与证书校验；127.0.0.1 被阻止 | [NETWORK-RESULTS.json](evidence/NETWORK-RESULTS.json) |
| 高级工具 | auto 12 项、SOCKS 5 项、direct 5 项检查通过；覆盖 Map/Crawl、Code Context、Research 创建/分页/取消/零结果、私网拒绝 | [ADVANCED-AUTO-RESULTS.json](evidence/ADVANCED-AUTO-RESULTS.json)、[ADVANCED-SOCKS-RESULTS.json](evidence/ADVANCED-SOCKS-RESULTS.json)、[ADVANCED-DIRECT-RESULTS.json](evidence/ADVANCED-DIRECT-RESULTS.json) |
| 压力测试 | 修复后 270/270 成功；各滑窗最多 5 次；无 429/5xx/网络失败 | [LOAD-RESULTS.json](evidence/LOAD-RESULTS.json)、[LOAD-BEFORE-FIX.json](evidence/LOAD-BEFORE-FIX.json) |
| 最终交付 | 安装包源码与运行时哈希一致；默认 3 工具、全量 10 工具；npx 离线诊断成功 | [BUILD-RESULTS.json](evidence/BUILD-RESULTS.json)、[INSTALLED-SCHEMA-RESULTS.json](evidence/INSTALLED-SCHEMA-RESULTS.json)、[NPX-RESULTS.json](evidence/NPX-RESULTS.json) |
| 安全扫描 | 51 个文件；当前 Vault 凭据的明文精确匹配为空 | [SECURITY-RESULTS.json](evidence/SECURITY-RESULTS.json) |

0.4.0 基础验收的官方 Search/Fetch 共 10 次真实请求：登录验证 1、首轮冒烟 3、首次 doctor 1、Claude Search 1、最终冒烟 3、最终 doctor 1。Codex 两次工具调用与 Claude Extract 命中缓存。Schema、代理本地 HTTP/DoH 与 npx 离线诊断不增加官方 API 调用。

## 覆盖范围

| 能力 | 真实环境 | 受控测试 |
| --- | --- | --- |
| Search / Fetch / Extract | 通过 | 通过 |
| Map / Crawl | Claude 高级验收 | 通过 |
| Code Context | Claude 高级验收 | 通过 |
| Research start/status/cancel | Claude 高级验收 | 通过 |
| Windows DPAPI | 通过 | 通过 |
| macOS Keychain / Linux Secret Service / AES 权限 | 待系统实机 | 回退后端单测 |
| Cursor / Windsurf / Gemini 注册 | 待系统实机 | 配置回退逻辑 |
| 代理 / Fake-IP / DoH | 三路径通过 | 通过 |

## 相关文档

- [README](README.md)
- [轮次记录](docs/ROUNDS.md)
- [仓库设置](docs/REPOSITORY.md)
- [变更记录](CHANGELOG.md)
- [证据目录](evidence/README.md)

## 复现命令

```sh
npm ci
npm run typecheck
npm test
npm run build
node dist/cli.js --version
node dist/cli.js --help
npm run smoke
LIVE_NETWORK=1 npx vitest run test/network.live.test.ts
```
