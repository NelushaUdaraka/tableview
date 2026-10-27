/**
 * A SQL Server execution plan, as the Plan tab draws it: each statement's tree
 * of operators with what each costs, the rows it was expected to produce and —
 * for an actual plan — the rows it did, the warnings SQL Server raised, and
 * the indexes it wished it had, as `CREATE INDEX` statements.
 *
 * Read from the showplan XML that `SET SHOWPLAN_XML` (estimated) or
 * `SET STATISTICS XML` (actual) returns, which is also what a `.sqlplan` file
 * holds.
 */
import type { StatementResult } from './types'
import { child, descendants, parseXml, type XmlElement } from './xml'

/** The column a showplan comes back in, as a result set of one row. */
export const SHOWPLAN_COLUMN = 'Microsoft SQL Server 2005 XML Showplan'

export interface PlanOperator {
  nodeId: number
  physicalOp: string
  logicalOp: string
  /** What it reads or writes: `[dbo].[orders].[IX_orders_date] [o]`. */
  object?: string
  /** Rows per execution, as estimated. */
  estimatedRows: number
  /** Rows over every execution, as estimated: what the actual rows compare with. */
  estimatedTotalRows: number
  actualRows?: number
  actualExecutions?: number
  /** Its own cost: its subtree's less its children's. */
  cost: number
  subtreeCost: number
  /** Its own cost as a share of the statement's, 0–100. */
  costPercent: number
  parallel: boolean
  /** Set when actual rows are far off the estimate: more than ten times either way. */
  rowGap: 'over' | 'under' | null
  warnings: string[]
  children: PlanOperator[]
}

export interface MissingIndex {
  /** The improvement SQL Server estimates, 0–100. */
  impact: number
  table: string
  equality: string[]
  inequality: string[]
  include: string[]
  createIndex: string
}

export interface PlanStatement {
  text: string
  type: string
  cost: number
  /** Its cost as a share of every statement in the plan, 0–100. */
  costPercent: number
  /** An actual plan: run, with the rows each operator produced. */
  actual: boolean
  root: PlanOperator | null
  warnings: string[]
  missingIndexes: MissingIndex[]
  degreeOfParallelism?: number
  elapsedMs?: number
  cpuMs?: number
}

