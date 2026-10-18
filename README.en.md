# DeepSeek Web Research MCP 0.4.1

[中文](README.md) | English

A local stdio MCP server backed by the native DeepSeek Search/Fetch API. It provides search, content extraction, bounded site discovery and asynchronous evidence research. The implementation uses Node.js 24 LTS and TypeScript, with dependencies pinned by `npm-shrinkwrap.json`. The package is distributed independently and does not require Python.

The service stores the API key in the system credential store: DPAPI on Windows, Keychain on macOS, Secret Service on Linux with a session bus, and an AES-256-GCM file on headless hosts. Agent configuration holds the launch command; the vault supplies the key at runtime.

## Install and run

Node.js 24 LTS or a newer supported LTS release is required. Validation used 24.22.0 and also covered 24.13.1.

```sh
npm ci
npm run build
node dist/cli.js auth login
node dist/cli.js setup --dry-run
node dist/cli.js setup
node dist/cli.js doctor
```

The npm registry release is pending; the delivered tarball works locally:

```sh
npx --yes --package ./deepseek-web-research-mcp-0.4.1.tgz deepseek-web-research-mcp auth login
npx --yes --package ./deepseek-web-research-mcp-0.4.1.tgz deepseek-web-research-mcp setup
```

After publication the entry is `npx deepseek-web-research-mcp auth login`. With no subcommand the server starts stdio MCP. Enter the API key through hidden input or `auth login --stdin`; login runs one Search request before saving. `auth status` shows the backend and a mask, and `auth logout` erases the credential.

Credential and configuration files live in `%LOCALAPPDATA%/deepseek-web-research-mcp` on Windows and `$XDG_CONFIG_HOME/deepseek-web-research-mcp` (default `~/.config/deepseek-web-research-mcp`) elsewhere. Read-back binds to the current OS user; sign in again after migrating a user or machine. The AES file backend uses mode 0600 and a key derived from machine and user identity; system Keychain and DPAPI provide stronger platform isolation.

The vault protects Agent configuration, environment variables and shell history from plaintext storage. Runtime authentication reads the key from the vault; the `DEEPSEEK_API_KEY` environment variable stays outside the auth path. Logs, errors and child-process environments pass through credential redaction.


`DEEPSEEK_MCP_HOME` selects an independent data directory and contains a path. Keychain and Secret Service entries are namespaced by that directory. Code running as the same OS user can access the credential.

## Agent registration

`setup` registers detected Claude Code and Codex installations: it backs up existing configuration, then calls `claude mcp add --scope user` or `codex mcp add` and replaces only the `deepseek-search` entry. When the Codex management command is unavailable it patches TOML; `--scope project` is supported. Cursor, Windsurf and Gemini receive keyless configuration through `--agent cursor,windsurf,gemini` or `--agent all`. `--dry-run` lists configuration targets and the backup directory.

setup installs the production package under the user data directory `runtime/` and registers a stable entry that survives npx cache cleanup. Run setup again after upgrading. Backups live in `backups/` beside the runtime and follow credential-file handling rules.

Manual registration:

```sh
claude mcp add --scope user deepseek-search -- node "<install-dir>/dist/cli.js"
codex mcp add deepseek-search -- node "<install-dir>/dist/cli.js"
```

Claude Code / Cursor / Windsurf / Gemini JSON sample:

```json
{"mcpServers":{"deepseek-search":{"command":"node","args":["<install-dir>/dist/cli.js"]}}}
```

Codex `config.toml`:

```toml
[mcp_servers.deepseek-search]
command = "node"
args = ["<install-dir>/dist/cli.js"]
```

Replace `<install-dir>` with the installation directory. Configuration stores the launch command and arguments; the vault supplies the credential. Restart existing Agent sessions after registration. `doctor` reports credential state, one live API check and each Harness registration; `doctor --offline` skips the API call; API validation failure returns exit code 1.

## Tools and parameters

