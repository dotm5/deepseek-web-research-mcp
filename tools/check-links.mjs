import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SKIP = new Set(['.git', 'node_modules', '.venv', '.pytest_cache', '.ruff_cache', 'coverage', 'dist', 'work', '.work', '.artifacts']);
const USAGE = 'Usage: node tools/check-links.mjs [--root PATH]';

function markdownFiles(root) {
  const files = [];
  const walk = directory => {
    for (const entry of readdirSync(directory)) {
      if (SKIP.has(entry)) continue;
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.md')) files.push(full);
    }
  };
  walk(root);
  return files;
}

function links(text) {
  const found = [];
  let fence;
  text.split(/\r?\n/).forEach((line, index) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      const kind = marker[1][0];
      fence = fence === kind ? undefined : (fence ?? kind);
      return;
    }
    if (fence) return;
    for (const match of line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)/g)) found.push([index + 1, match[1]]);
    const definition = line.match(/^\s{0,3}\[[^\]]+\]:\s*(\S+)/);
    if (definition) found.push([index + 1, definition[1]]);
  });
  return found;
}

function check(root) {
  const errors = [];
  for (const file of markdownFiles(root)) {
    for (const [line, raw] of links(readFileSync(file, 'utf8'))) {
      const target = raw.replace(/^<|>$/g, '');
      if (!target || /^(#|https?:\/\/|mailto:|tel:|data:)/.test(target)) continue;
      const relative = decodeURIComponent(target.split('#')[0].split('?')[0]);
      if (!relative) continue;
      if (!existsSync(path.resolve(path.dirname(file), relative))) errors.push(`${path.relative(root, file)}:${line}: missing ${target}`);
    }
  }
  return errors;
}

const { values } = parseArgs({ options: { root: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const root = path.resolve(values.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const errors = check(root);
for (const error of errors) console.log(error);
if (errors.length) process.exit(1);
console.log('Relative links OK');
