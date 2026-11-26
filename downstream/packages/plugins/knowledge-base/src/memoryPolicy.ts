/**
 * Memory policy: the redline and AI-provenance decisions the Host must enforce.
 *
 * This module is deliberately a pure function set. It never reads configuration,
 * the filesystem or the caller's session; the authenticated viewer and the loaded
 * node/edge are explicit arguments. That is what lets the Host call the same rule
 * from the graph loader, the guardian pass and a future write route without the
 * browser becoming the only guard.
 *
 * The policy mirrors design §6–7:
 *
 * - `authority: redline` and `internalizable: false` both block internalization,
 *   for a node and for an edge; a relation inherits the stricter policy of its two
 *   endpoints (`relation 任一端 redline → reject`);
 * - a redline is still readable and subscribable — it is a policy that cannot be
 *   overridden, not a hidden node;
 * - AI-generated content may be published, but only with an explicit `origin`;
 * - publishing and `setAuthority` are restricted to an admin or the owner, and a
 *   personal edit never overrides a department/global redline.
 *
 * T1's `graphModel.ts` and `graphPolicy.ts` own the canonical attribute and
 * viewer types; this module imports them type-only, so the policy cannot drift
 * from what the loader actually produces.
 *
 * @module @sparkelf/dsh-knowledge-base/memory-policy
 */

import type {
  LoadedGraphEdge,
  LoadedGraphNode,
  MemoryAuthority,
  MemoryOrigin,
  MemoryReviewStatus,
} from './graphModel.ts'
import type { GraphViewer } from './graphPolicy.ts'

export type { GraphViewer, MemoryAuthority, MemoryOrigin, MemoryReviewStatus }

/** The actions a caller can ask the policy about. */
export type MemoryAction = 'view' | 'subscribe' | 'internalize' | 'edit' | 'publish' | 'setAuthority'

/** The node fields the policy reads. Provenance stays optional so a legacy node
 * that predates the field reaches the publish guard instead of being typed away. */
export type PolicyNode = Pick<LoadedGraphNode, 'id' | 'authority' | 'internalizable'>
  & Partial<Pick<LoadedGraphNode, 'origin' | 'reviewStatus'>>

/** The edge fields the policy reads. */
export type PolicyEdge = Pick<LoadedGraphEdge, 'id' | 'authority' | 'internalizable'>

/** One endpoint of a relation. */
export type PolicyEndpoint = Pick<LoadedGraphNode, 'authority' | 'internalizable'>

/** The answer a Host route or guardian pass acts on. */
export interface PolicyDecision {
  allowed: boolean
  /**
   * Stable reason code when denied:
   * `redline`, `not-internalizable`, `missing-subject`, `ambiguous-subject`,
   * `missing-origin`, `admin-or-owner-required`, `owner-required`,
   * `unsupported-action`.
   */
  reason?: string
  /** True when the subject is a redline whose policy cannot be overridden. */
  nonOverridable?: boolean
}

/** The decision input, matching the module contract. */
export interface DecideMemoryActionInput {
  action: MemoryAction
  node?: PolicyNode
  edge?: PolicyEdge
  /**
   * Both endpoints of `edge`, when the caller has them.
   *
   * A relation inherits the stricter endpoint policy, so callers that pass this
   * get the design rule enforced directly. Callers that only have a projected
   * edge (the loader already folded the endpoints into `edge.authority` /
   * `edge.internalizable`) may omit it.
   */
  edgeEndpoints?: readonly PolicyEndpoint[]
  viewer?: GraphViewer
  /** Whether the subject is the caller's own personal memory. */
  isOwner?: boolean
}

/** The tags a runtime injection carries for one node. */
export interface RuntimeInjectionTags {
  authorityTag: string
  originTag: string
  nonOverridable: boolean
}

/**
 * The node shape {@link runtimeInjectionTags} reads.
 *
 * A full `LoadedGraphNode` is assignable. The optional members let a legacy node
 * that predates the provenance field still be injected with the human fallback.
 */
export type RuntimeInjectionNode = Pick<LoadedGraphNode, 'authority'>
  & Partial<Pick<LoadedGraphNode, 'origin' | 'internalizable'>>

/** Authority labels used in the prompt and UI. */
const AUTHORITY_TAGS: Record<MemoryAuthority, string> = {
  canonical: '权威',
  advisory: '建议',
  redline: '红线',
}

/** Origin labels used in the prompt and UI. */
const ORIGIN_TAGS: Record<MemoryOrigin, string> = {
  human: '人工',
  ai: 'AI 生成',
  mixed: 'AI+人工',
}

