import { build } from 'esbuild';
import { fork } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import assert from 'node:assert/strict';

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/load.mjs [--phases=name,name] [--work=PATH] [--output=PATH]');
  process.exit(0);
}

const work = path.resolve(process.argv.find(v => v.startsWith('--work='))?.slice(7) ?? 'work'), bundle = path.join(work, 'deepseek-load-worker.mjs'); await mkdir(work, { recursive: true });
await build({ entryPoints: ['scripts/load-worker.ts'], outfile: bundle, bundle: true, platform: 'node', target: 'node24', format: 'esm', plugins: [{ name: 'external-dependencies', setup(builder) { builder.onResolve({ filter: /^[^./]/ }, args => ({ path: args.path.startsWith('node:') || builtinModules.includes(args.path) ? args.path : import.meta.resolve(args.path), external: true })); } }] });
const runId = Date.now().toString(36), events = [], results = [], workers = [], pending = new Map(); let stopped = false, activePhase = '', seq = 0;
const urls = [
  'https://api-docs.deepseek.com/zh-cn/api/fetch/', 'https://modelcontextprotocol.io/', 'https://nodejs.org/api/sqlite.html',
  'https://github.com/modelcontextprotocol/typescript-sdk', 'https://www.typescriptlang.org/docs/handbook/intro.html',
  'https://zod.dev/', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript', 'https://docs.python.org/3/library/asyncio.html',
  'https://docs.rs/tokio/latest/tokio/', 'https://tokio.rs/tokio/tutorial', 'https://example.com/', 'https://www.rust-lang.org/learn'
];
function stop(reason) { if (stopped) return; stopped = true; events.push({ type: 'stopped', reason, time: Date.now(), phase: activePhase }); for (const worker of workers) worker.send({ type: 'stop' }); }
for (let i = 0; i < 3; i++) {
  const env = { ...process.env }; delete env.DEEPSEEK_API_KEY;
  const child = fork(bundle, [], { execArgv: [], env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); workers.push(child);
  child.stderr.on('data', () => {});
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Worker initialization timed out')), 15000);
    child.on('error', reject); child.on('exit', code => { if (pending.size) stop('Worker exited unexpectedly'); });
    child.on('message', message => {
      if (message.type === 'ready') { clearTimeout(timeout); events.push({ ...message, worker: i }); resolve(); return; }
      if (message.type === 'done') { const task = pending.get(message.id); if (task) { pending.delete(message.id); results.push({ ...message, phase: task.phase, worker: i }); task.resolve(); } return; }
      events.push({ ...message, worker: i, phase: activePhase });
      if (message.type === 'api-end' && [401, 402].includes(message.status)) stop(`HTTP ${message.status}`);
      const recent = events.filter(e => e.type === 'api-end').slice(-12); if (recent.length === 12 && recent.filter(e => e.status === 429 || e.status >= 500 || !e.status).length >= 8) stop('Excessive throttling or transport errors');
    });
  });
}
function call(kind, index, phase, workerIndex = index % workers.length) {
  if (stopped) return Promise.resolve(); const id = `${runId}-${seq++}`;
  const body = kind === 'search' ? { query: 'Model Context Protocol TypeScript SDK', count: 1, ori_question: `MCP stability ${id}`, need_content: index % 5 === 0 } : { url: `${urls[index % urls.length]}#mcp-load-${id}` };
  return new Promise(resolve => { pending.set(id, { resolve, phase }); workers[workerIndex].send({ type: 'call', id, kind, body }); });
}
const only = process.argv.find(v => v.startsWith('--phases='))?.slice(9).split(',');
const phases = [ { name: 'baseline-3qps', rate: 3, seconds: 10, workers: 1 }, { name: 'ceiling-5qps', rate: 5, seconds: 12, workers: 1 }, { name: 'three-process-contention', rate: 15, seconds: 5, workers: 3 } ].filter(p => !only || only.includes(p.name));
const phaseTimes = [];
try {
  for (const phase of phases) {
    activePhase = phase.name; const started = Date.now(), begin = performance.now(), tasks = []; console.log(`Running ${phase.name}: offered ${phase.rate} QPS per endpoint, ${phase.seconds}s, ${phase.workers} process(es)`);
    for (let i = 0; i < phase.rate * phase.seconds && !stopped; i++) {
      const delay = begin + i * 1000 / phase.rate - performance.now(); if (delay > 0) await sleep(delay);
      tasks.push(call('search', i, phase.name, i % phase.workers), call('fetch', i, phase.name, i % phase.workers));
    }
    await Promise.race([Promise.all(tasks), sleep(90000, undefined, { ref: false }).then(() => { throw new Error('Phase drain timed out'); })]);
    phaseTimes.push({ ...phase, started, ended: Date.now(), offered_calls: tasks.length }); if (stopped) break;
  }
} finally { for (const worker of workers) worker.send({ type: 'close' }); }
function percentile(values, p) { const sorted = [...values].sort((a,b) => a-b); return sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]) : null; }
const summary = phaseTimes.map(phase => ({ ...phase, endpoints: ['search', 'fetch'].map(kind => {
  const attempts = events.filter(e => e.phase === phase.name && e.kind === kind && e.type === 'api-start').sort((a,b) => a.time-b.time), replies = events.filter(e => e.phase === phase.name && e.kind === kind && e.type === 'api-end'), calls = results.filter(r => r.phase === phase.name && r.kind === kind);
  const statuses = {}; for (const r of replies) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  const gaps = attempts.slice(1).map((r,i) => r.time-attempts[i].time);
  const windowCount = Math.max(0, ...attempts.map(a => attempts.filter(b => b.time >= a.time && b.time < a.time + 1000).length));
  return { kind, business_calls: calls.length, successes: calls.filter(c => c.ok).length, empty: calls.filter(c => c.ok && !c.nonempty).length, failed: calls.filter(c => !c.ok).map(c => c.error), api_attempts: attempts.length, statuses, retries: calls.reduce((n,c) => n + Math.max(0,c.meta.api_requests-1),0), cache_hits: calls.reduce((n,c) => n+c.meta.cache_hits,0), coalesced_hits: calls.reduce((n,c) => n+c.meta.coalesced_hits,0), dispatch_qps: attempts.length > 1 ? Math.round((attempts.length-1)/(attempts.at(-1).time-attempts[0].time)*1000*100)/100 : 0, max_rolling_second_starts: windowCount, min_dispatch_gap_ms: gaps.length ? Math.min(...gaps) : null, api_latency_ms: { p50: percentile(replies.map(r=>r.latency_ms),.5), p95: percentile(replies.map(r=>r.latency_ms),.95) }, end_to_end_latency_ms: { p50: percentile(calls.map(c=>c.latency_ms),.5), p95: percentile(calls.map(c=>c.latency_ms),.95) } };
}) }));
const report = { timestamp: new Date().toISOString(), run_id: runId, scope: 'Real core client/API load with SQLite account limit shared across three processes; MCP/Claude acceptance is recorded separately.', config: { searchQps: 5, fetchQps: 5, domainQps: 1, domainConcurrency: 1, retries: 2, request_budget_per_call: 3, cache_bypassed: true, singleflight_keys_unique: true, fetch_url_fragment_ids: true }, stopped, summary, results, events };
const reportPath = process.argv.find(v => v.startsWith('--output='))?.slice(9) ?? 'evidence/LOAD-RESULTS.json';
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2)+'\n'); console.log(JSON.stringify({ stopped, summary },null,2));
assert.equal(stopped,false,'Stopped by guard; inspect report'); assert.ok(results.every(r=>r.meta.cache_hits===0 && r.meta.coalesced_hits===0));
