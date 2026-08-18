/** Types for the dependency-free curated plugin drift checker. */

/** One curated manifest entry. */
export interface CuratedEntry {
  name: string
  source: { kind: string; spec?: string; url?: string }
  pinned: string | number
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
