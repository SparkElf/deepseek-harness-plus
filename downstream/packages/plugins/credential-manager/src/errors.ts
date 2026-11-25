/** Error types shared by the store, the HTTP API, and the model tools. */
export class CredentialError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message)
    this.name = 'CredentialError'
    this.status = options.status ?? 400
    this.code = options.code ?? 'credential_error'
  }
}

export function validationError(message: string): CredentialError {
  return new CredentialError(message, { status: 400, code: 'validation_error' })
}

export function notFoundError(id: string): CredentialError {
  return new CredentialError('Credential not found: ' + id, { status: 404, code: 'not_found' })
}

export function conflictError(message: string): CredentialError {
  return new CredentialError(message, { status: 409, code: 'conflict' })
}