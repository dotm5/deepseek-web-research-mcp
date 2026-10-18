import { XMLParser } from 'fast-xml-parser';
import { createRequire } from 'node:module';
import { DeepSeekClient } from './client.js';
import { Metrics, cpLength, httpUrl, redact, SuiteError } from './common.js';
import { canonicalURL, mergeResults, normalize, provenance } from './normalizer.js';
import { hostMatches, planQueries, type SearchOptions } from './planner.js';
import { blocks, markdown, plainText, selectChunks } from './content.js';
import { Network } from './network.js';
const robotsParser = createRequire(import.meta.url)('robots-parser') as (url: string, content: string) => { isAllowed(url: string, agent: string): boolean | undefined };

export async function parallel<T, R>(values: T[], concurrency: number, fn: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => { while (next < values.length) { const i = next++; results[i] = await fn(values[i], i); } })); return results;
}
function failure(url: string, error: unknown) { return { url, error: error instanceof SuiteError ? error.toJSON() : { code: 'REQUEST_FAILED', message: redact(error) } }; }
export interface ExtractOptions { urls: string[]; format?: 'markdown' | 'text'; query?: string; max_characters?: number; chunks_per_source?: number; force_refresh?: boolean; request_budget?: number; code_language?: string }
export interface MapOptions { url: string; max_depth?: number; limit?: number; select_paths?: string[]; allow_external?: boolean; request_budget?: number; max_duration_seconds?: number }
export class WebSuite {
  constructor(public client: DeepSeekClient) {}
  async search(options: SearchOptions, metrics = new Metrics(options.request_budget ?? 10)) {
    const plan = planQueries(options, Math.min(8, metrics.budget)), rows: ReturnType<typeof normalize>[] = [], failed_results: ReturnType<typeof failure>[] = [];
    const wanted = options.max_results ?? options.count ?? 10;
    const accepts = (row: ReturnType<typeof normalize>) => {
      if (options.include_domains?.length && !options.include_domains.some(d => hostMatches(row.url, d))) return false;
      if (options.exclude_domains?.some(d => hostMatches(row.url, d))) return false;
      const text = `${row.title}\n${row.snippet}\n${row.content}`.toLowerCase();
      return (options.include_text ?? []).every(t => text.includes(t.toLowerCase())) && !(options.exclude_text ?? []).some(t => text.includes(t.toLowerCase()));
    };
    await parallel(plan.queries, this.client.config.concurrency, async query => {
      const body: Record<string, unknown> = { query, count: Math.min(50, wanted), need_content: options.need_content ?? false };
      if (options.ori_question) body.ori_question = options.ori_question; if (options.localization !== undefined) body.localization = options.localization;
      try {
        let reply = await this.client.call('search', body, metrics, options.force_refresh);
        const unpack = (data: Record<string, any>) => (Array.isArray(data.results) ? data.results : []).map((r: Record<string, any>) => normalize({ ...r, fetched_at: data.fetched_at }, options.max_characters ?? 12000, query)).filter(accepts);
        let found = unpack(reply);
        if ((options.include_text?.length || options.exclude_text?.length) && found.length < wanted && Number(body.count) < 50 && metrics.api_requests < metrics.budget) { reply = await this.client.call('search', { ...body, count: 50 }, metrics, options.force_refresh); found = unpack(reply); }
        rows.push(...found);
      } catch (error) { failed_results.push(failure(query, error)); }
    });
    const results = mergeResults(rows).slice(0, wanted);
    return { results, failed_results, query_plan: plan, meta: metrics.snapshot() };
  }
  async fetch(url: string, max = 12000, refresh = false, metrics = new Metrics()) {
    httpUrl(url); const raw = await this.client.call('fetch', { url }, metrics, refresh);
    return { ...normalize({ ...raw, url }, max), meta: metrics.snapshot() };
  }
  async extract(options: ExtractOptions, metrics = new Metrics(options.request_budget ?? Math.min(20, options.urls.length + 2))) {
    const outcomes = await parallel([...new Set(options.urls)], this.client.config.concurrency, async url => {
      try {
        const row = await this.fetch(url, 2_000_000, options.force_refresh, metrics), max = options.max_characters ?? 12000;
        const chunks = selectChunks(row.content, options.query, options.chunks_per_source ?? (options.query ? 5 : 10000), max, options.code_language);
        const content = chunks.map(c => c.content).join('\n\n');
        const formatted = options.format === 'text' ? plainText(content) : content;
        const { meta: _meta, ...record } = row;
        const pieces = blocks(markdown(row.content));
        return { ok: true as const, row: { ...record, content: formatted, truncated: row.truncated || chunks.length < pieces.length || chunks.some(c => c.content !== pieces[c.index]), original_length: row.original_length, chunks } };
      } catch (error) { return { ok: false as const, failure: failure(url, error) }; }
    });
    return { results: outcomes.filter(r => r.ok).map(r => r.row), failed_results: outcomes.filter(r => !r.ok).map(r => r.failure), meta: metrics.snapshot() };
  }
  private links(content: string, base: string) {
    const values = [...content.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)|href\s*=\s*["']([^"']+)["']/gi)].map(m => m[1] ?? m[2]);
    return values.flatMap(value => { try { const url = httpUrl(new URL(value.replace(/&amp;/g, '&'), base).href); return [canonicalURL(url.href)]; } catch { return []; } });
  }
  async map(options: MapOptions, metrics = new Metrics(options.request_budget ?? 8, Date.now() + (options.max_duration_seconds ?? 60) * 1000)) {
    const root = httpUrl(options.url), origin = root.origin, max = options.limit ?? 50, depth = options.max_depth ?? 2;
    const network = this.client.network instanceof Network ? this.client.network : undefined;
    // Validate the seed before reporting it as a discovered public URL, including max_depth=0.
    if (network) await network.addresses(root.hostname.replace(/^\[|\]$/g, ''), AbortSignal.any([AbortSignal.timeout(Math.max(1, metrics.deadline - Date.now())), ...(metrics.signal ? [metrics.signal] : [])]), metrics);
    const failed_results: ReturnType<typeof failure>[] = [], queue: { url: string; depth: number }[] = [{ url: canonicalURL(root.href), depth: 0 }], queued = new Set([canonicalURL(root.href)]), results: { url: string; depth: number; source: string }[] = [];
    let robots: ReturnType<typeof robotsParser> | undefined;
    const permitted = (url: string) => { const u = new URL(url); return (options.allow_external || u.origin === origin) && (robots?.isAllowed(url, 'DeepSeekResearchBot') !== false); };
    const paths = (url: string) => !(options.select_paths?.length) || options.select_paths.some(p => new URL(url).pathname.includes(p));
    const enqueue = (url: string, level: number) => { if (queued.size >= Math.max(100, max * 10) || queued.has(url) || !permitted(url) || level > depth) return; queued.add(url); queue.push({ url, depth: level }); };
    if (network) {
      const sitemaps = [new URL('/sitemap.xml', origin).href];
      try { const reply = await network.localGet(new URL('/robots.txt', origin).href, metrics); if (reply.status === 200 && !/^\s*</.test(reply.text)) { robots = robotsParser(new URL('/robots.txt', origin).href, reply.text); for (const match of reply.text.matchAll(/^Sitemap:\s*(\S+)/gim)) sitemaps.unshift(new URL(match[1], origin).href); } } catch (e) { failed_results.push(failure(origin + '/robots.txt', e)); }
      const visited = new Set<string>();
      while (sitemaps.length && visited.size < 4) {
        const url = sitemaps.shift()!; if (visited.has(url)) continue; visited.add(url);
        try {
          const reply = await network.localGet(url, metrics); if (reply.status !== 200 || !/<(?:urlset|sitemapindex)\b/.test(reply.text)) continue;
          const parsed = new XMLParser({ ignoreAttributes: true, processEntities: false }).parse(reply.text);
          const array = (v: any) => v === undefined ? [] : Array.isArray(v) ? v : [v];
          for (const item of array(parsed.sitemapindex?.sitemap)) if (typeof item.loc === 'string' && new URL(item.loc).origin === origin) sitemaps.push(item.loc);
          for (const item of array(parsed.urlset?.url)) if (typeof item.loc === 'string') { try { const u = httpUrl(item.loc); const level = Math.max(1, u.pathname.split('/').filter(Boolean).length - root.pathname.split('/').filter(Boolean).length); enqueue(canonicalURL(u.href), level); } catch {} }
        } catch (e) { failed_results.push(failure(url, e)); }
      }
    }
    for (let i = 0; i < queue.length && results.length < max; i++) {
      try { metrics.check(); } catch (e) { failed_results.push(failure(queue[i].url, e)); break; }
      const item = queue[i]; if (!permitted(item.url)) continue;
      if (paths(item.url)) results.push({ ...item, source: i === 0 ? 'seed' : 'discovery' });
      if (item.depth >= depth || results.length >= max) continue;
      try {
        const page = await this.fetch(item.url, 200000, false, metrics); let links = this.links(markdown(page.content), item.url);
        if (!links.length && network && this.client.config.localHtml) { const local = await network.localGet(item.url, metrics); if (local.status === 200) links = this.links(local.text, local.url); }
        for (const link of links) enqueue(link, item.depth + 1);
      } catch (e) { failed_results.push(failure(item.url, e)); if (e instanceof SuiteError && /BUDGET|DEADLINE/.test(e.code)) break; }
    }
    return { results, failed_results, meta: { ...metrics.snapshot(), queued_urls: queued.size, robots_checked: !!robots,
      network: network ? { proxy: redact(network.proxy ?? 'direct'), dns: network.config.dns, doh_queries: metrics.doh_queries, pinned_requests: metrics.pinned_requests, public_ip_pinning: true } : undefined } };
  }
  async crawl(options: MapOptions & { max_pages?: number }, metrics = new Metrics(options.request_budget ?? 12, Date.now() + (options.max_duration_seconds ?? 60) * 1000)) {
    const map = await this.map({ ...options, limit: options.max_pages ?? 10 }, metrics);
    const extracted = await this.extract({ urls: map.results.map(r => r.url) }, metrics);
    return { ...extracted, failed_results: [...map.failed_results, ...extracted.failed_results], discovered: map.results, meta: { ...metrics.snapshot(), network: map.meta.network } };
  }
  async codeContext(options: { query: string; language?: string; repo?: string; library?: string; official_domains?: string[]; max_results?: number; request_budget?: number; max_characters?: number }) {
    const metrics = new Metrics(options.request_budget ?? 10);
    const repo = options.repo?.replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
    if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new SuiteError('INVALID_REPO', 'repo must be owner/name or its GitHub URL');
    const query = [options.query, options.library, options.language].filter(Boolean).join(' ');
    const searched = await this.search({ query: repo ? `${query} ${repo}` : query, include_domains: repo ? ['github.com'] : undefined, additional_queries: repo ? [] : [`${query} site:github.com`, ...((options.official_domains ?? []).map(d => `${query} site:${d}`)), ...(!options.official_domains?.length ? [`${query} official documentation`] : [])], max_results: options.max_results ?? 5, need_content: true }, metrics);
    const sources = searched.results.filter(r => !repo || new URL(r.url).pathname === '/' + repo || new URL(r.url).pathname.startsWith('/' + repo + '/'));
    const urls = sources.slice(0, 3).map(r => r.url), bodyBudget = options.max_characters ?? 12000;
    const extracted = await this.extract({ urls, query, max_characters: Math.floor(bodyBudget / Math.max(1, urls.length)), chunks_per_source: 8, code_language: options.language }, metrics);
    const results = extracted.results.map((row, i) => ({ ...row, ...provenance(row, sources.find(s => s.url === row.url)), summary: undefined, chunks: row.chunks.map(({ index, score }) => ({ index, score })), citation_id: `C${i + 1}`,
      versions: [...new Set(row.content.match(/\bv?\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?\b/g) ?? [])].slice(0, 20) }));
    const search_results = sources.map(({ content: _content, summary: _summary, ...source }) => source);
    return { results, search_results, failed_results: [...searched.failed_results, ...extracted.failed_results], meta: { ...metrics.snapshot(), body_character_budget: bodyBudget } };
  }
}