const number = (value: string | undefined): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** `PlanAffectingConvert` → `Plan affecting convert`. */
function words(name: string): string {
  const spaced = name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function columnName(reference: XmlElement): string {
  const { Table, Column, Alias } = reference.attrs
  return [Alias ?? Table, Column].filter(Boolean).join('.')
}

/** A `<Warnings>` element in words, one line per warning. */
export function describeWarnings(warnings: XmlElement | undefined): string[] {
  if (!warnings) return []
  const out: string[] = []
  if (warnings.attrs.NoJoinPredicate === 'true' || warnings.attrs.NoJoinPredicate === '1') {
    out.push('No join predicate')
  }
  for (const warning of warnings.children) {
    const attrs = warning.attrs
    switch (warning.name) {
      case 'PlanAffectingConvert':
        out.push(
          `Implicit conversion ${attrs.Expression ?? ''} may affect ${
            attrs.ConvertIssue === 'Seek Plan' ? 'the use of an index seek' : 'the row estimates'
          }`.replace(/\s+/g, ' ')
        )
        break
      case 'ColumnsWithNoStatistics':
        out.push(`No statistics on ${descendants(warning, 'ColumnReference').map(columnName).join(', ')}`)
        break
      case 'SpillToTempDb':
        out.push(`Spilled to tempdb${attrs.SpillLevel ? ` (level ${attrs.SpillLevel})` : ''}`)
        break
      case 'SortSpillDetails':
      case 'HashSpillDetails':
      case 'ExchangeSpillDetails':
        out.push(`${words(warning.name.replace('Details', ''))} to tempdb`)
        break
      case 'MemoryGrantWarning':
        out.push(`Memory grant: ${words(attrs.GrantWarningKind ?? 'warning').toLowerCase()}`)
        break
      case 'Wait':
        out.push(`Waited ${attrs.WaitTime ?? '?'} ms on ${attrs.WaitType ?? 'a resource'}`)
        break
      case 'UnmatchedIndexes':
        out.push('A filtered index could not be used because of parameterisation')
        break
      default:
        out.push(words(warning.name))
    }
  }
  return out
}

/** The RelOps directly under an operator, through whatever element its kind wraps them in. */
function childOperators(relOp: XmlElement): XmlElement[] {
  const out: XmlElement[] = []
  const visit = (node: XmlElement): void => {
    for (const entry of node.children) {
      if (entry.name === 'RelOp') out.push(entry)
      else visit(entry)
    }
  }
  visit(relOp)
  return out
}

/** The table or index an operator works on, from its own element and not its children's. */
function objectOf(relOp: XmlElement): string | undefined {
  let found: XmlElement | undefined
  const visit = (node: XmlElement): void => {
    for (const entry of node.children) {
      if (found || entry.name === 'RelOp') continue
      if (entry.name === 'Object') found = entry
      else visit(entry)
    }
  }
  visit(relOp)
  if (!found) return undefined
  const { Schema, Table, Index, Alias } = found.attrs
  const name = [Schema, Table, Index].filter(Boolean).join('.')
  return Alias && Alias !== Table ? `${name} ${Alias}` : name
}

/** Actual rows and executions, added up over the threads that ran it. */
function runtime(relOp: XmlElement): { rows: number; executions: number } | null {
  const info = child(relOp, 'RunTimeInformation')
  if (!info) return null
  let rows = 0
  let executions = 0
  for (const thread of info.children) {
    rows += number(thread.attrs.ActualRows)
    executions += number(thread.attrs.ActualExecutions)
  }
  return { rows, executions }
}

/** How far the actual rows are off the estimate, when they are far enough to matter. */
export function rowGap(estimated: number, actual: number | undefined): 'over' | 'under' | null {
  if (actual === undefined || Math.max(estimated, actual) < 10) return null
  const ratio = (actual + 1) / (estimated + 1)
  if (ratio >= 10) return 'over'
  if (ratio <= 0.1) return 'under'
  return null
}

function operator(relOp: XmlElement, statementCost: number): PlanOperator {
  const attrs = relOp.attrs
  const children = childOperators(relOp).map((entry) => operator(entry, statementCost))
  const subtreeCost = number(attrs.EstimatedTotalSubtreeCost)
  const cost = Math.max(0, subtreeCost - children.reduce((sum, entry) => sum + entry.subtreeCost, 0))
  const ran = runtime(relOp)
  const estimatedRows = number(attrs.EstimateRows)
  const executions = ran
    ? Math.max(1, ran.executions)
    : 1 + number(attrs.EstimateRebinds) + number(attrs.EstimateRewinds)
  const estimatedTotalRows = estimatedRows * executions
  return {
    nodeId: number(attrs.NodeId),
    physicalOp: attrs.PhysicalOp ?? '',
    logicalOp: attrs.LogicalOp ?? '',
    object: objectOf(relOp),
    estimatedRows,
    estimatedTotalRows,
    ...(ran ? { actualRows: ran.rows, actualExecutions: ran.executions } : {}),
    cost,
    subtreeCost,
    costPercent: statementCost > 0 ? (cost / statementCost) * 100 : 0,
    parallel: attrs.Parallel === 'true' || attrs.Parallel === '1',
    rowGap: rowGap(estimatedTotalRows, ran?.rows),
    warnings: describeWarnings(child(relOp, 'Warnings')),
    children
  }
}

const unbracket = (name: string): string => name.replace(/^\[|\]$/g, '').replace(/\]\]/g, ']')

/** A missing-index hint as the statement that would create it. */
export function missingIndexes(queryPlan: XmlElement): MissingIndex[] {
  return descendants(queryPlan, 'MissingIndexGroup').flatMap((group) =>
    group.children
      .filter((entry) => entry.name === 'MissingIndex')
      .map((index) => {
        const columns = (usage: string): string[] =>
          index.children
            .filter((entry) => entry.name === 'ColumnGroup' && entry.attrs.Usage === usage)
            .flatMap((entry) => entry.children.map((column) => column.attrs.Name ?? ''))
            .filter(Boolean)
        const equality = columns('EQUALITY')
        const inequality = columns('INEQUALITY')
        const include = columns('INCLUDE')
        const { Database, Schema, Table } = index.attrs
        const table = [Database, Schema, Table].filter(Boolean).join('.')
        const keys = [...equality, ...inequality]
        const name = `IX_${[Table, ...keys].map((part) => unbracket(part ?? '')).join('_')}`
          .replace(/[^\w]+/g, '_')
          .slice(0, 128)
        const createIndex = [
          `CREATE NONCLUSTERED INDEX [${name}]`,
          `ON ${table} (${keys.join(', ')})`,
          ...(include.length ? [`INCLUDE (${include.join(', ')})`] : [])
        ].join('\n') + ';'
        return {
          impact: number(group.attrs.Impact),
          table,
          equality,
          inequality,
          include,
          createIndex
        }
      })
  )
}

