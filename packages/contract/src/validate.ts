/** Validation primitives shared by runtime validators. */

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validationResult(errors: string[]): ValidationResult {
  return { ok: errors.length === 0, errors };
}

/**
 * Raised by adapters/CLI when a response violates the contract or a request
 * cannot be served. `code` uses stable machine-readable strings.
 */
export class ContractError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
    this.status = status;
  }
}

/** Assert a runtime value is a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce unknown to string or throw. */
export function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ContractError('invalid_request', `${field} must be a string`);
  }
  return value;
}

export function asInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ContractError('invalid_request', `${field} must be an integer`);
  }
  return value;
}