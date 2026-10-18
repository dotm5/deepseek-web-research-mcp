import { mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { isDeepStrictEqual } from 'node:util';
import { atomicWrite, dataDirectory, executable, readJson, run, SuiteError, PACKAGE_NAME } from './common.js';

type Harness = { name: string; executable?: string; config: string; kind: 'json' | 'toml'; detected: boolean };
const NAME = 'deepseek-search';
async function exists(file: string) { try { await stat(file); return true; } catch { return false; } }
export function patchToml(text: string, entry: string): string {
  const before = parseToml(text); const lines = text.split(/\r?\n/); const kept: string[] = []; let skip = false;
  for (const line of lines) { const header = line.match(/^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/); if (header) { const name = header[1].replace(/["']/g, ''); skip = name === `mcp_servers.${NAME}` || name.startsWith(`mcp_servers.${NAME}.`); } if (!skip) kept.push(line); }
  const result = kept.join('\n').trimEnd() + `\n\n[mcp_servers.${NAME}]\ncommand = "node"\nargs = [${JSON.stringify(entry)}]\n`;
  const after = parseToml(result);
  for (const doc of [before, after]) { const servers = doc.mcp_servers; if (servers && typeof servers === 'object' && !Array.isArray(servers)) { delete (servers as Record<string, unknown>)[NAME]; if (!Object.keys(servers).length) delete doc.mcp_servers; } }
  if (!isDeepStrictEqual(before, after)) throw new SuiteError('CONFIG_CONFLICT', 'Cannot safely patch this TOML layout; use the harness native CLI');
  return result;
}
export class HarnessManager {
  constructor(public entry: string, public directory = dataDirectory(), public home = homedir()) {}
  async detect(scope = 'user'): Promise<Harness[]> {
    const claude = await executable('claude'), codex = await executable('codex'), gemini = await executable('gemini');
    const specs: Harness[] = [
      { name: 'claude', executable: claude, config: scope === 'project' ? path.resolve('.mcp.json') : path.join(this.home, '.claude.json'), kind: 'json', detected: !!claude },
      { name: 'codex', executable: codex, config: scope === 'project' ? path.resolve('.codex/config.toml') : path.join(this.home, '.codex/config.toml'), kind: 'toml', detected: !!codex || await exists(path.join(this.home, '.codex')) },
      { name: 'cursor', config: path.join(this.home, '.cursor/mcp.json'), kind: 'json', detected: await exists(path.join(this.home, '.cursor')) },
      { name: 'windsurf', config: path.join(this.home, '.codeium/windsurf/mcp_config.json'), kind: 'json', detected: await exists(path.join(this.home, '.codeium/windsurf')) },
      { name: 'gemini', executable: gemini, config: path.join(this.home, '.gemini/settings.json'), kind: 'json', detected: !!gemini || await exists(path.join(this.home, '.gemini')) }
    ]; return specs;
  }
  async registrations(scope = 'user') {
    return Promise.all((await this.detect(scope)).map(async harness => {
      let registered = false, keyless = false, current = false;
      try { const text = await readFile(harness.config, 'utf8'); const parsed = harness.kind === 'toml' ? parseToml(text) : JSON.parse(text); const item = (harness.kind === 'toml' ? parsed.mcp_servers : parsed.mcpServers)?.[NAME]; registered = !!item; keyless = !!item && !item.env?.DEEPSEEK_API_KEY; current = !!item && item.command === 'node' && Array.isArray(item.args) && item.args[0] === this.entry && keyless; } catch {}
      return { name: harness.name, detected: harness.detected, registered, keyless, current, config: harness.config };
    }));
  }
  async setup(targets = ['claude', 'codex'], scope = 'user', dryRun = false) {
    if (!['user', 'project'].includes(scope)) throw new SuiteError('INVALID_SCOPE', 'Use user or project scope');
    const all = await this.detect(scope); const chosen = all.filter(h => (targets.includes('all') || targets.includes(h.name)) && h.detected);
    if (targets.some(name => name !== 'all' && !all.some(h => h.name === name))) throw new SuiteError('INVALID_HARNESS', 'Unknown harness name');
    const reports = [];
    for (const harness of chosen) {
      const args = harness.name === 'claude' ? ['mcp', 'add', '--scope', scope, NAME, '--', 'node', this.entry] : ['mcp', 'add', NAME, '--', 'node', this.entry];
      const useNative = !!harness.executable && (harness.name === 'claude' || (harness.name === 'codex' && scope === 'user'));
      const plan = { harness: harness.name, config: harness.config, command: useNative ? [harness.executable!, ...args] : ['patch', harness.config], backup: null as string | null, status: 'planned' };
      if (dryRun) { reports.push(plan); continue; }
      if (await exists(harness.config)) { const backup = path.join(this.directory, 'backups', `${harness.name}-${Date.now()}-${Math.random().toString(16).slice(2)}.bak`); await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 }); await atomicWrite(backup, await readFile(harness.config, 'utf8')); plan.backup = backup; }
      let native = false;
      if (harness.executable && useNative) {
        const help = await run(harness.executable, ['mcp', 'add', '--help'], '', 15000);
        if (help.code === 0) {
          // Only this namespace is replaced; backups preserve its previous registration.
          if ((await this.registrations(scope)).find(h => h.name === harness.name)?.registered && harness.name === 'claude') { const removed = await run(harness.executable, ['mcp', 'remove', '--scope', scope, NAME]); if (removed.code) throw new SuiteError('SETUP_FAILED', 'Could not replace the previous Claude registration'); }
          const result = await run(harness.executable, args, '', 30000); if (result.code) throw new SuiteError('SETUP_FAILED', `${harness.name} native registration failed; configuration backup retained`); native = true;
        }
      }
      if (!native) {
        if (harness.kind === 'toml') { let text = ''; try { text = await readFile(harness.config, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } await atomicWrite(harness.config, patchToml(text, this.entry)); }
        else { const doc = await readJson<Record<string, unknown>>(harness.config, {}); const servers = (doc.mcpServers ?? {}) as Record<string, unknown>; doc.mcpServers = { ...servers, [NAME]: { command: 'node', args: [this.entry] } }; await atomicWrite(harness.config, JSON.stringify(doc, null, 2) + '\n'); }
      }
      if (!(await this.registrations(scope)).find(h => h.name === harness.name)?.current) throw new SuiteError('SETUP_VERIFY_FAILED', `${harness.name} configuration did not match the keyless launch command`);
      reports.push({ ...plan, status: native ? 'registered-native-cli' : 'registered-config-fallback' });
    }
    return reports;
  }
}
export const runtimeEntry = (directory = dataDirectory()) => path.join(directory, 'runtime/node_modules', PACKAGE_NAME, 'dist/cli.js');
/** Snapshot the installed package under a stable user directory, independent of npx's cache lifetime. */
export async function stageRuntime(packageRoot: string, directory = dataDirectory()) {
  const runtime = path.join(directory, 'runtime'); await mkdir(runtime, { recursive: true, mode: 0o700 });
  const npm = await executable('npm');
  if (!npm) throw new SuiteError('NPM_UNAVAILABLE', 'npm is required to stage the persistent runtime');
  const packed = await run(npm, ['pack', packageRoot, '--ignore-scripts', '--json', '--pack-destination', runtime], '', 60000);
  if (packed.code) throw new SuiteError('STAGING_FAILED', 'Could not pack the managed runtime');
  const records = JSON.parse(packed.stdout) as { filename: string; name: string }[];
  if (records.length !== 1 || records[0].name !== PACKAGE_NAME || path.basename(records[0].filename) !== records[0].filename) throw new SuiteError('STAGING_FAILED', 'Unexpected package identity while staging runtime');
  const tarball = path.join(runtime, records[0].filename);
  const installed = await run(npm, ['install', '--prefix', runtime, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tarball], '', 60000);
  if (installed.code) throw new SuiteError('STAGING_FAILED', 'Could not install the managed runtime');
  const entry = runtimeEntry(directory); await stat(entry); return entry;
}
