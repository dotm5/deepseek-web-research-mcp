import path from 'node:path';
import { z } from 'zod';
import { atomicWrite, dataDirectory, readJson } from './common.js';

export const configSchema = z.strictObject({
  tools: z.string().default(''), proxy: z.string().default('auto'), dns: z.enum(['auto', 'system', 'doh']).default('auto'),
  localHtml: z.boolean().default(false), searchQps: z.number().positive().max(5).default(3), fetchQps: z.number().positive().max(5).default(3), domainQps: z.number().positive().max(5).default(1), domainConcurrency: z.number().int().min(1).max(5).default(1), concurrency: z.number().int().min(1).max(32).default(8),
  searchTtl: z.number().int().nonnegative().default(300), fetchTtl: z.number().int().nonnegative().default(3600), cacheEntries: z.number().int().positive().default(256), cacheBytes: z.number().int().min(1024).default(67108864), retries: z.number().int().min(0).max(5).default(2), timeout: z.number().positive().max(120).default(30)
});
export type Config = z.infer<typeof configSchema>;
export async function loadConfig(directory = dataDirectory()): Promise<Config> { return configSchema.parse(await readJson(path.join(directory, 'config.json'), {})); }
export async function setConfig(key: string, value: string, directory = dataDirectory()) {
  const current = await loadConfig(directory);
  const parsed = key === 'tools' || key === 'proxy' || key === 'dns' ? value : value === 'true' ? true : value === 'false' ? false : Number(value);
  const next = configSchema.parse({ ...current, [key]: parsed });
  await atomicWrite(path.join(directory, 'config.json'), JSON.stringify(next, null, 2) + '\n'); return next;
}
