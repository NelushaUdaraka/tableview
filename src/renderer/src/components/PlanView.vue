<script setup lang="ts">
/**
 * The Plan tab: how SQL Server runs each statement, as a tree of operators.
 *
 * Each operator says what it is and what it works on, its share of the
 * statement's cost, the rows it was expected to produce and — from an actual
 * plan — the rows it did, with the gaps that usually explain a slow query
 * marked. Warnings and missing-index hints sit above the tree they belong to;
 * a hint comes as the `CREATE INDEX` it suggests, to copy.
 */
import { computed, ref } from 'vue'
import { parseShowplan, type PlanOperator, type PlanStatement } from '@shared/showplan'
import AppIcon from './AppIcon.vue'
import { api } from '../lib/api'
import { useToastStore } from '../stores/toasts'

const props = defineProps<{ plans: string[] }>()

const toasts = useToastStore()

interface PlanDocument {
  xml: string
  statements: PlanStatement[]
  error?: string
}

const documents = computed<PlanDocument[]>(() =>
  props.plans.map((xml) => {
    try {
      return { xml, statements: parseShowplan(xml).filter((statement) => statement.root || statement.missingIndexes.length) }
    } catch (error) {
      return { xml, statements: [], error: error instanceof Error ? error.message : String(error) }
    }
  })
)

/** Operators folded away, by statement and node: `0:1:4`. */
const folded = ref<Set<string>>(new Set())

function toggle(key: string): void {
  const next = new Set(folded.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  folded.value = next
}

interface Line {
  key: string
  op: PlanOperator
  depth: number
  hasChildren: boolean
}

/** The tree as lines to draw, a folded operator's children left out. */
function lines(root: PlanOperator | null, prefix: string): Line[] {
  const out: Line[] = []
  const visit = (op: PlanOperator, depth: number): void => {
    const key = `${prefix}:${op.nodeId}`
    out.push({ key, op, depth, hasChildren: op.children.length > 0 })
    if (folded.value.has(key)) return
    for (const next of op.children) visit(next, depth + 1)
  }
  if (root) visit(root, 0)
  return out
}

function rows(value: number | undefined): string {
  if (value === undefined) return ''
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 100) / 100
  return rounded.toLocaleString('en-US')
}

function percent(value: number): string {
  return value >= 10 ? `${Math.round(value)}%` : `${value.toFixed(1)}%`
}

function gapTitle(op: PlanOperator): string {
  if (op.actualRows === undefined) return ''
  const per = op.actualExecutions && op.actualExecutions > 1
    ? ` (${rows(op.estimatedRows)} per execution × ${op.actualExecutions})`
    : ''
  const off = op.rowGap === 'over' ? 'far more than' : op.rowGap === 'under' ? 'far fewer than' : 'against'
  return `${rows(op.actualRows)} rows, ${off} the ${rows(op.estimatedTotalRows)} estimated${per}`
}

async function copy(text: string, what: string): Promise<void> {
  await api.copyToClipboard(text)
  toasts.info(`Copied ${what}`)
}

async function save(xml: string, index: number): Promise<void> {
  try {
    const saved = await api.saveTextFile(xml, `plan${props.plans.length > 1 ? `-${index + 1}` : ''}.sqlplan`, 'sqlplan')
    if (saved) toasts.success('Saved the plan', saved)
  } catch (error) {
    toasts.fromError('Could not save the plan', error)
  }
}

const actual = computed(() => documents.value.some((doc) => doc.statements.some((s) => s.actual)))
</script>

