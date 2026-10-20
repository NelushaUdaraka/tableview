<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import BaseModal from './BaseModal.vue'
import type { IconName } from '../lib/icons'
import {
  UPDATE_ACTION_LABELS,
  nextUpdateAction,
  updateInProgress,
  updateSummary
} from '../lib/updateStatus'
import { useSettingsStore } from '../stores/settings'
import { useUpdateStore } from '../stores/updates'

defineEmits<{ (event: 'close'): void }>()
const settings = useSettingsStore()
const updates = useUpdateStore()

const updateAction = computed(() => nextUpdateAction(updates.state))
const updateHint = computed(() =>
  updates.state.mode === 'notify'
    ? 'Looks for a new release when TableView starts and every four hours, and says when there is one to download.'
    : 'Looks for a new release when TableView starts and every four hours, downloads it in the background, and installs it when you restart or quit.'
)

function runUpdateAction(): void {
  switch (updateAction.value) {
    case 'check':
    case 'get':
      void updates.check()
      break
    case 'restart':
      updates.install()
      break
    case 'download':
      updates.download()
      break
  }
}

const THEMES: { value: 'dark' | 'light' | 'system'; label: string; icon: IconName }[] = [
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'system', label: 'System', icon: 'monitor' }
]
</script>

<template>
  <BaseModal kicker="Preferences" title="Settings" width="560px" @close="$emit('close')">
    <div class="settings">
      <div class="field">
        <span class="field__label">Theme</span>
        <div class="seg">
          <button
            v-for="entry in THEMES"
            :key="entry.value"
            class="seg__opt settings__seg-opt"
            :class="{ 'seg__opt--on': settings.settings.theme === entry.value }"
            @click="settings.update({ theme: entry.value })"
          >
            <AppIcon :name="entry.icon" :size="14" />
            {{ entry.label }}
          </button>
        </div>
      </div>

      <hr class="rule" />

      <div class="settings__row">
        <label class="field" style="flex: 1">
          <span class="field__label">Font size</span>
          <input
            class="input"
            type="number"
            min="10"
            max="22"
            :value="settings.settings.fontSize"
            @change="settings.update({ fontSize: Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
        <label class="field" style="flex: 1">
          <span class="field__label">Rows per page</span>
          <input
            class="input"
            type="number"
            min="10"
            max="5000"
            step="50"
            :value="settings.settings.pageSize"
            @change="settings.update({ pageSize: Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
      </div>

      <label class="field">
        <span class="field__label">Editor font</span>
        <input
          class="input mono"
          :value="settings.settings.editorFontFamily"
          @change="settings.update({ editorFontFamily: ($event.target as HTMLInputElement).value })"
        />
      </label>

      <label class="field">
        <span class="field__label">Maximum rows kept per result</span>
        <input
          class="input"
          type="number"
          min="1000"
          max="1000000"
          step="1000"
          :value="settings.settings.maxResultRows"
          @change="settings.update({ maxResultRows: Number(($event.target as HTMLInputElement).value) })"
        />
        <span class="field__hint">
          Rows past this cap are counted but not held in memory.
        </span>
      </label>

      <div class="settings__row">
        <label class="field" style="flex: 1">
          <span class="field__label">Formatter keyword case</span>
          <select
            class="select"
            :value="settings.settings.formatterKeywordCase"
            @change="settings.update({ formatterKeywordCase: ($event.target as HTMLSelectElement).value as 'upper' | 'lower' | 'preserve' })"
          >
            <option value="upper">UPPERCASE</option>
            <option value="lower">lowercase</option>
            <option value="preserve">Preserve</option>
          </select>
        </label>
        <label class="field" style="flex: 1">
          <span class="field__label">Formatter indent</span>
          <input
            class="input"
            type="number"
            min="1"
            max="8"
            :value="settings.settings.formatterIndent"
            @change="settings.update({ formatterIndent: Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
      </div>

      <hr class="rule" />

      <label class="checkbox">
        <input
          type="checkbox"
          :checked="settings.settings.confirmBeforeApply"
          @change="settings.update({ confirmBeforeApply: ($event.target as HTMLInputElement).checked })"
        />
        <span>Confirm before applying a change set</span>
      </label>

      <hr class="rule" />

      <div class="settings__updates">
        <!-- Holds the moment it is flipped, so a switch rather than a box. -->
        <button
          class="settings__switch"
          role="switch"
          :aria-checked="settings.settings.autoUpdate"
          aria-describedby="settings-update-hint"
          @click="settings.update({ autoUpdate: !settings.settings.autoUpdate })"
        >
          <span>Update automatically</span>
          <span
            class="switch"
            :class="{ 'switch--on': settings.settings.autoUpdate }"
            aria-hidden="true"
          ></span>
        </button>
        <span v-if="updates.state.mode !== 'unsupported'" id="settings-update-hint" class="field__hint">
          {{ updateHint }}
        </span>
        <div class="settings__update">
          <span class="settings__update-line" role="status">{{ updateSummary(updates.state) }}</span>
          <button
            v-if="updateAction"
            class="btn btn--sm"
            :disabled="updateInProgress(updates.state)"
            @click="runUpdateAction"
          >
            {{ UPDATE_ACTION_LABELS[updateAction] }}
          </button>
        </div>
      </div>

      <p v-if="settings.appInfo" class="settings__about">
        TableView {{ settings.appInfo.version }} · Electron
        {{ settings.appInfo.electronVersion }} · Node {{ settings.appInfo.nodeVersion }}<br />
        Data directory: <span class="mono selectable">{{ settings.appInfo.userDataPath }}</span
        ><br />
        Saved secrets:
        {{
          settings.appInfo.secretsAreOsBacked
            ? 'encrypted with the OS keystore'
            : 'encrypted with a local key file'
        }}
      </p>
    </div>
    <template #footer>
      <button class="btn btn--primary" @click="$emit('close')">Done</button>
    </template>
  </BaseModal>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.settings__row {
  display: flex;
  gap: 16px;
}
.settings__seg-opt {
  height: calc(var(--h-control-lg) - 6px);
  padding: 0 14px;
  font-size: 13px;
}
.settings__updates {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* The label reads first and the switch sits at the end of its row, where a
   settings list puts it; the whole row is the button. */
.settings__switch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
/* Free-standing, so the focus ring is drawn outside it. */
.settings__switch:focus-visible {
  outline-offset: 3px;
  border-radius: var(--radius-xs);
}
.settings__update {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 4px;
}
.settings__update-line {
  min-width: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.settings__update .btn {
  flex: 0 0 auto;
}
.settings__about {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--bg-app) 55%, var(--bg-overlay));
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.7;
}
</style>
