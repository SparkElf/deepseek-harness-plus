import { describe, expect, it, vi } from 'vitest'
import {
  BUILT_IN_WORKFLOWS,
  findWorkflow,
  workflowMarker,
  type WorkflowDefinition,
} from '../src/client/workflows/registry.ts'
import { checkCustomCron, CRON_FIELD_COUNT, frequencyChoices, intervalCron, INTERVAL_SPECS, resolveCron } from '../src/client/workflows/cron.ts'
import {
  findSubscription,
  findSubscriptions,
  subscriptionIndex,
  type SubscribedTaskView,
} from '../src/client/workflows/dedupe.ts'
import {
  createSubscriptionSession,
  subscribeWorkflow,
  subscriptionPrompt,
  unsubscribeWorkflow,
  VERIFY_ATTEMPTS,
  type CreateSubscriptionDeps,
  type SubscribeDeps,
  type SubscribeState,
} from '../src/client/workflows/subscribe.ts'

/** Build a fake task list entry. */
function task(id: string, prompt = '', name = ''): SubscribedTaskView {
  return { id, prompt, name }
}

describe('the built-in workflow registry', () => {
  it('offers the three shipped workflows with stable ids', () => {
    expect(BUILT_IN_WORKFLOWS.map(workflow => workflow.id)).toEqual([
      'kb-organize-personal',
      'kb-index-personal',
      'kb-archive-stale',
    ])
  })

  it('gives every workflow a full set of fields', () => {
    for (const workflow of BUILT_IN_WORKFLOWS) {
      expect(workflow.titleKey).not.toBe('')
      expect(workflow.descriptionKey).not.toBe('')
      expect(workflow.defaultCron).not.toBe('')
      expect(workflow.instruction).not.toBe('')
      expect(workflow.frequencies.length).toBeGreaterThan(0)
    }
  })

  it('prefills every default cron as a usable five-field expression', () => {
    for (const workflow of BUILT_IN_WORKFLOWS) {
      expect(checkCustomCron(workflow.defaultCron)).toEqual({ ok: true, cron: workflow.defaultCron })
    }
  })

  it('offers the custom shortcut without a cron of its own', () => {
    for (const workflow of BUILT_IN_WORKFLOWS) {
      const custom = workflow.frequencies.find(frequency => frequency.id === 'custom')
      expect(custom).toBeDefined()
      expect(custom?.cron).toBeUndefined()
    }
  })

  it('finds a workflow by id and reports an unknown one', () => {
    expect(findWorkflow('kb-organize-personal')?.id).toBe('kb-organize-personal')
    expect(findWorkflow('nope')).toBeUndefined()
  })

  it('marks a workflow by id, not by title', () => {
    expect(workflowMarker('kb-organize-personal')).toBe('[workflow:kb-organize-personal]')
    // The id is the contract; a title change must not move the marker.
    expect(workflowMarker('kb-organize-personal')).toContain('kb-organize-personal')
  })
})

describe('cron shortcuts map without interpreting', () => {
  it('returns the shortcut expression verbatim', () => {
    const workflow = findWorkflow('kb-organize-personal') as WorkflowDefinition
    expect(resolveCron('daily', workflow, '')).toEqual({ ok: true, cron: '0 9 * * *' })
    expect(resolveCron('weekly', workflow, '')).toEqual({ ok: true, cron: '0 9 * * 1' })
  })

  it('accepts a five-field custom expression and normalises its spaces', () => {
    expect(checkCustomCron('  0   9  *  *  1 ')).toEqual({ ok: true, cron: '0 9 * * 1' })
  })

  it('rejects an empty custom expression', () => {
    expect(checkCustomCron('   ')).toEqual({ ok: false, reason: 'empty' })
  })

  it('rejects the wrong number of fields rather than guessing', () => {
    expect(checkCustomCron('0 9 * *')).toEqual({ ok: false, reason: 'fieldCount' })
    expect(checkCustomCron('0 9 * * * *')).toEqual({ ok: false, reason: 'fieldCount' })
  })

  it('does not judge the meaning of a range or step', () => {
    // Interpretation belongs to the Schedule; only the shape is ours to check.
    expect(checkCustomCron('*/15 8-18 * * 1-5')).toEqual({ ok: true, cron: '*/15 8-18 * * 1-5' })
  })

  it('routes custom through the shape check and shortcuts around it', () => {
    const workflow = findWorkflow('kb-index-personal') as WorkflowDefinition
    expect(resolveCron('custom', workflow, '0 3 * * *')).toEqual({ ok: true, cron: '0 3 * * *' })
    expect(resolveCron('custom', workflow, 'bad')).toEqual({ ok: false, reason: 'fieldCount' })
  })

  it('offers one choice per frequency, prelabelled for the dialog', () => {
    const workflow = findWorkflow('kb-archive-stale') as WorkflowDefinition
    const choices = frequencyChoices(workflow, workflow.defaultCron)
    expect(choices).toHaveLength(workflow.frequencies.length)
    expect(choices[0]?.labelKey).toBe('workflow.frequency.daily')
    expect(choices.at(-1)?.cron).toBe(workflow.defaultCron)
  })

  it('states the field count once, so the check and its message cannot drift', () => {
    expect(CRON_FIELD_COUNT).toBe(5)
  })
})

