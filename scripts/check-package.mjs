import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export async function npmCommand() {
  const found = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['npm'], { encoding: 'utf8', windowsHide: true });
  assert.equal(found.status, 0, 'npm is required');
  const candidates = found.stdout.trim().split(/\r?\n/);
  for (const candidate of candidates) {
    if (process.platform !== 'win32') return { command: candidate, prefix: [] };
    if (/\.cmd$/i.test(candidate)) {
      const text = await readFile(candidate, 'utf8');
      const match = text.match(/%(?:dp0%|~dp0)[\\/](node_modules[\\/][^"\r\n]*[\\/]npm-cli\.js)/i);
      if (match) return { command: process.execPath, prefix: [path.resolve(path.dirname(candidate), match[1])] };
    }
  }
  throw new Error('Cannot resolve npm CLI without invoking a shell');
}
export function entries(buffer) {
  const archive = gunzipSync(buffer), files = [];
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(v => v === 0)) break;
    const field = (start, end) => header.subarray(start, end).toString().replace(/\0.*$/s, '');
    const name = [field(345, 500), field(0, 100)].filter(Boolean).join('/');
    const size = parseInt(field(124, 136).trim() || '0', 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= archive.length);
    const type = field(156, 157);
    assert.ok(['0', ''].includes(type), `Unexpected archive entry type: ${name}`);
    assert.ok(name.startsWith('package/') && !name.split('/').includes('..'));
    files.push({ name: name.slice(8), data: archive.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
export function inspectText(name, text) {
  assert.ok(!/sk-[a-f\d]{24,}/i.test(text), `Possible API credential in ${name}`);
  assert.ok(!/(?:BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|npm_[A-Za-z0-9]{30,}|gh[pousr]_[A-Za-z0-9]{30,})/.test(text), `Possible private token in ${name}`);
  assert.ok(!/[A-Za-z]:[\\/]+Users[\\/]+[^\s"'<>/\\]+/i.test(text), `Personal Windows path in ${name}`);
  assert.ok(!/(?:\/home\/|\/Users\/)[A-Za-z0-9_.-]+\//.test(text), `Personal Unix path in ${name}`);
  for (const privatePath of [process.cwd(), homedir()]) {
    if (privatePath.length > 5) for (const form of [privatePath, privatePath.replaceAll('\\', '/'), JSON.stringify(privatePath).slice(1, -1)]) assert.ok(!text.includes(form), `Build machine path in ${name}`);
  }
}
export function inspectPackage(files) {
  const allowed = new Set(['dist/cli.js', 'package.json', 'npm-shrinkwrap.json', 'README.md', 'README.en.md', 'LICENSE', 'CHANGELOG.md']);
  assert.equal(files.length, allowed.size, 'Unexpected package content count');
  for (const file of files) { assert.ok(allowed.has(file.name), `Not on release allowlist: ${file.name}`); inspectText(file.name, file.data.toString('utf8')); }
  const pkg = JSON.parse(files.find(f => f.name === 'package.json').data);
  assert.equal(pkg.name, 'deepseek-web-research-mcp'); assert.equal(pkg.license, 'MIT');
  assert.deepEqual(pkg.bin, { 'deepseek-web-research-mcp': 'dist/cli.js' });
  for (const deps of [pkg.dependencies, pkg.devDependencies]) for (const version of Object.values(deps)) assert.match(version, /^\d+\.\d+\.\d+$/, 'Dependencies must be registry versions pinned exactly');
  const lock = JSON.parse(files.find(f => f.name === 'npm-shrinkwrap.json').data);
  for (const [name, item] of Object.entries(lock.packages)) {
    assert.ok(!item.link, `Linked dependency: ${name}`);
    if (name) { assert.match(item.resolved, /^https:\/\/registry\.npmjs\.org\//, `Non-registry dependency: ${name}`); assert.ok(item.integrity, `Missing integrity: ${name}`); }
    if (name && !item.dev && !item.devOptional) assert.ok(!item.hasInstallScript, `Runtime dependency has a native/install script: ${name}`);
  }
  const cli = files.find(f => f.name === 'dist/cli.js').data.toString();
  assert.ok(cli.startsWith('#!/usr/bin/env node\n')); assert.ok(!cli.includes('sourceMappingURL='));
  return { version: pkg.version, name: pkg.name, files: files.map(f => f.name), runtime_install_scripts: false, local_path_dependencies: false, embedded_credentials: false };
}
async function main() {
  const npm = await npmCommand();
  const packed = spawnSync(npm.command, [...npm.prefix, 'pack', '--ignore-scripts', '--json', '--pack-destination', path.join(root, '.artifacts')], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(packed.status, 0, packed.stderr);
  const { filename } = JSON.parse(packed.stdout)[0];
  const result = inspectPackage(entries(await readFile(path.join(root, '.artifacts', filename))));
  async function sourceScan(dir) { for (const item of await readdir(dir, { withFileTypes: true })) { if (['node_modules', '.git', '.artifacts', 'dist'].includes(item.name)) continue; const file = path.join(dir, item.name); if (item.isDirectory()) await sourceScan(file); else inspectText(path.relative(root, file), await readFile(file, 'utf8')); } }
  await sourceScan(root);
  console.log(JSON.stringify({ ...result, public_source_scanned: true }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { mkdir } = await import('node:fs/promises'); await mkdir(path.join(root, '.artifacts'), { recursive: true }); await main();
}
