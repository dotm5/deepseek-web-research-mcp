import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { chmod, readFile, rm, stat } from 'node:fs/promises';
import { hostname, platform, userInfo } from 'node:os';
import path from 'node:path';
import { atomicWrite, dataDirectory, executable, rememberSecret, run, SuiteError, PACKAGE_NAME } from './common.js';

const SERVICE = PACKAGE_NAME;
const ACCOUNT = userInfo().username;
const PS = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
$d=[Console]::In.ReadToEnd() | ConvertFrom-Json
if($d.mode -eq 'encrypt') { ConvertFrom-SecureString (ConvertTo-SecureString $d.value -AsPlainText -Force) }
else { $s=ConvertTo-SecureString $d.value; $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) } }`;

/** Portable fallback guards ciphertext at rest; it is not protection from code already running as this user. */
export function seal(secret: string, material: string): string {
  const salt = randomBytes(32), iv = randomBytes(12), key = scryptSync(material, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(SERVICE));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  key.fill(0);
  return JSON.stringify({ version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
}
export function unseal(envelope: string, material: string): string {
  const d = JSON.parse(envelope); if (d.version !== 1) throw new Error('Unsupported envelope');
  const key = scryptSync(material, Buffer.from(d.salt, 'base64'), 32);
  try { const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(d.iv, 'base64')); cipher.setAAD(Buffer.from(SERVICE)); cipher.setAuthTag(Buffer.from(d.tag, 'base64')); return Buffer.concat([cipher.update(Buffer.from(d.ciphertext, 'base64')), cipher.final()]).toString('utf8'); }
  finally { key.fill(0); }
}
export class CredentialVault {
  constructor(public directory = dataDirectory(), private forced?: 'encrypted-file') {}
  // OS credential services are global to a user; namespace them by the selected data profile.
  private get service() { return `${SERVICE}:${createHash('sha256').update(path.resolve(this.directory)).digest('hex').slice(0, 16)}`; }
  private file(backend: string) { return path.join(this.directory, backend === 'windows-dpapi' ? 'credentials.dpapi' : 'credentials.enc'); }
  private async material() { let machine = hostname(); for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) { try { machine = (await readFile(p, 'utf8')).trim(); break; } catch {} } return [platform(), machine, userInfo().username, userInfo().uid, userInfo().homedir].join('\0'); }
  private async backend() {
    if (this.forced) return this.forced;
    try { const saved = JSON.parse(await readFile(path.join(this.directory, 'vault.json'), 'utf8')).backend; if (['windows-dpapi', 'macos-keychain', 'secret-service', 'encrypted-file'].includes(saved)) return saved as string; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new SuiteError('VAULT_METADATA', 'Credential backend metadata is invalid'); }
    if (process.platform === 'win32') return 'windows-dpapi';
    if (process.platform === 'darwin' && await executable('security')) return 'macos-keychain';
    if (process.platform === 'linux' && process.env.DBUS_SESSION_BUS_ADDRESS && await executable('secret-tool')) return 'secret-service';
    return 'encrypted-file';
  }
  async get(): Promise<string | undefined> {
    const backend = await this.backend(); let value: string | undefined;
    try {
      if (backend === 'windows-dpapi') { const encrypted = await readFile(this.file(backend), 'utf8'); const r = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PS], JSON.stringify({ mode: 'decrypt', value: encrypted })); if (r.code) throw new Error(); value = r.stdout.trim(); }
      else if (backend === 'macos-keychain') { const r = await run('security', ['find-generic-password', '-s', this.service, '-a', ACCOUNT, '-w']); if (r.code === 44) return undefined; if (r.code) throw new Error(); value = r.stdout.trim(); }
      else if (backend === 'secret-service') { const r = await run('secret-tool', ['lookup', 'service', this.service, 'account', ACCOUNT]); if (r.code === 1 && !r.stdout) return undefined; if (r.code) throw new Error(); value = r.stdout.trim(); }
      else { const s = await stat(this.file(backend)); if (process.platform !== 'win32' && (s.mode & 0o077)) throw new SuiteError('VAULT_PERMISSIONS', 'Credential ciphertext requires mode 0600'); value = unseal(await readFile(this.file(backend), 'utf8'), await this.material()); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; if (error instanceof SuiteError) throw error; throw new SuiteError('VAULT_LOCKED', 'Credential vault could not be unlocked for this user'); }
    if (value) rememberSecret(value); return value || undefined;
  }
  async set(value: string) {
    if (!/^sk-[A-Za-z0-9_-]{12,256}$/.test(value)) throw new SuiteError('INVALID_KEY_FORMAT', 'Expected a DeepSeek API key');
    rememberSecret(value); const backend = await this.backend();
    if (backend === 'windows-dpapi') { const r = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PS], JSON.stringify({ mode: 'encrypt', value })); if (r.code || !r.stdout.trim()) throw new SuiteError('VAULT_WRITE_FAILED', 'DPAPI encryption failed'); await atomicWrite(this.file(backend), r.stdout.trim()); }
    else if (backend === 'macos-keychain') { const r = await run('security', ['-i'], `add-generic-password -U -s "${this.service}" -a "${ACCOUNT.replace(/["\\]/g, '\\$&')}" -w "${value}"\n`); if (r.code) throw new SuiteError('VAULT_WRITE_FAILED', 'Keychain storage failed'); }
    else if (backend === 'secret-service') { const r = await run('secret-tool', ['store', '--label=DeepSeek Web Research MCP', 'service', this.service, 'account', ACCOUNT], value); if (r.code) throw new SuiteError('VAULT_WRITE_FAILED', 'Secret Service storage failed; use auth login --fallback only on a headless host'); }
    else { await atomicWrite(this.file(backend), seal(value, await this.material())); if (process.platform !== 'win32') await chmod(this.file(backend), 0o600); }
    await atomicWrite(path.join(this.directory, 'vault.json'), JSON.stringify({ backend }));
    if (await this.get() !== value) throw new SuiteError('VAULT_VERIFY_FAILED', 'Stored credential could not be read back');
    return backend;
  }
  async status() { const key = await this.get(); return { configured: !!key, backend: await this.backend(), mask: key ? `sk-****...${key.slice(-4)}` : null }; }
  async logout() {
    const backend = await this.backend();
    if (backend === 'macos-keychain') { const r = await run('security', ['delete-generic-password', '-s', this.service, '-a', ACCOUNT]); if (r.code && r.code !== 44) throw new SuiteError('VAULT_DELETE_FAILED', 'Keychain removal failed'); }
    else if (backend === 'secret-service') { const r = await run('secret-tool', ['clear', 'service', this.service, 'account', ACCOUNT]); if (r.code > 1) throw new SuiteError('VAULT_DELETE_FAILED', 'Secret Service removal failed'); }
    await rm(this.file(backend), { force: true });
    // Also clear any previous fallback rather than leaving a second usable credential.
    await rm(path.join(this.directory, 'credentials.enc'), { force: true });
    await rm(path.join(this.directory, 'credentials.dpapi'), { force: true });
    await rm(path.join(this.directory, 'vault.json'), { force: true });
  }
}
export const MISSING_KEY = `API Key not found. Please run 'npx ${PACKAGE_NAME} auth login' in your terminal.`;
