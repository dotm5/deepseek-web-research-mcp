import { cpLength, cpSlice, SuiteError } from './common.js';

export function hostname(value: string) {
  if (/[\s@]/.test(value)) throw new SuiteError('INVALID_DOMAIN', 'Domains must be hostnames without credentials or spaces');
  const u = new URL(value.includes('://') ? value : `https://${value}`);
  if (u.port || u.pathname !== '/' || u.search || u.hash || !/^([a-z\d-]+\.)*[a-z\d-]+$/i.test(u.hostname)) throw new SuiteError('INVALID_DOMAIN', 'Use a hostname without a path or port');
  return u.hostname.toLowerCase().replace(/\.$/, '');
}
export function hostMatches(url: string, domain: string) {
  try { const host = new URL(url).hostname.toLowerCase().replace(/\.$/, ''); const wanted = hostname(domain); return host === wanted || host.endsWith('.' + wanted); } catch { return false; }
}
export interface SearchOptions {
  query: string; count?: number; max_results?: number; include_domains?: string[]; exclude_domains?: string[]; start_date?: string; end_date?: string;
  additional_queries?: string[]; include_text?: string[]; exclude_text?: string[]; max_characters?: number; need_content?: boolean; ori_question?: string; localization?: string; force_refresh?: boolean; request_budget?: number;
}
function splitText(value: string, limit: number) {
  const out: string[] = []; let current = '';
  for (const token of value.match(/(?:"[^"]*"|\S+)/gu) ?? []) {
    if (cpLength(token) > limit) { if (current) out.push(current); current = ''; let rest = token; while (cpLength(rest) > limit) { out.push(cpSlice(rest, limit)); rest = Array.from(rest).slice(limit).join(''); } current = rest; }
    else if (cpLength(current + (current ? ' ' : '') + token) <= limit) current += (current ? ' ' : '') + token;
    else { out.push(current); current = token; }
  }
  if (current) out.push(current); return out;
}
export function planQueries(options: SearchOptions, cap = 8) {
  const fixed = [...(options.exclude_domains ?? []).map(d => `-site:${hostname(d)}`), ...(options.start_date ? [`after:${options.start_date}`] : []), ...(options.end_date ? [`before:${options.end_date}`] : [])].join(' ');
  const sites = options.include_domains?.length ? options.include_domains.map(d => `site:${hostname(d)}`) : [''];
  const queries: string[] = [];
  for (const site of sites) {
    const suffix = [site, fixed].filter(Boolean).join(' '), room = 128 - cpLength(suffix) - (suffix ? 1 : 0);
    if (room < 1) throw new SuiteError('FILTERS_TOO_LONG', 'Domain/date filters exceed the 128 character provider limit; reduce filters');
    for (const query of [options.query, ...(options.additional_queries ?? [])]) for (const part of splitText(query, room)) queries.push([part, suffix].filter(Boolean).join(' '));
  }
  const unique = [...new Set(queries)]; return { queries: unique.slice(0, cap), omitted_queries: unique.slice(cap), split_semantics: unique.length > 1 ? 'Union of bounded subqueries; not an exact conjunction of all terms.' : undefined };
}
