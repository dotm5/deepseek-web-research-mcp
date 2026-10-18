import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SKIP = new Set(['.git', 'node_modules', '.venv', '.pytest_cache', '.ruff_cache', 'coverage', 'dist', 'work', '.work', '.artifacts']);
const BANNED = [
  '不能证明', '不能推出', '不能断言', '并不意味着', '不等于', '不能把', '仅能说明',
  '尚不能排除', '需要注意边界的是', '既不能', '而非', '并非', '其实', '顺手',
  '搞定', '撑到', '教训', '说白了', '咱们'
];
const SYMBOLS = ['⇒', '★', '☆', '✅', '❌', '⚠', '🔹', '「', '」'];
const USAGE = 'Usage: node tools/check-docs.mjs [--root PATH]';

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

function check(file) {
  const errors = [];
  let fence;
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      const kind = marker[1][0];
      fence = fence === kind ? undefined : (fence ?? kind);
      return;
    }
    if (!fence && line.trimStart().startsWith('>')) errors.push(`${index + 1}: blockquote`);
    if (!fence && /\*\*|__/.test(line)) errors.push(`${index + 1}: bold`);
    for (const word of BANNED) if (line.includes(word)) errors.push(`${index + 1}: banned phrase ${word}`);
    for (const symbol of SYMBOLS) if (line.includes(symbol)) errors.push(`${index + 1}: banned symbol ${symbol}`);
    if (/(?<![A-Za-z0-9])[A-Za-z]:[\\/]/.test(line)) errors.push(`${index + 1}: absolute local path`);
  });
  return errors;
}

const { values } = parseArgs({ options: { root: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const root = path.resolve(values.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
let failures = 0;
for (const file of markdownFiles(root)) {
  for (const error of check(file)) {
    failures++;
    console.log(`${path.relative(root, file)}:${error}`);
  }
}
if (failures) process.exit(1);
console.log('Documentation style OK');
