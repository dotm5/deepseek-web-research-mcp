# DeepSeek Web Research MCP 0.4.1

中文 | [English](README.en.md)

DeepSeek 原生 Search/Fetch API 的本地 stdio MCP Server，提供搜索、正文提取、有界站点发现与异步证据研究。实现使用 Node.js 24 LTS 与 TypeScript，依赖由 `npm-shrinkwrap.json` 固定。项目独立分发，不依赖 Python。

服务使用系统凭据库保存 API Key：Windows 为 DPAPI，macOS 为 Keychain，Linux 有会话总线时为 Secret Service，无桌面后端时为 AES-256-GCM 文件。Agent 配置只保存启动命令，凭据由 Vault 在运行时读取。

## 安装与运行

要求 Node.js 24 LTS 或更新的受支持 LTS。本次验证使用 24.22.0，同时兼容 24.13.1。

```sh
npm ci
npm run build
node dist/cli.js auth login
node dist/cli.js setup --dry-run
node dist/cli.js setup
node dist/cli.js doctor
```

npm registry 尚未发布；交付的 tarball 可本地使用：

```sh
npx --yes --package ./deepseek-web-research-mcp-0.4.1.tgz deepseek-web-research-mcp auth login
npx --yes --package ./deepseek-web-research-mcp-0.4.1.tgz deepseek-web-research-mcp setup
```

发布后的入口为 `npx deepseek-web-research-mcp auth login`。无子命令时启动 stdio MCP。API Key 通过隐藏回显或 `auth login --stdin` 输入；保存前执行一次 Search 请求验证。`auth status` 显示后端与掩码，`auth logout` 擦除凭据。

凭据文件与配置位于 Windows `%LOCALAPPDATA%/deepseek-web-research-mcp`，其他平台 `$XDG_CONFIG_HOME/deepseek-web-research-mcp`（默认 `~/.config/deepseek-web-research-mcp`）。回读绑定当前 OS 用户；迁移用户或备份机器后重新登录。AES 文件后端使用 0600 权限与机器/用户信息派生密钥；系统 Keychain/DPAPI 提供更强的平台隔离。

Vault 的防护目标是 Agent 配置、环境变量与 Shell 历史中的明文。运行时从 Vault 取 Key；`DEEPSEEK_API_KEY` 环境变量不参与鉴权。日志、错误与子进程环境执行凭据脱敏。


可使用 `DEEPSEEK_MCP_HOME` 指定独立数据目录，变量值为路径。Keychain 与 Secret Service 条目按数据目录隔离。系统凭据库与 AES 文件均以当前用户权限工作；同用户任意代码具备读取凭据的能力。

## Agent 注册

`setup` 默认注册检测到的 Claude Code 与 Codex：先备份原配置，再调用 `claude mcp add --scope user` 或 `codex mcp add`，只替换 `deepseek-search` 条目。Codex 管理命令不可用时补写 TOML；支持 `--scope project`。Cursor、Windsurf、Gemini 通过 `--agent cursor,windsurf,gemini` 或 `--agent all` 注入无密钥配置。`--dry-run` 列出配置目标与备份目录。

setup 把生产包安装到用户数据目录的 `runtime/`，并注册稳定入口，npx 缓存清理后入口保持有效。更新版本后再次运行 setup。备份位于同目录 `backups/`，按凭据文件管理。

手动注册示例：

```sh
claude mcp add --scope user deepseek-search -- node "<install-dir>/dist/cli.js"
codex mcp add deepseek-search -- node "<install-dir>/dist/cli.js"
```

Claude Code / Cursor / Windsurf / Gemini JSON 示例：

```json
{"mcpServers":{"deepseek-search":{"command":"node","args":["<install-dir>/dist/cli.js"]}}}
```

Codex `config.toml`：

```toml
[mcp_servers.deepseek-search]
command = "node"
args = ["<install-dir>/dist/cli.js"]
```

把 `<install-dir>` 替换为安装目录。配置中只保存启动命令与参数，凭据由 Vault 提供。注册后重启已有 Agent 会话以加载新工具。`doctor` 输出凭据状态、一次真实 API 连通性与各 Harness 注册状态；`doctor --offline` 跳过 API 调用；真实 API 校验失败时退出码为 1。

