// Windows Job Objects (ported from v1 workspace-win/src/native.ts, trimmed to the
// job part). MSYS fork/exec breaks the Windows parent chain, so `taskkill /T`
// misses grandchildren; a job contains every descendant and kills them together.
import koffi from 'koffi';

const IS_WIN = process.platform === 'win32';
const JobObjectExtendedLimitInformation = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_SET_QUOTA = 0x0100, PROCESS_TERMINATE = 0x0001, JOB_OBJECT_TERMINATE = 0x0008;

const k = IS_WIN ? (() => {
  const lib = koffi.load('kernel32.dll');
  return {
    CreateJob: lib.func('void * __stdcall CreateJobObjectW(void *, const char16_t *)'),
    OpenJob: lib.func('void * __stdcall OpenJobObjectW(uint32_t, int, const char16_t *)'),
    SetInfo: lib.func('int __stdcall SetInformationJobObject(void *, int, void *, uint32_t)'),
    OpenProcess: lib.func('void * __stdcall OpenProcess(uint32_t, int, uint32_t)'),
    Assign: lib.func('int __stdcall AssignProcessToJobObject(void *, void *)'),
    SetHandleInfo: lib.func('int __stdcall SetHandleInformation(void *, uint32_t, uint32_t)'),
    Terminate: lib.func('int __stdcall TerminateJobObject(void *, uint32_t)'),
    Close: lib.func('int __stdcall CloseHandle(void *)'),
    LastError: lib.func('uint32_t __stdcall GetLastError()'),
  };
})() : undefined;

/**
 * Create a job. A named job can be reopened with openJob() after desk-node restarts,
 * as long as some process still holds a handle to it (see `inheritable`).
 */
export function createJob({ killOnClose, name = null }) {
  if (!k) return null;
  const job = k.CreateJob(null, name ? `Local\\${name}` : null);
  if (!job) throw new Error(`CreateJobObjectW failed: ${k.LastError()}`);
  if (killOnClose) {
    const limits = Buffer.alloc(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION on x64
    limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
    if (!k.SetInfo(job, JobObjectExtendedLimitInformation, limits, limits.length)) {
      k.Close(job);
      throw new Error(`SetInformationJobObject failed: ${k.LastError()}`);
    }
  }
  return wrap(job);
}

/** Put `pid` (and all its future descendants) in a new job. Returns null off Windows. */
export function jobFor(pid, options) {
  const job = createJob(options);
  if (!job) return null;
  try { job.assign(pid); } catch (error) { job.close(); throw error; }
  return job;
}

/** Reopen a named job for termination; null if it no longer exists (all processes gone). */
export function openJob(name) {
  if (!k) return null;
  const job = k.OpenJob(JOB_OBJECT_TERMINATE, 0, `Local\\${name}`);
  return job ? wrap(job) : null;
}

function wrap(job) {
  let open = true;
  return {
    assign(pid) {
      const proc = k.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
      if (!proc) throw new Error(`OpenProcess(${pid}) failed: ${k.LastError()}`);
      try { if (!k.Assign(job, proc)) throw new Error(`AssignProcessToJobObject failed: ${k.LastError()}`); }
      finally { k.Close(proc); }
    },
    /** While inheritable, processes spawned by desk-node inherit (and keep alive) this handle. */
    inheritable(on) { k.SetHandleInfo(job, 1, on ? 1 : 0); },
    terminate() { if (open) k.Terminate(job, 1); },
    close() { if (open) { open = false; k.Close(job); } },
  };
}
