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
  TableTrigger
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
import { SshTunnel } from '../../tunnel/ssh'
import { SsmTunnel } from '../../tunnel/ssm'
import { credentialsToEnv } from '../../../shared/aws/credentials'
import type { Tunnel, TunnelHandle } from '../../tunnel/types'
import { buildMssqlConfig } from './config'
import type { DbClient, ExecuteOptions, ServerInfo } from '../types'
import * as Q from './queries'
import { DriverColumn, declarationOf, isReadOnlyType, jsKindOf, renderDriverType } from './types'


const DEFAULT_MAX_ROWS = 50000

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

  constructor(private config: ConnectionConfig) {}

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
      const forwardError = this.tunnel?.lastForwardError
      const via = this.config.ssm?.enabled ? 'SSM session' : 'SSH tunnel'
      await this.teardownTunnel()
      if (forwardError) {
        throw new Error(
          `Could not reach ${this.config.host}:${this.config.port} through the ${via} — ${forwardError.message}`
        )
      }
      throw error
    }

    this.pool = pool
    this.serverInfo = await this.fetchServerInfo()
    return this.serverInfo
  }

  async disconnect(): Promise<void> {
    for (const request of this.activeRequests.values()) {
      try {
        request.cancel()
      } catch {
        /* request already finished */
      }
    }
    this.activeRequests.clear()

    if (this.pool) {
      try {
        await this.pool.close()
      } catch {
        /* pool already closed */
      }
      this.pool = null
    }
    await this.teardownTunnel()
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
    try {
      return credentialsToEnv(JSON.parse(ssm.credentials))
    } catch {
      throw new Error(
        'The saved AWS credentials for this connection could not be read. Paste a fresh block from the AWS access portal.'
      )
    }
  }

  private async teardownTunnel(): Promise<void> {
    if (this.tunnel) {
      await this.tunnel.close()
      this.tunnel = null
      this.tunnelHandle = null
    }
  }

  private requirePool(): sql.ConnectionPool {
    if (!this.pool?.connected) {
      throw new Error('Not connected. Open the connection before running queries.')
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
    const result = await request.query<T>(text)
    return (result.recordset ?? []) as T[]
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
      errors.push(error)
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
    await this.executeOne(`TRUNCATE TABLE ${qualify(schema, table)}`, [], {})
  }

  async dropObject(schema: string, name: string, type: 'table' | 'view'): Promise<void> {
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