## 工具与参数

默认注册前三个工具。`--tools=all` 临时启用全部，`config set tools all` 持久启用，也可用逗号分隔指定额外工具。

| 工具 | 注册 | 主要参数 |
| --- | --- | --- |
| `deepseek_search` | 默认 | `query` 1–128 Unicode 字符；`count` 1–50；`ori_question`；`localization` IP 或空串；`need_content`；`max_characters` 100–100000；`force_refresh`；`request_budget` 1–30；域名/日期/文本过滤器 |
| `deepseek_fetch` | 默认 | `url`；`max_characters` 100–100000；`force_refresh`；`request_budget` 1–30 |
| `deepseek_extract` | 默认 | `urls` 1–20；`format` markdown/text；可空 `query`；`max_characters`；`chunks_per_source` 1–50；`force_refresh`；`request_budget` |
| `deepseek_search_advanced` | 可选 | `query` 1–4096；`max_results` 1–50；include/exclude_domains 各 10 项；`start_date`、`end_date`；additional_queries 8 项；include/exclude_text 各 10 项；`max_characters`；`need_content`；`force_refresh`；`request_budget` |
| `deepseek_map` | 可选 | `url`；`max_depth` 0–5；`limit` 1–100；`select_paths` 10 项；`allow_external`；`request_budget`；`max_duration_seconds` 1–120 |
| `deepseek_crawl` | 可选 | `url`；`max_depth`；`max_pages` 1–30；`max_duration_seconds`；`select_paths`；`allow_external`；`request_budget` |
| `deepseek_code_context` | 可选 | `query` 1–2048；`language`；`repo` owner/name；`library`；`official_domains` 10 项；`max_results` 1–10；`max_characters` 500–20000；`request_budget` |
| `deepseek_research_start` | 可选 | `query` 1–4096；`additional_queries` 5 项；`request_budget` 1–30 |
| `deepseek_research_status` | 可选 | `id` UUID；`offset` 0–100；`limit` 1–5；`max_characters` 500–20000 |
| `deepseek_research_cancel` | 可选 | `id` UUID |

默认正文预算为 12000 字符。`max_characters` 在 Code Context 与 Research 中为多个来源共享的正文预算。`request_budget` 统计物理 API 尝试，包含重试。

```sh
node dist/cli.js --tools=all --proxy=socks5://127.0.0.1:7897 --search-qps=5 --fetch-qps=5
node dist/cli.js --dns=doh --local-html
```

后端为 DeepSeek 原生 Search/Fetch；Map、Crawl、Code Context 与 Research 在本进程内完成编排。Research 需要 MCP 进程保持运行。Code Context 的版本号来自正文提及值，官方身份由调用方提供的 `official_domains` 与来源 URL 共同表达。

Code Context 返回 `C1…` 引用；Research 返回 `S1…` 引用，并保留 `source_queries`、`provider_score`、`authority` 与来源 URL。authority 是提供方评分。Research 默认返回精简证据；使用 `offset=0, limit=1, max_characters=20000` 查看单来源正文，`view_truncated` 与 `pagination` 标示响应裁剪和来源分页。完整证据保留在 SQLite。零匹配返回 `NO_SEARCH_RESULTS`；部分来源 404 放入 `failed_results`，其余证据继续保留。运行中取消的任务保留实际 API 尝试数。

### 搜索行为

原生语法直接写入 query：`site:github.com`、`-site:example.com`、`lang:en`、`after:2025-01-01`、`before:2026-10-18`、引号短语与 OR。示例：

```text
site:github.com modelcontextprotocol stdio after:2025-01-01
site:nodejs.org sqlite lang:en
```

`need_content=true` 让 Search 附带正文。域名匹配以解析后的 Hostname 为准：精确主机与子域通过，字符串假冒域名落在匹配集合之外。日期编译为提供方操作符，包含边界遵循 DeepSeek 语义。

长查询连同过滤器超过 128 字符时按段拆分，按规范 URL 合并，最多 8 个子查询；`query_plan` 返回执行的子查询、`omitted_queries` 与合并语义。子查询是有界并集。过滤器本身过长时返回 `FILTERS_TOO_LONG`。文本过滤不足时在预算内把 count 扩到 50 一次。

