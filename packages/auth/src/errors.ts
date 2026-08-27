/** Stable errors at the identity boundary. */
export class AuthError extends Error {
  readonly code: string;
  readonly status: number;
  readonly reason?: string;

  constructor(code: string, message: string, status = 401, reason?: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
    if (reason !== undefined) this.reason = reason;
  }
}