<template>
  <div class="plan">
    <div v-if="documents.length === 0" class="empty-state">
      <div class="empty-state__icon"><AppIcon name="plan" :size="20" /></div>
      <div class="empty-state__title">No plan</div>
    </div>

    <section v-for="(doc, docIndex) in documents" :key="docIndex" class="plan__doc">
      <div class="plan__doc-head">
        <span class="caps">
          {{ actual ? 'Actual plan' : 'Estimated plan' }}<template v-if="documents.length > 1">
            {{ docIndex + 1 }} of {{ documents.length }}</template
          >
        </span>
        <div class="plan__spacer"></div>
        <button class="btn btn--sm btn--ghost" @click="copy(doc.xml, 'the plan XML')">
          <AppIcon name="copy" :size="12" />
          Copy XML
        </button>
        <button class="btn btn--sm" title="Save as a .sqlplan file, which SSMS also opens" @click="save(doc.xml, docIndex)">
          <AppIcon name="save" :size="12" />
          Save as .sqlplan
        </button>
      </div>

      <p v-if="doc.error" class="plan__error">This plan could not be read: {{ doc.error }}</p>

      <article v-for="(statement, index) in doc.statements" :key="index" class="stmt">
        <header class="stmt__head">
          <span class="stmt__type">{{ statement.type || 'Statement' }}</span>
          <span class="stmt__meta num">
            {{ percent(statement.costPercent) }} of the batch · cost {{ statement.cost.toPrecision(3) }}
            <template v-if="statement.elapsedMs !== undefined">
              · {{ statement.elapsedMs }} ms elapsed, {{ statement.cpuMs }} ms CPU
            </template>
            <template v-if="statement.degreeOfParallelism && statement.degreeOfParallelism > 1">
              · {{ statement.degreeOfParallelism }} threads
            </template>
          </span>
        </header>
        <pre class="stmt__text mono selectable" :title="statement.text">{{ statement.text }}</pre>

        <ul v-if="statement.warnings.length" class="stmt__warnings">
          <li v-for="(warning, at) in statement.warnings" :key="at">
            <AppIcon name="triangle-alert" :size="12" />
            <span class="selectable">{{ warning }}</span>
          </li>
        </ul>

        <div v-for="(hint, at) in statement.missingIndexes" :key="at" class="hint">
          <div class="hint__head">
            <AppIcon name="info" :size="12" />
            <span>Missing index · SQL Server estimates it would improve this statement by
              <strong class="num">{{ Math.round(hint.impact) }}%</strong></span>
            <div class="plan__spacer"></div>
            <button class="btn btn--sm btn--ghost" @click="copy(hint.createIndex, 'the CREATE INDEX statement')">
              <AppIcon name="copy" :size="12" />
              Copy
            </button>
          </div>
          <pre class="hint__sql mono selectable">{{ hint.createIndex }}</pre>
        </div>

        <table v-if="statement.root" class="ops">
          <thead>
            <tr>
              <th>Operator</th>
              <th class="ops__cost">Cost</th>
              <th class="num">Est. rows</th>
              <th v-if="statement.actual" class="num">Actual rows</th>
              <th v-if="statement.actual" class="num">Executions</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="line in lines(statement.root, `${docIndex}:${index}`)" :key="line.key">
              <tr class="ops__row" :data-op="line.op.physicalOp">
                <td>
                  <div class="ops__name">
                  <span class="ops__indent" :style="{ width: `${line.depth * 16}px` }"></span>
                  <button
                    v-if="line.hasChildren"
                    class="ops__twisty"
                    :aria-expanded="!folded.has(line.key)"
                    :aria-label="folded.has(line.key) ? 'Show what feeds it' : 'Hide what feeds it'"
                    @click="toggle(line.key)"
                  >
                    <AppIcon :name="folded.has(line.key) ? 'chevron-right' : 'chevron-down'" :size="12" />
                  </button>
                  <span v-else class="ops__twisty ops__twisty--blank"></span>
                  <span class="ops__op">{{ line.op.physicalOp }}</span>
                  <span
                    v-if="line.op.logicalOp && line.op.logicalOp !== line.op.physicalOp"
                    class="ops__logical"
                    >{{ line.op.logicalOp }}</span
                  >
                  <span v-if="line.op.parallel" class="badge" title="Runs on several threads">parallel</span>
                  <span v-if="line.op.object" class="ops__object mono truncate" :title="line.op.object">{{
                    line.op.object
                  }}</span>
                  <span
                    v-if="line.op.warnings.length"
                    class="ops__warn"
                    :title="line.op.warnings.join('\n')"
                    :aria-label="line.op.warnings.join('. ')"
                  >
                    <AppIcon name="triangle-alert" :size="12" />
                  </span>
                  </div>
                </td>
                <td class="ops__cost">
                  <div class="ops__cost-cell">
                    <span class="ops__bar"><span :style="{ width: `${Math.min(100, line.op.costPercent)}%` }"></span></span>
                    <span class="num">{{ percent(line.op.costPercent) }}</span>
                  </div>
                </td>
                <td class="num">{{ rows(line.op.estimatedTotalRows) }}</td>
                <td
                  v-if="statement.actual"
                  class="num"
                  :class="{ 'ops__gap': line.op.rowGap }"
                  :title="gapTitle(line.op)"
                >
                  {{ rows(line.op.actualRows) }}
                </td>
                <td v-if="statement.actual" class="num">{{ line.op.actualExecutions ?? '' }}</td>
              </tr>
              <tr v-for="(warning, at) in line.op.warnings" :key="`${line.key}-w${at}`" class="ops__warning">
                <td :colspan="statement.actual ? 5 : 3">
                  <span :style="{ marginLeft: `${line.depth * 16 + 22}px` }">
                    <AppIcon name="triangle-alert" :size="11" />
                    {{ warning }}
                  </span>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </article>
    </section>
  </div>
