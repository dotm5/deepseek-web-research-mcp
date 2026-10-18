import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { CacheManager } from './cache.js';
import { RateLimiter } from './rateLimiter.js';
import type { Config } from './config.js';
import type { Transport } from './network.js';
import { httpUrl, Metrics, rememberSecret, SuiteError } from './common.js';
import { MISSING_KEY } from './vault.js';

export class DeepSeekClient {
  limiter: RateLimiter; scope: string;
  constructor(private key: string | undefined, public network: Transport, public cache: CacheManager, public config: Config) {
    if (key) rememberSecret(key);
    this.scope = createHash('sha256').update(key ?? 'missing').digest('hex');
    // Provider limits apply to accounts, not keys. Conservatively share the local bucket across keys;
    // cache entries remain credential-isolated. Separate SQLite files cannot coordinate with one another.
    this.limiter = new RateLimiter(cache, 'deepseek-account');
  }
  async call(kind: 'search' | 'fetch', body: object, metrics: Metrics, refresh = false): Promise<Record<string, any>> {
    if (!this.key) throw new SuiteError('MISSING_API_KEY', MISSING_KEY);
    const ttl = kind === 'search' ? this.config.searchTtl : this.config.fetchTtl;
    return this.cache.load(this.cache.key(this.scope + kind, body), ttl, refresh, metrics, async () => {
      const request = async () => {
        for (let attempt = 0; ; attempt++) {
          await this.limiter.acquire(kind, kind === 'search' ? this.config.searchQps : this.config.fetchQps, metrics); metrics.take();
          let reply;
          try { reply = await this.network.request(`https://api.deepseek.com/v1/tools/${kind}`, { method: 'POST', body, headers: { Authorization: `Bearer ${this.key}` }, signal: AbortSignal.any([AbortSignal.timeout(Math.max(1, metrics.deadline - Date.now())), ...(metrics.signal ? [metrics.signal] : [])]) }); }
          catch { metrics.failures++; throw new SuiteError('NETWORK_ERROR', 'DeepSeek connection failed; check proxy settings. The request was not retried because completion is unknown.'); }
          if (reply.status >= 200 && reply.status < 300) { try { const data = JSON.parse(reply.text) as Record<string, any>; if (!data || (kind === 'search' ? !Array.isArray(data.results) : typeof data.content !== 'string')) throw new Error(); return { ...data, fetched_at: new Date().toISOString() }; } catch { metrics.failures++; throw new SuiteError('INVALID_RESPONSE', `DeepSeek returned an invalid ${kind} response`); } }
          metrics.failures++;
          const retry = reply.status === 429 || reply.status >= 500;
          if (!retry || attempt >= this.config.retries) throw new SuiteError('DEEPSEEK_HTTP_ERROR', `DeepSeek ${kind} returned HTTP ${reply.status}${reply.status === 401 ? '; API key is invalid or expired' : ''}`, reply.status, retry);
          const header = reply.headers['retry-after']; const parsed = header ? (/^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 0;
          const delay = Math.max(0, Number.isFinite(parsed) ? parsed : 0, 500 * 2 ** attempt);
          if (delay >= metrics.deadline - Date.now()) throw new SuiteError('RETRY_DEADLINE', 'Retry-After exceeds remaining tool duration');
          await sleep(delay, undefined, { signal: metrics.signal });
        }
      };
      return kind === 'fetch' ? this.limiter.domain(httpUrl((body as { url: string }).url).hostname, this.config.domainConcurrency, this.config.domainQps, metrics, request) : request();
    });
  }
}
