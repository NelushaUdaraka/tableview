import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { AppSettings, DEFAULT_SETTINGS } from '@shared/types'
import type { AppInfo } from '@shared/ipc'
import { api } from '../lib/api'

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>({ ...DEFAULT_SETTINGS })
  const appInfo = ref<AppInfo | null>(null)
  const loaded = ref(false)

  // A plain matchMedia call inside the computed would not be a reactive
  // dependency, so `theme: 'system'` would never follow an OS theme change.
  const systemQuery = window.matchMedia?.('(prefers-color-scheme: light)')
  const systemPrefersLight = ref(systemQuery?.matches ?? false)
  systemQuery?.addEventListener?.('change', (event) => {
    systemPrefersLight.value = event.matches
  })

  const resolvedTheme = computed<'dark' | 'light'>(() => {
    if (settings.value.theme === 'system') {
      return systemPrefersLight.value ? 'light' : 'dark'
    }
    return settings.value.theme
  })

  function applyTheme(): void {
    document.documentElement.setAttribute('data-theme', resolvedTheme.value)
    document.documentElement.style.setProperty('--font-size', `${settings.value.fontSize}px`)
    document.documentElement.style.setProperty(
      '--font-mono',
      settings.value.editorFontFamily
    )
  }

  watch(resolvedTheme, applyTheme, { immediate: false })
  watch(() => [settings.value.fontSize, settings.value.editorFontFamily], applyTheme)

  async function load(): Promise<void> {
    settings.value = await api.getSettings()
    appInfo.value = await api.getAppInfo()
    loaded.value = true
    applyTheme()
  }

  async function update(patch: Partial<AppSettings>): Promise<void> {
    settings.value = await api.updateSettings(patch)
    applyTheme()
  }

  function toggleTheme(): void {
    void update({ theme: resolvedTheme.value === 'dark' ? 'light' : 'dark' })
  }

  return { settings, appInfo, loaded, resolvedTheme, load, update, toggleTheme, applyTheme }
})
