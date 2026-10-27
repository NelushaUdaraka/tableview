/**
 * Execution plans as the Plan tab reads them, from plans a real SQL Server
 * 2022 returned (test/fixtures): the operator tree, each operator's share of
 * the cost, estimated against actual rows, warnings and missing indexes.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  SHOWPLAN_COLUMN,
  compilesOnly,
  describeWarnings,
  liftPlans,
  missingIndexes,
  parseShowplan,
  rowGap,
  type PlanOperator
} from '../../src/shared/showplan'
import { parseXml } from '../../src/shared/xml'

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')

const flatten = (node: PlanOperator | null): PlanOperator[] =>
  node ? [node, ...node.children.flatMap(flatten)] : []

describe('parseXml', () => {
  it('reads elements and attributes, decoding entities', () => {
    const root = parseXml(
      `<?xml version="1.0"?><!-- note --><a x="1 &lt; 2 &amp;&#65;&#x42;"><b y='q'/><c></c></a>`
    )
    expect(root).toEqual({
      name: 'a',
      attrs: { x: '1 < 2 &AB' },
      children: [
        { name: 'b', attrs: { y: 'q' }, children: [] },
        { name: 'c', attrs: {}, children: [] }
      ]
    })
  })

  it('refuses text that is not a whole document', () => {
    expect(() => parseXml('<a><b></a>')).toThrow()
    expect(() => parseXml('not xml')).toThrow()
  })
})

describe('an estimated plan', () => {
  const statements = parseShowplan(fixture('showplan-estimated.xml'))

  it('lists each statement of the batch with its share of the cost', () => {
    expect(statements.map((statement) => [statement.type, statement.actual])).toEqual([
      ['SELECT', false],
      ['SELECT WITHOUT QUERY', false]
    ])
    expect(statements[0].text).toContain("WHERE b.code = N'C12'")
    expect(Math.round(statements[0].costPercent)).toBe(100)
    expect(statements[1].root).toBeNull()
  })

  it('builds the operator tree through the elements that wrap each child', () => {
    const operators = flatten(statements[0].root)
    expect(operators.map((op) => op.physicalOp)).toEqual([
      'Sort',
      'Stream Aggregate',
      'Sort',
      'Nested Loops',
      'Clustered Index Scan',
      'Clustered Index Seek'
    ])
    expect(statements[0].root!.children).toHaveLength(1)
    const loops = operators[3]
    expect(loops.children.map((op) => op.physicalOp)).toEqual(['Clustered Index Scan', 'Clustered Index Seek'])
    expect(operators[4].object).toMatch(/^\[dbo\]\.\[plan_big\]\.\[PK__plan_big__\w+\] \[b\]$/)
  })

  it("gives each operator its own cost, which add up to the statement's", () => {
    const operators = flatten(statements[0].root)
    const total = operators.reduce((sum, op) => sum + op.costPercent, 0)
    expect(total).toBeGreaterThan(99.9)
    expect(total).toBeLessThan(100.1)
    expect(operators.every((op) => op.actualRows === undefined && op.rowGap === null)).toBe(true)
  })

  it("says what the implicit conversion does to the plan", () => {
    expect(statements[0].warnings).toEqual([
      "Implicit conversion CONVERT_IMPLICIT(nvarchar(20),[b].[code],0)=N'C12' may affect the use of an index seek"
    ])
  })
})

describe('an actual plan', () => {
  const [statement] = parseShowplan(fixture('showplan-actual.xml'))

  it('carries the rows each operator produced, and the time the statement took', () => {
    expect(statement.actual).toBe(true)
    const operators = flatten(statement.root)
    expect(operators.map((op) => [op.physicalOp, op.actualRows, op.actualExecutions])).toEqual([
      ['Stream Aggregate', 1, 1],
      ['Clustered Index Scan', 5, 1]
    ])
    expect(statement.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('turns the missing-index hint into a CREATE INDEX statement', () => {
    expect(statement.missingIndexes).toHaveLength(1)
    const [hint] = statement.missingIndexes
    expect(Math.round(hint.impact)).toBe(96)
    expect(hint.createIndex).toBe(
      'CREATE NONCLUSTERED INDEX [IX_plan_big_code]\nON [beekeeper_test].[dbo].[plan_big] ([code]);'
    )
  })
})

describe('a plan whose top operator has no counters', () => {
  it('is still an actual plan, with nothing said for that operator’s rows', () => {
    const [statement] = parseShowplan(`<ShowPlanXML><BatchSequence><Batch><Statements>
      <StmtSimple StatementText="SELECT 1" StatementType="SELECT" StatementSubTreeCost="1"><QueryPlan>
        <RelOp NodeId="0" PhysicalOp="Compute Scalar" LogicalOp="Compute Scalar" EstimateRows="1" EstimatedTotalSubtreeCost="1">
          <ComputeScalar><RelOp NodeId="1" PhysicalOp="Table Scan" LogicalOp="Table Scan" EstimateRows="2" EstimatedTotalSubtreeCost="0.9">
            <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="400" ActualExecutions="1"/></RunTimeInformation>
          </RelOp></ComputeScalar>
        </RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`)
    expect(statement.actual).toBe(true)
    expect(statement.root?.actualRows).toBeUndefined()
    expect(statement.root?.children[0]).toMatchObject({ actualRows: 400, rowGap: 'over' })
  })
})

describe('missingIndexes', () => {
  it('puts equality columns before inequality ones, and the rest in INCLUDE', () => {
    const plan = parseXml(`<QueryPlan><MissingIndexes><MissingIndexGroup Impact="40.5">
      <MissingIndex Database="[shop]" Schema="[sales]" Table="[orders]">
        <ColumnGroup Usage="INEQUALITY"><Column Name="[placed_at]"/></ColumnGroup>
        <ColumnGroup Usage="EQUALITY"><Column Name="[status]"/></ColumnGroup>
        <ColumnGroup Usage="INCLUDE"><Column Name="[total]"/><Column Name="[customer_id]"/></ColumnGroup>
      </MissingIndex></MissingIndexGroup></MissingIndexes></QueryPlan>`)
    expect(missingIndexes(plan)[0].createIndex).toBe(
      'CREATE NONCLUSTERED INDEX [IX_orders_status_placed_at]\n' +
        'ON [shop].[sales].[orders] ([status], [placed_at])\n' +
        'INCLUDE ([total], [customer_id]);'
    )
  })
})

describe('describeWarnings', () => {
  it('says each kind of warning in words', () => {
    const warnings = parseXml(`<Warnings NoJoinPredicate="true">
      <ColumnsWithNoStatistics><ColumnReference Table="[t]" Column="a"/></ColumnsWithNoStatistics>
      <SpillToTempDb SpillLevel="2"/>
      <MemoryGrantWarning GrantWarningKind="ExcessiveGrant"/>
      <SomethingNew/>
    </Warnings>`)
    expect(describeWarnings(warnings)).toEqual([
      'No join predicate',
      'No statistics on [t].a',
      'Spilled to tempdb (level 2)',
      'Memory grant: excessive grant',
      'Something new'
    ])
  })
})

describe('rowGap', () => {
  it('flags rows ten times off the estimate, either way, once there are enough to matter', () => {
    expect(rowGap(10, 500)).toBe('over')
    expect(rowGap(5000, 3)).toBe('under')
    expect(rowGap(10, 40)).toBeNull()
    expect(rowGap(1, 5)).toBeNull()
    expect(rowGap(10, undefined)).toBeNull()
  })
})

describe('compilesOnly', () => {
  it('lets a plain script be planned without running, and not one that switches the options', () => {
    expect(compilesOnly('DELETE FROM t WHERE id = 1')).toBe(true)
    expect(compilesOnly('SET SHOWPLAN_XML OFF; DELETE FROM t')).toBe(false)
    expect(compilesOnly('set noexec off\nDELETE FROM t')).toBe(false)
    expect(compilesOnly('SET STATISTICS  XML ON')).toBe(false)
  })
})

describe('liftPlans', () => {
  it('takes plan result sets out of the statements and keeps the rest', () => {
    const column = (name: string) => ({
      name,
      index: 0,
      dataType: 'nvarchar(max)',
      jsKind: 'string' as const,
      nullable: true,
      isIdentity: false,
      isReadOnly: false
    })
    const rows = { columns: [column('code')], rows: [['b']], rowCount: 1, truncated: false }
    const plan = { columns: [column(SHOWPLAN_COLUMN)], rows: [['<ShowPlanXML/>']], rowCount: 1, truncated: false }
    const statement = { sql: 'x', resultSets: [rows, plan], rowsAffected: [], messages: [], durationMs: 1 }
    const untouched = { ...statement, resultSets: [rows] }
    const lifted = liftPlans([statement, untouched])
    expect(lifted.plans).toEqual(['<ShowPlanXML/>'])
    expect(lifted.statements[0].resultSets).toEqual([rows])
    expect(lifted.statements[1]).toBe(untouched)
  })

  it("takes each plan's own row off the rows affected, and all of them for an estimated plan", () => {
    const plan = {
      columns: [{ name: SHOWPLAN_COLUMN, index: 0, dataType: 'nvarchar(max)', jsKind: 'string' as const, nullable: true, isIdentity: false, isReadOnly: false }],
      rows: [['<ShowPlanXML/>']],
      rowCount: 1,
      truncated: false
    }
    const statement = { sql: 'x', resultSets: [plan], rowsAffected: [5, 1], messages: [], durationMs: 1 }
    expect(liftPlans([statement]).statements[0].rowsAffected).toEqual([5])
    expect(liftPlans([statement], { estimated: true }).statements[0].rowsAffected).toEqual([])
  })
})
