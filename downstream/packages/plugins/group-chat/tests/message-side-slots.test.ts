/**
 * The claim waits for the official renderer instead of reading the ledger once.
 *
 * This is the failure that only appears in a live composition. `ctx.slots.inject` re-runs on a
 * *declaration* change, and the Chat node slot is declared by the shell's root long before
 * `@deepseek-ai/dsh-client-ui-chat` registers its `user` renderer — so a single read of the
 * ledger at that moment sees some other cell, finds no official view, and registers nothing.
 * Nothing is logged and nothing crashes; the bubbles simply keep their official alignment, so
 * the split looks unimplemented rather than broken.
 *
 * `SlotCore` is the pure registry the runtime wraps, so the ordering can be reproduced exactly
 * here: declare the slot, fire the plugin's reconcile against an empty-ish ledger, then let the
 * official renderer arrive and assert the claim lands.
 */
import { describe, expect, it } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

/** The slot the chat surface renders its nodes through. */
const SLOT = 'conversation.chat.node'

/** Stand-in for the official keyed renderer. */
const Official = (): null => null

/** Stand-in for this plugin's renderer, matched by identity. */
const Ours = (): null => null

/**
 * Build a registry with the slot declared, as the shell's root declares it.
 *
 * The registration is cast narrowly because `SlotCore`'s root seat is typed for the runtime's
 * own shell shim: it demands a component that consumes a `renderSlot` seat and an `inject` face
 * carrying the shell's actions. This test exercises ordering semantics, not rendering, so it
 * declares the same *shape* — a root that declares the keyed session child — without restating
 * a shim only the shell can supply. The declaration itself is load-bearing: registering into an
 * undeclared slot throws, so the slot has to exist before anything can be registered for it.
 *
 * @returns the core, ready for entries to register into.
 */
const declaredSlot = (): SlotCore => {
  const core = new SlotCore()
  ;(core.register as unknown as (options: unknown, component: () => null) => () => void)(
    { name: 'root', children: { [SLOT]: { kind: 'keyed', scope: 'session' } } },
    () => null,
  )
  return core
}

/**
 * The lookup this plugin performs: lowest-priority live entry for a cell, other than its own.
 * Mirrors `officialViewFor` in `src/client/index.ts`.
 */
const officialViewFor = (core: SlotCore, key: string): unknown =>
  core
    .entries(SLOT)
    .filter((entry) => entry.options.key === key && entry.component !== Ours)
    .reduce<{ options: { priority?: number }; component: unknown } | undefined>(
      (lowest, entry) =>
        lowest === undefined || (entry.options.priority ?? 0) < (lowest.options.priority ?? 0)
          ? entry
          : lowest,
      undefined,
    )?.component

describe('认领官方渲染器的时机', () => {
  it('账本里还没有官方渲染器时，不认领这一格', () => {
    // The state the plugin actually meets at inject time. Registering here would blank the
    // cell, because a wrapper with no official view renders nothing.
    const core = declaredSlot()
    expect(officialViewFor(core, 'user')).toBeUndefined()
    expect(officialViewFor(core, 'steering')).toBeUndefined()
  })

  it('官方渲染器到达后，按优先级取到的是它', () => {
    const core = declaredSlot()
    core.register({ name: SLOT, key: 'user' }, Official)

    // Before this plugin claims the cell, the official entry is simply the winner.
    expect(core.entriesOfSlot(SLOT).find((e) => e.options.key === 'user')?.component).toBe(Official)
    // And the lookup agrees.
    expect(officialViewFor(core, 'user')).toBe(Official)
  })

  it('认领之后，官方渲染器仍能从账本里读回来', () => {
    // The reason the lookup uses `entries` rather than `entriesOfSlot`: once this plugin is the
    // winner, the winners projection hands back this plugin's own component, and the official
    // one survives only in the raw ledger.
    const core = declaredSlot()
    core.register({ name: SLOT, key: 'user' }, Official)
    core.register({ name: SLOT, key: 'user', priority: -1 }, Ours)

    expect(core.entriesOfSlot(SLOT).find((e) => e.options.key === 'user')?.component).toBe(Ours)
    expect(officialViewFor(core, 'user')).toBe(Ours === Official ? Ours : Official)
  })

  it('订阅在官方渲染器注册时通知，认领因此能补上', async () => {
    // The mechanism the fix relies on. `slots.subscribe` fires for entries touched on this key,
    // which is what turns the late arrival into a claim.
    //
    // Notifications batch per microtask (per the SlotCore contract: "N same-tick mutations
    // produce one notification per touched key"), so the await is the contract, not a flake
    // workaround — asserting synchronously would fail on a correct implementation.
    const core = declaredSlot()
    let notified = 0
    const unsubscribe = core.subscribe(SLOT, () => { notified += 1 })

    core.register({ name: SLOT, key: 'steering' }, Official)
    await Promise.resolve()
    expect(notified, '官方渲染器注册应触发通知').toBeGreaterThan(0)

    // Re-running reconcile now finds the renderer and claims the cell.
    const official = officialViewFor(core, 'steering')
    expect(official).toBe(Official)
    core.register({ name: SLOT, key: 'steering', priority: -1 }, Ours)
    expect(core.entriesOfSlot(SLOT).find((e) => e.options.key === 'steering')?.component).toBe(Ours)

    unsubscribe()
  })

  it('user 与 steering 是各自独立的一格', () => {
    // A room message renders as `steering` once a turn has claimed it and `user` otherwise, so
    // claiming one cell leaves the other on the official side.
    const core = declaredSlot()
    core.register({ name: SLOT, key: 'user' }, Official)
    core.register({ name: SLOT, key: 'user', priority: -1 }, Ours)

    expect(officialViewFor(core, 'user')).toBe(Official)
    // Nothing was ever registered for `steering`, so there is no official view to wrap.
    expect(officialViewFor(core, 'steering')).toBeUndefined()
  })
})
