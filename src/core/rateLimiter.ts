import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CacheManager } from './cache.js';
import { Metrics } from './common.js';

/** Buckets and expiring leases are shared by processes using the same account and SQLite file. */
export class RateLimiter {
  constructor(private cache: CacheManager, private scope: string) {}
  async acquire(name: string, qps: number, metrics: Metrics) {
    const db = this.cache.db, key = `${this.scope}:${name}`;
    while (true) {
      metrics.check(); let wait = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare('SELECT tokens,updated FROM buckets WHERE key=?').get(key) as { tokens: number; updated: number } | undefined;
        // BEGIN can wait for another process. Never write a timestamp captured before that wait,
        // or move updated backwards after a clock adjustment: either would mint extra tokens.
        const now = Math.max(Date.now(), row?.updated ?? 0);
        const tokens = Math.min(1, (row?.tokens ?? 1) + Math.max(0, now - (row?.updated ?? now)) * qps / 1000);
        wait = tokens >= 1 ? 0 : Math.ceil((1 - tokens) * 1000 / qps);
        db.prepare('INSERT OR REPLACE INTO buckets VALUES(?,?,?)').run(key, wait ? tokens : tokens - 1, now); db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      if (!wait) return;
      await sleep(Math.min(wait, Math.max(1, metrics.deadline - Date.now())), undefined, { signal: metrics.signal });
    }
  }
  async domain<T>(host: string, concurrency: number, qps: number, metrics: Metrics, fn: () => Promise<T>): Promise<T> {
    const db = this.cache.db, domain = `${this.scope}:${host}`, id = randomUUID();
    while (true) {
      metrics.check(); db.exec('BEGIN IMMEDIATE'); let acquired = false;
      try {
        db.prepare('DELETE FROM leases WHERE expires<=?').run(Date.now());
        const row = db.prepare('SELECT COUNT(*) AS count FROM leases WHERE domain=?').get(domain) as { count: number };
        if (row.count < concurrency) { db.prepare('INSERT INTO leases VALUES(?,?,?)').run(id, domain, metrics.deadline + 1000); acquired = true; } db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      if (acquired) break; await sleep(40, undefined, { signal: metrics.signal });
    }
    try { await this.acquire(`domain:${host}`, qps, metrics); return await fn(); }
    finally { db.prepare('DELETE FROM leases WHERE id=?').run(id); }
  }
}
