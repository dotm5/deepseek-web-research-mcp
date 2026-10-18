# 变更记录

## 0.4.1 — 2026-10-18

- 独立公开包命名为 `deepseek-web-research-mcp`；MIT 许可，默认数据目录与安装包身份同步，MCP 注册名保留 `deepseek-search`。
- 增加 npm 内容白名单、依赖 shrinkwrap、无 source map 构建、隔离 npx 安装验收与 Git 对象密钥扫描。
- 修复全新 Codex TOML 注册，dry-run 反映实际路径；PATH 顺序支持 npm shim，系统凭据条目按数据目录隔离。

- 通过当前 Claude Code DeepSeek 模型真实调用 Map/Crawl、Code Context 与 Research，覆盖 HTTP/SOCKS5/direct-TUN、引用分页、运行中取消、零结果和私网拒绝。
- 修复 Research 失败原因为 null 与状态响应过大被 Claude 转存文件的问题；保留查询/评分引用链及运行/取消的请求计量。
- Code Context 在首次选段前优先考虑代码语言，返回 C 引用，正文共享预算并移除重复正文；补齐提供方 Markdown 对引号、斜杠、`@` 等字符的单层转义解码。
- 增加进程级代理/DNS/QPS 启动覆盖参数、每工具 DoH/公网 IP 固定请求计数及受控备用 DoH 引导地址。
- 真实多进程压力测试定位并修复 SQLite 锁等待前时间戳导致的令牌重复补充；跨 Key 共享限流，缓存保持隔离。
- 修复后 270 次真实调用全部成功，无 429/5xx/网络失败；首轮失败证据保留。默认仍为各 3 QPS。

## 0.4.0 — 2026-10-18

- 迁移为 Node 24 LTS / TypeScript 工程，tsup 单入口、原生 `node:sqlite`，Python 0.3.0 作为历史基线保留。
- 增加 DPAPI / Keychain / Secret Service / AES-GCM CredentialVault，隐藏输入与标准输入登录验证，以及日志脱敏。
- 增加 auth/setup/doctor/config CLI，支持无密钥 Harness 注册、配置备份与稳定用户目录运行包。
- 共享限流、SQLite 缓存/任务状态、长查询拆分、URL 合并、批量失败隔离与 BM25 结构化片段提取。
- 提供默认 3 工具及可选高级 Search、Map/Crawl、Code Context、Research 工具，兼容代理与 Clash Fake-IP 公网发现。
- 增加核心 Vitest 测试与低请求成本的真实 MCP 冒烟脚本。

## 相关文档

- [README](README.md)
- [验证结论](VALIDATION.md)
- [轮次记录](docs/ROUNDS.md)
- [证据目录](evidence/README.md)
