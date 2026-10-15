/**
 * SQL Server client: connection lifecycle, query execution, schema
 * introspection and table editing.
 *
 * Deliberately free of Electron imports so it can be driven directly from
 * integration tests against a real server.
 */
import sql from 'mssql'
import { randomUUID } from 'node:crypto'
import {
  AppliedChanges,
  CellValue,
  ColumnMeta,
  ConnectionConfig,
  DatabaseSummary,
  QueryResultSet,
  RoutineObject,
  RoutineType,
  SchemaObject,
  SerializedError,
  ServerMessage,
  StatementResult,
  TableChangeSet,
  TableColumn,
  TableConstraint,
  TableDataRequest,
  TableDataResponse,
  TableForeignKey,
  TableIndex,
  TableStructure,
  TableTrigger,
  DEFAULT_SQLSERVER_OPTIONS,
  READ_ONLY_CONNECTION,
  SSM_CREDENTIALS_EXPIRED
} from '../../../shared/types'
import { serializeRow, deserializeCell } from '../../../shared/serialize'
import { qualify } from '../../../shared/sql/identifiers'
import {
  SqlParam,
  buildCountQuery,
  buildDeleteStatement,
  buildInsertStatement,
  buildSelectQuery,
  buildUpdateStatement,
  renderColumnType
} from '../../../shared/sql/builder'
import { splitBatches } from '../../../shared/sql/statements'
import { findWrite, findWriteInScript, type WriteStatement } from '../../../shared/sql/readOnly'
import { SshTunnel } from '../../tunnel/ssh'
import { SsmTunnel } from '../../tunnel/ssm'
import { credentialsToEnv, expiresAt, isExpired } from '../../../shared/aws/credentials'
import type { Tunnel, TunnelHandle } from '../../tunnel/types'
import { buildMssqlConfig } from './config'
import { planReconnect } from '../reconnect'
import type { ClientStateListener, DbClient, ExecuteOptions, ServerInfo } from '../types'
import * as Q from './queries'
import { DriverColumn, declarationOf, isReadOnlyType, jsKindOf, renderDriverType } from './types'


const DEFAULT_MAX_ROWS = 50000

/**
 * How long to let a tunnel explain itself after the driver has given up.
 *
 * The two race: the driver's socket closes the instant a forward fails, while
 * the transport's own diagnosis arrives on a child process's pipe. Losing that
 * race costs the user the actual reason, so it is worth a short wait on a
 * connection that has already failed.
 */
const FORWARD_ERROR_GRACE_MS = 1500

/** Used for connections saved before the option existed. */
const DEFAULT_KEEPALIVE_MS = DEFAULT_SQLSERVER_OPTIONS.keepAliveIntervalMs

/**
 * Driver errors that mean the socket went away rather than the server refusing
 * something. Only these may be reinterpreted as a tunnel failure — a login
 * rejection travels the same path and must reach the user unchanged.
 */
/** Attaches a code so the renderer can offer the fix rather than a toast. */
function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

function isTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /socket hang up|connection lost|econnreset|epipe|read econnreset/i.test(message)
}

/**
 * What a read-only connection answers with instead of running a script that
 * writes: the whole script, refused, as a failed statement — so it reads in
 * the results like any other error, with the line it is about.
 */
function readOnlyRefusal(sql: string, write: WriteStatement): StatementResult {
  const message = `${write.description} — this connection is read-only, so nothing was run.`
  return {
    sql,
    resultSets: [],
    rowsAffected: [],
    // Listed with the messages too, the way a failed statement's errors are.
    messages: [{ kind: 'error', message, lineNumber: write.line }],
    durationMs: 0,
    error: { message, code: READ_ONLY_CONNECTION, lineNumber: write.line }
  }
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const anyError = error as Error & Record<string, unknown>
    const original = anyError.originalError as Record<string, unknown> | undefined
    const info = (original?.info ?? original) as Record<string, unknown> | undefined
    return {
      message: error.message,
      code: (anyError.code as string | undefined) ?? undefined,
      number: numberOrUndefined(info?.number ?? anyError.number),
      state: numberOrUndefined(info?.state),
      class: numberOrUndefined(info?.class),
      lineNumber: numberOrUndefined(info?.lineNumber),
      procName: stringOrUndefined(info?.procName),
      serverName: stringOrUndefined(info?.serverName),
      detail: stringOrUndefined(original?.message)
    }
  }
  return { message: String(error) }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Uint8Array does not bind as varbinary; Buffer does. */