/** Resolve whether the caller may publish or set authority. */
function hasPublishRights(viewer: GraphViewer | undefined, isOwner: boolean | undefined): boolean {
  if (isOwner === true) return true
  if (viewer === undefined || viewer.userId.trim() === '') return false
  return viewer.isAdmin || viewer.isSuperAdmin
}

/**
 * Fold the two endpoint policies into the effective edge policy.
 *
 * Stricter wins: any redline endpoint makes the relation a redline, and the
 * relation is internalizable only when the edge itself and both endpoints are.
 */
function effectiveEdgePolicy(edge: PolicyEdge, endpoints: readonly PolicyEndpoint[] | undefined): PolicyEndpoint {
  const endpointRedline = endpoints?.some(endpoint => endpoint.authority === 'redline') ?? false
  const endpointInternalizable = endpoints === undefined
    || endpoints.every(endpoint => endpoint.internalizable !== false)
  return {
    authority: endpointRedline ? 'redline' : edge.authority,
    internalizable: edge.internalizable !== false && endpointInternalizable,
  }
}

/** Build a denial with an optional non-overridable marker. */
function deny(reason: string, nonOverridable = false): PolicyDecision {
  return nonOverridable ? { allowed: false, reason, nonOverridable: true } : { allowed: false, reason }
}

/** Build an allowance. `nonOverridable` is a runtime-injection tag, not a gate. */
function allow(): PolicyDecision {
  return { allowed: true }
}

/**
 * Decide one memory action against the subject's redline/provenance policy.
 *
 * The function is intentionally strict about missing context: an action that needs
 * a subject denies instead of guessing, and publish/setAuthority need an explicit
 * admin or owner. `view` and `subscribe` do not require a viewer here because the
 * Host has already resolved graph visibility before calling; a redline remains
 * viewable and subscribable, and only the runtime injection marks it
 * non-overridable.
 *
 * @param input - action, subject, optional edge endpoints, viewer and ownership.
 * @returns The decision, with a stable reason code when denied.
 */
export function decideMemoryAction(input: DecideMemoryActionInput): PolicyDecision {
  if (input.node !== undefined && input.edge !== undefined) {
    return deny('ambiguous-subject')
  }

  const subject = input.node ?? input.edge
  if (subject === undefined) return deny('missing-subject')

  const edgePolicy = input.edge === undefined
    ? undefined
    : effectiveEdgePolicy(input.edge, input.edgeEndpoints)
  const authority = edgePolicy?.authority ?? subject.authority
  const internalizable = edgePolicy?.internalizable ?? subject.internalizable
  const redline = authority === 'redline'

  switch (input.action) {
    case 'view':
      return allow()

    case 'subscribe':
      // Redline nodes are the canonical subscribe-only case: the proxy is the
      // intended way to consume them, so subscription is allowed.
      return allow()

    case 'internalize':
      if (redline) return deny('redline', true)
      if (internalizable === false) return deny('not-internalizable')
      return allow()

    case 'edit':
      // A personal branch may be edited freely, but a redline — even one copied
      // into personal memory before it was reclassified — is never overridden.
      if (redline) return deny('redline', true)
      if (input.isOwner !== true) return deny('owner-required')
      return allow()

    case 'publish':
      if (input.node === undefined) return deny('missing-subject')
      // AI-generated content is publishable, but an unstamped node has no
      // provenance and must not silently become published knowledge.
      if (input.node.origin === undefined) return deny('missing-origin')
      if (!hasPublishRights(input.viewer, input.isOwner)) return deny('admin-or-owner-required')
      return allow()

    case 'setAuthority':
      if (input.node === undefined) return deny('missing-subject')
      if (!hasPublishRights(input.viewer, input.isOwner)) return deny('admin-or-owner-required')
      return allow()

    default:
      return deny('unsupported-action')
  }
}

/**
 * The tags a runtime injection carries for a node.
 *
 * A redline is marked `nonOverridable` so the runtime reads it from the
 * authoritative source and ranks it above personal memory and preferences.
 *
 * @param node - the loaded node being injected.
 * @returns Authority/origin labels and the non-overridable flag.
 */
export function runtimeInjectionTags(node: RuntimeInjectionNode): RuntimeInjectionTags {
  const authority = node.authority ?? 'advisory'
  const origin = node.origin ?? 'human'
  return {
    authorityTag: AUTHORITY_TAGS[authority] ?? AUTHORITY_TAGS.advisory,
    originTag: ORIGIN_TAGS[origin] ?? ORIGIN_TAGS.human,
    nonOverridable: authority === 'redline',
  }
}
