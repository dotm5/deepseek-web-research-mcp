import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { Agent, ProxyAgent, request, type Dispatcher, type buildConnector } from 'undici';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { SocksClient } from 'socks';
import ipaddr from 'ipaddr.js';
import type { Config } from './config.js';
import { httpUrl, Metrics, run, SuiteError } from './common.js';

export interface Reply { status: number; headers: Record<string, string>; text: string }
export interface Transport { request(url: string, options?: { method?: string; body?: object; headers?: Record<string, string>; signal?: AbortSignal; servername?: string; limit?: number }): Promise<Reply> }
export function publicIP(value: string) { try { return ipaddr.process(value).range() === 'unicast'; } catch { return false; } }
const isFakeIP = (value: string) => net.isIPv4(value) && ipaddr.parse(value).match(ipaddr.parse('198.18.0.0'), 15);
async function listening(port: number) { return new Promise<boolean>(resolve => { const socket = net.connect({ host: '127.0.0.1', port }); const done = (ok: boolean) => { socket.destroy(); resolve(ok); }; socket.setTimeout(150, () => done(false)); socket.once('connect', () => done(true)); socket.once('error', () => done(false)); }); }
export async function findProxy(setting: string): Promise<string | undefined> {
  if (setting !== 'auto') { if (setting === 'direct') return undefined; const u = new URL(setting); if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(u.protocol)) throw new SuiteError('INVALID_PROXY', 'Use HTTP(S)/SOCKS5 proxy URL, auto, or direct'); return setting; }
  const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (env) return env.includes('://') ? env : `http://${env}`;
  if (process.platform === 'win32') {
    try { const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; const enabled = await run('reg.exe', ['query', key, '/v', 'ProxyEnable']); if (/REG_DWORD\s+0x1\b/.test(enabled.stdout)) { const data = await run('reg.exe', ['query', key, '/v', 'ProxyServer']); const value = data.stdout.match(/ProxyServer\s+REG_SZ\s+(.+)/)?.[1]?.trim(); const proxy = value?.includes('=') ? value.match(/(?:^|;)https=([^;]+)/)?.[1] ?? value.match(/(?:^|;)http=([^;]+)/)?.[1] : value; if (proxy) return proxy.includes('://') ? proxy : `http://${proxy}`; } } catch {}
  }
  const roots = [path.join(homedir(), '.config/clash'), path.join(homedir(), '.config/mihomo')];
  if (process.env.APPDATA) roots.unshift(path.join(process.env.APPDATA, 'io.github.clash-verge-rev.clash-verge-rev'));
  for (const root of roots) for (const name of ['clash-verge.yaml', 'config.yaml']) {
    let text = ''; try { text = await readFile(path.join(root, name), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/^(mixed-port|port|socks-port):\s*(\d+)\s*(?:#.*)?$/gm)) { const port = Number(m[2]); if (port > 0 && port < 65536 && await listening(port)) return `${m[1] === 'socks-port' ? 'socks5' : 'http'}://127.0.0.1:${port}`; }
  }
  return undefined;
}
export class Network implements Transport {
  private agents = new Map<string, Dispatcher>();
  private dns = new Map<string, { expires: number; addresses: string[] }>();
  constructor(public config: Config, public proxy?: string) {}
  static async create(config: Config) { return new Network(config, await findProxy(config.proxy)); }
  private dispatcher(servername: string) {
    const key = `${this.proxy ?? 'direct'}:${servername}`; const hit = this.agents.get(key); if (hit) return hit;
    let agent: Dispatcher;
    if (this.proxy?.startsWith('socks5')) {
      const proxy = new URL(this.proxy);
      const connect = (options: buildConnector.Options, callback: buildConnector.Callback) => {
        const protocol = options.protocol;
        void SocksClient.createConnection({ command: 'connect', proxy: { host: proxy.hostname, port: Number(proxy.port || 1080), type: 5, userId: decodeURIComponent(proxy.username) || undefined, password: decodeURIComponent(proxy.password) || undefined }, destination: { host: options.hostname, port: Number(options.port || (protocol === 'https:' ? 443 : 80)) }, timeout: this.config.timeout * 1000 }).then(({ socket }) => {
          if (protocol === 'https:') { const secure = tls.connect({ socket, servername, rejectUnauthorized: true }); let called = false; secure.once('secureConnect', () => { if (!called) { called = true; callback(null, secure); } }); secure.once('error', error => { if (!called) { called = true; callback(error, null); } }); }
          else callback(null, socket);
        }).catch(error => callback(error instanceof Error ? error : new Error('SOCKS connection failed'), null));
      };
      agent = new Agent({ connect, allowH2: false });
    } else if (this.proxy) agent = new ProxyAgent({ uri: this.proxy, allowH2: false, requestTls: { servername, rejectUnauthorized: true, allowH2: false } });
    else agent = new Agent({ allowH2: false, connect: { servername, rejectUnauthorized: true, allowH2: false } });
    this.agents.set(key, agent); return agent;
  }
  async request(url: string, options: Parameters<Transport['request']>[1] = {}): Promise<Reply> {
    const u = httpUrl(url); const servername = options.servername ?? u.hostname;
    const signals = [AbortSignal.timeout(this.config.timeout * 1000), ...(options.signal ? [options.signal] : [])];
    // fetch reconstructs Host from the numeric URL. request preserves the validated original Host.
    const response = await request(url, { method: (options.method ?? 'GET') as Dispatcher.HttpMethod, body: options.body ? JSON.stringify(options.body) : undefined,
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      signal: AbortSignal.any(signals), dispatcher: this.dispatcher(servername) });
    const chunks: Uint8Array[] = []; let size = 0;
    const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase();
    const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
    const body = decoder ? response.body.pipe(decoder) : response.body;
    if (decoder) response.body.on('error', error => decoder.destroy(error));
    try { for await (const value of body) { size += value.byteLength; if (size > (options.limit ?? 8 * 1024 * 1024)) throw new SuiteError('RESPONSE_TOO_LARGE', 'Response exceeded the decoded byte limit'); chunks.push(value); } }
    finally { if (!response.body.readableEnded) response.body.destroy(); if (decoder && !decoder.readableEnded) decoder.destroy(); }
    return { status: response.statusCode, headers: Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')])), text: Buffer.concat(chunks).toString('utf8') };
  }
  async addresses(host: string, signal?: AbortSignal, metrics?: Metrics): Promise<string[]> {
    signal?.throwIfAborted();
    if (net.isIP(host)) { if (!publicIP(host)) throw new SuiteError('SSRF_BLOCKED', 'Destination IP must be public'); return [host]; }
    if (/(?:^|\.)(localhost|local|internal)$/i.test(host)) throw new SuiteError('SSRF_BLOCKED', 'Local hostnames are not allowed');
    const cached = this.dns.get(host); if (cached && cached.expires > Date.now()) return cached.addresses;
    let addresses: string[] = []; let doh = this.config.dns === 'doh' || (this.config.dns === 'auto' && !!this.proxy);
    if (!doh) { addresses = (await lookup(host, { all: true })).map(r => r.address); doh = this.config.dns === 'auto' && addresses.some(isFakeIP); }
    if (doh) {
      const answers = await Promise.all(['A', 'AAAA'].map(async type => {
        for (const bootstrap of ['1.1.1.1', '1.0.0.1']) {
          signal?.throwIfAborted(); if (metrics) metrics.doh_queries++;
          try {
            const reply = await this.request(`https://${bootstrap}/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { Host: 'cloudflare-dns.com', Accept: 'application/dns-json' }, servername: 'cloudflare-dns.com', limit: 65536, signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]) });
            const data = JSON.parse(reply.text);
            if (reply.status !== 200 || data.Status !== 0) throw new SuiteError('PUBLIC_DNS_FAILED', 'Trusted public DNS lookup failed');
            return (data.Answer ?? []).filter((r: { type: number }) => r.type === 1 || r.type === 28).map((r: { data: string }) => r.data) as string[];
          } catch (error) {
            if (error instanceof SuiteError || bootstrap === '1.0.0.1') throw new SuiteError('PUBLIC_DNS_FAILED', 'Trusted DNS lookup failed after bounded public bootstrap attempts');
          }
        }
        throw new SuiteError('PUBLIC_DNS_FAILED', 'Trusted DNS lookup failed');
      }));
      addresses = answers.flat();
    }
    addresses = [...new Set(addresses)]; if (!addresses.length || addresses.some(ip => !publicIP(ip))) throw new SuiteError('SSRF_BLOCKED', 'DNS must resolve exclusively to public addresses');
    this.dns.set(host, { expires: Date.now() + 30000, addresses }); return addresses;
  }
  async localGet(url: string, metrics: Metrics): Promise<Reply & { url: string }> {
    for (let hop = 0; hop < 4; hop++) {
      metrics.take(true); const u = httpUrl(url); if (u.port && !['80', '443'].includes(u.port)) throw new SuiteError('SSRF_BLOCKED', 'Only ports 80/443 are allowed');
      const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, metrics.deadline - Date.now())), ...(metrics.signal ? [metrics.signal] : [])]);
      const host = u.hostname.replace(/^\[|\]$/g, ''); const addresses = await this.addresses(host, signal, metrics); u.hostname = net.isIPv6(addresses[0]) ? `[${addresses[0]}]` : addresses[0];
      let reply: Reply; try { metrics.pinned_requests++; reply = await this.request(u.href, { servername: host, headers: { Host: host, 'User-Agent': 'DeepSeekResearchBot/0.4', Accept: 'text/html,text/plain,application/xml' }, limit: 2 * 1024 * 1024, signal }); } catch (error) { metrics.failures++; if (hop === 0 && !(error instanceof SuiteError)) continue; throw new SuiteError('LOCAL_HTTP_ERROR', 'Public discovery transport failed'); }
      if (reply.status >= 300 && reply.status < 400 && reply.headers.location) { url = new URL(reply.headers.location, url).href; continue; }
      if (reply.status >= 400 && reply.status !== 404) throw new SuiteError('LOCAL_HTTP_ERROR', `Public discovery HTTP ${reply.status}`);
      return { ...reply, url };
    }
    throw new SuiteError('REDIRECT_LIMIT', 'Public discovery redirect limit reached');
  }
  async close() { await Promise.all([...this.agents.values()].map(agent => agent.close())); }
}
