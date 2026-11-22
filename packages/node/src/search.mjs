// Glob (ported from v1 deskd/src/mcp-readonly.ts) and Grep (bundled ripgrep).
import { spawn } from 'node:child_process';
import { glob, stat } from 'node:fs/promises';
import path from 'node:path';
import { DeskError } from './errors.mjs';
import { cleanOutput, cleanText, decodeOutput } from './output.mjs';

const GLOB_LIMIT = 100, GLOB_SCAN_LIMIT = 50000;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

export async function runGlob(paths, { pattern, path: dir }, signal) {
  if (typeof pattern !== 'string' || !pattern.trim()) throw new DeskError('BAD_REQUEST', 'pattern is required');
  if (/^([a-zA-Z]:|[\\/])/.test(pattern)) throw new DeskError('BAD_REQUEST', 'pattern must be relative', 'Put the directory in "path" and keep "pattern" relative, e.g. {"path":"D:/x","pattern":"**/*.ts"}');
  const base = await paths.check(dir ?? paths.defaultDir);
  const found = [];
  let scanned = 0, complete = true;
  // Do not descend into blocked or denied directories at all.
  const exclude = (entry) => (typeof entry === 'string'
    ? SKIP_DIRS.has(path.basename(entry)) || paths.isBlocked(path.win32.resolve(base, entry))
    : SKIP_DIRS.has(entry.name) || paths.isBlocked(path.win32.join(entry.parentPath, entry.name)));
  for await (const entry of glob(pattern.replaceAll('\\', '/'), { cwd: base, withFileTypes: true, exclude })) {
    if (++scanned > GLOB_SCAN_LIMIT || signal?.aborted) { complete = false; break; }
    if (!entry.isFile()) continue;
    const abs = path.win32.join(entry.parentPath, entry.name);
    if (paths.isBlocked(abs)) continue;
    try { found.push({ abs, mtime: (await stat(abs)).mtimeMs }); } catch { /* vanished or inaccessible */ }
  }
  found.sort((a, b) => b.mtime - a.mtime || a.abs.localeCompare(b.abs));
  const shown = found.slice(0, GLOB_LIMIT).map((f) => paths.display(f.abs));
  const lines = shown.length ? [...shown] : ['No files found'];
  if (found.length > GLOB_LIMIT) lines.push(`[desk-node: ${found.length - GLOB_LIMIT} more matches omitted; narrow the pattern]`);
  if (!complete) lines.push('[desk-node: scan stopped early; narrow the pattern or path]');
  return { text: lines.join('\n'), data: { matched: found.length, complete } };
}

export async function runGrep(paths, rg, args, signal) {
  const { pattern } = args;
  if (typeof pattern !== 'string' || !pattern) throw new DeskError('BAD_REQUEST', 'pattern is required');
  const target = await paths.check(args.path ?? paths.defaultDir);
  const mode = args.output_mode ?? 'files_with_matches';
  // --null: each path ends in NUL, so it can be checked against blocked/denied exactly.
  const argv = ['--no-config', '--color', 'never', '--no-heading', '--with-filename', '--null', '--path-separator', '/', '--max-columns', '1000', '--max-columns-preview'];
  if (mode === 'files_with_matches') argv.push('--files-with-matches');
  else if (mode === 'count') argv.push('--count');
  else if (mode === 'content') {
    if (args['-n'] !== false) argv.push('--line-number');
    for (const flag of ['-A', '-B', '-C']) if (Number.isInteger(args[flag])) argv.push(flag, String(args[flag]));
  } else throw new DeskError('BAD_REQUEST', `Unknown output_mode: ${mode}`, 'Use content, files_with_matches or count');
  if (args['-i']) argv.push('--ignore-case');
  if (args.multiline) argv.push('--multiline', '--multiline-dotall');
  if (typeof args.glob === 'string') argv.push('--glob', args.glob);
  if (typeof args.type === 'string') argv.push('--type', args.type);
  argv.push('--regexp', pattern);
  // Search relative to the default directory so output paths come out in display form.
  const shown = paths.display(target);
  if (shown !== '.') argv.push('--', shown);

  const { stdout, stderr, code } = await new Promise((resolve, reject) => {
    const child = spawn(rg, argv, { cwd: paths.defaultDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', (e) => reject(new DeskError('INTERNAL', `Cannot run ripgrep: ${e.message}`)));
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('close', (c) => { signal?.removeEventListener('abort', onAbort); resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), code: c }); });
  });
  if (signal?.aborted) throw new DeskError('CANCELLED', 'Grep was cancelled by the caller');
  if (code === 2 && !stdout.length) throw new DeskError('GREP_FAILED', cleanOutput(stderr).trim() || 'ripgrep failed');
  let lines = grepLines(paths, decodeOutput(stdout), mode === 'files_with_matches');
  const total = lines.length;
  if (Number.isInteger(args.head_limit) && args.head_limit > 0) lines = lines.slice(0, args.head_limit);
  if (!lines.length) return { text: 'No matches found', data: { matches: 0 } };
  if (total > lines.length) lines.push(`[desk-node: ${total - lines.length} more lines omitted by head_limit]`);
  return { text: lines.join('\n'), data: { lines: total } };
}

/** ripgrep --null output -> display lines without blocked/denied files ("path:rest", or "path"). */
export function grepLines(paths, text, pathsOnly) {
  const allowed = (p) => !paths.isBlocked(paths.resolve(p));
  if (pathsOnly) return text.split(/[\0\n]/).filter((p) => p && allowed(p)).map(cleanText);
  const lines = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const nul = line.indexOf('\0');
    if (nul < 0) { lines.push(cleanText(line)); continue; } // "--" between context groups
    const file = line.slice(0, nul);
    if (allowed(file)) lines.push(cleanText(`${file}:${line.slice(nul + 1)}`));
  }
  // Drop separators left without neighbours by the filter.
  return lines.filter((l, i) => l !== '--' || (i > 0 && i < lines.length - 1 && lines[i - 1] !== '--'));
}