结果字段为 `title`、`url`、`snippet`、`content`、`provider_score`、`authority`、`published_at`、`fetched_at`、`truncated`、`original_length`，并保留 `rerank_score`、`date` 兼容字段。`meta` 含耗时、API 尝试数、缓存/合并命中数、失败次数与本地请求数。批量操作以 `results` 与 `failed_results` 区分成功和失败；零结果且存在失败时 MCP 返回 `isError=true`。网页内容按不可信证据处理，客户端按数据处理。

### 提取与输出

Extract 并发调度 URL，单 URL 失败写入 `failed_results`，其他来源继续。普通提取按标题、段落、代码围栏与表格分块；传入 query 时使用 BM25 词法排序，中文采用双字词。完整代码块与表格按结构保留；超出预算的结构块跳过，段落可截短。`chunks_per_source` 限制相关块数量，选中的块带原文 `index` 与词法分数。

部分提供方页面转义 Markdown 结构标记。检测到至少两处转义结构标记时，解码一层 `\x21-\x7e` 标点转义，引号、斜杠与 `@` 一并恢复；结构标记不足两处时正文按原文返回。Fetch 返回提供方 Markdown、来源信息与截断元数据。

`meta` 与结果字段沿用搜索记录。`content` 是选块或裁剪后的正文；`original_length` 记录原始长度。`url` 为规范请求地址，目标状态与最终跳转由客户端另行核验。`published_at`、`authority`、`provider_score` 为提供方元数据。

### 站点发现与研究作业

Map 优先读取 robots.txt 与 sitemap.xml，最多解析 4 份 sitemap，再按深度读取 DeepSeek Markdown 链接。`select_paths` 为路径子串选择器。`config set localHtml true` 在链接缺失时启用本地 HTML 回退。每条本地请求限制在 80/443 端口与 2 MiB 响应；私网、回环、链路本地、198.18/15 Fake-IP 与非允许端口返回 `SSRF_BLOCKED`。robots.txt 读取失败写入 `failed_results`；有效规则约束根站点。

Crawl 在 Map 的基础上对发现的 URL 执行共享 Extract 管线，受 `max_pages`、`max_duration_seconds` 与 `request_budget` 约束，返回部分结果与失败记录。

Research 作业执行查询拆解、搜索、按 authority/score 选源、词法提取与 `citation_id` 编号，输出结构化证据。作业状态与完整证据存入 SQLite；终态保留最近 64 个任务。进程退出时运行中任务取消。失去心跳的 running 任务在 120 秒后标记 failed。cancel 支持跨进程，运行中任务的心跳间隔为 1 秒；已完成任务保持 completed，取消操作返回 completed。运行或取消的任务保留实际 API 尝试数。

## 代理与 Fake-IP

`config set proxy auto` 为默认值：读取 `HTTPS_PROXY`/`ALL_PROXY`/`HTTP_PROXY`、Windows 系统代理，以及 Clash/Mihomo 配置中实际监听的端口。显式值支持 `http://127.0.0.1:7897`、`socks5://127.0.0.1:7897`、`socks5h://...` 与 `direct`。

本地发现通过固定 Cloudflare DoH 获取公网地址：主引导 `1.1.1.1` 连接失败时切换到 `1.0.0.1`，每次尝试 5 秒并受工具总时限约束。所有 A/AAAA 回答通过公网校验后，连接固定到公网 IP，保留原始 Host、TLS SNI 与证书验证。每次重定向重新校验目标。

`config set dns doh` 显式使用 DoH，`system` 使用系统 DNS 并拒绝 Fake-IP 结果。解析结果包含私网地址时返回 `SSRF_BLOCKED`。Map/Crawl 的 `meta.network` 返回代理、DoH 查询数、公网 IP 固定请求数与 `public_ip_pinning`；并行工具各自计数。

启动参数可覆盖配置而不改全局文件：`--tools`、`--proxy`、`--dns`、`--local-html`、`--search-qps`、`--fetch-qps`、`--domain-qps`、`--domain-concurrency`。QPS 上限为 5。

## 缓存与限流

配置保存在数据目录的 `config.json`，由 `config set <key> <value>` 修改。启动参数优先于配置文件。