describe('recognising an existing subscription', () => {
  const workflow = findWorkflow('kb-organize-personal') as WorkflowDefinition

  it('recognises the marker inside a task prompt', () => {
    const found = findSubscription(workflow, [task('t1', `${workflowMarker(workflow.id)}\n整理`)])
    expect(found?.task.id).toBe('t1')
    expect(found?.via).toBe('marker')
  })

  it('falls back to the workflow id when the marker was paraphrased away', () => {
    // This is the case the generous match exists for: the model dropped the marker.
    const found = findSubscription(workflow, [task('t1', '请整理 kb-organize-personal 这个桶')])
    expect(found?.task.id).toBe('t1')
    expect(found?.via).toBe('title')
  })

  it('recognises a subscription from the task name alone', () => {
    const found = findSubscription(workflow, [task('t1', '', 'kb-organize-personal')])
    expect(found?.via).toBe('title')
  })

  it('does not treat a different workflow as this one', () => {
    const other = findWorkflow('kb-archive-stale') as WorkflowDefinition
    expect(findSubscription(workflow, [task('t1', workflowMarker(other.id))])).toBeUndefined()
  })

  it('reports nothing for an unrelated task', () => {
    expect(findSubscription(workflow, [task('t1', '每天帮我打卡')])).toBeUndefined()
  })

  it('finds one subscription per workflow across a mixed list', () => {
    const archive = findWorkflow('kb-archive-stale') as WorkflowDefinition
    const found = findSubscriptions(
      [task('t1', workflowMarker(workflow.id)), task('t2', workflowMarker(archive.id)), task('t3', '无关')],
      BUILT_IN_WORKFLOWS,
    )
    expect(found.map(item => item.workflowId)).toEqual(['kb-organize-personal', 'kb-archive-stale'])
  })

  it('indexes subscriptions so a card asks one question', () => {
    const index = subscriptionIndex(findSubscriptions(
      [task('t1', workflowMarker(workflow.id))],
      BUILT_IN_WORKFLOWS,
    ))
    expect(index.get('kb-organize-personal')?.task.id).toBe('t1')
    expect(index.get('kb-index-personal')).toBeUndefined()
  })
})

