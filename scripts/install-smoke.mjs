import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { npmCommand, root, entries, inspectPackage } from './check-package.mjs';

const live = process.argv.includes('--live');
let key = '';
if (live) { assert.ok(!process.stdin.isTTY, 'For live login, pipe the key to this script through stdin'); for await (const chunk of process.stdin) { key += chunk; assert.ok(key.length < 1024); } key = key.trim(); assert.match(key, /^sk-[A-Za-z0-9_-]{12,256}$/); }
const temp = await mkdtemp(path.join(tmpdir(), 'deepseek-install-'));
const npm = await npmCommand(), metadata = JSON.parse(await readFile(path.join(root, 'package.json'))), bin = metadata.name;
const home = path.join(temp, 'home'), data = path.join(temp, 'private-data'), cache = path.join(temp, 'npx-cache'), fakeBin = path.join(temp, 'bin');
await mkdir(home, { recursive: true }); await mkdir(fakeBin, { recursive: true });
const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'local'), APPDATA: path.join(home, 'roaming'), XDG_CONFIG_HOME: path.join(home, '.config'), DEEPSEEK_MCP_HOME: data, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, npm_config_cache: cache, npm_config_userconfig: path.join(home, '.npmrc'), npm_config_registry: 'https://registry.npmjs.org/' };
delete env.DEEPSEEK_API_KEY; delete env.NODE_OPTIONS; delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME;
await writeFile(env.npm_config_userconfig, '');
const checks = [];
function check(name, condition) { assert.ok(condition, name); checks.push({ name, passed: true }); process.stderr.write(`PASS ${name}\n`); }
function run(args, input = '', expected = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(npm.command, [...npm.prefix, ...args], { cwd: temp, env, windowsHide: true, stdio: 'pipe' });
    let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Install acceptance timed out')); }, 120000);
    child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d); child.on('error', reject); child.stdin.on('error', () => {}); child.stdin.end(input);
    child.on('close', code => { clearTimeout(timer); if (key && (stdout.includes(key) || stderr.includes(key))) return reject(new Error('Credential appeared in CLI output')); if (code !== expected) return reject(new Error(`CLI failed (exit ${code}); ${stderr.replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')}`)); resolve({ stdout, stderr }); });
  });
}
let artifact, packageAudit;
const cli = async (args, input = '', expected = 0) => {
  const result = await run(['exec', '--yes', '--package', artifact, '--', bin, ...args], input, expected);
  return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
};
try {
  artifact = path.join(temp, `${bin}-${metadata.version}.tgz`);
  const packed = await run(['pack', root, '--ignore-scripts', '--json', '--pack-destination', temp]);
  artifact = path.join(temp, JSON.parse(packed.stdout)[0].filename);
  packageAudit = inspectPackage(entries(await readFile(artifact)));
  // Stub only Agent configuration commands. npm, npx, CLI, SQLite and OS vault are real.
  const stub = `import fs from 'node:fs';import path from 'node:path';const a=process.argv.slice(2),name=path.basename(process.argv[1],'.js'),home=process.env.USERPROFILE||process.env.HOME;const file=name==='claude'?path.join(home,'.claude.json'):path.join(home,'.codex/config.toml');if(a.includes('--help'))process.exit(0);if(a[0]!=='mcp'||!['add','remove'].includes(a[1]))process.exit(2);let doc={};try{doc=JSON.parse(fs.readFileSync(file,'utf8'))}catch{};fs.mkdirSync(path.dirname(file),{recursive:true});if(name==='claude'){doc.mcpServers??={};if(a[1]==='remove')delete doc.mcpServers['deepseek-search'];else doc.mcpServers['deepseek-search']={command:'node',args:[a.at(-1)]};fs.writeFileSync(file,JSON.stringify(doc));}else fs.writeFileSync(file,'model = "preserved"\\n[mcp_servers.deepseek-search]\\ncommand = "node"\\nargs = ['+JSON.stringify(a.at(-1))+']\\n');`;
  for (const name of ['claude', 'codex']) {
    const folder = path.join(fakeBin, 'node_modules/stub-agent'); await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, 'package.json'), '{"type":"module"}'); await writeFile(path.join(folder, `${name}.js`), stub);
    if (process.platform === 'win32') await writeFile(path.join(fakeBin, `${name}.cmd`), `@echo off\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\stub-agent\\${name}.js" %*\r\n`);
    else { const target = path.join(fakeBin, name); await writeFile(target, `#!/usr/bin/env node\n${stub.replace("path.basename(process.argv[1],'.js')", JSON.stringify(name))}`); await chmod(target, 0o755); }
  }
  await mkdir(path.join(home, '.codex'), { recursive: true });
  await writeFile(path.join(home, '.claude.json'), '{"theme":"preserved","mcpServers":{"other":{"command":"preserved"}}}');
  await writeFile(path.join(home, '.codex/config.toml'), 'model = "preserved"\n');
  check('npx installed the expected package version', (await cli(['--version'])).version === metadata.version);
  check('fresh profile has no credential', !(await cli(['auth', 'status'])).configured);
  await cli(['auth', 'login', '--stdin'], '\n', 1);
  await cli(['auth', 'login', 'sk-synthetic-not-a-real-key'], '', 1);
  check('empty stdin and key-in-argv login are rejected', !(await cli(['auth', 'status'])).configured);
} catch (error) {
  await rm(temp, { recursive: true, force: true }); throw error;
}
try {
  if (live) {
    const login = await cli(['auth', 'login', '--stdin'], key + '\n');
    check('live npx auth login validates and saves in OS vault', login.configured && login.validation.ok && login.validation.api_requests === 1);
    check('npx auth status reads credential across processes', (await cli(['auth', 'status'])).configured);
  }
  const plan = await cli(['setup', '--dry-run']);
  check('setup dry-run detects isolated Claude and Codex', plan.plan.length === 2 && plan.keyless);
  const setup = await cli(['setup']);
  check('setup uses both native CLI management interfaces', setup.registrations.length === 2 && setup.registrations.every(r => r.status === 'registered-native-cli'));
  const stable = path.join(data, 'runtime/node_modules', bin, 'dist/cli.js');
  check('managed runtime is outside npx cache', setup.entry === stable && !stable.startsWith(cache));
  const claude = JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8'));
  check('setup preserves unrelated Claude settings', claude.theme === 'preserved' && claude.mcpServers.other.command === 'preserved');
  check('registration contains only command and args', Object.keys(claude.mcpServers['deepseek-search']).sort().join(',') === 'args,command');
  const doctor = await cli(['doctor', ...(live ? [] : ['--offline'])]);
  check('doctor verifies both keyless current registrations', doctor.harnesses.filter(h => ['claude', 'codex'].includes(h.name)).every(h => h.current && h.keyless));
  if (live) check('doctor performs one successful real Search request', doctor.api.ok && doctor.api.api_requests === 1);
  await cli(['setup']); // Existing registration must be replaceable.
  check('repeat setup succeeds', true);
  if (live) { await cli(['auth', 'logout']); check('logout removes isolated vault credential', !(await cli(['auth', 'status'])).configured); }
  await rm(cache, { recursive: true, force: true }); await rm(artifact, { force: true });
  const client = new Client({ name: 'clean-install-check', version: metadata.version });
  const transport = new StdioClientTransport({ command: process.execPath, args: [stable, '--tools=all'], env, stderr: 'pipe' });
  try {
    await client.connect(transport); check('managed MCP survives deletion of npx cache and tarball', (await client.listTools()).tools.length === 10);
    if (!live) { const result = await client.callTool({ name: 'deepseek_search', arguments: { query: 'test' } }); check('missing key error guides to correct npm package', result.isError && JSON.stringify(result).includes(`npx ${bin} auth login`)); }
  } finally { await client.close(); }
  const report = { version: metadata.version, platform: process.platform, node: process.version, live, api_requests: live ? 2 : 0, cli_sha256: createHash('sha256').update(await readFile(stable)).digest('hex'), package_audit: packageAudit, checks, scope: 'Real npm exec/npx install and managed MCP process; isolated stub Agent management CLIs. Live mode adds two real API calls and OS-vault login/logout. No existing user configuration is changed.' };
  await mkdir(path.join(root, 'evidence'), { recursive: true }); await writeFile(path.join(root, 'evidence', live ? 'install-live.json' : 'install.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { key = ''; await rm(temp, { recursive: true, force: true }); }
