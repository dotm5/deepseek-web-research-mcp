import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { seal, unseal, CredentialVault } from '../src/core/vault.js';
import { redact, Metrics, rememberSecret, cpLength } from '../src/core/common.js';
import { planQueries, hostMatches } from '../src/core/planner.js';
import { canonicalURL } from '../src/core/normalizer.js';
import { CacheManager } from '../src/core/cache.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { DeepSeekClient } from '../src/core/client.js';
import { configSchema } from '../src/core/config.js';
import { WebSuite } from '../src/core/suite.js';
import { toolDefinitions, selectedTools } from '../src/tools/index.js';
import { ResearchManager } from '../src/core/research.js';
import { markdown, plainText, selectChunks } from '../src/core/content.js';
import { Network, publicIP } from '../src/core/network.js';
import { patchToml } from '../src/core/harness.js';
import { createServer } from 'node:http';

const fakeKey = 'sk-unit-test-credential-123456789';
const config = configSchema.parse({ searchQps: 5, fetchQps: 5, domainQps: 5 });
describe('credential isolation', () => {
  it('authenticated encryption rejects tampering and another machine identity', () => { const encrypted = seal(fakeKey, 'machine-user'); expect(encrypted).not.toContain(fakeKey); expect(unseal(encrypted, 'machine-user')).toBe(fakeKey); expect(() => unseal(encrypted, 'other-user')).toThrow(); const data = JSON.parse(encrypted); data.tag = Buffer.alloc(16).toString('base64'); expect(() => unseal(JSON.stringify(data), 'machine-user')).toThrow(); });
  it('persists the chosen fallback backend, masks and removes the secret', async () => { const dir = await mkdtemp(path.join(tmpdir(), 'dsmcp-')); try { const vault = new CredentialVault(dir, 'encrypted-file'); await vault.set(fakeKey); expect(await new CredentialVault(dir).get()).toBe(fakeKey); expect(await readFile(path.join(dir, 'credentials.enc'), 'utf8')).not.toContain(fakeKey); if (process.platform !== 'win32') expect((await stat(path.join(dir, 'credentials.enc'))).mode & 0o777).toBe(0o600); expect((await vault.status()).mask).not.toContain(fakeKey); await vault.logout(); expect(await vault.get()).toBeUndefined(); } finally { await rm(dir, { recursive: true, force: true }); } });
  it('redacts known credentials, generic keys and proxy passwords', () => { rememberSecret('custom-secret-value'); expect(redact('custom-secret-value ' + fakeKey + ' http://alice:pass@localhost')).toBe('[REDACTED] [REDACTED] http://[REDACTED]@localhost'); });
  it.skipIf(process.platform !== 'win32')('round-trips current-user DPAPI despite inherited PowerShell 7 module paths', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dsmcp-dpapi-'));
    try { const vault = new CredentialVault(dir); await vault.set(fakeKey); expect((await vault.status()).backend).toBe('windows-dpapi'); expect(await vault.get()).toBe(fakeKey); expect(await readFile(path.join(dir, 'credentials.dpapi'), 'utf8')).not.toContain(fakeKey); await vault.logout(); expect(await vault.get()).toBeUndefined(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
});
describe('query planning and normalization', () => {
  it('splits long Unicode queries with native operators and reports budget omissions', () => { const plan = planQueries({ query: '中文'.repeat(100), include_domains: ['github.com', 'nodejs.org'], start_date: '2025-01-01', end_date: '2026-10-18' }, 3); expect(plan.queries.length).toBe(3); expect(plan.omitted_queries.length).toBeGreaterThan(0); for (const q of [...plan.queries, ...plan.omitted_queries]) { expect(cpLength(q)).toBeLessThanOrEqual(128); expect(q).toContain('after:2025-01-01'); } });
  it('enforces hostname boundaries and canonical URLs', () => { expect(hostMatches('https://docs.example.com/a', 'example.com')).toBe(true); expect(hostMatches('https://evil-example.com', 'example.com')).toBe(false); expect(hostMatches('https://example.com.evil.org', 'example.com')).toBe(false); expect(hostMatches('https://evil.org/example.com', 'example.com')).toBe(false); expect(canonicalURL('https://EXAMPLE.com:443/a?utm_source=x&b=2&a=1#x')).toBe('https://example.com/a?a=1&b=2'); });
});
describe('SQLite cache and account limits', () => {
  it('shares account limits across keys while keeping cached responses isolated', async () => {
    const cache = new CacheManager(':memory:'), starts: number[] = [];
    const transport = { request: vi.fn(async () => { starts.push(Date.now()); return { status: 200, headers: {}, text: '{"results":[]}' }; }) };
    try { const a = new DeepSeekClient('sk-first-test-key-123456', transport, cache, config), b = new DeepSeekClient('sk-other-test-key-123456', transport, cache, config); await Promise.all([a.call('search', { query: 'a' }, new Metrics()), b.call('search', { query: 'a' }, new Metrics())]); expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(185); const metrics = new Metrics(); await a.call('search', { query: 'a' }, metrics); expect(metrics.cache_hits).toBe(1); expect(transport.request).toHaveBeenCalledTimes(2); }
    finally { cache.close(); }
  });
  it('never moves bucket timestamps backwards or refunds time spent waiting for a write lock', async () => {
    const cache = new CacheManager(':memory:');
    try { const start = Date.now(), future = start + 100; cache.db.prepare('INSERT INTO buckets VALUES(?,?,?)').run('account:search', 0, future); const limiter = new RateLimiter(cache, 'account'), task = limiter.acquire('search', 5, new Metrics()); const row = cache.db.prepare('SELECT updated FROM buckets WHERE key=?').get('account:search') as { updated: number }; expect(row.updated).toBeGreaterThanOrEqual(future); await task; expect(Date.now() - start).toBeGreaterThanOrEqual(285); }
    finally { cache.close(); }
  });
  it('shares persistent cache and coalesces concurrent calls; refresh bypasses hits', async () => { const cache = new CacheManager(':memory:', 1); const metrics = new Metrics(), fn = vi.fn(async () => { await new Promise(r => setTimeout(r, 5)); return { ok: true }; }); try { await Promise.all([cache.load('a', 30, false, metrics, fn), cache.load('a', 30, false, metrics, fn)]); await cache.load('a', 30, false, metrics, fn); expect(fn).toHaveBeenCalledTimes(1); expect(metrics.cache_hits).toBe(1); expect(metrics.coalesced_hits).toBe(1); await cache.load('a', 30, true, metrics, fn); expect(fn).toHaveBeenCalledTimes(2); cache.put('b', 2, 30); expect(cache.get('a')).toBeUndefined(); } finally { cache.close(); } });
  it('enforces an independent token bucket shared across limiter instances', async () => { const cache = new CacheManager(':memory:'); try { const a = new RateLimiter(cache, 'account'), b = new RateLimiter(cache, 'account'), metrics = new Metrics(); const begin = Date.now(); await a.acquire('search', 5, metrics); await b.acquire('fetch', 5, metrics); await b.acquire('search', 5, metrics); expect(Date.now() - begin).toBeGreaterThanOrEqual(185); } finally { cache.close(); } });
  it('retries 429 then succeeds, while 401 is not retried', async () => { const cache = new CacheManager(':memory:'); const request = vi.fn().mockResolvedValueOnce({ status: 429, headers: { 'retry-after': '0' }, text: '' }).mockResolvedValueOnce({ status: 200, headers: {}, text: '{"results":[]}' }).mockResolvedValueOnce({ status: 401, headers: {}, text: fakeKey }); const client = new DeepSeekClient(fakeKey, { request }, cache, config); try { const metrics = new Metrics(3); await client.call('search', { query: 'a' }, metrics); expect(metrics.api_requests).toBe(2); await expect(client.call('search', { query: 'b' }, metrics)).rejects.toThrow('HTTP 401'); expect(request).toHaveBeenCalledTimes(3); } finally { cache.close(); } });
});
describe('extraction and schemas', () => {
  it('decodes one provider escape layer including quotes, slash and at-sign while preserving real code escapes', () => {
    const source = ['# SDK', '', '## Example', '', '```typescript', "import { McpServer } from '@modelcontextprotocol/server';", "const windows_path = 'C:\\\\tools';", '```'].join('\n');
    const escaped = source.replace(/([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])/g, '\\$1');
    expect(markdown(escaped)).toBe(source); expect(markdown(source)).toBe(source);
  });
  it('isolates a failed URL and preserves a relevant complete code block', async () => { const cache = new CacheManager(':memory:'); const request = vi.fn(async (_url, opts) => opts.body.url.includes('bad') ? { status: 404, headers: {}, text: '' } : { status: 200, headers: {}, text: JSON.stringify({ title: 'Example', content: '# Setup\n\nNoise paragraph.\n\n## Node\n\n```ts\nconst user_name = 1;\n```\n\n| key | value |\n| --- | --- |\n| node | 24 |' }) }); const suite = new WebSuite(new DeepSeekClient(fakeKey, { request }, cache, config)); try { const result = await suite.extract({ urls: ['https://good.example/a', 'https://bad.example/a'], query: 'const user_name', chunks_per_source: 1 }); expect(result.results).toHaveLength(1); expect(result.failed_results).toHaveLength(1); expect(result.results[0].content).toContain('```ts\nconst user_name = 1;\n```'); } finally { cache.close(); } });
  it('selects structural blocks without breaking code or removing underscores', () => { const value = '# API\n\n```ts\nconst user_name = a_b;\n```\n\nOther information.'; expect(plainText(value)).toContain('user_name = a_b'); expect(selectChunks(value, 'user_name', 1, 100)[0].content).toContain('```ts'); expect(markdown('\\# Title\n\n\\`\\`\\`ts\nx\n\\`\\`\\`')).toContain('```ts'); });
  it('publishes legal object schemas with Unicode bounds and exactly 3 defaults / 10 all', () => { const cache = new CacheManager(':memory:'); const suite = new WebSuite(new DeepSeekClient(undefined, { request: vi.fn() }, cache, config)), jobs = new ResearchManager(suite); try { const definitions = toolDefinitions(suite, jobs); expect(selectedTools(definitions, '')).toHaveLength(3); expect(selectedTools(definitions, 'all')).toHaveLength(10); for (const tool of definitions) { const schema = z.toJSONSchema(tool.schema); expect(schema.type).toBe('object'); expect(schema.additionalProperties).toBe(false); } const tool = definitions[0]; expect(z.toJSONSchema(tool.schema).properties?.query).toMatchObject({ maxLength: 128 }); expect(tool.schema.safeParse({ query: '😀'.repeat(128) }).success).toBe(true); expect(tool.schema.safeParse({ query: '😀'.repeat(129) }).success).toBe(false); expect(tool.schema.safeParse({ query: 'a', count: 51 }).success).toBe(false); } finally { cache.close(); } });
});
describe('safe discovery and configuration', () => {
  it('registers Codex in a fresh TOML config without an existing MCP table', () => {
    expect(patchToml('', '/opt/mcp/cli.js')).toContain('[mcp_servers.deepseek-search]');
    expect(patchToml('model = "preserved"\n', '/opt/mcp/cli.js')).toContain('model = "preserved"');
    const first = patchToml('model = "preserved"\n', '/opt/mcp/cli.js');
    expect(patchToml(first, '/opt/mcp/cli.js')).toBe(first);
  });
  it('fails over a transient DoH bootstrap failure without disabling public-IP checks', async () => {
    const network = new Network({ ...config, dns: 'doh' });
    const request = vi.spyOn(network, 'request').mockImplementation(async url => { if (url.startsWith('https://1.1.1.1/')) throw new Error('connect timeout'); return { status: 200, headers: {}, text: '{"Status":0,"Answer":[{"type":1,"data":"43.169.32.32"}]}' }; });
    try { expect(await network.addresses('example.org')).toEqual(['43.169.32.32']); expect(request.mock.calls.some(c => c[0].startsWith('https://1.0.0.1/'))).toBe(true); request.mockImplementation(async () => ({ status: 200, headers: {}, text: '{"Status":0,"Answer":[{"type":1,"data":"127.0.0.1"}]}' })); await expect(network.addresses('other.example.org')).rejects.toThrow('public'); }
    finally { await network.close(); }
  });
  it('preserves original Host when connecting to a numeric address', async () => {
    const server = createServer((req, res) => { res.end(req.headers.host); }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port, network = new Network(config);
    try { const result = await network.request(`http://127.0.0.1:${port}/`, { servername: 'example.com', headers: { Host: 'example.com' } }); expect(result.text).toBe('example.com'); }
    finally { await network.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('rejects private, loopback, mapped-private and mixed DNS answers', async () => { for (const ip of ['127.0.0.1', '10.0.0.1', '::1', '::ffff:127.0.0.1', '198.18.0.1', '169.254.169.254']) expect(publicIP(ip)).toBe(false); expect(publicIP('1.1.1.1')).toBe(true); const network = new Network({ ...config, dns: 'doh' }); vi.spyOn(network, 'request').mockResolvedValue({ status: 200, headers: {}, text: JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }, { type: 1, data: '127.0.0.1' }] }) }); await expect(network.addresses('example.org')).rejects.toThrow('exclusively'); await network.close(); });
  it('patches only its own TOML registration without leaking a key', () => { const before = 'model = "x"\n[mcp_servers.other]\ncommand="other"\n[mcp_servers.deepseek-search]\ncommand="python"\n[mcp_servers.deepseek-search.env]\nDEEPSEEK_API_KEY="old"\n'; const next = patchToml(before, 'C:\\app\\cli.js'); expect(next).toContain('command="other"'); expect(next).not.toContain('DEEPSEEK_API_KEY'); expect(next).toContain('command = "node"'); });
});
