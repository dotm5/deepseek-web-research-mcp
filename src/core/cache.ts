import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Metrics } from './common.js';

export class CacheManager {
  db: DatabaseSync;
  private pending = new Map<string, Promise<unknown>>();
  constructor(file: string, public entries = 256, public bytes = 64 * 1024 * 1024) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    if (file !== ':memory:' && process.platform !== 'win32') chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY,value TEXT NOT NULL,expires REAL NOT NULL,touched REAL NOT NULL,bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS buckets(key TEXT PRIMARY KEY,tokens REAL NOT NULL,updated REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS leases(id TEXT PRIMARY KEY,domain TEXT NOT NULL,expires REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,state TEXT NOT NULL,payload TEXT NOT NULL,result TEXT,error TEXT,updated REAL NOT NULL,owner TEXT NOT NULL);`);
  }
  key(scope: string, value: unknown) { return createHash('sha256').update(scope + '\0' + JSON.stringify(value)).digest('hex'); }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value,expires FROM cache WHERE key=?').get(key) as { value: string; expires: number } | undefined;
    if (!row) return undefined;
    if (row.expires <= Date.now()) { this.db.prepare('DELETE FROM cache WHERE key=?').run(key); return undefined; }
    this.db.prepare('UPDATE cache SET touched=? WHERE key=?').run(Date.now(), key); return JSON.parse(row.value) as T;
  }
  put(key: string, value: unknown, ttl: number) {
    const json = JSON.stringify(value), bytes = Buffer.byteLength(json); if (!ttl || bytes > this.bytes) return;
    this.db.prepare('INSERT OR REPLACE INTO cache VALUES(?,?,?,?,?)').run(key, json, Date.now() + ttl * 1000, Date.now(), bytes);
    this.db.prepare('DELETE FROM cache WHERE expires<=?').run(Date.now());
    while (true) {
      const size = this.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM cache').get() as { count: number; bytes: number };
      if (size.count <= this.entries && size.bytes <= this.bytes) break;
      this.db.exec('DELETE FROM cache WHERE key=(SELECT key FROM cache ORDER BY touched,key LIMIT 1)');
    }
  }
  async load<T>(key: string, ttl: number, refresh: boolean, metrics: Metrics, fn: () => Promise<T>): Promise<T> {
    if (!refresh) { const hit = this.get<T>(key); if (hit !== undefined) { metrics.cache_hits++; return hit; } }
    const flightKey = key + (refresh ? ':refresh' : '');
    const hit = this.pending.get(flightKey); if (hit) { metrics.coalesced_hits++; return hit as Promise<T>; }
    const task = Promise.resolve().then(fn).then(value => { this.put(key, value, ttl); return value; });
    this.pending.set(flightKey, task);
    try { return await task; } finally { this.pending.delete(flightKey); }
  }
  close() { this.db.close(); }
}
