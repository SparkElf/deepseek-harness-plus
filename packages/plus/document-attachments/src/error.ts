/** Document parser failures crossing provider and Host admission. @module @deepseek-ai/dsh-document-parser/error */

import type { DocumentParserErrorCode } from './types.ts'

/** Failure crossing the document-parser capability seam. */
export class DocumentParserError extends Error {
  /** Stable machine-routing failure code. */
  readonly code: DocumentParserErrorCode

  /**
   * @param message - user-safe failure description without original bytes or parser temporary paths.
   * @param code - stable parser failure code.
   * @param options - optional chained cause.
   */
  constructor(message: string, code: DocumentParserErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DocumentParserError'
    this.code = code
  }
}
