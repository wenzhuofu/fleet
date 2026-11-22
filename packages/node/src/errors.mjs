// Structured errors returned to callers as {code, message, next}.
export class DeskError extends Error {
  constructor(code, message, next) {
    super(message);
    this.code = code;
    this.next = next;
  }
}

const FS_CODES = {
  ENOENT: ['NOT_FOUND', 'File or directory does not exist'],
  EACCES: ['ACCESS_DENIED', 'Access denied'],
  EPERM: ['ACCESS_DENIED', 'Operation not permitted (file may be locked or read-only)'],
  EBUSY: ['FILE_BUSY', 'File is locked by another process'],
  EISDIR: ['IS_DIRECTORY', 'Path is a directory'],
  ENOTDIR: ['NOT_FOUND', 'A path component is not a directory'],
};

export function toErrorEnvelope(error) {
  if (error instanceof DeskError) {
    return { code: error.code, message: error.message, ...(error.next ? { next: error.next } : {}) };
  }
  const mapped = error && FS_CODES[error.code];
  if (mapped) return { code: mapped[0], message: `${mapped[1]}: ${error.path ?? ''}`.trim() };
  return { code: 'INTERNAL', message: String(error?.message ?? error) };
}
