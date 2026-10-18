import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import metadata from '../../package.json' with { type: 'json' };

const secrets = new Set<string>();
export const VERSION = metadata.version;
export const PACKAGE_NAME = metadata.name;
export function rememberSecret(value: string) { if (value) secrets.add(value); }
export function redact(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value);
  for (const key of secrets) text = text.split(key).join('[REDACTED]');
  return text.replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]').replace(/((?:https?|socks5h?):\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@');
}
export class SuiteError extends Error {
  constructor(public code: string, message: string, public status?: number, public retryable = false) { super(message); }
  toJSON() { return { code: this.code, message: redact(this.message), status: this.status, retryable: this.retryable }; }
}
export const cpLength = (value: string) => Array.from(value).length;
export const cpSlice = (value: string, length: number) => Array.from(value).slice(0, Math.max(0, length)).join('');
export function dataDirectory() {
  if (process.env.DEEPSEEK_MCP_HOME) return path.resolve(process.env.DEEPSEEK_MCP_HOME);
  return process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData/Local'), PACKAGE_NAME) : path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), PACKAGE_NAME);
}
export async function atomicWrite(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID() + '.tmp';
  await writeFile(temp, content, { mode: 0o600, flag: 'wx' });
  await rename(temp, file);
  if (process.platform !== 'win32') await chmod(file, 0o600);
}
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw new SuiteError('INVALID_CONFIG', 'Configuration is not valid JSON'); }
}
export function run(command: string, args: string[], input = '', timeout = 15000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.DEEPSEEK_API_KEY;
    // Windows PowerShell cannot load PowerShell 7's Security module inherited through PSModulePath.
    if (process.platform === 'win32' && /(?:^|[\\/])powershell(?:\.exe)?$/i.test(command)) for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
    const nodeScript = process.platform === 'win32' && /\.[cm]?js$/i.test(command);
    const child = spawn(nodeScript ? process.execPath : command, nodeScript ? [command, ...args] : args, { windowsHide: true, shell: false, env, stdio: 'pipe' });
    let stdout = '', stderr = '', size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new SuiteError('COMMAND_TIMEOUT', 'System credential or harness command timed out')); }, timeout);
    const collect = (chunk: Buffer, which: 'stdout' | 'stderr') => { size += chunk.length; if (size > 2e6) { child.kill(); return; } if (which === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString(); };
    child.stdout.on('data', chunk => collect(chunk, 'stdout')); child.stderr.on('data', chunk => collect(chunk, 'stderr'));
    child.on('error', () => { clearTimeout(timer); reject(new SuiteError('COMMAND_UNAVAILABLE', 'Required system command is unavailable')); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
export async function executable(name: string): Promise<string | undefined> {
  try {
    const r = await run(process.platform === 'win32' ? 'where.exe' : 'which', [name], '', 5000);
    if (r.code !== 0) return undefined;
    const paths = r.stdout.trim().split(/\r?\n/);
    // Resolve standard npm shims to their JS entry, then run with Node, never cmd.exe or shell interpolation.
    for (const shim of paths) {
      if (process.platform !== 'win32' || /\.(?:exe|com)$/i.test(shim)) return shim;
      if (!/\.cmd$/i.test(shim)) continue;
      const matches = [...(await readFile(shim, 'utf8')).matchAll(/%(?:dp0%|~dp0)[\\/](node_modules[\\/][^"\r\n]+\.[cm]?js)/gi)];
      for (const match of matches) {
        if (name === 'npm' && !/[\\/]npm-cli\.js$/i.test(match[1])) continue;
        const candidate = path.resolve(path.dirname(shim), match[1]);
        if (candidate.startsWith(path.join(path.dirname(shim), 'node_modules') + path.sep) && (await stat(candidate)).isFile()) return candidate;
      }
    }
    return undefined;
  } catch { return undefined; }
}
export class Metrics {
  doh_queries = 0; pinned_requests = 0;
  started = Date.now(); api_requests = 0; cache_hits = 0; coalesced_hits = 0; failures = 0; local_requests = 0;
  constructor(public budget = 10, public deadline = Date.now() + 120000, public signal?: AbortSignal) {}
  check() { this.signal?.throwIfAborted(); if (Date.now() >= this.deadline) throw new SuiteError('DEADLINE_EXCEEDED', 'Tool duration limit reached'); }
  take(local = false) { this.check(); const count = local ? this.local_requests : this.api_requests; if (count >= (local ? 12 : this.budget)) throw new SuiteError('REQUEST_BUDGET_EXCEEDED', 'Request budget reached'); if (local) this.local_requests++; else this.api_requests++; }
  snapshot() { return { elapsed_ms: Date.now() - this.started, api_requests: this.api_requests, cache_hits: this.cache_hits, coalesced_hits: this.coalesced_hits, failures: this.failures, local_requests: this.local_requests, request_budget: this.budget }; }
}
export function httpUrl(value: string): URL {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password || /\s/.test(value) || value.length > 8192) throw new SuiteError('INVALID_URL', 'Use an HTTP(S) URL without credentials');
  return u;
}
