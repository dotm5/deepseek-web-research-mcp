import { cpLength, cpSlice } from './common.js';

export function canonicalURL(value: string) {
  try { const u = new URL(value); u.hash = ''; for (const key of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|msclkid$)/i.test(key)) u.searchParams.delete(key); u.searchParams.sort(); return u.href; } catch { return value; }
}
export function normalize(raw: Record<string, any>, max = 12000, query?: string) {
  const text = typeof raw.content === 'string' ? raw.content : '';
  const score = typeof raw.rerank_score === 'number' ? raw.rerank_score : null;
  return { title: String(raw.title ?? ''), url: canonicalURL(String(raw.url ?? '')), snippet: String(raw.snippet ?? raw.summary ?? ''), summary: String(raw.summary ?? ''),
    content: cpSlice(text, max), provider_score: score, rerank_score: score, authority: raw.authority ?? null,
    published_at: raw.published_at ?? raw.date ?? null, date: raw.date ?? null, fetched_at: raw.fetched_at ?? new Date().toISOString(), truncated: cpLength(text) > max,
    original_length: cpLength(text), source_queries: query ? [query] : [] };
}
export type RecordResult = ReturnType<typeof normalize>;
/** Retain search provenance when the body comes from the separate Fetch endpoint. */
export function provenance(record: RecordResult, source?: RecordResult) {
  return source ? { ...record, provider_score: source.provider_score, rerank_score: source.rerank_score, authority: source.authority,
    published_at: source.published_at, date: source.date, source_queries: source.source_queries, snippet: source.snippet, summary: source.summary } : record;
}
export function mergeResults(records: RecordResult[]) {
  const map = new Map<string, RecordResult>();
  for (const row of records) {
    const old = map.get(row.url); if (!old) { map.set(row.url, row); continue; }
    const sources = [...new Set([...old.source_queries, ...row.source_queries])];
    const winner = (row.provider_score ?? -Infinity) > (old.provider_score ?? -Infinity) ? row : old;
    map.set(row.url, { ...winner, content: row.content.length > old.content.length ? row.content : old.content, source_queries: sources });
  }
  return [...map.values()].sort((a, b) => (b.provider_score ?? 0) - (a.provider_score ?? 0) || Number(b.authority ?? 0) - Number(a.authority ?? 0));
}
