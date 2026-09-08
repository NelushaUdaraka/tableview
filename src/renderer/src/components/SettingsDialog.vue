<script setup lang="ts">
import BaseModal from './BaseModal.vue'
import { useSettingsStore } from '../stores/settings'

defineEmits<{ (event: 'close'): void }>()
const settings = useSettingsStore()

const THEMES: { value: 'dark' | 'light' | 'system'; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' }
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

      <p v-if="settings.appInfo" class="settings__about muted">
        Beekeeper Clone {{ settings.appInfo.version }} · Electron
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
  height: 32px;
  padding: 0 16px;
  font-size: 13px;
}
.settings__about {
  margin: 0;
  padding-top: 16px;
  border-top: var(--rule) solid var(--border-strong);
  font-size: 11px;
  line-height: 1.7;
}
</style>
