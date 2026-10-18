import { it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { Network, findProxy } from '../src/core/network.js';
import { configSchema } from '../src/core/config.js';
import { Metrics } from '../src/core/common.js';

it.skipIf(process.env.LIVE_NETWORK !== '1')('pins real public IPs through HTTP proxy, SOCKS and direct/TUN with TLS validation', async () => {
  const config = configSchema.parse({}), detected = await findProxy('auto'), results = [];
  for (const proxy of [detected, 'socks5://127.0.0.1:7897', undefined]) {
    const network = new Network(config, proxy), metrics = new Metrics(0);
    try {
      const addresses = await network.addresses('api-docs.deepseek.com');
      expect(addresses.length).toBeGreaterThan(0); expect(addresses.every(ip => !ip.startsWith('198.18.'))).toBe(true);
      const response = await network.localGet('https://api-docs.deepseek.com/robots.txt', metrics); expect(response.status).toBe(200); expect(response.text.length).toBeGreaterThan(0);
      const spare = await network.request('https://1.0.0.1/dns-query?name=api-docs.deepseek.com&type=A', { servername: 'cloudflare-dns.com', headers: { Host: 'cloudflare-dns.com', Accept: 'application/dns-json' }, signal: AbortSignal.timeout(10000) });
      expect(spare.status).toBe(200); expect(JSON.parse(spare.text).Status).toBe(0);
      await expect(network.localGet('http://127.0.0.1/', metrics)).rejects.toThrow('public');
      results.push({ proxy: proxy ?? 'direct/TUN', dns_answers: addresses, status: response.status, backup_bootstrap_status: spare.status, bytes: response.text.length, meta: metrics.snapshot(), loopback_blocked: true });
      console.log({ mode: proxy ?? 'direct/TUN', passed: true });
      await writeFile('NETWORK-RESULTS.json', JSON.stringify({ timestamp: new Date().toISOString(), system_dns: await lookup('api-docs.deepseek.com', { all: true }), results }, null, 2) + '\n');
    } finally { await network.close(); }
  }
  await writeFile('NETWORK-RESULTS.json', JSON.stringify({ timestamp: new Date().toISOString(), system_dns: await lookup('api-docs.deepseek.com', { all: true }), results }, null, 2) + '\n');
}, 60000);
