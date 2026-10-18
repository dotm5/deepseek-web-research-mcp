import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { stdin: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, report: { type: 'string' }, root: { type: 'string' } } });
if (values.help) { console.log('Usage: node scripts/check-secrets.mjs [--stdin] [--report=PATH] [--root=PATH]\nScans every Git object (including unreachable objects), index blobs and candidate working files. Optional stdin supplies an exact secret in memory; secret values are never reported.'); process.exit(0); }
const root = path.resolve(values.root ?? fileURLToPath(new URL('../', import.meta.url)));
let exact = '';
if (values.stdin) { for await (const chunk of process.stdin) { exact += chunk; if (exact.length > 1024) throw new Error('Secret input exceeds limit'); } exact = exact.trim(); if (!exact) throw new Error('Empty exact-secret input'); }
function git(args, encoding = 'utf8') { const result = spawnSync('git', args, { cwd: root, encoding, maxBuffer: 128*1024*1024, windowsHide: true }); if (result.status !== 0) throw new Error('Git inspection failed'); return result.stdout; }
const findings = [];
function scan(data, location) {
  const text = data.toString('utf8'), kinds = [];
  if (exact && data.includes(Buffer.from(exact))) kinds.push('exact-vault-secret');
  if (/sk-[a-f\d]{24,}/i.test(text) || /sk-(?:proj|svcacct)-[A-Za-z0-9_-]{30,}/.test(text)) kinds.push('provider-key');
  if (/(?:npm_[A-Za-z0-9]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/.test(text)) kinds.push('registry-or-github-token');
  if (/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/.test(text)) kinds.push('private-key');
  if (kinds.length) findings.push({ location, kinds });
}
let objectCount = 0, indexCount = 0, candidateCount = 0;
const stream = git(['cat-file','--batch-all-objects','--batch'], null);
for (let offset = 0; offset < stream.length;) {
  const end = stream.indexOf(10, offset); if (end < 0) throw new Error('Invalid Git object framing');
  const [oid, type, length] = stream.subarray(offset,end).toString().split(' '), size = Number(length);
  if (!Number.isSafeInteger(size) || size < 0 || end+1+size >= stream.length) throw new Error('Invalid Git object size');
  scan(stream.subarray(end+1,end+1+size), `git:${type}:${oid}`); objectCount++; offset = end+size+2;
}
for (const entry of git(['ls-files','--stage','-z']).split('\0').filter(Boolean)) {
  const match = entry.match(/^\d+ ([a-f\d]+) \d+\t([\s\S]+)$/); if (!match) throw new Error('Invalid index framing');
  scan(git(['cat-file','blob',match[1]], null), `index:${match[2]}`); indexCount++;
}
for (const name of git(['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean)) {
  try { scan(await readFile(path.join(root,name)), `worktree:${name}`); candidateCount++; } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const refs = git(['for-each-ref','--format=%(refname)']).trim().split('\n').filter(Boolean).length;
const history = spawnSync('git',['rev-list','--all','--count'],{cwd:root,encoding:'utf8',windowsHide:true});
const report = { timestamp: new Date().toISOString(), scope: 'All local Git objects including unreachable objects, staged blobs, and non-ignored tracked/untracked candidate files; known credential stays in memory.', refs, commits: history.status === 0 ? Number(history.stdout.trim() || 0) : 0, objects: objectCount, index_blobs: indexCount, candidate_files: candidateCount, exact_secret_checked: !!exact, findings, passed: findings.length === 0 };
exact = '';
if (values.report) { const output = path.resolve(root, values.report); await mkdir(path.dirname(output), {recursive:true}); await writeFile(output,JSON.stringify(report,null,2)+'\n'); }
console.log(JSON.stringify(report,null,2));
if (findings.length) process.exitCode = 1;