describe('subscribing a workflow', () => {
  const workflow = findWorkflow('kb-organize-personal') as WorkflowDefinition
  const CRON = '0 9 * * 1'

  /** Build deps with sensible fakes; each test overrides what it cares about. */
  function deps(overrides: Partial<SubscribeDeps<SubscribedTaskView>> = {}) {
    const states: SubscribeState[] = []
    const base: SubscribeDeps<SubscribedTaskView> = {
      listTasks: vi.fn(async () => [] as readonly SubscribedTaskView[]),
      createSession: vi.fn(async () => 'session-1'),
      sendPrompt: vi.fn(async () => true),
      removeTask: vi.fn(async () => true),
      sleep: vi.fn(async () => undefined),
      onChange: (state: SubscribeState) => { states.push(state) },
    }
    return { deps: { ...base, ...overrides }, states, base }
  }

  it('runs the full sequence and reports the created task', async () => {
    let reads = 0
    const { deps: d, states } = deps({
      listTasks: async () => {
        reads += 1
        // Before: nothing. After the prompt: the model's task exists.
        return reads === 1 ? [] : [task('task-9', workflowMarker(workflow.id))]
      },
    })
    const outcome = await subscribeWorkflow(workflow, CRON, d)

    expect(outcome).toEqual({ ok: true, taskId: 'task-9', sessionId: 'session-1' })
    expect(states.map(state => state.phase)).toEqual([
      'idle', 'creating-session', 'prompting', 'verifying', 'subscribed',
    ])
  })

  it('sends a prompt naming the tool, the cron, the instruction and the marker', async () => {
    let reads = 0
    const sent: string[] = []
    const { deps: d } = deps({
      listTasks: async () => (++reads === 1 ? [] : [task('t', workflowMarker(workflow.id))]),
      sendPrompt: async (_session, text) => { sent.push(text); return true },
    })
    await subscribeWorkflow(workflow, CRON, d)

    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('schedule_create')
    expect(sent[0]).toContain(CRON)
    expect(sent[0]).toContain(workflowMarker(workflow.id))
    expect(sent[0]).toContain(workflow.instruction)
  })

  it('does not create a Session when already subscribed', async () => {
    // THE duplicate guard: the second click must not reach createSession at all.
    const createSession = vi.fn(async () => 'session-x')
    const { deps: d } = deps({
      listTasks: async () => [task('existing', workflowMarker(workflow.id))],
      createSession,
    })
    const outcome = await subscribeWorkflow(workflow, CRON, d)

    expect(outcome.ok).toBe(false)
    expect(outcome.failure).toBe('already-subscribed')
    expect(outcome.taskId).toBe('existing')
    expect(createSession).not.toHaveBeenCalled()
  })

  it('creates at most one task when subscribing twice in sequence', async () => {
    // Both attempts race the same Host; only the first may create a Session.
    const tasks: SubscribedTaskView[] = []
    const createSession = vi.fn(async () => 'session-1')
    const sendPrompt = vi.fn(async () => {
      tasks.push(task('created-1', workflowMarker(workflow.id)))
      return true
    })
    const listTasks = vi.fn(async () => [...tasks])
    const { deps: d } = deps({ listTasks, createSession, sendPrompt })

    const first = await subscribeWorkflow(workflow, CRON, d)
    const second = await subscribeWorkflow(workflow, CRON, d)

    expect(first.ok).toBe(true)
    expect(second.failure).toBe('already-subscribed')
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(tasks).toHaveLength(1)
  })

  it('fails when the Session cannot be created', async () => {
    const { deps: d } = deps({ createSession: async () => { throw new Error('host down') } })
    const outcome = await subscribeWorkflow(workflow, CRON, d)
    expect(outcome.failure).toBe('session-failed')
  })

  it('fails when the Session is created without an id', async () => {
    const { deps: d } = deps({ createSession: async () => '' })
    expect((await subscribeWorkflow(workflow, CRON, d)).failure).toBe('session-unaddressable')
  })

  it('fails when the prompt is refused', async () => {
    const { deps: d } = deps({ sendPrompt: async () => false })
    const outcome = await subscribeWorkflow(workflow, CRON, d)
    expect(outcome.failure).toBe('prompt-failed')
  })

  it('reports failure when the model never creates the task', async () => {
    // The prompt lands, the model only replies with prose: no task, no subscription.
    const { deps: d, states } = deps({ listTasks: async () => [] })
    const outcome = await subscribeWorkflow(workflow, CRON, d)

    expect(outcome.ok).toBe(false)
    expect(outcome.failure).toBe('not-created')
    // It really polled, rather than deciding after one look.
    expect(d.sleep).toHaveBeenCalledTimes(VERIFY_ATTEMPTS)
    expect(states.at(-1)?.phase).toBe('failed')
  })

  it('keeps polling until the task appears, not just once', async () => {
    let reads = 0
    const { deps: d } = deps({
      listTasks: async () => {
        reads += 1
        // First read is the pre-flight; the task shows up on the third verification.
        if (reads <= 1) return []
        return reads >= 4 ? [task('late', workflowMarker(workflow.id))] : []
      },
    })
    const outcome = await subscribeWorkflow(workflow, CRON, d)
    expect(outcome.ok).toBe(true)
    expect(outcome.taskId).toBe('late')
  })

  it('does not report success when the task list cannot be read', async () => {
    const { deps: d } = deps({ listTasks: async () => { throw new Error('offline') } })
    const outcome = await subscribeWorkflow(workflow, CRON, d)
    expect(outcome.ok).toBe(false)
    // An unreadable list is not evidence of absence, so it refuses rather than risks a duplicate.
    expect(outcome.failure).toBe('not-created')
  })
})

