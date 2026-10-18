# 验证轮次记录

本文件按时间记录每次验证的输入、命令与观察。结论汇总见 [VALIDATION.md](../VALIDATION.md)，原始报告见[证据目录](../evidence/README.md)。

## 第 1 轮：0.4.0 首轮基线

| 验证层 | 观察 |
| --- | --- |
| 工具链 | 官方最新 LTS Node 24.22.0 便携版经 SHA256 验证；兼容系统 Node 24.13.1。TypeScript 7.0.2、tsup 9.0.0、Vitest 5.0.5、Zod 4.6.7、MCP 2.3.1。直接依赖与 `package-lock.json` 固定。 |
| 类型/构建 | `tsc --noEmit`、`tsup target=node24` 通过；`dist/cli.js` 为 ESM 可执行入口，保留 `node:sqlite` 前缀。 |
| 核心测试 | 18 项通过；1 项网络集成测试默认跳过，单独运行通过。覆盖 AES-GCM 篡改/身份隔离、回退后端、Windows DPAPI 实机存取/擦除、脱敏、查询拆分、Hostname 边界、缓存/Singleflight/LRU、共享限流、429/401、Extract 部分失败、Markdown 块、3/10 Schema、原 Host 保留、SSRF、TOML 保留、BFS/Research/Code 工作流。 |
| stdio / Schema | 默认 3 工具、`--tools=all` 10 工具；全部 JSON Schema 通过 AJV 2020-12 编译；`query.maxLength=128`，运行时按 Unicode 字符校验；`count=51` 被 MCP 拒绝。安装目录的最终包另做零 API 握手验证。 |
| 实际 Search/Extract | 最新 LTS 子进程真实握手；Search 1 次与双 URL Extract 2 次成功；含 `need_content`、`site:`、`after:`、正文截断，`failed_results` 为空。 |
| 凭据 | 临时 Key 经 stdin 输入，1 次真实 Search 验证后写入当前用户 DPAPI；加密存储后回读一致；`auth status` 只显示掩码。真实凭据未进入项目、启动参数或 Agent 配置。 |
| doctor | 真实 Search 成功；发现 HTTP 代理 `127.0.0.1:7897`；Claude/Codex 均 detected/registered/keyless/current=true。 |
| Harness 注册 | Claude 2.1.248 与 Codex 0.162.1 原生命令完成 user scope 注册；备份路径与稳定运行入口记录在案。`claude mcp get` 显示 Connected；`codex mcp get` 显示 stdio、env=null、env_vars=[]。 |
| Claude 实际模型调用 | 原生 Claude Code 与现有 OpenCode Go 路由的 deepseek-v4.1-flash，使用注册的稳定入口与隔离无密钥配置；Search/Extract 各调用 1 次，前者真实 API 1 次，后者缓存命中；无错误、无权限拒绝。 |
| Codex 实际模型调用 | 原生 `codex exec` 读取已安装用户配置；Search/Extract 各调用 1 次，均命中缓存。 |
| 代理 / Fake-IP | 系统 DNS 返回 198.18.1.56 与 `fdfe:dcba:9876::136`。HTTP 代理、SOCKS5、direct/TUN 三路径均通过 DoH 获得公网 43.169.32.32，保留 Host/SNI 与证书校验后收到 HTTP 200，并阻止 127.0.0.1。robots.txt 返回 HTML 软 404；Map 跳过该内容。 |
| 分发 | `npm pack` 生成相邻 tarball；本机 `npx --package <tarball> ... doctor --offline` 成功。npm registry 未发布。 |

本轮 0.4.0 官方 Search/Fetch 共 10 次真实请求：登录验证 1 + 首轮冒烟 3 + 首次 doctor 1 + Claude Search 1 + 最终 LTS 冒烟 3 + 最终 doctor 1。Codex 两次工具调用与 Claude Extract 命中缓存；Schema、代理本地 HTTP/DoH 与 npx 离线诊断不增加官方 API 调用。首次启动/Schema 排错在 API 请求前失败。

真机暴露并修复两个构建期问题：tsup 默认剥离 `node:`，内置 SQLite 加载失败；PowerShell 7 的 `PSModulePath` 传入 Windows PowerShell，安全模块加载失败。代理验收发现 Undici `fetch` 重建 Host 使固定公网 IP 请求收到 418，已改为 `request` 接口并保留原 Host 回归测试。网络测试期间一次 DoH 连接超时，最终三路径重测通过；证书校验与私网检查保持开启。

0.4.0 验收边界：Windows DPAPI、当前 Claude/Codex 与本机 Clash 已实测；macOS Keychain、Linux Secret Service/AES 权限及 Cursor/Windsurf/Gemini 注册缺少对应系统实机。Map/Crawl/Research/Code Context 有受控工作流测试，真实 API 冒烟集中在 Search/Extract。Research 为进程内异步作业与 SQLite 证据存储，作业生命周期绑定 MCP 进程。

## 第 2 轮：0.4.1 Claude Code 高级工具

环境：原生 Claude Code 2.1.248；当前 OpenCode Go 路由返回 deepseek-v4.1-flash。MCP 以已注册稳定入口与 `--tools=all` 启动；测试配置无 Key，默认工具配置保持原样。

- `ADVANCED-AUTO-RESULTS.json`：12 项检查通过。
- `ADVANCED-SOCKS-RESULTS.json`：5 项通过。
- `ADVANCED-DIRECT-RESULTS.json`：5 项通过。
- 检查依据工具结果 JSON；模型最终总结单独记录。

观察：

