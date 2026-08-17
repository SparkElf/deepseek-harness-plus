/**
 * backups domain contract: host-only transport faces for the settings Backup
 * section — the mirror of the `downloads` domain. No wire envelope: the
 * carrier's GET/POST routes answer these directly, and the browser
 * `IApiClient` never exposes them. Archives move as temp files named by
 * single-use tokens, never as base64 in JSON, so large harness homes do not
 * multiply through string encodings on either side of the wire.
 */

/** A staged backup artifact named by a single-use token. */
export interface BackupArtifact {
  /** Opaque single-use token naming the Host temp file. */
  token: string
}

/** Host-only backup transport faces (no wire envelope; absent from IApiClient). */
export interface BackupsApi {
  /**
   * Write a fresh export archive of the harness home (settings incl. provider/
   * model configuration, credentials with key values, storages; runtime-
   * generated `profiles` and `supervisor` excluded) to a Host temp file and
   * mint its single-use download token.
   * @returns the token plus the archive's entry count.
   */
  createExport(): Promise<{ token: string; entries: number }>

  /**
   * Consume a download token once and stream the archive as a zip attachment
   * response; unknown or expired tokens answer undefined (the carrier maps it
   * to 404). The temp file is removed once the stream settles.
   * @param token - token minted by `createExport`.
   * @returns the attachment response, or undefined.
   */
  download(token: string): Promise<Response | undefined>

  /**
   * Register an uploaded temp file (the carrier streams the request body to
   * disk and hands the path over) under a single-use import token.
   * @param path - absolute temp file path holding the uploaded archive.
   * @returns the import token.
   */
  registerUpload(path: string): BackupArtifact

  /**
   * Consume an import token once.
   * @param token - token minted by `registerUpload`.
   * @returns the staged archive path, or undefined for unknown/expired tokens.
   */
  takeUpload(token: string): string | undefined
}
