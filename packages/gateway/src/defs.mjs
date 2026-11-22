// MCP tool definitions. Input schemas mirror Claude Code's built-in tools plus `machine`.
// Keep descriptions short: the always-loaded tools are sent every turn (size checked in test/).
// Usage rules that do not change a call's arguments live in the plugin's skill, not here.

const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });
const bool = (description) => ({ type: 'boolean', description });
const PATH = 'Paths: D:/x, D:\\x, /d/x, or relative to the default dir';

export function toolDefs(defaultMachine) {
  const machine = str(`Default ${defaultMachine}`);
  // readOnlyHint lets the client run several of these in parallel.
  const READ_ONLY = new Set(['Machines', 'Read', 'Glob', 'Grep']);
  const ALWAYS_LOAD = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']);
  const tool = (name, description, properties, required = []) => ({
    name,
    description,
    inputSchema: { type: 'object', properties: { ...properties, machine }, required },
    ...(READ_ONLY.has(name) ? { annotations: { readOnlyHint: true } } : {}),
    ...(ALWAYS_LOAD.has(name) ? { _meta: { 'anthropic/alwaysLoad': true } } : {}),
  });
  const T = { type: 'string' }, N = { type: 'integer' }, B = { type: 'boolean' };
  const SHELL = { type: 'string', enum: ['bash', 'cmd', 'powershell'], description: 'Default bash (Git Bash on Windows)' };

  return [
    {
      name: 'Copy',
      description: 'Copy one file between the VPS and a machine, SHA-256 verified; a different existing target is backed up. Files to the VPS: max 50 MiB.',
      inputSchema: { type: 'object', properties: { from: str('machine:path, or VPS path starting / or ~/'), to: str('Same forms; a directory keeps the name'), backup: B }, required: ['from', 'to'] },
      _meta: { 'anthropic/alwaysLoad': true },
    },
    tool('Machines',
      'list (default): machines with status, OS, shell, RTT. checkpoint/checkpoints/restore: per-session Git snapshots of the repo at path (restore previews unless confirm). restart: restart desk-node over ssh (healthy node needs confirm). upgrade: install a desk-node build.',
      {
        action: { type: 'string', enum: ['list', 'checkpoint', 'checkpoints', 'restore', 'restart', 'upgrade'] },
        path: T, ref: str('Checkpoint n, default latest'), confirm: B, version: T,
      }),

    tool('Read',
      `Read a file on a machine as cat -n (max 2000 lines); images come back as images. ${PATH}.`,
      { file_path: T, offset: int('1-based line'), limit: N },
      ['file_path']),

    tool('Write',
      'Create or overwrite a file on a machine. Overwriting needs a Read of any part first; keeps encoding and line endings.',
      { file_path: T, content: T },
      ['file_path', 'content']),

    tool('Edit',
      'Replace an exact, unique string in a file on a machine (replace_all for every match). Needs a Read of any part first.',
      { file_path: T, old_string: T, new_string: T, replace_all: B },
      ['file_path', 'old_string', 'new_string']),

    tool('Glob',
      'Find files by glob on a machine, newest first, max 100.',
      { pattern: T, path: T },
      ['pattern']),

    tool('Grep',
      'ripgrep on a machine.',
      {
        pattern: T, path: T, glob: T, type: T,
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Default files_with_matches' },
        '-i': B, '-n': B, '-A': N, '-B': N, '-C': N, head_limit: N, multiline: B,
      },
      ['pattern']),

    tool('Bash',
      'Run a command on a machine in a fresh shell (cwd and variables do not persist; leftover processes are killed 1 s after exit). Long output is summarized and archived: Grep/Read the archive instead of re-running, or set full. Long-running work: BashJob.',
      { command: T, shell: SHELL, cwd: T, timeout: int('ms, default 120000, max 600000'), description: T, run_in_background: B, full: B },
      ['command']),

    tool('BashJob',
      'Background jobs on a machine that survive restarts. start → id; status waits up to wait_ms and shows the log tail; output returns the full log; stop kills the tree; list.',
      {
        action: { type: 'string', enum: ['start', 'status', 'output', 'stop', 'list'] },
        id: T, command: T, shell: SHELL, cwd: T, wait_ms: int('Max 300000'), limit: N,
      },
      ['action']),
  ];
}
