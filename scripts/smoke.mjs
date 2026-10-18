import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import Ajv from 'ajv/dist/2020.js';

if (process.argv.includes('--help')) { console.log('Usage: node scripts/smoke.mjs [--live] [--entry=PATH] [--node=PATH] [--output=PATH]'); process.exit(0); }
const live = process.argv.includes('--live'), entry = process.argv.find(v => v.startsWith('--entry='))?.slice(8) ?? path.resolve('dist/cli.js');
const node = process.argv.find(v => v.startsWith('--node='))?.slice(7) ?? process.execPath;
const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k !== 'DEEPSEEK_API_KEY' && typeof v === 'string'));
const report = { timestamp: new Date().toISOString(), node: process.version, entry: path.basename(entry), live, server_versions: [], schemas: [], calls: [], api_requests: 0 };
async function session(all, fn) {
  const client = new Client({ name: 'deepseek-smoke', version: '0.4.1' });
  const transport = new StdioClientTransport({ command: node, args: [entry, ...(all ? ['--tools=all'] : [])], env, stderr: 'pipe' });
  let errors = ''; transport.stderr?.on('data', d => { errors += d; });
  try { await client.connect(transport); report.server_versions.push(client.getServerVersion()); await fn(client); } catch (error) { throw new Error(`${error.message}\nServer stderr: ${errors}`); } finally { await client.close(); if (errors && !/ExperimentalWarning: SQLite/.test(errors)) report.stderr = errors; }
}
await session(false, async client => { const tools = (await client.listTools()).tools; assert.equal(tools.length, 3); report.default_tools = tools.map(t => t.name); });
await session(true, async client => {
  const tools = (await client.listTools()).tools; assert.equal(tools.length, 10);
  const ajv = new Ajv({ strict: false, validateFormats: false });
  for (const tool of tools) { assert.equal(tool.inputSchema.type, 'object'); assert.equal(tool.inputSchema.additionalProperties, false); ajv.compile(tool.inputSchema); report.schemas.push({ name: tool.name, valid: true, required: tool.inputSchema.required ?? [] }); }
  assert.equal(tools.find(t => t.name === 'deepseek_search').inputSchema.properties.query.maxLength, 128);
  const invalid = await client.callTool({ name: 'deepseek_search', arguments: { query: 'test', count: 51 } }); assert.equal(invalid.isError, true); report.invalid_arguments_rejected = true;
  if (!live) return;
  for (const call of [
    { name: 'deepseek_search', arguments: { query: 'site:api-docs.deepseek.com search after:2025-01-01', count: 2, need_content: true, max_characters: 1000, force_refresh: true, request_budget: 2 } },
    { name: 'deepseek_extract', arguments: { urls: ['https://api-docs.deepseek.com/zh-cn/api/search/', 'https://api-docs.deepseek.com/zh-cn/api/fetch/'], query: 'query count need_content url', max_characters: 2000, chunks_per_source: 3, force_refresh: true, request_budget: 3 } }
  ]) {
    const response = await client.callTool(call); assert.notEqual(response.isError, true, JSON.stringify(response));
    const result = response.structuredContent ?? JSON.parse(response.content.find(c => c.type === 'text').text);
    assert.ok(result.results.length > 0); report.api_requests += result.meta.api_requests;
    report.calls.push({ name: call.name, results: result.results.map(r => ({ title: r.title, url: r.url, content_length: r.content.length, truncated: r.truncated, original_length: r.original_length })), failed_results: result.failed_results, meta: result.meta });
  }
});
assert.ok(report.api_requests <= 5);
await mkdir('evidence', { recursive: true });
await writeFile(process.argv.find(v => v.startsWith('--output='))?.slice(9) ?? (live ? 'evidence/live.json' : 'evidence/schema.json'), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
