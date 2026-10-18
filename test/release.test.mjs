import { describe, it, expect } from 'vitest';
import { inspectText } from '../scripts/check-package.mjs';

describe('public artifact scanning', () => {
  it('rejects a provider key without logging its value', () => {
    const secret = 'sk-' + 'a'.repeat(32);
    expect(() => inspectText('cli.js', secret)).toThrow('Possible API credential');
    try { inspectText('cli.js', secret); } catch (error) { expect(error.message).not.toContain(secret); }
  });
  it('rejects raw and JSON-escaped personal paths', () => {
    const personal = 'C:' + '\\Users\\someone\\checkout';
    expect(() => inspectText('cli.js', personal)).toThrow('Personal Windows path');
    expect(() => inspectText('cli.js', JSON.stringify(personal))).toThrow('Personal Windows path');
    expect(() => inspectText('cli.js', '/home/' + 'someone/checkout')).toThrow('Personal Unix path');
  });
  it('allows portable config examples and synthetic unit credentials', () => {
    expect(() => inspectText('README.md', '%LOCALAPPDATA%/deepseek-web-research-mcp')).not.toThrow();
    expect(() => inspectText('test.ts', 'sk-synthetic-unit-credential')).not.toThrow();
  });
});
