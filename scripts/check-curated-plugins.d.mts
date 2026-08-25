/** Types for the dependency-free curated plugin drift checker. */

/** One curated local patch and its upstream retirement lifecycle. */
export interface CuratedPatch {
  file: string
  upstreamUrl: string
  retireWhen: string
}

/** One curated manifest entry. */
export interface CuratedEntry {
  name: string
  source: { kind: string; spec?: string; url?: string }
  pinned: string | number
  localPatches: CuratedPatch[]
  plusBundle?: boolean
  [key: string]: unknown
}

/** One drift comparison record. */
export interface DriftRecord {
  name: string
  pinned: string | number
  latest: string
  drifted: boolean
}

/** Parse the curated manifest (simple YAML subset). */
export declare function parseManifest(text: string): CuratedEntry[]

/** Compare one pin against a latest value. */
export declare function comparePin(entry: CuratedEntry, latest: string): DriftRecord

/** Check default-mounted npm plugin pins against Web Bundle dependencies. */
export declare function bundledPinIssues(entries: CuratedEntry[], dependencies: Record<string, string>, defaultBundles: readonly string[]): string[]

/** Check curated npm patches against pnpm patch registrations. */
export declare function localPatchIssues(entries: CuratedEntry[], patchedDependencies: Record<string, string>): string[]

/** Return the process status for a completed upstream check. */
export declare function driftExitCode(drifted: number, lookupFailed: number, failOnDrift: boolean): number

/** Run the curated plugin drift check. */
export declare function main(args?: string[]): number