describe('unsubscribing a workflow', () => {
  const workflow = findWorkflow('kb-organize-personal') as WorkflowDefinition
  const CRON = '0 9 * * 1'

  it('removes the task that represents the subscription', async () => {
    const removeTask = vi.fn(async () => true)
    expect(await unsubscribeWorkflow('task-9', 'session-1', { removeTask })).toBe(true)
    // The owning Session travels with the id: deletion is routed through it.
    expect(removeTask).toHaveBeenCalledWith('task-9', 'session-1')
  })

  it('reports a failed removal rather than claiming success', async () => {
    const states: SubscribeState[] = []
    const removed = await unsubscribeWorkflow('task-9', 'session-1', {
      removeTask: async () => false,
      onChange: state => { states.push(state) },
    })
    expect(removed).toBe(false)
    expect(states.at(-1)?.phase).toBe('failed')
    expect(states.at(-1)?.failure).toBe('cancel-failed')
  })

  it('allows subscribing again after an unsubscribe', async () => {
    // The whole point of offering unsubscribe: it must restore the card, not dead-end it.
    const tasks: SubscribedTaskView[] = []
    const createSession = vi.fn(async () => 'session-1')
    const { deps: d } = {
      deps: {
        listTasks: async () => [...tasks],
        createSession,
        sendPrompt: async () => { tasks.push(task('created-1', workflowMarker(workflow.id))); return true },
        removeTask: async (id: string) => {
          const index = tasks.findIndex(item => item.id === id)
          if (index === -1) return false
          tasks.splice(index, 1)
          return true
        },
        sleep: async () => undefined,
      } satisfies SubscribeDeps<SubscribedTaskView>,
    }

    expect((await subscribeWorkflow(workflow, CRON, d)).ok).toBe(true)
    // Subscribed: a second attempt is refused.
    expect((await subscribeWorkflow(workflow, CRON, d)).failure).toBe('already-subscribed')
    // Unsubscribe, then it is available again.
    const owningSession = tasks.find(item => item.id === 'created-1')?.sessionId ?? ''
    expect(await unsubscribeWorkflow('created-1', owningSession, d)).toBe(true)
    expect(findSubscription(workflow, tasks)).toBeUndefined()
    const again = await subscribeWorkflow(workflow, CRON, d)
    expect(again.ok).toBe(true)
    expect(createSession).toHaveBeenCalledTimes(2)
  })
})

