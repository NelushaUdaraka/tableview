<script setup lang="ts">
/**
 * A piece of T-SQL to read, highlighted as the editor would highlight it.
 *
 * Inline, so it sits inside whatever `<pre>` or block its parent lays out;
 * the text itself is untouched, so selecting and copying it gives back the
 * SQL exactly.
 */
import { computed } from 'vue'
import { SQL_TOKEN_COLORS, highlightSql } from '../lib/sqlHighlight'

const props = defineProps<{ sql: string }>()

const pieces = computed(() =>
  highlightSql(props.sql).map((piece) => ({
    text: piece.text,
    style: piece.token
      ? { color: SQL_TOKEN_COLORS[piece.token], ...(piece.token === 'comment' ? { fontStyle: 'italic' } : {}) }
      : undefined
  }))
)
</script>

<template>
  <code class="sql-code"><span v-for="(piece, index) in pieces" :key="index" :style="piece.style">{{ piece.text }}</span></code>
</template>

<style scoped>
.sql-code {
  font: inherit;
  color: inherit;
}
</style>