The first three tools are registered by default. `--tools=all` enables every tool for one process, `config set tools all` persists the selection, and a comma-separated list adds individual tools.

| Tool | Registration | Main parameters |
| --- | --- | --- |
| `deepseek_search` | default | `query` 1–128 Unicode characters; `count` 1–50; `ori_question`; `localization` IP or empty; `need_content`; `max_characters` 100–100000; `force_refresh`; `request_budget` 1–30; domain/date/text filters |
| `deepseek_fetch` | default | `url`; `max_characters` 100–100000; `force_refresh`; `request_budget` 1–30 |
| `deepseek_extract` | default | `urls` 1–20; `format` markdown/text; nullable `query`; `max_characters`; `chunks_per_source` 1–50; `force_refresh`; `request_budget` |
| `deepseek_search_advanced` | opt-in | `query` 1–4096; `max_results` 1–50; include/exclude_domains 10 each; `start_date`, `end_date`; additional_queries 8; include/exclude_text 10 each; `max_characters`; `need_content`; `force_refresh`; `request_budget` |
| `deepseek_map` | opt-in | `url`; `max_depth` 0–5; `limit` 1–100; `select_paths` 10; `allow_external`; `request_budget`; `max_duration_seconds` 1–120 |
| `deepseek_crawl` | opt-in | `url`; `max_depth`; `max_pages` 1–30; `max_duration_seconds`; `select_paths`; `allow_external`; `request_budget` |
| `deepseek_code_context` | opt-in | `query` 1–2048; `language`; `repo` owner/name; `library`; `official_domains` 10; `max_results` 1–10; `max_characters` 500–20000; `request_budget` |
| `deepseek_research_start` | opt-in | `query` 1–4096; `additional_queries` 5; `request_budget` 1–30 |
| `deepseek_research_status` | opt-in | `id` UUID; `offset` 0–100; `limit` 1–5; `max_characters` 500–20000 |
| `deepseek_research_cancel` | opt-in | `id` UUID |

The default body budget is 12000 characters. `max_characters` is shared across sources in Code Context and Research. `request_budget` counts physical API attempts, including retries.

```sh
node dist/cli.js --tools=all --proxy=socks5://127.0.0.1:7897 --search-qps=5 --fetch-qps=5
node dist/cli.js --dns=doh --local-html
```

The backend is the native DeepSeek Search/Fetch API; Map, Crawl, Code Context and Research are orchestrated inside the process. Research requires the MCP process to stay alive. Code Context version strings come from document text, and caller-supplied `official_domains` plus source URLs express official identity.

Code Context returns `C1…` citations; Research returns `S1…` citations and retains `source_queries`, `provider_score`, `authority` and source URLs. authority is the provider score. Research returns compact evidence by default; use `offset=0, limit=1, max_characters=20000` to inspect one source body, with `view_truncated` and `pagination` marking response trimming and source paging. Full evidence stays in SQLite. Zero matches return `NO_SEARCH_RESULTS`; a 404 source lands in `failed_results` while other evidence remains. A running job that is cancelled retains its actual API attempt count.

### Search behavior

Native syntax goes directly into the query: `site:github.com`, `-site:example.com`, `lang:en`, `after:2025-01-01`, `before:2026-10-18`, quoted phrases and OR. Examples:

```text
site:github.com modelcontextprotocol stdio after:2025-01-01
site:nodejs.org sqlite lang:en
```

`need_content=true` adds body text to Search. Domain matching uses the parsed hostname: an exact host or subdomain passes, while string look-alikes fall outside the match set. Dates compile to provider operators, and inclusive boundaries follow DeepSeek semantics.

A long query with filters that exceeds 128 characters splits into segments, merges by canonical URL and caps at 8 subqueries; `query_plan` reports executed subqueries, `omitted_queries` and merge semantics. Subqueries form a bounded union. Oversized filters return `FILTERS_TOO_LONG`. When text filtering leaves a gap, count expands to 50 once within budget.

