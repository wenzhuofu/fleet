// Launch the upgrader (upgrade.mjs) detached from desk-node: Win32_Process.Create makes it a
// child of the WMI host, outside desk-node's process tree and its scheduled task, so the
// restart it performs cannot kill it.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeskError } from './errors.mjs';

const LOCK_STALE_MS = 10 * 60 * 1000;

export async function startUpgrade({ home, packageName, version }) {
  if (!/^desk-node-[\w.+-]+\.tar\.gz$/.test(packageName)) throw new DeskError('BAD_REQUEST', 'package must be a desk-node-<version>.tar.gz name in C:\\desk-node\\incoming');
  if (!/^[\w.+-]+$/.test(version)) throw new DeskError('BAD_REQUEST', 'Invalid version');
  const pkg = path.join(home, 'incoming', packageName);
  await stat(pkg).catch(() => { throw new DeskError('NOT_FOUND', `Package not uploaded: ${pkg}`); });
  const lock = path.join(home, 'logs', 'upgrade.lock');
  const held = await stat(lock).catch(() => null);
  if (held && Date.now() - held.mtimeMs < LOCK_STALE_MS) throw new DeskError('UPGRADE_RUNNING', `Another upgrade is running (${(await readFile(lock, 'utf8')).trim()})`, 'Wait for it to finish');
  const id = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomUUID().slice(0, 6)}`;
  await writeFile(lock, id);

  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'upgrade.mjs');
  const q = (s) => `"${s}"`;
  const commandLine = [process.execPath, script, '--home', home, '--package', pkg, '--version', version, '--id', id].map(q).join(' ');
  const psLiteral = (s) => `'${s.replaceAll("'", "''")}'`;
  const command = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psLiteral(commandLine)}; CurrentDirectory = ${psLiteral(home)} }; if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create returned $($r.ReturnValue)" }; $r.ProcessId`;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const pid = await new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
      if (error) reject(new DeskError('UPGRADE_FAILED', `Cannot start the upgrader: ${stderr || error.message}`));
      else resolve(Number(stdout.trim()));
    });
  }).catch(async (error) => { await rm(lock, { force: true }); throw error; });
  return { text: `Upgrade ${id} started (pid ${pid}): -> ${version}`, data: { id, pid } };
}

export async function readUpgrade(home, id) {
  if (!/^[\w-]+$/.test(id)) throw new DeskError('BAD_REQUEST', 'Invalid upgrade id');
  try {
    const result = JSON.parse(await readFile(path.join(home, 'logs', `upgrade-${id}.json`), 'utf8'));
    return { text: `Upgrade ${id}: ${result.result}`, data: { state: 'done', ...result } };
  } catch (error) {
    if (error.code === 'ENOENT') return { text: `Upgrade ${id}: running`, data: { state: 'running' } };
    throw error;
  }
}