function toBindable(value: CellValue): unknown {
  const raw = deserializeCell(value)
  if (raw instanceof Uint8Array && !Buffer.isBuffer(raw)) return Buffer.from(raw)
  return raw
}

export function mapDriverColumns(columns: DriverColumn[]): ColumnMeta[] {
  return columns.map((column, index) => {
    const declaration = declarationOf(column)
    return {
      name: column.name || `(no name ${index + 1})`,
      index: column.index ?? index,
      dataType: renderDriverType(column),
      jsKind: jsKindOf(declaration),
      nullable: column.nullable ?? true,
      isIdentity: Boolean(column.identity),
      isReadOnly: Boolean(column.readOnly) || isReadOnlyType(declaration)
    }
  })
}

export class SqlServerClient implements DbClient {
  private pool: sql.ConnectionPool | null = null
  private tunnel: Tunnel | null = null
  private tunnelHandle: TunnelHandle | null = null
  private readonly activeRequests = new Map<string, sql.Request>()
  private serverInfo: ServerInfo | null = null
  private stateListener: ClientStateListener | null = null
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  /** True from the moment a drop is noticed until the connection is back. */
  private recovering = false
  /** True while a heartbeat is in flight, so a slow one is not doubled up on. */
  private probing = false
  /** Set by `disconnect`, so nothing reopens a connection the user closed. */
  private closed = false

  constructor(private config: ConnectionConfig) {}

  onStateChange(listener: ClientStateListener | null): void {
    this.stateListener = listener
  }

  setReadOnly(readOnly: boolean): void {
    // Every check reads the config as it is at the time, and so does the
    // reconnect after a drop, which keeps whichever way it was left.
    this.config = { ...this.config, readOnly }
  }

  private announce(event: Parameters<ClientStateListener>[0]): void {
    try {
      this.stateListener?.(event)
    } catch {
      // A listener that throws must not take the connection down with it.
    }
  }

  get isConnected(): boolean {
    return Boolean(this.pool?.connected)
  }

  get tunnelPort(): number | undefined {
    return this.tunnelHandle?.localPort
  }

  get info(): ServerInfo | null {
    return this.serverInfo
  }

  get currentConfig(): ConnectionConfig {
    return this.config
  }

  async connect(): Promise<ServerInfo> {
    if (this.pool?.connected) return this.serverInfo!
    this.closed = false
    const info = await this.openConnection()
    this.startKeepAlive()
    return info
  }

  /**
   * Opens the transport and the pool, and reads the server's details.
   *
   * Separate from `connect` because recovering from a drop runs exactly this
   * and nothing else: the same tunnel, the same pool, the same first query —
   * only without the caller who asked for it the first time.
   */
  private async openConnection(): Promise<ServerInfo> {
    this.tunnel = this.createTunnel()
    if (this.tunnel) {
      this.tunnelHandle = await this.tunnel.open()
    }

    const poolConfig = buildMssqlConfig(this.config, this.tunnelHandle)
    const pool = new sql.ConnectionPool(poolConfig)

    // Without a listener an idle-pool error would crash the main process.
    pool.on('error', (error) => {
      // eslint-disable-next-line no-console
      console.error('[mssql] pool error:', error?.message ?? error)
    })

    try {
      await pool.connect()
    } catch (error) {
      // A refused port-forward reaches the driver only as a closed socket, so
      // prefer the tunnel's own error when there is one.
      const tunnel = this.tunnel
      const via = this.config.ssm?.enabled ? 'SSM session' : 'SSH tunnel'
      const dropped = Boolean(tunnel) && isTransportFailure(error)
      // Give the transport a moment to say why, but only when the driver's
      // failure is the shape a broken forward produces.
      const forwardError = dropped
        ? ((await tunnel!.waitForForwardError?.(FORWARD_ERROR_GRACE_MS)) ??
          tunnel!.lastForwardError)
        : (tunnel?.lastForwardError ?? null)
      const hint = tunnel?.droppedConnectionHint
      await this.teardownTunnel()

      if (forwardError) {
        const message = `Could not reach ${this.config.host}:${this.config.port} through the ${via} — ${forwardError.message}`
        const code = (forwardError as Error & { code?: string }).code
        throw code ? codedError(message, code) : new Error(message)
      }
      // The forward stayed silent: some topologies accept the local socket
      // before anything has been dialled at the far end, so the drop is all
      // there is to go on. Say that, rather than passing on "socket hang up".
      if (dropped) {
        throw new Error(
          `Could not reach ${this.config.host}:${this.config.port} through the ${via} — the local port accepted the connection and it was dropped immediately (${
            error instanceof Error ? error.message : String(error)
          }).${hint ? ` ${hint}` : ''}`
        )
      }
      throw error
    }

    this.pool = pool
    this.serverInfo = await this.fetchServerInfo()
    return this.serverInfo
  }

