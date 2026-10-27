/**
 * The activity monitor's rows as the main process shapes them from the DMVs:
 * which sessions are this app's own, and which permission is missing when
 * the login can only see itself.
 */
import { describe, expect, it } from 'vitest'
import {
  missingActivityPermission,
  serverActivity,
  validSessionId
} from '../../src/main/db/sqlserver/activity'
import * as Q from '../../src/main/db/sqlserver/queries'
import { STATE_SQL } from '../../src/shared/sessions'

const own = { pid: 4242, host: 'my-laptop' }
const granted = { monitorSessionId: 55, engineEdition: 3, serverState: 1, databaseState: 1 }

function row(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 60,
    login: 'sa',
    host: 'other-box   ',
    program: 'SSMS',
    hostProcessId: 99,
    database: 'shop',
    status: 'sleeping',
    command: null,
    blockedBy: null,
    waitType: null,
    waitTimeMs: 0,
    waitResource: null,
    cpuMs: 12,
    logicalReads: 300,
    elapsedMs: null,
    openTransactions: 1,
    sql: '  BEGIN TRAN; UPDATE t SET x = 1  ',
    sqlIsCurrent: false,
    loginTime: new Date('2026-10-26T10:00:00Z'),
    lastRequestEnd: new Date('2026-10-26T10:05:00Z'),
    ...patch
  }
}

describe('serverActivity', () => {
  it('shapes each session, trimming what the server pads', () => {
    const activity = serverActivity(
      granted,
      [row()],
      own,
      { tabs: { 60: 'tab-3' }, lastBatches: {} },
      new Date('2026-10-26T11:00:00Z')
    )
    expect(activity).toEqual({
      monitorSessionId: 55,
      tabSessions: { 60: 'tab-3' },
      readAt: '2026-10-26T11:00:00.000Z',
      sessions: [
        {
          sessionId: 60,
          login: 'sa',
          host: 'other-box',
          program: 'SSMS',
          database: 'shop',
          status: 'sleeping',
          command: null,
          blockedBy: null,
          waitType: null,
          waitTimeMs: 0,
          waitResource: null,
          cpuMs: 12,
          logicalReads: 300,
          elapsedMs: null,
          openTransactions: 1,
          sql: 'BEGIN TRAN; UPDATE t SET x = 1',
          sqlIsCurrent: false,
          loginTime: '2026-10-26T10:00:00.000Z',
          lastRequestEnd: '2026-10-26T10:05:00.000Z',
          ownProcess: false
        }
      ]
    })
  })

  it("marks sessions from this process and host as the app's own", () => {
    const activity = serverActivity(
      granted,
      [row({ hostProcessId: 4242, host: 'MY-LAPTOP' }), row({ hostProcessId: 4242 })],
      own
    )
    expect(activity.sessions.map((session) => session.ownProcess)).toEqual([true, false])
  })

  it('keeps who a blocked request waits on', () => {
    const [session] = serverActivity(
      granted,
      [row({ blockedBy: 60, status: 'suspended', waitType: 'LCK_M_U', waitTimeMs: 5100 })],
      own
    ).sessions
    expect(session).toMatchObject({ blockedBy: 60, status: 'suspended', waitType: 'LCK_M_U', waitTimeMs: 5100 })
  })

  it("shows a tab's last batch rather than the app's state read after it", () => {
    const sessions = serverActivity(
      granted,
      [row({ sql: STATE_SQL }), row({ sessionId: 61, sql: STATE_SQL })],
      own,
      { tabs: { 60: 'tab-1' }, lastBatches: { 60: 'BEGIN TRAN; UPDATE t SET x = 1' } }
    ).sessions
    expect(sessions.map((session) => session.sql)).toEqual(['BEGIN TRAN; UPDATE t SET x = 1', null])
  })

  it('says nothing of permissions when the login has them', () => {
    expect(serverActivity(granted, [], own).missingPermission).toBeUndefined()
  })
})

describe('missingActivityPermission', () => {
  it('names VIEW SERVER STATE on a server', () => {
    expect(missingActivityPermission({ ...granted, serverState: 0 })).toBe('VIEW SERVER STATE')
  })

  it('names VIEW DATABASE STATE on Azure SQL Database', () => {
    expect(
      missingActivityPermission({ ...granted, engineEdition: 5, serverState: 0, databaseState: 0 })
    ).toBe('VIEW DATABASE STATE')
    expect(
      missingActivityPermission({ ...granted, engineEdition: 5, serverState: 0, databaseState: 1 })
    ).toBeUndefined()
  })
})

describe('validSessionId', () => {
  it('takes whole numbers in range and nothing else', () => {
    expect(validSessionId(53)).toBe(53)
    expect(() => validSessionId(0)).toThrow()
    expect(() => validSessionId(1.5)).toThrow()
    expect(() => validSessionId('53; DROP TABLE x')).toThrow()
    expect(() => validSessionId(40000)).toThrow()
  })
})

describe('KILL_SESSION', () => {
  it('binds the session id rather than writing it into the text', () => {
    expect(Q.KILL_SESSION).toContain('@sessionId')
    expect(Q.KILL_SESSION).toContain('CAST(@sessionId AS int)')
  })
})
