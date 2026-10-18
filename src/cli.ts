import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CredentialVault, MISSING_KEY } from './core/vault.js';
import { loadConfig, setConfig } from './core/config.js';
import { Network } from './core/network.js';
import { dataDirectory, Metrics, redact, SuiteError, VERSION, PACKAGE_NAME } from './core/common.js';
import { CacheManager } from './core/cache.js';
import { DeepSeekClient } from './core/client.js';
import { HarnessManager, stageRuntime, runtimeEntry } from './core/harness.js';
import { serve } from './server.js';

async function inputSecret(fromStdin: boolean) {
  if (fromStdin) { let value = ''; for await (const chunk of process.stdin) { value += chunk; if (value.length > 1024) throw new SuiteError('INPUT_TOO_LONG', 'Credential input exceeds limit'); } return value.trim(); }
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new SuiteError('TTY_REQUIRED', 'Use auth login --stdin for piped input');
  process.stderr.write('DeepSeek API key: '); process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const done = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', receive); process.stderr.write('\n'); };
    const receive = (chunk: string) => { for (const char of chunk) { if (char === '\u0003') { done(); reject(new SuiteError('CANCELLED', 'Login cancelled')); return; } if (char === '\r' || char === '\n') { done(); resolve(value.trim()); return; } if (char === '\u007f' || char === '\b') value = value.slice(0, -1); else if (char >= ' ' && value.length < 512) value += char; } }; process.stdin.on('data', receive);
  });
}
async function validateKey(key: string) {
  const config = await loadConfig(), network = await Network.create(config), cache = new CacheManager(':memory:');
  try { const client = new DeepSeekClient(key, network, cache, { ...config, retries: 0 }); const metrics = new Metrics(1); const result = await client.call('search', { query: 'site:api-docs.deepseek.com search', count: 1, need_content: false }, metrics, true); if (!Array.isArray(result.results)) throw new SuiteError('INVALID_RESPONSE', 'Search validation returned no results array'); return { ok: true, ...metrics.snapshot() }; }
  finally { await network.close(); cache.close(); }
}
function print(value: unknown) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }
async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new SuiteError('NODE_VERSION', 'Install Node.js 24 LTS or a newer supported LTS release');
  const args = process.argv.slice(2), command = args[0], entry = fileURLToPath(import.meta.url);
  const option = (name: string, fallback?: string) => args.find(v => v.startsWith(name + '='))?.slice(name.length + 1) ?? (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  if (!command || ['--tools', '--proxy', '--dns', '--local-html', '--search-qps', '--fetch-qps', '--domain-qps', '--domain-concurrency'].some(flag => command === flag || command.startsWith(flag + '='))) {
    const proxy = option('--proxy'), dns = option('--dns');
    const rates = Object.fromEntries([['--search-qps', 'searchQps'], ['--fetch-qps', 'fetchQps'], ['--domain-qps', 'domainQps'], ['--domain-concurrency', 'domainConcurrency']].flatMap(([flag, key]) => option(flag) === undefined ? [] : [[key, Number(option(flag))]]));
    return serve(option('--tools'), { ...rates, ...(proxy ? { proxy } : {}), ...(dns ? { dns: dns as 'auto' | 'system' | 'doh' } : {}), ...(args.includes('--local-html') ? { localHtml: true } : {}) });
  }
  if (command === '--version' || command === '-v') return print({ version: VERSION, node: process.version });
  if (command === '--help' || command === 'help') { process.stdout.write(`${PACKAGE_NAME} [--tools=all] [--proxy=auto|direct|URL] [--dns=auto|system|doh] [--local-html]\n  [--search-qps=3] [--fetch-qps=3] [--domain-qps=1] [--domain-concurrency=1]\n  auth login|set [--stdin] [--fallback] / status / logout\n  setup [--agent claude,codex|all] [--scope user|project] [--dry-run]\n  doctor [--offline]\n  config set <key> <value> / show\nCredentials are never accepted as command-line arguments or read from DEEPSEEK_API_KEY.\n`); return; }
  if (command === 'auth') {
    const action = args[1], permitted = new Set(['--stdin', '--fallback']);
    if (args.slice(2).some(v => !permitted.has(v))) throw new SuiteError('KEY_ARGUMENT_FORBIDDEN', 'API keys must be entered interactively or via --stdin, never as command-line arguments');
    const vault = new CredentialVault(dataDirectory(), args.includes('--fallback') ? 'encrypted-file' : undefined);
    if (action === 'login' || action === 'set') { const key = await inputSecret(args.includes('--stdin')); if (!/^sk-[A-Za-z0-9_-]{12,256}$/.test(key)) throw new SuiteError('INVALID_KEY_FORMAT', 'Expected a DeepSeek API key'); const validation = await validateKey(key); await vault.set(key); print({ ...(await vault.status()), validation }); return; }
    if (action === 'status') return print(await vault.status()); if (action === 'logout') { await vault.logout(); return print({ configured: false }); }
    throw new SuiteError('USAGE', 'Use auth login, status or logout');
  }
  if (command === 'config') { if (args[1] === 'show') return print(await loadConfig()); if (args[1] === 'set' && args.length === 4) return print(await setConfig(args[2], args[3])); throw new SuiteError('USAGE', 'Use config show or config set <key> <value>'); }
  if (command === 'setup') {
    const scope = option('--scope', 'user')!, targets = option('--agent', 'claude,codex')!.split(','), stable = runtimeEntry();
    if (args.includes('--dry-run')) return print({ staging_directory: path.join(dataDirectory(), 'runtime'), backup_directory: path.join(dataDirectory(), 'backups'), keyless: true, plan: await new HarnessManager(stable).setup(targets, scope, true) });
    const installed = await stageRuntime(path.dirname(path.dirname(entry))); return print({ entry: installed, registrations: await new HarnessManager(installed).setup(targets, scope) });
  }
  if (command === 'doctor') {
    const vault = new CredentialVault(), credentials = await vault.status(); let api: unknown = { skipped: true };
    if (!args.includes('--offline')) { try { const key = await vault.get(); if (!key) throw new SuiteError('MISSING_API_KEY', MISSING_KEY); api = await validateKey(key); } catch (e) { api = { ok: false, error: redact(e) }; } }
    const config = await loadConfig(), network = await Network.create(config);
    try { print({ version: VERSION, node: process.version, credentials, api, network: { proxy: redact(network.proxy ?? 'direct'), dns: config.dns }, harnesses: await new HarnessManager(runtimeEntry()).registrations() }); }
    finally { await network.close(); }
    if ('ok' in (api as object) && !(api as { ok: boolean }).ok) process.exitCode = 1;
    return;
  }
  throw new SuiteError('UNKNOWN_COMMAND', 'Unknown command; run --help');
}
main().catch(error => { process.stderr.write(JSON.stringify({ error: error instanceof SuiteError ? error.toJSON() : { code: 'ERROR', message: redact(error) } }) + '\n'); process.exitCode = 1; });