Result fields are `title`, `url`, `snippet`, `content`, `provider_score`, `authority`, `published_at`, `fetched_at`, `truncated` and `original_length`, with `rerank_score` and `date` compatibility fields. `meta` reports elapsed time, API attempts, cache/coalesced hits, failures and local requests. Batch operations separate `results` from `failed_results`; zero results with failures sets MCP `isError=true`. Web content is untrusted evidence, and the client handles it as data.

### Extraction and output

Extract schedules URLs concurrently, records a failed URL in `failed_results` and continues with other sources. Standard extraction splits headings, paragraphs, code fences and tables; a query ranks blocks with BM25 lexical scoring, using Han bigrams for Chinese. Complete code blocks and tables keep their structure; structural blocks beyond the budget are skipped, and paragraphs may be shortened. `chunks_per_source` caps selected chunks, and selected chunks carry their source `index` and lexical score.

Some provider pages escape Markdown structural markers. When at least two escaped structural markers are present, one `\x21-\x7e` punctuation layer is decoded, restoring quotes, slashes and `@`; content with fewer than two structural markers returns unchanged. Fetch returns provider Markdown, source metadata and truncation state.

`meta` and result fields follow the search record. `content` is the selected or trimmed body; `original_length` records the source length. `url` is the canonical request address; the client verifies target status and the final redirect separately. `published_at`, `authority` and `provider_score` are provider metadata.

### Site discovery and research jobs

Map reads robots.txt and sitemap.xml first, parses at most 4 sitemap documents, then follows DeepSeek Markdown links by depth. `select_paths` is a path-substring selector. `config set localHtml true` enables the local HTML fallback when links are absent. Each local request is limited to ports 80/443 and a 2 MiB response; private, loopback, link-local, 198.18/15 Fake-IP and disallowed-port targets return `SSRF_BLOCKED`. A robots.txt read failure lands in `failed_results`; valid rules constrain the root site.

Crawl runs the shared Extract pipeline over URLs discovered by Map, bounded by `max_pages`, `max_duration_seconds` and `request_budget`, and returns partial results with failures.

A Research job decomposes the query, searches, ranks sources by authority/score, extracts lexically and assigns `citation_id` values, returning structured evidence. State and full evidence persist in SQLite; the 64 most recent terminal jobs are retained. Process shutdown cancels running jobs. A running job that loses its heartbeat becomes failed after 120 seconds. Cancel works across processes, and the heartbeat runs every second; a completed job stays completed and cancel returns completed. Running or cancelled jobs retain their actual API attempt count.

## Proxy and Fake-IP

`config set proxy auto` is the default: it reads `HTTPS_PROXY`/`ALL_PROXY`/`HTTP_PROXY`, Windows system proxy settings, and actually listening ports from Clash/Mihomo configuration. Explicit values accept `http://127.0.0.1:7897`, `socks5://127.0.0.1:7897`, `socks5h://...` and `direct`.

Local discovery resolves public addresses through fixed Cloudflare DoH: the primary bootstrap `1.1.1.1` falls back to `1.0.0.1` on connection failure, with a 5-second attempt bound inside the tool deadline. Every A/AAAA answer passes public-address validation; the connection pins the public IP and preserves the original Host, TLS SNI and certificate verification. Each redirect revalidates its target.

`config set dns doh` selects DoH explicitly, and `system` uses system DNS while rejecting Fake-IP answers. A private address in the answer returns `SSRF_BLOCKED`. `meta.network` on Map/Crawl reports the proxy, DoH query count, pinned public-IP request count and `public_ip_pinning`; parallel tools keep separate counters.

Launch options override configuration for one process: `--tools`, `--proxy`, `--dns`, `--local-html`, `--search-qps`, `--fetch-qps`, `--domain-qps`, `--domain-concurrency`. QPS values cap at 5.

## Cache and rate limits