describe('opening a subscription session immediately', () => {
  const workflow = findWorkflow('kb-organize-personal') as WorkflowDefinition
  const CRON = '0 9 * * 1'
  const MODEL = { provider: 'dashscope', model: 'deepseek-v4.1-flash-1017', reasoningEffort: 'max' }

  function immediateDeps(overrides: Partial<CreateSubscriptionDeps<SubscribedTaskView>> = {}) {
    const states: SubscribeState[] = []
    const base: CreateSubscriptionDeps<SubscribedTaskView> = {
      listTasks: vi.fn(async () => [] as readonly SubscribedTaskView[]),
      createSession: vi.fn(async () => 'session-1'),
      sendPrompt: vi.fn(async () => true),
      removeTask: vi.fn(async () => true),
      selectModel: vi.fn(async () => true),
      openSession: vi.fn(),
      onChange: (state: SubscribeState) => { states.push(state) },
    }
    return { deps: { ...base, ...overrides }, states }
  }

  it('selects the model before the prompt and opens the session without polling', async () => {
    const order: string[] = []
    const listTasks = vi.fn(async () => [] as readonly SubscribedTaskView[])
    const { deps, states } = immediateDeps({
      listTasks,
      createSession: async () => { order.push('create'); return 'session-1' },
      selectModel: async (sessionId, selection) => {
        order.push('select:' + sessionId + ':' + selection.provider + '/' + selection.model + '/' + String(selection.reasoningEffort))
        return true
      },
      sendPrompt: async () => { order.push('prompt'); return true },
      openSession: sessionId => { order.push('open:' + sessionId) },
    })

    const outcome = await createSubscriptionSession(workflow, CRON, MODEL, deps)

    expect(outcome).toEqual({ ok: true, sessionId: 'session-1', opened: true })
    // The model selection must precede the prompt: otherwise the FIRST turn uses the
    // workspace default, which is exactly the tokensfree 502 this change fixes.
    expect(order).toEqual([
      'create',
      'select:session-1:dashscope/deepseek-v4.1-flash-1017/max',
      'prompt',
      'open:session-1',
    ])
    expect(listTasks).toHaveBeenCalledTimes(1) // pre-flight only; no verification poll
    expect(states.map(state => state.phase)).toEqual([
      'idle', 'creating-session', 'selecting-model', 'prompting', 'opened',
    ])
  })

  it('keeps the workspace default when no model was chosen', async () => {
    const selectModel = vi.fn(async () => true)
    const { deps } = immediateDeps({ selectModel })
    const outcome = await createSubscriptionSession(workflow, CRON, undefined, deps)
    expect(outcome.ok).toBe(true)
    expect(selectModel).not.toHaveBeenCalled()
  })

  it('reports model-failed and sends nothing when the model cannot be installed', async () => {
    const sendPrompt = vi.fn(async () => true)
    const openSession = vi.fn()
    const { deps, states } = immediateDeps({
      selectModel: async () => false,
      sendPrompt,
      openSession,
    })
    const outcome = await createSubscriptionSession(workflow, CRON, MODEL, deps)
    expect(outcome).toMatchObject({ ok: false, failure: 'model-failed', sessionId: 'session-1' })
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(openSession).not.toHaveBeenCalled()
    expect(states.at(-1)).toMatchObject({ phase: 'failed', failure: 'model-failed' })
  })

  it('reports prompt-failed and does not open the session', async () => {
    const openSession = vi.fn()
    const { deps } = immediateDeps({ sendPrompt: async () => false, openSession })
    const outcome = await createSubscriptionSession(workflow, CRON, MODEL, deps)
    expect(outcome).toMatchObject({ ok: false, failure: 'prompt-failed' })
    expect(openSession).not.toHaveBeenCalled()
  })

  it('reports session-failed when the Session cannot be created', async () => {
    const { deps } = immediateDeps({ createSession: async () => { throw new Error('nope') } })
    const outcome = await createSubscriptionSession(workflow, CRON, MODEL, deps)
    expect(outcome).toMatchObject({ ok: false, failure: 'session-failed' })
  })

  it('keeps the duplicate pre-flight before creating a Session', async () => {
    const createSession = vi.fn(async () => 'session-x')
    const { deps } = immediateDeps({
      listTasks: async () => [task('existing', workflowMarker(workflow.id))],
      createSession,
    })
    const outcome = await createSubscriptionSession(workflow, CRON, MODEL, deps)
    expect(outcome).toMatchObject({ ok: false, failure: 'already-subscribed', taskId: 'existing' })
    expect(createSession).not.toHaveBeenCalled()
  })

  it('still succeeds when the Host has no openSession (older profile)', async () => {
    const { deps } = immediateDeps({ openSession: undefined })
    const outcome = await createSubscriptionSession(workflow, CRON, MODEL, deps)
    expect(outcome).toEqual({ ok: true, sessionId: 'session-1', opened: false })
  })
})

describe('the strengthened subscription prompt', () => {
  const workflow = findWorkflow('kb-archive-stale') as WorkflowDefinition

  it('states that the cron is already valid and must be used verbatim', () => {
    // A model asked to produce a monthly cron sometimes answers with nothing at all;
    // telling it the value is final removes that hesitation without changing the rule.
    const prompt = subscriptionPrompt(workflow, '0 9 1 * *')
    expect(prompt).toContain('0 9 1 * *')
    expect(prompt).toContain('合法的 5 段格式')
    expect(prompt).toContain('直接原样使用')
    expect(prompt).toContain('description:')
    expect(prompt).toContain(`source_id: ${JSON.stringify(workflow.id)}`)
    expect(prompt).toContain('source: "workflow"')
  })

  it('puts the cron on its own line', () => {
    const prompt = subscriptionPrompt(workflow, '0 9 1 * *')
    const lines = prompt.split('\n')
    expect(lines.some(line => line.trim() === '0 9 1 * *')).toBe(true)
  })
})

