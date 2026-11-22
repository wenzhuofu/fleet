// Command output cleaning (ported from v1 workspace-core/src/output.ts OutputNormalizer):
// decode (UTF-8, falling back to CP936 per line), strip ANSI escapes, collapse
// carriage returns, drop control characters. Command output is then summarized
// (policy v2, summarizeOutput) with the full text archived; boundText (head 20%,
// tail 80% of 30,000 characters) remains the safety net and is used for Grep.
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const OUTPUT_MAX_CHARS = 30000;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const gbk = new TextDecoder('gb18030');

/** Decode bytes as UTF-8; any line that is not valid UTF-8 is decoded as CP936. */
export function decodeOutput(bytes) {
  try { return utf8.decode(bytes); } catch { /* fall back per line */ }
  const parts = [];
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i === bytes.length || bytes[i] === 0x0a) {
      const line = bytes.subarray(start, i);
      try { parts.push(utf8.decode(line)); } catch { parts.push(gbk.decode(line)); }
      start = i + 1;
    }
  }
  return parts.join('\n');
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function cleanText(text) {
  return text
    .replace(ANSI, '')
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => {
      const cr = line.lastIndexOf('\r', line.length - 2);
      const kept = cr >= 0 ? line.slice(cr + 1) : line;
      return kept.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    })
    .join('\n');
}

export function cleanOutput(bytes) {
  return cleanText(decodeOutput(bytes));
}

/**
 * Bound text to maxChars keeping the first 20% and last 80%.
 * `archive` is called with the full text and must return a display path.
 */
export async function boundText(text, archive, maxChars = OUTPUT_MAX_CHARS) {
  if (text.length <= maxChars) return { text, truncated: false };
  const where = await archive(text);
  const marker = `\n\n… [desk-node: ${text.length - maxChars} of ${text.length} chars omitted; full output: ${where}] …\n\n`;
  const budget = Math.max(0, maxChars - marker.length);
  const head = Math.floor(budget * 0.2), tail = budget - head;
  return { text: text.slice(0, head) + marker + text.slice(text.length - tail), truncated: true, archive: where };
}

export function archiver(dir, display) {
  return async (text) => {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.log`);
    await writeFile(file, text, { mode: 0o600 });
    return display(file);
  };
}

// Output policy v2 (Bash, BashJob): long output becomes head + key lines + tail.
export const SUMMARY = { maxLines: 120, maxChars: 6000, head: 20, tail: 60, keyLines: 20, lineMaxChars: 500 };
const KEY_LINE = /error|fail|exception|traceback|warn/i;
const kb = (n) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Clip one line to SUMMARY.lineMaxChars, saying how much was left out. */
export function clipLine(line, max = SUMMARY.lineMaxChars) {
  return line.length > max ? `${line.slice(0, max)}… [+${line.length - max} chars]` : line;
}

/**
 * Output within both limits passes through unchanged. Larger output is archived and
 * summarized as first 20 lines, up to 20 distinct matching middle lines, last 60 lines,
 * and a one-line footer. Line numbers are those of the archived text.
 * `archive(text)` stores the full text and returns its display path.
 */
export async function summarizeOutput(text, archive, S = SUMMARY) {
  const lines = text.split('\n');
  const big = lines.length > S.maxLines || text.length > S.maxChars;
  if (!big) return { text, truncated: false };
  const where = await archive(text);
  const bytes = Buffer.byteLength(text);
  const clip = (l) => clipLine(l, S.lineMaxChars);
  if (lines.length <= S.head + S.tail) {
    return { text: `${lines.map(clip).join('\n')}\n[desk-node: ${lines.length} lines, ${kb(bytes)}; shown 1-${lines.length}; full output: ${where}]`, truncated: true, archive: where };
  }
  const tailFrom = lines.length - S.tail;
  const seen = new Set(), keys = [];
  for (let i = S.head; i < tailFrom && keys.length < S.keyLines; i++) {
    if (!KEY_LINE.test(lines[i])) continue;
    const k = lines[i].trim();
    if (seen.has(k)) continue;
    seen.add(k);
    keys.push(`L${i + 1}: ${clip(lines[i])}`);
  }
  const out = [
    ...lines.slice(0, S.head).map(clip),
    `… [desk-node: lines ${S.head + 1}-${tailFrom} omitted${keys.length ? `; ${keys.length} of them match error|fail|exception|traceback|warn:` : ''}]`,
    ...keys,
    ...(keys.length ? ['…'] : []),
    ...lines.slice(tailFrom).map(clip),
    `[desk-node: ${lines.length} lines, ${kb(bytes)}; shown 1-${S.head}, ${tailFrom + 1}-${lines.length}${keys.length ? `, ${keys.length} matching lines` : ''}; full output: ${where}]`,
  ];
  return { text: out.join('\n'), truncated: true, archive: where };
}

/**
 * Archive retention: delete *.log under `dirs` older than maxAgeMs, then the oldest
 * until the total is under maxBytes. `keep(file)` protects files still in use.
 */
export async function pruneOutputs(dirs, { maxAgeMs = 7 * 24 * 3600 * 1000, maxBytes = 1024 ** 3, keep = () => false } = {}) {
  const files = [];
  for (const dir of dirs) {
    let names;
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.log')) continue;
      const file = path.join(dir, name);
      try { const st = await stat(file); if (st.isFile()) files.push({ file, size: st.size, mtime: st.mtimeMs }); } catch { /* gone */ }
    }
  }
  files.sort((a, b) => a.mtime - b.mtime);
  let total = files.reduce((n, f) => n + f.size, 0), removed = 0, freed = 0;
  const cutoff = Date.now() - maxAgeMs;
  for (const f of files) {
    if (!(f.mtime < cutoff || total > maxBytes) || keep(f.file)) continue;
    try { await unlink(f.file); removed++; freed += f.size; total -= f.size; } catch { /* in use or gone */ }
  }
  return { removed, freed, total };
}
