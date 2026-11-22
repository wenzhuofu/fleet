// Every failure reaches the model as {code, message, next}.
export class GatewayError extends Error {
  constructor(code, message, next) {
    super(message);
    this.code = code;
    this.next = next;
  }
}

export function toEnvelope(error) {
  if (error instanceof GatewayError) return { code: error.code, message: error.message, ...(error.next ? { next: error.next } : {}) };
  if (error?.code === 'ENOENT' && error.path) return { code: 'BAD_CONFIG', message: `File not found: ${error.path}`, next: 'Check ~/fleet/machines.json and the token file it names' };
  return { code: 'INTERNAL', message: String(error?.message ?? error) };
}