Configuration lives in `config.json` under the data directory and changes through `config set <key> <value>`. Launch options take precedence.

| Setting | Default / meaning |
| --- | --- |
| `tools` | empty = three defaults; a list or all |
| `proxy` / `dns` | auto / auto; proxy auto/direct/URL, DNS auto/system/doh |
| `localHtml` | false; enables the local HTML link fallback |
| `searchQps` / `fetchQps` | 3 / 3, maximum 5 |
| `domainQps` / `domainConcurrency` | 1 / 1, maximum 5 |
| `concurrency` | 8, maximum 32 |
| `searchTtl` / `fetchTtl` | 300 / 3600 seconds; 0 disables new cache writes |
| `cacheEntries` / `cacheBytes` | 256 / 67108864; LRU logical capacity |
| `retries` | 2, maximum 5; bounded 429/5xx retries with Retry-After |
| `timeout` | 30-second HTTP I/O timeout; default tool deadline 120 seconds, Map/Crawl 60 seconds, Research 90 seconds |

Search and Fetch use independent token buckets; per-host Fetch adds a 1 QPS bucket and a 1-concurrency lease. Processes on one SQLite database share the account bucket and domain leases, while cache entries stay credential-isolated; separate databases and machines meter independently. `force_refresh` bypasses cache, and concurrent identical refreshes coalesce.

`request_budget` includes retries. Ordinary 4xx responses return directly; 429/5xx retry with Retry-After or exponential backoff and return `RETRY_DEADLINE` when the wait exceeds the tool deadline. A network interruption returns `NETWORK_ERROR` with the upstream completion state unknown, and the client treats the request as incomplete. When the cache fills, LRU eviction removes records; cache and research evidence live in local SQLite.

## Billing

The official guide (2026-10-18) lists Server-side Search/Fetch calls from Harness, Claude Code and Codex as free of charge until 2026-11-01 00:00 Beijing time, with per-call billing starting then; the standalone API reference rate is CNY 5 per 1000 successful requests. The client name identifies the call source; the account bill is the authority for how a self-hosted MCP REST request is metered. The reports in this repository count real requests and results.

## Development checks

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run smoke
npm run smoke -- --live
```

The smoke run verifies the real stdio handshake, 3/10 tools, JSON Schema and invalid-argument rejection with zero API requests. `--live` adds one Search and two Fetch calls, capped at five attempts including retries.

Claude Code advanced-tool acceptance:

```sh
node scripts/claude-advanced-smoke.mjs --mode=auto --entry=<install-dir>/dist/cli.js
```

`--mode` accepts auto, socks and direct; SOCKS defaults to port 7897. The script uses the current Claude Code model, writes raw transcripts to `work/` and filtered JSON reports to `evidence/`.

Bounded load test:

```sh
node scripts/load.mjs
node scripts/load.mjs --phases=ceiling-5qps,three-process-contention
```

The load test calls the live API, bypasses cache and Singleflight, and uses unique request keys; defaults are 330 business calls, at most 3 attempts per call, a 60-second call deadline and 12 rotating public domains. Production defaults remain 3 QPS per endpoint.

## Related documents

- [Validation results](VALIDATION.md)
- [Round records](docs/ROUNDS.md)
- [Repository settings](docs/REPOSITORY.md)
- [Evidence index](evidence/README.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [License](LICENSE)
- [Release procedure](RELEASING.md)

## Operational constraints and follow-up measurements

- The vault supplies the API key; Agent configuration stores the launch command only.
- Proxy and DNS settings come from deployment configuration; tool parameters scope queries and extraction.
- Deleting the data directory removes cache, rate-limit state and research results; stop the MCP process first.
- Follow-up measurements: system-level acceptance for macOS Keychain, Linux Secret Service/AES permissions and Cursor/Windsurf/Gemini registration; full external workflows for Map/Crawl/Research/Code Context.

## Reproduction commands

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