/** Every statement in a showplan, in order, with its operators. */
export function parseShowplan(xml: string): PlanStatement[] {
  const root = parseXml(xml)
  // The batch's statements, wherever an IF or a cursor puts them — but not a
  // function's own, which sit inside the plan of the statement calling it.
  const simple: XmlElement[] = []
  const visit = (node: XmlElement): void => {
    for (const entry of node.children) {
      if (entry.name === 'StmtSimple') simple.push(entry)
      if (entry.name !== 'QueryPlan') visit(entry)
    }
  }
  visit(root)
  const total = simple.reduce((sum, statement) => sum + number(statement.attrs.StatementSubTreeCost), 0)
  return simple.map((statement) => {
    const attrs = statement.attrs
    const cost = number(attrs.StatementSubTreeCost)
    const queryPlan = child(statement, 'QueryPlan')
    const relOp = queryPlan ? child(queryPlan, 'RelOp') : undefined
    const time = queryPlan ? child(queryPlan, 'QueryTimeStats') : undefined
    const rootOperator = relOp ? operator(relOp, cost || number(relOp.attrs.EstimatedTotalSubtreeCost)) : null
    return {
      text: (attrs.StatementText ?? '').trim(),
      type: attrs.StatementType ?? '',
      cost,
      costPercent: total > 0 ? (cost / total) * 100 : 0,
      // Anywhere in it: a Compute Scalar at the top carries no counters of
      // its own, even in a plan that ran.
      actual: Boolean(queryPlan && descendants(queryPlan, 'RunTimeInformation').length > 0),
      root: rootOperator,
      warnings: queryPlan ? describeWarnings(child(queryPlan, 'Warnings')) : [],
      missingIndexes: queryPlan ? missingIndexes(queryPlan) : [],
      ...(queryPlan?.attrs.DegreeOfParallelism
        ? { degreeOfParallelism: number(queryPlan.attrs.DegreeOfParallelism) }
        : {}),
      ...(time ? { elapsedMs: number(time.attrs.ElapsedTime), cpuMs: number(time.attrs.CpuTime) } : {})
    }
  })
}

/**
 * Whether an estimated plan of this script can be had without running any of
 * it. Under `SHOWPLAN_XML` nothing but `SET` statements run, so a script that
 * switches showplan off — or another compile-only option — could run what
 * follows; such a script is held to the same checks as a run.
 */
export function compilesOnly(script: string): boolean {
  return !/\b(SHOWPLAN\w*|NOEXEC|PARSEONLY|FMTONLY|STATISTICS\s+XML|STATISTICS\s+PROFILE)\b/i.test(script)
}

/**
 * Takes the showplan result sets out of a run's statements, so the results
 * show the query's own rows and the plans go to the Plan tab. Any result set
 * of one column by that name is a plan, whether the app asked for it or the
 * script set `STATISTICS XML` itself.
 */
export function liftPlans(
  statements: StatementResult[],
  options: { estimated?: boolean } = {}
): {
  statements: StatementResult[]
  plans: string[]
} {
  const plans: string[] = []
  const kept = statements.map((statement) => {
    let lifted = 0
    const resultSets = statement.resultSets.filter((set) => {
      const isPlan = set.columns.length === 1 && set.columns[0].name === SHOWPLAN_COLUMN
      if (isPlan) {
        lifted += 1
        for (const row of set.rows) if (typeof row[0] === 'string') plans.push(row[0])
      }
      return !isPlan
    })
    if (lifted === 0) return statement
    // Each plan's row was counted as a row affected. An estimated plan ran
    // nothing, so it affected nothing at all.
    const rowsAffected = options.estimated ? [] : withoutPlanRows(statement.rowsAffected, lifted)
    return { ...statement, resultSets, rowsAffected }
  })
  return { statements: kept, plans }
}

/** The counts with `plans` single-row counts taken off the end — a plan's own row each. */
function withoutPlanRows(counts: number[], plans: number): number[] {
  const out = [...counts]
  let left = plans
  for (let index = out.length - 1; index >= 0 && left > 0; index -= 1) {
    if (out[index] === 1) {
      out.splice(index, 1)
      left -= 1
    }
  }
  return out
}