describe('the interval frequency shortcuts', () => {
  const workflow = findWorkflow('kb-organize-personal') as WorkflowDefinition

  it('offers both intervals between the calendar presets and custom', () => {
    const ids = workflow.frequencies.map(frequency => frequency.id)
    expect(ids).toEqual(['daily', 'weekly', 'monthly', 'everyHours', 'everyMinutes', 'custom'])
  })

  it('carries a non-empty default for each interval', () => {
    // An empty box would make the reader fill a value before anything works.
    expect(INTERVAL_SPECS.everyHours.defaultCount).toBe(6)
    expect(INTERVAL_SPECS.everyMinutes.defaultCount).toBe(30)
    for (const spec of Object.values(INTERVAL_SPECS)) {
      expect(spec.defaultCount).toBeGreaterThanOrEqual(spec.min)
      expect(spec.defaultCount).toBeLessThanOrEqual(spec.max)
    }
  })

  it('generates an hourly expression pinned to the hour', () => {
    // The minute field is 0, so the task runs on the hour rather than at an offset.
    expect(intervalCron(INTERVAL_SPECS.everyHours, '2')).toEqual({ ok: true, cron: '0 */2 * * *' })
    expect(intervalCron(INTERVAL_SPECS.everyHours, '6')).toEqual({ ok: true, cron: '0 */6 * * *' })
  })

  it('generates a minutely expression stepping the minute field', () => {
    expect(intervalCron(INTERVAL_SPECS.everyMinutes, '15')).toEqual({ ok: true, cron: '*/15 * * * *' })
    expect(intervalCron(INTERVAL_SPECS.everyMinutes, '30')).toEqual({ ok: true, cron: '*/30 * * * *' })
  })

  it('keeps every generated expression usable by the five-field check', () => {
    // The generated value must pass the same shape check a typed one must pass.
    for (const spec of Object.values(INTERVAL_SPECS)) {
      for (const count of [spec.min, spec.defaultCount, spec.max]) {
        const result = intervalCron(spec, String(count))
        expect(result.ok).toBe(true)
        if (result.ok) expect(checkCustomCron(result.cron)).toEqual({ ok: true, cron: result.cron })
      }
    }
  })

  it('rejects a non-integer instead of rounding it', () => {
    expect(intervalCron(INTERVAL_SPECS.everyHours, '1.5')).toEqual({ ok: false, reason: 'notInteger' })
    expect(intervalCron(INTERVAL_SPECS.everyHours, 'abc')).toEqual({ ok: false, reason: 'notInteger' })
  })

  it('rejects an out-of-range count instead of clamping it', () => {
    // A silently altered schedule is a schedule the reader did not choose.
    expect(intervalCron(INTERVAL_SPECS.everyHours, '0')).toEqual({ ok: false, reason: 'outOfRange' })
    expect(intervalCron(INTERVAL_SPECS.everyHours, '24')).toEqual({ ok: false, reason: 'outOfRange' })
    expect(intervalCron(INTERVAL_SPECS.everyMinutes, '60')).toEqual({ ok: false, reason: 'outOfRange' })
  })

  it('accepts both bounds inclusive', () => {
    expect(intervalCron(INTERVAL_SPECS.everyHours, '1')).toEqual({ ok: true, cron: '0 */1 * * *' })
    expect(intervalCron(INTERVAL_SPECS.everyHours, '23')).toEqual({ ok: true, cron: '0 */23 * * *' })
    expect(intervalCron(INTERVAL_SPECS.everyMinutes, '1')).toEqual({ ok: true, cron: '*/1 * * * *' })
    expect(intervalCron(INTERVAL_SPECS.everyMinutes, '59')).toEqual({ ok: true, cron: '*/59 * * * *' })
  })

  it('rejects an empty count rather than substituting the default', () => {
    expect(intervalCron(INTERVAL_SPECS.everyHours, '  ')).toEqual({ ok: false, reason: 'empty' })
  })

  it('resolves an interval through resolveCron', () => {
    expect(resolveCron('everyHours', workflow, '', '2')).toEqual({ ok: true, cron: '0 */2 * * *' })
    expect(resolveCron('everyMinutes', workflow, '', '15')).toEqual({ ok: true, cron: '*/15 * * * *' })
    // The custom field is irrelevant while an interval is selected.
    expect(resolveCron('everyMinutes', workflow, 'garbage', '15')).toEqual({ ok: true, cron: '*/15 * * * *' })
  })

  it('does not fall through to the workflow default when an interval is selected', () => {
    // Before this existed, an interval id had no `cron`, so resolveCron would have
    // reported `empty` and the dialog would have blocked the submit.
    expect(resolveCron('everyHours', workflow, '', '6').ok).toBe(true)
  })

  it('labels the count field per unit', () => {
    expect(INTERVAL_SPECS.everyHours.unit).toBe('hours')
    expect(INTERVAL_SPECS.everyMinutes.unit).toBe('minutes')
  })
})