- Map 发现 `modelcontextprotocol.io/` 以外的 `/examples`、`/seps`；Crawl 提取两页非空正文。HTTP 自动代理、SOCKS5、direct/TUN 均记录本地元数据 HTTP、DoH 与公网 IP 固定请求计数。部分正文来自缓存；本轮 fresh API 计数保持独立。
- Code Context 返回真实 C1 仓库 URL、源子查询、`provider_score`/`authority` 与完整 TypeScript 围栏。修复前存在先选段后语言排序、重复正文与不完整 ASCII 标点解码；最终响应在正文共享预算内，chunk 只保留索引与评分。
- Research 主任务完成 Search → Fetch → 证据汇总；S1–S4 的 URL 均与 `search_results` 匹配，`source_queries` 与评分保留。一次目标 Fetch 404 作为 `failed_results` 保留，四份成功证据完成。
- S1/S2 为 nightly/canary 文档；S3 为 Node v24.20.0 版本文档；S4 为第三方 GitHub fork。authority=3 表示提供方评分；官方身份与最新版本由 URL 与文档版本独立表达。
- 修复默认状态响应 71.8KB 被 Claude 转存文件的问题：最终默认响应约 13KB，模型直接读取引用；来源分页后 S1 身份保持，完整证据仍在 SQLite。
- 真实运行中任务完成 `running → cancelled`；最终保留 4 次 API 尝试，`progress_final=true`。已完成任务 cancel 保持 completed。
- 零匹配任务返回 `NO_SEARCH_RESULTS`，evidence 为空。
- 对 127.0.0.1 的 Map 负例在种子预检返回 `SSRF_BLOCKED`，包括 `max_depth=0`。
- 最后一次复查发生 DoH 主引导地址连接超时；新增受控备用地址。主地址故障注入单测、备用地址真实 TLS/DoH 与 HTTP/SOCKS/direct 三路径均通过。

## 第 3 轮：0.4.1 有界压力测试

`LOAD-BEFORE-FIX.json` 保留首轮，`LOAD-RESULTS.json` 为修复后复测。压力作用于真实核心客户端/API；全部绕过本地缓存与 Singleflight，Search 使用唯一 `ori_question`，Fetch 使用唯一 fragment 键，轮换 12 个域名。

| 档位 | Search | Fetch | 说明 |
| --- | --- | --- | --- |
| 首轮 3 QPS 输入基线 | 30/30 成功 | 29/30 成功 | 测试客户端上限 5，调度输入 3；1 次 Fetch 网络超时，请求按未知完成状态处理 |
| 首轮 5 QPS 配置 | 60/60 成功 | 60/60 成功 | 无 429/5xx |
| 首轮三进程争用 | 75/75 成功，2 次 429 重试 | 75/75 成功 | 检出旧时间戳重复补令牌问题；Search 实际 5.23 QPS，某滑窗 7 次 |
| 修复后 5 QPS 配置 | 60/60 成功，4.77 QPS | 60/60 成功，4.77 QPS | 各滑窗最多 5 次，无 429/5xx/网络失败 |
| 修复后三进程争用 | 75/75 成功，4.72 QPS | 75/75 成功，4.26 QPS | 每接口总输入需求 15 QPS，共享桶压住实际速率；各滑窗最多 5 次 |

修复点：SQLite `BEGIN IMMEDIATE` 可能阻塞；时间在取得锁并读取桶后获取，`updated` 保持单调，避免等待期间的旧时间补充额外令牌。新增回归测试。不同 Key 在同一数据库共享限流，缓存保持隔离。

修复后 270 次业务调用/270 次 API 尝试全部成功；首轮 330 次业务调用/332 次尝试中 329 次成功、1 次网络超时。两轮共 600 次业务调用、602 次 API 尝试、599 次成功；首轮 2 次 429 由有界重试恢复，无 5xx。三进程争用的端到端 p95 约 12.5–12.9 秒，包含限流排队；API 自身 p95 约 0.28–0.76 秒。短时样本描述本轮测量。

## 第 4 轮：0.4.1 最终交付复核

- `FINAL-CLAUDE-RESULTS.json`：最终安装代码经原生 Claude Code 当前 DeepSeek 模型调用。Map 发现 3 个 URL、1 次 API/2 次本地请求且无失败；Code Context 返回 C1 与完整 TypeScript 代码块，引号、斜杠与 `@` 恢复；Research 分页读取 S3，URL 与原始 Search 引用一致。Research 读取既有任务，历史 404 保留，未计为新增 Fetch。
- 完整 Map/Crawl、研究创建/轮询/取消与三种代理路径见 `ADVANCED-AUTO/SOCKS/DIRECT-RESULTS.json`。DoH 备用引导与 Markdown 解码修复由核心测试、`NETWORK-RESULTS.json` 与最终 Claude 调用补充验证。
- `INSTALLED-SCHEMA-RESULTS.json`：最终 0.4.1 运行包默认 3 工具、全量 10 工具 Schema 通过，非法参数被拒绝。
- `NPX-RESULTS.json`：本地 0.4.1 tarball 可由 npx 执行；Claude/Codex 注册保持无 Key 配置，凭据由 Windows DPAPI 加载。
- `SECURITY-RESULTS.json`：交付目录执行当前 Vault 凭据的内存精确匹配检查，51 个文件，无明文 Key 命中。
- `BUILD-RESULTS.json`：源码构建、安装运行时、锁文件与 tarball 的 SHA256 一致。
- 0.4.0 归档保留；0.4.1 源码归档含构建产物、锁文件、测试、脚本与验收报告，`node_modules` 不进入归档。

## 相关文档

- [验证结论](../VALIDATION.md)
- [README](../README.md)
- [证据目录](../evidence/README.md)
- [变更记录](../CHANGELOG.md)
