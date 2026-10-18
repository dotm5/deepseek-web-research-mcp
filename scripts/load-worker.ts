import { DeepSeekClient } from '../src/core/client.js';
import { CredentialVault } from '../src/core/vault.js';
import { CacheManager } from '../src/core/cache.js';
import { Network } from '../src/core/network.js';
import { loadConfig, configSchema } from '../src/core/config.js';
import { Metrics, dataDirectory, redact } from '../src/core/common.js';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const config = configSchema.parse({ ...await loadConfig(), searchQps: 5, fetchQps: 5, domainQps: 1, domainConcurrency: 1 });
const key = await new CredentialVault().get(), cache = new CacheManager(path.join(dataDirectory(), 'state.sqlite'), config.cacheEntries, config.cacheBytes), network = await Network.create(config), abort = new AbortController();
if (!key) throw new Error('Run auth login before live load tests');
const observed = { async request(url: string, options: any) {
  const started = performance.now(), kind = url.endsWith('/search') ? 'search' : 'fetch';
  const request_id = kind === 'search' ? options.body.ori_question.replace('MCP stability ', '') : new URL(options.body.url).hash.replace('#mcp-load-', '');
  const target = kind === 'fetch' ? options.body.url.split('#')[0] : undefined;
  process.send?.({ type: 'api-start', kind, request_id, target, time: Date.now() });
  try { const response = await network.request(url, options); process.send?.({ type: 'api-end', kind, request_id, target, time: Date.now(), status: response.status, latency_ms: performance.now() - started }); return response; }
  catch (error) { process.send?.({ type: 'api-end', kind, request_id, target, time: Date.now(), status: 0, latency_ms: performance.now() - started, error: redact(error) }); throw error; }
} };
const client = new DeepSeekClient(key, observed, cache, config);
process.on('message', async (message: any) => {
  if (message.type === 'stop') { abort.abort(); return; }
  if (message.type === 'close') { await network.close(); cache.close(); process.disconnect?.(); return; }
  const started = performance.now(), metrics = new Metrics(3, Date.now() + 60000, abort.signal);
  try { const result = await client.call(message.kind, message.body, metrics, true); process.send?.({ type: 'done', id: message.id, kind: message.kind, ok: true, nonempty: message.kind === 'search' ? result.results.length > 0 : !!result.content.trim(), latency_ms: performance.now() - started, meta: metrics.snapshot() }); }
  catch (error) { process.send?.({ type: 'done', id: message.id, kind: message.kind, ok: false, latency_ms: performance.now() - started, error: redact(error), meta: metrics.snapshot() }); }
});
process.send?.({ type: 'ready', proxy: network.proxy ?? 'direct', pid: process.pid });
