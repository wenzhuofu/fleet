// Text encoding, ETag and Edit semantics (ported from v1 workspace-core/src/index.ts
// and workspace-win/src/files.ts). GBK uses ICU's TextDecoder plus a generated
// reverse table instead of iconv-lite.
import { createHash } from 'node:crypto';
import { DeskError } from './errors.mjs';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export function etag(bytes) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

/** Detect encoding/BOM/EOL and return text with LF line endings. */
export function decode(bytes) {
  let kind = 'utf8', bom = Buffer.alloc(0), body = bytes;
  if (bytes.subarray(0, 3).equals(UTF8_BOM)) { bom = bytes.subarray(0, 3); body = bytes.subarray(3); }
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) { kind = 'utf16le'; bom = bytes.subarray(0, 2); body = bytes.subarray(2); }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { kind = 'utf16be'; bom = bytes.subarray(0, 2); body = bytes.subarray(2); }
  if (kind === 'utf8' && body.includes(0)) throw new DeskError('BINARY', 'Binary file cannot be read as text');
  let text;
  if (kind === 'utf8') {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); }
    catch { kind = 'gb18030'; text = new TextDecoder('gb18030').decode(body); }
  } else {
    text = new TextDecoder(kind === 'utf16le' ? 'utf-16le' : 'utf-16be').decode(body);
  }
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return { kind, bom: Buffer.from(bom), eol: crlf > lf ? 'CRLF' : 'LF', text: text.replaceAll('\r\n', '\n') };
}

/** Encode text back using the original file's encoding, BOM and EOL. */
export function encode(text, format) {
  let body = text.replaceAll('\r\n', '\n');
  if (format.eol === 'CRLF') body = body.replaceAll('\n', '\r\n');
  let bytes;
  switch (format.kind) {
    case 'utf8': bytes = Buffer.from(body, 'utf8'); break;
    case 'utf16le': bytes = Buffer.from(body, 'utf16le'); break;
    case 'utf16be': bytes = Buffer.from(body, 'utf16le').swap16(); break;
    case 'gb18030': bytes = encodeGbk(body); break;
    default: throw new DeskError('INTERNAL', `Unknown encoding ${format.kind}`);
  }
  return Buffer.concat([format.bom, bytes]);
}

let gbkTable;
function encodeGbk(text) {
  if (!gbkTable) {
    gbkTable = new Map();
    const decoder = new TextDecoder('gbk');
    for (let lead = 0x81; lead <= 0xfe; lead++) {
      for (let trail = 0x40; trail <= 0xfe; trail++) {
        if (trail === 0x7f) continue;
        const ch = decoder.decode(Buffer.from([lead, trail]));
        if (ch.length === 1 && ch !== '�' && !gbkTable.has(ch)) gbkTable.set(ch, [lead, trail]);
      }
    }
  }
  const out = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x80) { out.push(code); continue; }
    const pair = gbkTable.get(ch);
    if (!pair) throw new DeskError('ENCODING', `Character U+${code.toString(16).toUpperCase()} cannot be encoded in this GBK file`, 'Remove the character, or convert the file to UTF-8 first');
    out.push(pair[0], pair[1]);
  }
  return Buffer.from(out);
}

export function edit(text, oldString, newString, replaceAll = false) {
  if (oldString === newString) throw new DeskError('EDIT_NOOP', 'The old and new strings are identical');
  if (!oldString) throw new DeskError('EDIT_NO_MATCH', 'The string to replace is empty');
  const pieces = text.split(oldString), count = pieces.length - 1;
  if (!count) throw new DeskError('EDIT_NO_MATCH', 'The string to replace was not found', 'Read the file again and copy old_string exactly');
  if (count > 1 && !replaceAll) throw new DeskError('EDIT_AMBIGUOUS', `Found ${count} matches of the string to replace, but replace_all is false`, 'Add surrounding context to old_string, or set replace_all');
  return { text: pieces.join(newString), replacements: count };
}

/** Per-session record of what was read; enforces READ_REQUIRED / STALE_ETAG before writes. */
export class ReadState {
  constructor(max = 20000) { this.max = max; this.values = new Map(); }
  key(sid, abs) { return `${sid}\0${abs.toLowerCase()}`; }
  record(sid, abs, tag) {
    const key = this.key(sid, abs);
    this.values.delete(key);
    this.values.set(key, tag);
    if (this.values.size > this.max) this.values.delete(this.values.keys().next().value);
  }
  require(sid, abs, current) {
    const read = this.values.get(this.key(sid, abs));
    if (!read) throw new DeskError('READ_REQUIRED', 'File has not been read yet. Read it first before writing to it.', 'Call Read on this file, then retry');
    if (read !== current) throw new DeskError('STALE_ETAG', 'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.', 'Call Read on this file again, then retry');
  }
}

/** Format lines like `cat -n`, bounded by a token budget (CJK = 1, other = 0.25; from v1 boundRead). */
export function formatRead(text, offset = 1, limit = 2000, { lineMaxChars = 2000, tokenBudget = 25000 } = {}) {
  if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1) throw new DeskError('BAD_REQUEST', 'offset and limit must be positive integers');
  if (!text) return { text: '(file exists but is empty)', totalLines: 0, numLines: 0, truncated: false };
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const out = [];
  let tokens = 0, clipped = false;
  for (let i = offset - 1; i < Math.min(lines.length, offset - 1 + limit); i++) {
    let line = lines[i];
    if (line.length > lineMaxChars) { line = line.slice(0, lineMaxChars) + `… [+${line.length - lineMaxChars} chars]`; clipped = true; }
    let cost = 0;
    for (const ch of line) cost += /[⺀-鿿가-힯＀-￯]/u.test(ch) ? 1 : 0.25;
    if (out.length && tokens + cost > tokenBudget) break;
    tokens += cost;
    out.push(`${String(i + 1).padStart(6)}\t${line}`);
  }
  const last = offset - 1 + out.length;
  const truncated = clipped || last < lines.length;
  if (offset > lines.length) return { text: `(file has ${lines.length} lines; offset ${offset} is past the end)`, totalLines: lines.length, numLines: 0, truncated: false };
  let result = out.join('\n');
  if (last < lines.length) result += `\n[desk-node: showing lines ${offset}-${last} of ${lines.length}; continue with offset=${last + 1} (limit up to 2000), or Grep this file with -C 3 for what you need]`;
  if (clipped) result += `\n[desk-node: lines over ${lineMaxChars} chars were clipped; file has ${lines.length} lines]`;
  return { text: result, totalLines: lines.length, numLines: out.length, truncated };
}
