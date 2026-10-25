import { describe, expect, it } from 'vitest'
import {
  createEveryScheduleRecord,
  decodeScheduleChange,
  foldScheduleEvents,
  scheduleView,
} from '../src/domain.ts'
import { scheduleRunLogs } from '../src/history.ts'
import type { ScheduleId as ScheduleIdType } from '../src/types.ts'
import { ScheduleId } from '../src/domain.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

function event(data: unknown, seq = 0, time = 1_000): SessionEvent {
  return { type: 'schedule/change', seq, time, data } as SessionEvent
}

function created(id: string, scheduledAt = '2026-08-05T12:05:00.000Z'): unknown {
  return {
    version: 1,
    operation: 'create',
    schedule: {
      id,
      kind: 'every',
      prompt: 'check metrics',
      everySeconds: 300,
      scheduledAt,
    },
  }
}

describe('Schedule management durable operations', () => {
  it('decodes pause, resume, update, run, and audit changes strictly', () => {
    expect(decodeScheduleChange({ version: 1, operation: 'pause', id: 'schedule-1' }))
      .toEqual({ version: 1, operation: 'pause', id: 'schedule-1' })
    expect(decodeScheduleChange({ version: 1, operation: 'resume', id: 'schedule-1' }))
      .toEqual({ version: 1, operation: 'resume', id: 'schedule-1' })
    const update = decodeScheduleChange({
      version: 1,
      operation: 'update',
      schedule: (created('schedule-1') as { schedule: unknown }).schedule,
    })
    expect(update).toMatchObject({ operation: 'update', schedule: { id: 'schedule-1' } })
    const run = decodeScheduleChange({
      version: 1,
      operation: 'run',
      run: {
        runId: 'run-1',
        scheduleId: 'schedule-1',
        at: '2026-08-05T12:00:00.000Z',
        status: 'triggered',
        trigger: 'manual',
        durationMs: 3,
      },
    })
    expect(run).toMatchObject({ operation: 'run', run: { runId: 'run-1', status: 'triggered' } })
    const audit = decodeScheduleChange({
      version: 1,
      operation: 'audit',
      audit: {
        auditId: 'audit-1',
        actor: 'lin',
        action: 'pause',
        scheduleId: 'schedule-1',
        outcome: 'allowed',
        at: '2026-08-05T12:00:00.000Z',
      },
    })
    expect(audit).toMatchObject({ operation: 'audit', audit: { actor: 'lin', outcome: 'allowed' } })
  })

  it('tracks pause state and update transitions in one fold', () => {
    const paused = foldScheduleEvents([
      event(created('schedule-1'), 0),
      event({ version: 1, operation: 'pause', id: 'schedule-1' }, 1),
    ])
    expect(paused.paused).toEqual(['schedule-1'])
    const pausedView = scheduleView(paused.active[0] as never, 0, !paused.paused.includes(ScheduleId('schedule-1')))
    expect(pausedView).toMatchObject({ enabled: false })

    const resumed = foldScheduleEvents([
      event(created('schedule-1'), 0),
      event({ version: 1, operation: 'pause', id: 'schedule-1' }, 1),
      event({ version: 1, operation: 'resume', id: 'schedule-1' }, 2),
    ])
    expect(resumed.paused).toEqual([])
    expect(scheduleView(resumed.active[0] as never, 0, true)).toMatchObject({ enabled: true })
  })

  it('replaces the record on update and clears pause state on delete', () => {
    const next = createEveryScheduleRecord(
      ScheduleId('schedule-1') as ScheduleIdType, 'new prompt', 600, Date.parse('2026-08-05T12:00:00.000Z'),
    )
    const folded = foldScheduleEvents([
      event(created('schedule-1'), 0),
      event({ version: 1, operation: 'pause', id: 'schedule-1' }, 1),
      event({ version: 1, operation: 'update', schedule: next }, 2),
    ])
    expect(folded.active[0]).toMatchObject({ prompt: 'new prompt', everySeconds: 600 })
    expect(folded.paused).toEqual(['schedule-1'])
    const deleted = foldScheduleEvents([
      event(created('schedule-1'), 0),
      event({ version: 1, operation: 'pause', id: 'schedule-1' }, 1),
      event({ version: 1, operation: 'delete', id: 'schedule-1' }, 2),
    ])
    expect(deleted.active).toEqual([])
    expect(deleted.paused).toEqual([])
  })

  it('rejects pause/resume/update transitions against inactive or wrongly paused records', () => {
    expect(() => foldScheduleEvents([
      event({ version: 1, operation: 'pause', id: 'missing' }),
    ])).toThrow(/inactive id/)
    expect(() => foldScheduleEvents([
      event(created('schedule-1'), 0),
      event({ version: 1, operation: 'resume', id: 'schedule-1' }, 1),
    ])).toThrow(/not paused/)
    expect(() => foldScheduleEvents([
      event({ version: 1, operation: 'update', schedule: (created('missing') as { schedule: unknown }).schedule }),
    ])).toThrow(/inactive id/)
  })

  it('derives run logs from explicit receipts and older dispatch-only streams', () => {
    const explicit = scheduleRunLogs([
      event(created('schedule-1'), 0),
      event({
        version: 1,
        operation: 'run',
        run: {
          runId: 'run-1',
          scheduleId: 'schedule-1',
          at: '2026-08-05T12:01:00.000Z',
          status: 'triggered',
          trigger: 'manual',
          durationMs: 4,
        },
      }, 1, Date.parse('2026-08-05T12:01:00.000Z')),
    ])
    expect(explicit).toEqual([{
      runId: 'run-1',
      scheduleId: 'schedule-1',
      at: '2026-08-05T12:01:00.000Z',
      status: 'triggered',
      trigger: 'manual',
      durationMs: 4,
    }])

    const legacy = scheduleRunLogs([
      event(created('schedule-1'), 0),
      event({ version: 1, operation: 'dispatch', id: 'schedule-1' }, 1, Date.parse('2026-08-05T12:05:00.000Z')),
    ])
    expect(legacy).toMatchObject([{
      scheduleId: 'schedule-1',
      status: 'dispatched',
      trigger: 'due',
      durationMs: 0,
    }])

    const deduped = scheduleRunLogs([
      event(created('schedule-1'), 0),
      event({ version: 1, operation: 'dispatch', id: 'schedule-1' }, 1, Date.parse('2026-08-05T12:05:00.000Z')),
      event({
        version: 1,
        operation: 'run',
        run: {
          runId: 'run-due',
          scheduleId: 'schedule-1',
          at: '2026-08-05T12:05:00.000Z',
          status: 'dispatched',
          trigger: 'due',
          durationMs: 0,
        },
      }, 2, Date.parse('2026-08-05T12:05:00.000Z')),
    ])
    expect(deduped.map(entry => entry.runId)).toEqual(['run-due'])
  })
})