| 配置项 | 默认值 / 含义 |
| --- | --- |
| `tools` | 空值 = 默认三工具；列表或 all |
| `proxy` / `dns` | auto / auto；代理 auto/direct/URL，DNS auto/system/doh |
| `localHtml` | false；启用本地 HTML 链接回退 |
| `searchQps` / `fetchQps` | 3 / 3，上限 5 |
| `domainQps` / `domainConcurrency` | 1 / 1，上限 5 |
| `concurrency` | 8，上限 32 |
| `searchTtl` / `fetchTtl` | 300 / 3600 秒；0 关闭新缓存写入 |
| `cacheEntries` / `cacheBytes` | 256 / 67108864；LRU 逻辑容量 |
| `retries` | 2，上限 5；429/5xx 有界重试，遵守 Retry-After |
| `timeout` | 30 秒 HTTP I/O 超时；单工具默认总时限 120 秒，Map/Crawl 默认 60 秒，Research 默认 90 秒 |

Search 与 Fetch 使用独立 Token Bucket；同域 Fetch 另有 1 QPS 与 1 并发租约。同一 SQLite 数据库的进程共享账户桶与域名租约，缓存按凭据隔离；不同数据库或机器无法协调同一官方账户的限额。`force_refresh` 绕过缓存，同时刷新的相同请求合并。

`request_budget` 包含重试。普通 4xx 直接返回；429/5xx 按 Retry-After 或指数退避重试，等待超出剩余时限时返回 `RETRY_DEADLINE`。网络中断返回 `NETWORK_ERROR`，上游完成状态未知，客户端按未完成处理。缓存满时按 LRU 淘汰；缓存与研究证据位于本机 SQLite。

## 计费说明

官方指南（2026-10-18）列出：Harness、Claude Code、Codex 经 Server 端工具调用访问 Search/Fetch 当前免费，北京时间 2026-11-01 00:00 起按次计费；独立接口参考费率为每千次成功请求 5 元。客户端名称属于调用来源标识；自建 MCP 的 REST 请求采用何种账单口径，以账户账单为准。本轮报告统计真实请求数与结果。

## 开发验证

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run smoke
npm run smoke -- --live
```

smoke 默认验证真实 stdio 握手、3/10 工具、JSON Schema 与非法参数拒绝，API 请求数为 0。`--live` 追加 1 次 Search 与 2 次 Fetch，含重试最多 5 次尝试。

Claude Code 高级工具验收：

```sh
node scripts/claude-advanced-smoke.mjs --mode=auto --entry=<install-dir>/dist/cli.js
```

`--mode` 支持 auto、socks、direct；SOCKS 默认端口 7897。脚本使用当前 Claude Code 模型，原始转录写入 `work/`，过滤后的 JSON 报告写入 `evidence/`。

有界压力测试：

```sh
node scripts/load.mjs
node scripts/load.mjs --phases=ceiling-5qps,three-process-contention
```

压力测试请求真实 API，绕过缓存与 Singleflight，使用唯一请求键；默认 330 次业务调用、每次最多 3 次尝试、单调用 60 秒时限，轮换 12 个公共域名。默认生产配置为各 3 QPS。

## 相关文档

- [验证结论](VALIDATION.md)
- [轮次记录](docs/ROUNDS.md)
- [仓库设置](docs/REPOSITORY.md)
- [证据目录](evidence/README.md)
- [变更记录](CHANGELOG.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [许可证](LICENSE)
- [发布步骤](RELEASING.md)

## 运行约束与后续测量

- API Key 由 Vault 提供；Agent 配置只保存启动命令。
- 代理与 DNS 设置来自部署配置；工具参数只影响查询与提取范围。
- 删除数据目录会同时删除缓存、限流状态与研究结果；操作前停止 MCP 进程。
- 后续测量：macOS Keychain、Linux Secret Service/AES 权限与 Cursor/Windsurf/Gemini 注册的系统实机验收；Map/Crawl/Research/Code Context 的完整外网流程。

## 复现命令

```sh
npm ci
npm run typecheck
npm test
npm run build
node tools/check-links.mjs
node tools/check-docs.mjs
npm run smoke
LIVE_NETWORK=1 npx vitest run test/network.live.test.ts
```