  // -------------------------------------------------------------------------
  // Staying connected
  // -------------------------------------------------------------------------

  /**
   * How often to poke an idle connection; 0 turns the heartbeat off.
   *
   * Read through the defaults because connections saved before this option
   * existed have no value for it, and a `NaN` interval would silently disable
   * the very thing that keeps them alive.
   */
  private get keepAliveIntervalMs(): number {
    const configured = this.config.options?.keepAliveIntervalMs
    return Number.isFinite(configured) ? Number(configured) : DEFAULT_KEEPALIVE_MS
  }

  private startKeepAlive(): void {
    this.stopKeepAlive()
    const interval = this.keepAliveIntervalMs
    if (interval <= 0) return
    this.keepAliveTimer = setInterval(() => void this.probe(), interval)
    // A heartbeat is no reason to hold the process open at quit.
    this.keepAliveTimer.unref?.()
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer)
    this.keepAliveTimer = null
  }

  /**
   * Sends one row down the connection to prove it is still there.
   *
   * Skipped whenever something else is already talking to the server: a
   * connection carrying a query needs no help staying up, and a heartbeat
   * queued behind a long-running statement proves nothing about the socket.
   */
  private async probe(): Promise<void> {
    if (this.closed || this.recovering || this.probing) return
    if (this.activeRequests.size > 0) return

    const pool = this.pool
    if (!pool?.connected) {
      void this.handleDrop(new Error('The connection pool closed'))
      return
    }

    this.probing = true
    try {
      await pool.request().query('SELECT 1')
    } catch (error) {
      void this.handleDrop(this.explainTransportFailure(error))
    } finally {
      this.probing = false
    }
  }

  /**
   * Takes the dead connection down and starts trying to get it back.
   *
   * Tearing the pool down first matters: a half-open pool hands out sockets
   * that fail one query at a time, which reads to the user as the app being
   * broken rather than the connection being gone.
   */
  private async handleDrop(error: unknown): Promise<void> {
    if (this.closed || this.recovering) return
    this.recovering = true
    this.reconnectAttempt = 0
    this.stopKeepAlive()
    this.announce({ state: 'reconnecting', error })
    await this.teardown()
    void this.attemptReconnect()
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closed) return
    try {
      await this.openConnection()
      this.recovering = false
      this.reconnectAttempt = 0
      this.startKeepAlive()
      this.announce({ state: 'connected' })
    } catch (error) {
      if (this.closed) return
      await this.teardown()
      this.reconnectAttempt += 1
      const plan = planReconnect(this.reconnectAttempt, error)

      // Nothing more to try: say the connection is gone, with the reason, and
      // leave it to the user — the window offers them a Reconnect button.
      if (!plan.retry) {
        this.recovering = false
        this.announce({ state: 'disconnected', error, attempt: this.reconnectAttempt })
        return
      }

      // Keep saying so: the window shows the last attempt's reason, so a
      // connection that is taking a while explains itself while it tries.
      this.announce({ state: 'reconnecting', error, attempt: this.reconnectAttempt })
      this.reconnectTimer = setTimeout(() => void this.attemptReconnect(), plan.delayMs)
      this.reconnectTimer.unref?.()
    }
  }

  /** Closes the pool and the transport, leaving the client able to reopen. */
  private async teardown(): Promise<void> {
    if (this.pool) {
      const pool = this.pool
      this.pool = null
      try {
        await pool.close()
      } catch {
        /* pool already closed */
      }
    }
    await this.teardownTunnel()
  }

  async disconnect(): Promise<void> {
    this.closed = true
    this.recovering = false
    this.stopKeepAlive()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null

    for (const request of this.activeRequests.values()) {
      try {
        request.cancel()
      } catch {
        /* request already finished */
      }
    }
    this.activeRequests.clear()

    await this.teardown()
    this.serverInfo = null
  }

  /**
   * Picks the transport for this connection. SSM and SSH are mutually
   * exclusive; the connection form only ever enables one.
   */
  private createTunnel(): Tunnel | null {
    const target = { host: this.config.host, port: this.config.port }

    if (this.config.ssm?.enabled && this.config.ssh?.enabled) {
      throw new Error(
        'Enable either the SSH tunnel or the AWS SSM session, not both — they would each claim a local port.'
      )
    }
    if (this.config.ssm?.enabled) {
      return new SsmTunnel(this.config.ssm, target, this.awsCredentialEnv())
    }
    if (this.config.ssh?.enabled) return new SshTunnel(this.config.ssh, target)
    return null
  }

  /**
   * The AWS environment for this connection's SSM session.
   *
   * `credentials` arrives already decrypted from the store; anything other than
   * the "pasted" source leaves resolution to the AWS CLI's own chain.
   */
  private awsCredentialEnv(): Record<string, string> | undefined {
    const ssm = this.config.ssm
    if (ssm?.credentialSource !== 'pasted') return undefined

    if (!ssm.credentials) {
      throw new Error(
        'This connection is set to use pasted AWS credentials, but none are saved against it. Edit the connection and paste a block from the AWS access portal.'
      )
    }
    let parsed: ReturnType<typeof JSON.parse>
    try {
      parsed = JSON.parse(ssm.credentials)
    } catch {
      throw new Error(
        'The saved AWS credentials for this connection could not be read. Paste a fresh block from the AWS access portal.'
      )
    }

    // The block says when it runs out, so there is no reason to spend a
    // session start-up discovering it.
    if (isExpired(parsed)) {
      const when = expiresAt(parsed)
      throw codedError(
        `The AWS credentials saved with this connection expired${
          when ? ` at ${when.toISOString().replace('T', ' ').slice(0, 19)} UTC` : ''
        }. Paste a fresh block from the AWS access portal.`,
        SSM_CREDENTIALS_EXPIRED
      )
    }

    return credentialsToEnv(parsed)
  }

  /**
   * Re-reads a driver failure that is really the transport giving out.
   *
   * A session that dies mid-use — credentials that ran out while the app was
   * open, most often — reaches the driver as a closed socket and nothing else.
   * The tunnel knows why, and its reason is the one worth showing.
   */
  /**
   * Starts recovery when a failure turns out to be the connection going away.
   *
   * Without this a drop is only noticed by the next heartbeat, so the query
   * after the one that failed fails too — for up to a whole keepalive interval
   * — when the connection could have been back by then.
   */
  private noteTransportFailure(error: unknown): void {
    if (!this.closed && isTransportFailure(error)) void this.handleDrop(error)
  }

  private explainTransportFailure(error: unknown): unknown {
    const forwardError = this.tunnel?.lastForwardError
    if (!forwardError || !isTransportFailure(error)) return error

    const code = (forwardError as Error & { code?: string }).code
    const message = `The connection dropped — ${forwardError.message}`
    return code ? codedError(message, code) : new Error(message)
  }

  private async teardownTunnel(): Promise<void> {
    if (this.tunnel) {
      await this.tunnel.close()
      this.tunnel = null
      this.tunnelHandle = null
    }
  }

  /**
   * Stops a change on a read-only connection before anything is sent.
   *
   * Checked here rather than left to the window, which only hides the
   * controls: anything that reaches the main process still has to get past
   * this.
   */
  private refuseIfReadOnly(what: string): void {
    if (this.config.readOnly) {
      throw codedError(`This connection is read-only, so ${what}.`, READ_ONLY_CONNECTION)
    }
  }

  private requirePool(): sql.ConnectionPool {
    if (!this.pool?.connected) {
      // A connection that is being reopened will be back on its own, so say
      // that rather than sending the user to reconnect by hand.
      throw new Error(
        this.recovering
          ? 'The connection dropped and is being reopened. Try again in a moment.'
          : 'Not connected. Open the connection before running queries.'
      )
    }
    return this.pool
  }

  // -------------------------------------------------------------------------
  // Low-level execution
  // -------------------------------------------------------------------------

  /** Metadata queries: object rows, fully buffered. */
  private async queryObjects<T = Record<string, unknown>>(
    text: string,
    params: SqlParam[] = []
  ): Promise<T[]> {
    const request = this.requirePool().request()
    for (const param of params) request.input(param.name, toBindable(param.value))
    try {
      const result = await request.query<T>(text)
      return (result.recordset ?? []) as T[]
    } catch (error) {
      this.noteTransportFailure(error)
      throw this.explainTransportFailure(error)
    }
  }

  /**
   * Executes one statement, streaming rows so a large result never has to be
   * materialised twice and can be capped or cancelled part-way through.
   */
  private async executeOne(
    text: string,
    params: SqlParam[],
    options: ExecuteOptions
  ): Promise<StatementResult> {
    const pool = this.requirePool()
    const request = pool.request()
    const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS
    const started = Date.now()

    request.stream = true
    request.arrayRowMode = true
    for (const param of params) request.input(param.name, toBindable(param.value))

    const resultSets: QueryResultSet[] = []
    const rowsAffected: number[] = []
    const messages: ServerMessage[] = []
    const errors: unknown[] = []
    let current: QueryResultSet | null = null

    request.on('recordset', (columns: DriverColumn[]) => {
      current = {
        columns: mapDriverColumns(columns ?? []),
        rows: [],
        rowCount: 0,
        truncated: false
      }
      resultSets.push(current)
    })

    request.on('row', (row: unknown[]) => {
      if (!current) return
      current.rowCount += 1
      if (current.rows.length < maxRows) current.rows.push(serializeRow(row))
      else current.truncated = true
    })

    request.on('rowsaffected', (count: number) => {
      rowsAffected.push(count)
    })

    request.on('info', (message: Record<string, unknown>) => {
      const entry: ServerMessage = {
        kind: 'info',
        message: String(message.message ?? ''),
        number: numberOrUndefined(message.number),
        severity: numberOrUndefined(message.class),
        lineNumber: numberOrUndefined(message.lineNumber)
      }
      messages.push(entry)
      options.onMessage?.(entry)
    })

    request.on('error', (error: unknown) => {
      errors.push(error)
    })

    const executionId = options.executionId
    if (executionId) this.activeRequests.set(executionId, request)

    try {
      // batch() allows statements that must start a batch (CREATE PROCEDURE,
      // CREATE VIEW …); query() is required whenever parameters are bound.
      if (params.length === 0 && options.asSingleBatch !== false) {
        await request.batch(text)
      } else {
        await request.query(text)
      }
    } catch (error) {
      errors.push(this.explainTransportFailure(error))
      this.noteTransportFailure(error)
    } finally {
      if (executionId) this.activeRequests.delete(executionId)
      request.removeAllListeners()
    }

    const result: StatementResult = {
      sql: text,
      resultSets,
      rowsAffected,
      messages,
      durationMs: Date.now() - started
    }

    if (errors.length > 0) {
      result.error = serializeError(errors[0])
      for (const error of errors) {
        const serialized = serializeError(error)
        result.messages.push({
          kind: 'error',
          message: serialized.message,
          number: serialized.number,
          severity: serialized.class,
          lineNumber: serialized.lineNumber
        })
      }
    }

    return result
  }

  /**
   * Splits a script into `GO`-delimited batches and runs them in order,
   * stopping at the first failure. Each batch may itself contain several
   * statements and therefore produce several result sets.
   */
  async runScript(text: string, options: ExecuteOptions = {}): Promise<StatementResult[]> {
    const statements = options.asSingleBatch
      ? [{ text, start: 0, end: text.length, startLine: 1 }]
      : splitBatches(text)

    if (statements.length === 0) return []

    // The whole script is checked before any of it runs: a script refused
    // halfway through has done the first half, which is harder to reason
    // about than a script that has done nothing.
    if (this.config.readOnly) {
      const write = options.asSingleBatch ? findWrite(text) : findWriteInScript(text)
      if (write) return [readOnlyRefusal(text, write)]
    }

    const results: StatementResult[] = []
    for (const statement of statements) {
      const result = await this.executeOne(statement.text, [], options)
      results.push(result)
      if (result.error) break
    }
    return results
  }

  cancel(executionId: string): boolean {
    const request = this.activeRequests.get(executionId)
    if (!request) return false
    try {
      request.cancel()
      return true
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // Server & database metadata
  // -------------------------------------------------------------------------

  private async fetchServerInfo(): Promise<ServerInfo> {
    const rows = await this.queryObjects<ServerInfo>(Q.SERVER_INFO)
    const row = rows[0]
    return {
      productVersion: String(row?.productVersion ?? ''),
      edition: String(row?.edition ?? ''),
      productLevel: String(row?.productLevel ?? ''),
      machineName: String(row?.machineName ?? ''),
      currentDatabase: String(row?.currentDatabase ?? ''),
      login: String(row?.login ?? ''),
      currentUser: String(row?.currentUser ?? ''),
      versionString: String(row?.versionString ?? '')
    }
  }

  async listDatabases(): Promise<DatabaseSummary[]> {
    const rows = await this.queryObjects<{
      name: string
      databaseId: number
      state: string
      collation: string | null
    }>(Q.LIST_DATABASES)

    return rows.map((row) => ({
      name: row.name,
      isSystem: Q.isSystemDatabase(row.name, row.databaseId),
      state: row.state,
      collation: row.collation ?? undefined
    }))
  }

  async listSchemas(): Promise<string[]> {
    const rows = await this.queryObjects<{ name: string }>(Q.LIST_SCHEMAS)
    return rows.map((row) => row.name)
  }

  async listObjects(): Promise<SchemaObject[]> {
    const rows = await this.queryObjects<{
      schema: string
      name: string
      type: string
      rowCountEstimate: number | string | null
    }>(Q.LIST_OBJECTS)

    return rows.map((row) => ({
      schema: row.schema,
      name: row.name,
      type: row.type === 'view' ? 'view' : 'table',
      rowCountEstimate:
        row.rowCountEstimate === null ? undefined : Number(row.rowCountEstimate)
    }))
  }

  async listRoutines(): Promise<RoutineObject[]> {
    const rows = await this.queryObjects<{ schema: string; name: string; type: RoutineType }>(
      Q.LIST_ROUTINES
    )
    return rows.map((row) => ({ schema: row.schema, name: row.name, type: row.type }))
  }

  /** Switches the active database by re-pointing the pool. */
  async useDatabase(database: string): Promise<void> {
    this.config = { ...this.config, database }
    if (this.pool?.connected) {
      await this.pool.close()
      this.pool = null
    }
    const poolConfig = buildMssqlConfig(this.config, this.tunnelHandle)
    const pool = new sql.ConnectionPool(poolConfig)
    pool.on('error', (error) => {
      // eslint-disable-next-line no-console
      console.error('[mssql] pool error:', error?.message ?? error)
    })
    await pool.connect()
    this.pool = pool
    this.serverInfo = await this.fetchServerInfo()
  }

  async getObjectDefinition(schema: string, name: string): Promise<string | null> {
    const rows = await this.queryObjects<{ definition: string | null }>(Q.OBJECT_DEFINITION_QUERY, [
      { name: 'object', value: qualify(schema, name) }
    ])
    return rows[0]?.definition ?? null
  }

  async getTableStructure(schema: string, table: string): Promise<TableStructure> {
    const objectName = qualify(schema, table)
    const param: SqlParam[] = [{ name: 'object', value: objectName }]

    const [columnRows, pkRows, indexRows, fkRows, triggerRows, constraintRows, estimateRows] =
      await Promise.all([
        this.queryObjects<Record<string, unknown>>(Q.TABLE_COLUMNS, param),
        this.queryObjects<{ name: string }>(Q.TABLE_PRIMARY_KEY, param),
        this.queryObjects<Record<string, unknown>>(Q.TABLE_INDEXES, param),
        this.queryObjects<Record<string, unknown>>(Q.TABLE_FOREIGN_KEYS, param),
        this.queryObjects<Record<string, unknown>>(Q.TABLE_TRIGGERS, param),
        this.queryObjects<Record<string, unknown>>(Q.TABLE_CONSTRAINTS, param),
        this.queryObjects<{ rowCountEstimate: number | string | null }>(Q.TABLE_ROW_ESTIMATE, param)
      ])

    const primaryKey = pkRows.map((row) => row.name)
    const objects = await this.listObjects()
    const objectType =
      objects.find((entry) => entry.schema === schema && entry.name === table)?.type ?? 'table'

    const columns: TableColumn[] = columnRows.map((row) => {
      const column: TableColumn = {
        name: String(row.name),
        position: Number(row.position),
        dataType: String(row.dataType),
        fullType: '',
        maxLength: row.maxLength === null ? null : Number(row.maxLength),
        precision: row.precision === null ? null : Number(row.precision),
        scale: row.scale === null ? null : Number(row.scale),
        nullable: Boolean(row.nullable),
        defaultValue: (row.defaultValue as string | null) ?? null,
        isIdentity: Boolean(row.isIdentity),
        identitySeed: (row.identitySeed as string | null) ?? null,
        identityIncrement: (row.identityIncrement as string | null) ?? null,
        isComputed: Boolean(row.isComputed),
        computedDefinition: (row.computedDefinition as string | null) ?? null,
        isPrimaryKey: primaryKey.includes(String(row.name)),
        collation: (row.collation as string | null) ?? null,
        description: (row.description as string | null) ?? null
      }
      column.fullType = renderColumnType(column)
      return column
    })

    return {
      schema,
      name: table,
      type: objectType,
      columns,
      primaryKey,
      indexes: groupIndexes(indexRows),
      foreignKeys: groupForeignKeys(fkRows),
      triggers: groupTriggers(triggerRows),
      constraints: constraintRows.map(
        (row): TableConstraint => ({
          name: String(row.name),
          type: row.type as TableConstraint['type'],
          definition: String(row.definition ?? ''),
          column: (row.column as string | null) ?? null
        })
      ),
      rowCountEstimate:
        estimateRows[0]?.rowCountEstimate === null || estimateRows[0]?.rowCountEstimate === undefined
          ? null
          : Number(estimateRows[0].rowCountEstimate)
    }
  }

  /** Foreign keys pointing at this table, for the relations panel. */
  async getInboundForeignKeys(schema: string, table: string): Promise<TableForeignKey[]> {
    const rows = await this.queryObjects<Record<string, unknown>>(Q.TABLE_INBOUND_FOREIGN_KEYS, [
      { name: 'object', value: qualify(schema, table) }
    ])
    return groupForeignKeys(rows)
  }

  // -------------------------------------------------------------------------
  // Table data
  // -------------------------------------------------------------------------

  async fetchTableData(request: TableDataRequest): Promise<TableDataResponse> {
    const started = Date.now()
    const useRaw = request.filterMode === 'raw' && Boolean(request.rawWhere?.trim())

    const select = buildSelectQuery({
      schema: request.schema,
      table: request.table,
      filters: useRaw ? [] : request.filters,
      rawWhere: useRaw ? request.rawWhere : undefined,
      sorts: request.sorts,
      offset: request.offset,
      limit: request.limit
    })

    // A raw WHERE is the user's own SQL inside ours, and a `;` ends the
    // SELECT as readily there as anywhere.
    if (useRaw && this.config.readOnly) {
      const write = findWrite(select.sql)
      if (write) {
        throw codedError(
          `${write.description} — this connection is read-only, so the filter was not run.`,
          READ_ONLY_CONNECTION
        )
      }
    }

    const statement = await this.executeOne(select.sql, select.params, {
      maxRows: request.limit,
      asSingleBatch: false
    })

    if (statement.error) {
      const error = new Error(statement.error.message)
      Object.assign(error, statement.error)
      throw error
    }

    const resultSet = statement.resultSets[0]
    let totalRows: number | null = null
    try {
      const count = buildCountQuery({
        schema: request.schema,
        table: request.table,
        filters: useRaw ? [] : request.filters,
        rawWhere: useRaw ? request.rawWhere : undefined
      })
      const rows = await this.queryObjects<{ total: number | string }>(count.sql, count.params)
      totalRows = rows[0] === undefined ? null : Number(rows[0].total)
    } catch {
      // Counting can be expensive or blocked; the grid works without a total.
      totalRows = null
    }

    return {
      columns: resultSet?.columns ?? [],
      rows: resultSet?.rows ?? [],
      offset: request.offset,
      limit: request.limit,
      totalRows,
      durationMs: Date.now() - started,
      sql: select.sql
    }
  }

  /** Applies staged grid edits inside a single transaction. */
  async applyChanges(changeSet: TableChangeSet): Promise<AppliedChanges> {
    this.refuseIfReadOnly('staged edits cannot be applied')
    const pool = this.requirePool()
    const statements: string[] = []
    let inserted = 0
    let updated = 0
    let deleted = 0

    const transaction = new sql.Transaction(pool)
    await transaction.begin()

    try {
      for (const item of changeSet.deletes) {
        const built = buildDeleteStatement(changeSet.schema, changeSet.table, item.key)
        deleted += await this.runInTransaction(transaction, built.sql, built.params)
        statements.push(built.sql)
      }

      for (const item of changeSet.updates) {
        const built = buildUpdateStatement(
          changeSet.schema,
          changeSet.table,
          item.key,
          item.changes
        )
        updated += await this.runInTransaction(transaction, built.sql, built.params)
        statements.push(built.sql)
      }

      for (const item of changeSet.inserts) {
        const built = buildInsertStatement(changeSet.schema, changeSet.table, item.values)
        inserted += await this.runInTransaction(transaction, built.sql, built.params)
        statements.push(built.sql)
      }

      await transaction.commit()
    } catch (error) {
      try {
        await transaction.rollback()
      } catch {
        /* the transaction was already aborted by the server */
      }
      throw error
    }

    return { inserted, updated, deleted, statements }
  }

  private async runInTransaction(
    transaction: sql.Transaction,
    text: string,
    params: SqlParam[]
  ): Promise<number> {
    const request = new sql.Request(transaction)
    for (const param of params) request.input(param.name, toBindable(param.value))
    const result = await request.query(text)
    return (result.rowsAffected ?? []).reduce((sum, count) => sum + count, 0)
  }

  /** Table/column names used to seed editor autocomplete. */
  async getAutocompleteSchema(): Promise<Record<string, string[]>> {
    const rows = await this.queryObjects<{ schema: string; table: string; column: string }>(
      Q.AUTOCOMPLETE_COLUMNS
    )
    const out: Record<string, string[]> = {}
    for (const row of rows) {
      const key = `${row.schema}.${row.table}`
      if (!out[key]) out[key] = []
      out[key].push(row.column)
    }
    return out
  }

  async truncateTable(schema: string, table: string): Promise<void> {
    this.refuseIfReadOnly('no table can be truncated')
    await this.executeOne(`TRUNCATE TABLE ${qualify(schema, table)}`, [], {})
  }

  async dropObject(schema: string, name: string, type: 'table' | 'view'): Promise<void> {
    this.refuseIfReadOnly('nothing can be dropped')
    const keyword = type === 'view' ? 'VIEW' : 'TABLE'
    const result = await this.executeOne(`DROP ${keyword} ${qualify(schema, name)}`, [], {})
    if (result.error) throw Object.assign(new Error(result.error.message), result.error)
  }
}

// ---------------------------------------------------------------------------
// Row-set grouping helpers (exported for unit testing)
// ---------------------------------------------------------------------------

export function groupIndexes(rows: Record<string, unknown>[]): TableIndex[] {
  const byName = new Map<string, TableIndex>()
  for (const row of rows) {
    const name = String(row.indexName ?? '')
    if (!name) continue
    let index = byName.get(name)
    if (!index) {
      index = {
        name,
        isUnique: Boolean(row.isUnique),
        isPrimaryKey: Boolean(row.isPrimaryKey),
        isClustered: String(row.typeDesc ?? '').toUpperCase() === 'CLUSTERED',
        isDisabled: Boolean(row.isDisabled),
        filterDefinition: (row.filterDefinition as string | null) ?? null,
        columns: []
      }
      byName.set(name, index)
    }
    index.columns.push({
      name: String(row.columnName ?? ''),
      descending: Boolean(row.descending),
      isIncluded: Boolean(row.isIncluded)
    })
  }
  return [...byName.values()]
}

export function groupForeignKeys(rows: Record<string, unknown>[]): TableForeignKey[] {
  const byName = new Map<string, TableForeignKey>()
  for (const row of rows) {
    const name = String(row.name ?? '')
    if (!name) continue
    let fk = byName.get(name)
    if (!fk) {
      fk = {
        name,
        columns: [],
        referencedSchema: String(row.referencedSchema ?? ''),
        referencedTable: String(row.referencedTable ?? ''),
        referencedColumns: [],
        onDelete: String(row.onDelete ?? 'NO_ACTION'),
        onUpdate: String(row.onUpdate ?? 'NO_ACTION'),
        isDisabled: Boolean(row.isDisabled)
      }
      byName.set(name, fk)
    }
    fk.columns.push(String(row.columnName ?? ''))
    fk.referencedColumns.push(String(row.referencedColumn ?? ''))
  }
  return [...byName.values()]
}

export function groupTriggers(rows: Record<string, unknown>[]): TableTrigger[] {
  const byName = new Map<string, TableTrigger>()
  for (const row of rows) {
    const name = String(row.name ?? '')
    if (!name) continue
    let trigger = byName.get(name)
    if (!trigger) {
      trigger = {
        name,
        isDisabled: Boolean(row.isDisabled),
        isInsteadOf: Boolean(row.isInsteadOf),
        events: []
      }
      byName.set(name, trigger)
    }
    const event = String(row.event ?? '')
    if (event && !trigger.events.includes(event)) trigger.events.push(event)
  }
  return [...byName.values()]
}

export type { DbClient, ExecuteOptions, ServerInfo } from '../types'

export function newExecutionId(): string {
  return randomUUID()
}