</template>

<style scoped>
.plan {
  height: 100%;
  overflow: auto;
  padding: 10px 14px 20px;
  font-size: 12px;
}
.plan__doc + .plan__doc {
  margin-top: 18px;
}
.plan__doc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  color: var(--text-muted);
}
.plan__spacer {
  flex: 1;
}
.plan__error {
  color: var(--danger);
}
.stmt {
  margin-bottom: 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  overflow: hidden;
}
.stmt__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 8px 12px 0;
}
.stmt__type {
  font-weight: 600;
  color: var(--text-primary);
}
.stmt__meta {
  color: var(--text-muted);
}
.stmt__text {
  margin: 4px 12px 8px;
  max-height: 3.2em;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
}
.stmt__warnings {
  margin: 0 12px 8px;
  padding: 0;
  list-style: none;
  color: var(--warning);
}
.stmt__warnings li {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 2px 0;
}
.stmt__warnings .icon {
  margin-top: 3px;
  flex: 0 0 auto;
}
.hint {
  margin: 0 12px 10px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.hint__head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
}
.hint__head .icon {
  color: var(--accent-fg);
}
.hint__sql {
  margin: 6px 0 0;
  color: var(--text-primary);
  white-space: pre-wrap;
}
.ops {
  width: 100%;
  border-collapse: collapse;
}
.ops th {
  height: 28px;
  padding: 0 10px;
  border-top: 1px solid var(--border-subtle);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-app);
  color: var(--text-muted);
  font-weight: 500;
  text-align: left;
  white-space: nowrap;
}
.ops th.num,
.ops td.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.ops td {
  height: 28px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.ops__row:hover td {
  background: var(--bg-hover);
}
.ops__name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.ops__indent {
  flex: 0 0 auto;
}
.ops__twisty {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  flex: 0 0 auto;
}
.ops__twisty:hover {
  background: var(--bg-hover-strong);
}
.ops__twisty--blank {
  cursor: default;
}
.ops__op {
  font-weight: 600;
  color: var(--text-primary);
}
.ops__logical {
  color: var(--text-muted);
}
.ops__object {
  max-width: 340px;
  color: var(--text-secondary);
}
.ops__warn {
  display: inline-flex;
  color: var(--warning);
}
.ops__cost {
  width: 120px;
}
.ops__cost-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ops__bar {
  position: relative;
  width: 60px;
  height: 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-primary) 8%, transparent);
  overflow: hidden;
  flex: 0 0 auto;
}
.ops__bar > span {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: inherit;
  background: var(--accent);
}
.ops__gap {
  color: var(--danger);
  font-weight: 600;
}
.ops__warning td {
  height: 22px;
  border-bottom: 1px solid var(--border);
  color: var(--warning);
  font-size: 11px;
}
</style>
