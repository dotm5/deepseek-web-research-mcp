import { it, expect, vi } from 'vitest';
import { CacheManager } from '../src/core/cache.js';
import { configSchema } from '../src/core/config.js';
import { DeepSeekClient } from '../src/core/client.js';
import { Network } from '../src/core/network.js';
import { WebSuite } from '../src/core/suite.js';
import { ResearchManager } from '../src/core/research.js';
import { Metrics } from '../src/core/common.js';

function fixture() {
  const cache = new CacheManager(':memory:'), config = configSchema.parse({ domainQps: 5, searchQps: 5, fetchQps: 5 });
  const network = new Network(config);
  vi.spyOn(network, 'addresses').mockResolvedValue(['1.1.1.1']);
  vi.spyOn(network, 'request').mockImplementation(async (_url, opts) => {
    const body = opts?.body as { query?: string; url?: string };
    return { status: 200, headers: {}, text: JSON.stringify(body.query ? { results: [{ title: 'Docs', url: 'https://example.org/docs/a', rerank_score: 1, authority: 3, snippet: 'API evidence' }] } : { title: 'API Docs', content: '# API\n\nVersion 1.2.3.\n\n```ts\nconst user_name = 1;\n```\n\n[Next](https://example.org/docs/b)\n\n[Blocked](https://example.org/private)' }) };
  });
  vi.spyOn(network, 'localGet').mockImplementation(async (url, metrics) => { metrics.take(true); return { url, status: 200, headers: {}, text: url.endsWith('robots.txt') ? 'User-agent: *\nDisallow: /private\nSitemap: https://example.org/sitemap.xml' : '<urlset><url><loc>https://example.org/docs/a</loc></url><url><loc>https://example.org/private</loc></url></urlset>' }; });
  return { cache, network, suite: new WebSuite(new DeepSeekClient('sk-unit-test-credential-123456789', network, cache, config)), async close() { await network.close(); cache.close(); } };
}
it('bounded BFS shares extraction cache and respects robots exclusions', async () => {
  const f = fixture(); try {
    const result = await f.suite.crawl({ url: 'https://example.org/docs/a', max_depth: 1, max_pages: 2, request_budget: 4 });
    expect(result.results.map(r => r.url)).toEqual(['https://example.org/docs/a', 'https://example.org/docs/b']);
    expect(result.discovered.some(r => r.url.includes('private'))).toBe(false); expect(result.meta.api_requests).toBe(2); expect(result.meta.cache_hits).toBe(1);
  } finally { await f.close(); }
});
it('research persists citation evidence and can be read from another manager', async () => {
  const f = fixture(), jobs = new ResearchManager(f.suite), observer = new ResearchManager(f.suite);
  try {
    const started = await jobs.start('API user_name', [], 3);
    for (let i = 0; i < 100 && observer.status(started.id).state === 'running'; i++) await new Promise(r => setTimeout(r, 10));
    const result = observer.status(started.id); expect(result.state).toBe('completed'); expect(result.result.evidence[0].citation_id).toBe('S1'); expect(result.result.evidence[0].url).toBe('https://example.org/docs/a'); expect(result.result.evidence[0].authority).toBe(3); expect(result.result.evidence[0].provider_score).toBe(1); expect(result.result.evidence[0].source_queries).toContain('API user_name'); expect(result.result.query_plan.queries).toContain('API user_name');
    const cancelled = await jobs.start('different query', [], 3); observer.cancel(cancelled.id); await jobs.close(); expect(jobs.status(cancelled.id).state).toBe('cancelled');
  } finally { await jobs.close(); await f.close(); }
});
it('code context keeps tagged code and version provenance', async () => {
  const f = fixture(); try { const result = await f.suite.codeContext({ query: 'API', language: 'ts', library: 'example', official_domains: ['example.org'], request_budget: 6 }); expect(result.results[0].content).toContain('```ts'); expect(result.results[0].versions).toContain('1.2.3'); expect(result.results[0].citation_id).toBe('C1'); expect(result.results[0].authority).toBe(3); expect(result.results[0].source_queries.length).toBeGreaterThan(0); expect(result.meta.api_requests).toBeLessThanOrEqual(6); } finally { await f.close(); }
});
it('research reports zero matches explicitly without invented citations', async () => {
  const f = fixture(), jobs = new ResearchManager(f.suite);
  vi.spyOn(f.suite, 'search').mockResolvedValue({ results: [], failed_results: [], query_plan: { queries: ['strict-query'], omitted_queries: [], split_semantics: undefined }, meta: new Metrics().snapshot() });
  try { const started = await jobs.start('strict-query'); for (let i = 0; i < 50 && jobs.status(started.id).state === 'running'; i++) await new Promise(r => setTimeout(r, 5)); const status = jobs.status(started.id); expect(status.state).toBe('failed'); expect(status.error).toMatchObject({ code: 'NO_SEARCH_RESULTS' }); expect(status.result.evidence).toEqual([]); }
  finally { await jobs.close(); await f.close(); }
});
it('research views bound bodies and retain stable citation IDs across pages', async () => {
  const f = fixture(), jobs = new ResearchManager(f.suite), id = '11111111-1111-4111-8111-111111111111';
  const evidence = Array.from({ length: 5 }, (_, i) => ({ citation_id: `S${i + 1}`, title: 'Docs', url: `https://example.org/${i}`, content: ('Evidence paragraph with useful API details.\n\n').repeat(100), chunks: [{ content: 'duplicated body'.repeat(500) }], summary: 'Long summary'.repeat(1000), snippet: 'short', source_queries: ['API'], authority: 3, provider_score: 1 }));
  f.cache.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run(id, 'completed', '{}', JSON.stringify({ evidence, search_results: evidence, meta: {} }), null, Date.now(), 'test');
  try { const compact = jobs.status(id); expect(JSON.stringify(compact).length).toBeLessThan(15000); expect(compact.result.evidence.reduce((n: number, r: any) => n + r.content.length, 0)).toBeLessThanOrEqual(6000); expect(compact.result.evidence[0].chunks).toBeUndefined(); const page = jobs.status(id, { offset: 1, limit: 1, max_characters: 20000 }); expect(page.result.evidence[0].citation_id).toBe('S2'); expect(page.result.pagination).toMatchObject({ total_sources: 5, offset: 1, has_more: true }); expect(page.result.evidence[0].view_truncated).toBe(false); }
  finally { await jobs.close(); await f.close(); }
});
it('Map refuses private seed addresses even with max_depth=0', async () => {
  const f = fixture(); vi.mocked(f.network.addresses).mockRestore();
  try { await expect(f.suite.map({ url: 'http://127.0.0.1/', max_depth: 0 })).rejects.toThrow('public'); expect(f.network.request).not.toHaveBeenCalled(); }
  finally { await f.close(); }
});
