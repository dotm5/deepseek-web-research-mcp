import { randomUUID } from 'node:crypto';
import { cpLength, cpSlice, Metrics, redact, SuiteError } from './common.js';
import type { WebSuite } from './suite.js';
import { provenance } from './normalizer.js';
import { selectChunks } from './content.js';

export interface ResearchView { offset?: number; limit?: number; max_characters?: number }

export class ResearchManager {
  private owner = randomUUID(); private running = new Map<string, { abort: AbortController; task: Promise<void>; metrics: Metrics }>();
  constructor(private suite: WebSuite) {}
  async start(query: string, additional: string[] = [], budget = 10) {
    const id = randomUUID(), abort = new AbortController(), db = this.suite.client.cache.db;
    db.prepare("DELETE FROM jobs WHERE id IN (SELECT id FROM jobs WHERE state IN ('completed','failed','cancelled') ORDER BY updated DESC LIMIT -1 OFFSET 63)").run();
    db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run(id, 'running', JSON.stringify({ query, additional_queries: additional, request_budget: budget }), null, null, Date.now(), this.owner);
    const metrics = new Metrics(budget, Date.now() + 90000, abort.signal);
    const task = this.execute(id, query, additional, budget, abort, metrics).finally(() => this.running.delete(id)); this.running.set(id, { abort, task, metrics });
    return { id, state: 'running', note: 'Keep this MCP process running. Results are evidence JSON; no external LLM is invoked.' };
  }
  private async execute(id: string, query: string, additional: string[], budget: number, abort: AbortController, metrics: Metrics) {
    const db = this.suite.client.cache.db; let phase = 'searching';
    const checkpoint = () => db.prepare("UPDATE jobs SET result=?,updated=? WHERE id=? AND owner=? AND state='running'").run(JSON.stringify({ phase, progress_final: false, meta: metrics.snapshot() }), Date.now(), id, this.owner);
    checkpoint();
    const heartbeat = setInterval(() => { const row = db.prepare('SELECT state FROM jobs WHERE id=?').get(id) as { state: string } | undefined; if (row?.state === 'cancelled') abort.abort(); else checkpoint(); }, 1000);
    try {
      const parts = additional.length ? additional : query.split(/[;；\n]/).map(v => v.trim()).filter(Boolean).slice(0, 3);
      const searched = await this.suite.search({ query, additional_queries: parts.filter(p => p !== query), max_results: 10 }, metrics);
      phase = 'extracting'; checkpoint();
      const selected = [...searched.results].sort((a, b) => Number(b.authority ?? 0) - Number(a.authority ?? 0) || (b.provider_score ?? 0) - (a.provider_score ?? 0)).slice(0, Math.min(5, Math.max(0, budget - metrics.api_requests)));
      const extracted = await this.suite.extract({ urls: selected.map(r => r.url), query, chunks_per_source: 6 }, metrics); metrics.check();
      const result = { query, subqueries: parts, query_plan: searched.query_plan, evidence: extracted.results.filter(r => r.content.trim()).map((r, i) => ({ ...r, ...provenance(r, selected.find(s => s.url === r.url)), citation_id: `S${i + 1}` })), search_results: searched.results, failed_results: [...searched.failed_results, ...extracted.failed_results], meta: metrics.snapshot() };
      const state = result.evidence.length ? 'completed' : 'failed';
      const error = state === 'completed' ? null : new SuiteError(searched.results.length ? 'NO_EVIDENCE' : searched.failed_results.length ? 'SEARCH_FAILED' : 'NO_SEARCH_RESULTS', searched.results.length ? 'No non-empty evidence could be extracted within the request budget; inspect failed_results.' : searched.failed_results.length ? 'All searches failed; inspect failed_results.' : 'DeepSeek returned zero matching search results. Rephrase the query or relax restrictive site/date terms.').toJSON();
      db.prepare("UPDATE jobs SET state=?,result=?,error=?,updated=? WHERE id=? AND state='running'").run(state, JSON.stringify(result), error ? JSON.stringify(error) : null, Date.now(), id);
    } catch (error) { db.prepare("UPDATE jobs SET state=?,error=?,updated=? WHERE id=? AND state='running'").run(abort.signal.aborted ? 'cancelled' : 'failed', JSON.stringify(error instanceof SuiteError ? error.toJSON() : { code: 'RESEARCH_FAILED', message: redact(error) }), Date.now(), id); }
    finally { clearInterval(heartbeat); db.prepare("UPDATE jobs SET result=?,updated=? WHERE id=? AND state='cancelled'").run(JSON.stringify({ phase: 'cancelled', progress_final: true, meta: metrics.snapshot() }), Date.now(), id); }
  }
  status(id: string, view: ResearchView = {}) {
    const db = this.suite.client.cache.db;
    db.prepare("UPDATE jobs SET state='failed',error='Worker stopped or lost heartbeat',updated=? WHERE state='running' AND updated<?").run(Date.now(), Date.now() - 120000);
    const row = db.prepare('SELECT id,state,payload,result,error,updated FROM jobs WHERE id=?').get(id) as { id: string; state: string; payload: string; result: string | null; error: string | null; updated: number } | undefined;
    if (!row) throw new SuiteError('JOB_NOT_FOUND', 'Research job not found');
    let error: unknown = row.error; if (row.error) { try { error = JSON.parse(row.error); } catch { error = { code: 'RESEARCH_FAILED', message: row.error }; } }
    const result = row.result ? JSON.parse(row.result) : null;
    if (result && Array.isArray(result.evidence)) {
      const all = result.evidence ?? [], offset = view.offset ?? 0, limit = view.limit ?? 5, selected = all.slice(offset, offset + limit);
      const perSource = Math.floor((view.max_characters ?? 6000) / Math.max(1, selected.length));
      result.evidence = selected.map((record: any) => {
        const { content, chunks: _chunks, summary: _summary, ...metadata } = record;
        const excerpt = cpLength(content) <= perSource ? content : selectChunks(content, undefined, 10000, perSource).map(c => c.content).join('\n\n');
        return { ...metadata, snippet: cpSlice(record.snippet ?? '', 240), content: excerpt, view_truncated: excerpt !== content,
          evidence_length: cpLength(content), returned_characters: cpLength(excerpt) };
      });
      result.search_results = (result.search_results ?? []).map((r: any) => ({ title: cpSlice(r.title, 256), url: r.url, provider_score: r.provider_score, authority: r.authority, published_at: r.published_at }));
      result.pagination = { total_sources: all.length, offset, limit, returned_sources: selected.length, has_more: offset + selected.length < all.length };
    }
    return { ...row, error, payload: JSON.parse(row.payload), result };
  }
  cancel(id: string) { this.status(id); this.suite.client.cache.db.prepare("UPDATE jobs SET state='cancelled',updated=? WHERE id=? AND state='running'").run(Date.now(), id); const worker = this.running.get(id); if (worker) { worker.abort.abort(); this.suite.client.cache.db.prepare("UPDATE jobs SET result=? WHERE id=? AND state='cancelled'").run(JSON.stringify({ phase: 'cancel_requested', progress_final: false, meta: worker.metrics.snapshot() }), id); } return this.status(id); }
  async close() { for (const job of this.running.values()) job.abort.abort(); await Promise.all([...this.running.values()].map(j => j.task)); }
}
