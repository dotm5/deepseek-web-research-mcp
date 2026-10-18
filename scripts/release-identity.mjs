import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
assert.equal(process.env.RELEASE_TAG, `v${pkg.version}`, 'Selected tag must match package version');
assert.ok(process.env.GITHUB_REPOSITORY, 'Run from the publishing GitHub repository');
assert.equal(pkg.repository?.url, `git+https://github.com/${process.env.GITHUB_REPOSITORY}.git`, 'Set package repository.url to the actual GitHub repository before publishing');
console.log(`Release identity verified: ${pkg.name}@${pkg.version}`);
