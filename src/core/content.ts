import { cpLength } from './common.js';

/** Some provider pages escape every Markdown structural marker. Decode exactly one layer only when structural evidence agrees. */
export function markdown(value: string) {
  return (value.match(/(?:^|\n)\s*(?:\\#{1,6}|\\`\\`\\`|\\\|)/g)?.length ?? 0) >= 2 ? value.replace(/\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])/g, '$1') : value;
}
export function blocks(value: string) {
  const result: string[] = []; let current: string[] = [], fence = '', heading = '';
  const flush = () => { if (current.length) result.push((heading ? heading + '\n\n' : '') + current.join('\n')); current = []; };
  for (const line of value.split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) { current.push(line); if (!fence) fence = marker[1][0]; else if (fence === marker[1][0]) { fence = ''; flush(); } continue; }
    if (!fence && /^#{1,6}\s/.test(line)) { flush(); heading = line; continue; }
    if (!fence && !line.trim()) { flush(); continue; } current.push(line);
  }
  flush(); return result;
}
export function terms(text: string) { return [...text.toLowerCase().matchAll(/[a-z\d_]+|[\p{Script=Han}]{1,2}/gu)].map(m => m[0]); }
export function selectChunks(content: string, query: string | undefined, count: number, max: number, codeLanguage?: string) {
  const pieces = blocks(markdown(content)), tokenized = pieces.map(terms), wanted = [...new Set(terms(query ?? ''))];
  const avg = tokenized.reduce((sum, t) => sum + t.length, 0) / Math.max(1, pieces.length);
  const ranked = pieces.map((text, index) => {
    const tokens = tokenized[index]; let score = 0;
    for (const term of wanted) { const df = tokenized.filter(t => t.includes(term)).length, tf = tokens.filter(t => t === term).length; score += Math.log(1 + (pieces.length - df + 0.5) / (df + 0.5)) * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * tokens.length / Math.max(1, avg))); }
    if (codeLanguage && new RegExp('```' + codeLanguage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(text)) score += 3;
    return { text, index, score };
  }).sort((a, b) => query || codeLanguage ? b.score - a.score || a.index - b.index : a.index - b.index);
  const selected: typeof ranked = []; let used = 0;
  for (const piece of ranked) { const size = cpLength(piece.text) + (selected.length ? 2 : 0); if (selected.length >= count) break; if (used + size <= max) { selected.push(piece); used += size; } else if (!/```|~~~|^\s*\|/m.test(piece.text) && max - used > 80) { selected.push({ ...piece, text: Array.from(piece.text).slice(0, max - used - (selected.length ? 2 : 0)).join('') }); used = max; } }
  return selected.map(p => ({ content: p.text, score: p.score, index: p.index }));
}
export function plainText(value: string) {
  const preserved: string[] = [];
  const saved = value.replace(/(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\1|`([^`]+)`/g, (_m, _f, body, inline) => { const id = preserved.push(body ?? inline) - 1; return `\u0000${id}\u0000`; });
  return saved.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\u0000(\d+)\u0000/g, (_m, i) => preserved[Number(i)]);
}
