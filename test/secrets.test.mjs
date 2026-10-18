import { it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('../scripts/check-secrets.mjs', import.meta.url));
async function fixture(test) {
  const prefix = path.join(tmpdir(), 'deepseek-secret-test-'), dir = await mkdtemp(prefix);
  try { expect(spawnSync('git',['init','--quiet'],{cwd:dir}).status).toBe(0); await test(dir); }
  finally { if (!path.resolve(dir).startsWith(path.resolve(prefix))) throw new Error('Unexpected fixture path'); await rm(dir,{recursive:true,force:true}); }
}
it('detects an unreachable credential blob without printing its contents', async () => {
  await fixture(async dir => {
    const secret = 'sk-' + 'ab'.repeat(16);
    expect(spawnSync('git',['hash-object','-w','--stdin'],{cwd:dir,input:secret}).status).toBe(0);
    const run = spawnSync(process.execPath,[scanner,`--root=${dir}`],{encoding:'utf8'});
    expect(run.status).toBe(1); expect(run.stdout).not.toContain(secret);
    const report = JSON.parse(run.stdout); expect(report.commits).toBe(0); expect(report.objects).toBe(1);
    expect(report.findings[0].location).toMatch(/^git:blob:/); expect(report.passed).toBe(false);
  });
});
it('checks exact stdin secrets in staged and untracked files without storing the input', async () => {
  await fixture(async dir => {
    const secret = ['exact','synthetic','marker'].join('-');
    await writeFile(path.join(dir,'staged.txt'),secret); await writeFile(path.join(dir,'untracked.txt'),secret);
    expect(spawnSync('git',['add','--','staged.txt'],{cwd:dir}).status).toBe(0);
    const run = spawnSync(process.execPath,[scanner,`--root=${dir}`,'--stdin'],{input:secret,encoding:'utf8'});
    expect(run.status).toBe(1); expect(run.stdout).not.toContain(secret);
    const report = JSON.parse(run.stdout); expect(report.exact_secret_checked).toBe(true);
    expect(report.findings.some(f=>f.location==='index:staged.txt')).toBe(true);
    expect(report.findings.some(f=>f.location==='worktree:untracked.txt')).toBe(true);
  });
});
