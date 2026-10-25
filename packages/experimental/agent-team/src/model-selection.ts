/** Live Agent model-selection ownership for durable Team member routes. */

import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'

interface InstalledSelection {
  readonly ref: ModelSelectionRef
  readonly dispose: () => void
}

/**
 * Owns one installed selection reference per live member Agent and releases
 * every listener when the Team runtime is replaced. The durable member snapshot
 * remains the authority; this class only makes that route reach prompt assembly
 * and request routing.
 */
export class TeamMemberModelSelection {
  private readonly installed = new Map<Agent, InstalledSelection>()

  /**
   * Return the Agent's selection reference, installing prompt and request
   * listeners on first use.
   * @param agent - exact live member Agent.
   * @returns the mutable reference consumed by the Agent's next request.
   */
  selectionFor(agent: Agent): ModelSelectionRef {
    const existing = this.installed.get(agent)
    if (existing !== undefined) return existing.ref
    const ref: ModelSelectionRef = { current: undefined, assembled: undefined }
    this.installed.set(agent, { ref, dispose: installModelSelection(agent.ctx, ref) })
    return ref
  }

  /**
   * Select the durable route for the Agent's next prompt assembly.
   * @param agent - exact live member Agent.
   * @param selection - route recorded by the member snapshot, or undefined when it has none.
   */
  apply(agent: Agent, selection: ModelSelection | undefined): void {
    this.selectionFor(agent).current = selection
  }

  /**
   * Release one disposed Agent's listeners and reference.
   * @param agent - Agent whose scope is being disposed.
   */
  forget(agent: Agent): void {
    const installed = this.installed.get(agent)
    if (installed === undefined) return
    this.installed.delete(agent)
    installed.dispose()
  }

  /** Release every installed listener; durable member snapshots keep the selected routes. */
  dispose(): void {
    for (const { dispose } of this.installed.values()) dispose()
    this.installed.clear()
  }
}
