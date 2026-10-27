<script setup lang="ts">
/**
 * Signing in to AWS SSO again, for a connection whose credentials the CLI
 * resolves.
 *
 * The main process runs `aws sso login` and opens the sign-in page in the
 * browser; this shows what is going on meanwhile, the page and code to use
 * when there is no browser here, and what went wrong if it did. It says
 * `signed-in` once the CLI has a fresh session, and the caller decides what
 * to do again with it.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import type { SsmConfig } from '@shared/types'
import type { SsoLoginPrompt } from '@shared/ipc'
import { api } from '../lib/api'

const props = withDefaults(
  defineProps<{
    config: SsmConfig
    /** The button as the one action that matters where it sits. */
    primary?: boolean
  }>(),
  { primary: false }
)

const emit = defineEmits<{ (event: 'signed-in'): void }>()

const state = ref<'idle' | 'running' | 'failed'>('idle')
const prompt = ref<SsoLoginPrompt | null>(null)
const error = ref('')
const copied = ref(false)

let current: string | null = null
let count = 0
let unsubscribe: (() => void) | null = null

onMounted(() => {
  unsubscribe = api.onSsoLoginPrompt((event) => {
    if (event.loginId === current) prompt.value = event
  })
})

onBeforeUnmount(() => {
  unsubscribe?.()
  // Nobody is left to see it through.
  if (current) void api.cancelSsoLogin(current).catch(() => undefined)
})

async function start(deviceCode = false): Promise<void> {
  const loginId = `sso-${Date.now().toString(36)}-${(count += 1)}`
  current = loginId
  state.value = 'running'
  prompt.value = null
  error.value = ''
  copied.value = false
  try {
    const signedIn = await api.ssoLogin(props.config, loginId, deviceCode)
    if (current !== loginId) return
    current = null
    state.value = 'idle'
    if (signedIn) emit('signed-in')
  } catch (failure) {
    if (current !== loginId) return
    current = null
    state.value = 'failed'
    error.value = failure instanceof Error ? failure.message : String(failure)
  }
}

async function cancel(): Promise<void> {
  const loginId = current
  current = null
  state.value = 'idle'
  prompt.value = null
  if (loginId) await api.cancelSsoLogin(loginId).catch(() => undefined)
}

/** The browser did not come up, or it is on another machine: a code works anywhere. */
async function useCode(): Promise<void> {
  await cancel()
  await start(true)
}

function openPage(): void {
  if (prompt.value) void api.openExternal(prompt.value.openUrl).catch(() => undefined)
}

async function copyCode(): Promise<void> {
  if (!prompt.value?.code) return
  await api.copyToClipboard(prompt.value.code)
  copied.value = true
}

defineExpose({ start })
</script>

<template>
  <div class="sso" :class="`sso--${state}`">
    <button
      v-if="state !== 'running'"
      type="button"
      class="btn"
      :class="{ 'btn--primary': primary, 'btn--sm': !primary }"
      @click="start()"
    >
      <AppIcon name="key" :size="14" />
      {{ state === 'failed' ? 'Try signing in again' : 'Sign in with AWS SSO' }}
    </button>

    <p v-if="state === 'failed'" class="sso__error" role="alert">
      <AppIcon name="circle-x" :size="14" />
      <span>{{ error }}</span>
    </p>

    <div v-if="state === 'running'" class="sso__wait" role="status">
      <div class="sso__line">
        <span class="spinner"></span>
        <span class="sso__waiting">
          {{
            prompt?.code
              ? 'Waiting for you to finish signing in…'
              : 'Waiting for you to finish signing in in your browser…'
          }}
        </span>
        <button type="button" class="btn btn--sm btn--muted" @click="cancel">Cancel</button>
      </div>

      <div v-if="prompt?.code" class="sso__device">
        <span class="sso__hint">Open this page on any device, and enter the code:</span>
        <span class="sso__url mono selectable">{{ prompt.url }}</span>
        <div class="sso__code-row">
          <code class="sso__code mono selectable">{{ prompt.code }}</code>
          <button type="button" class="btn btn--sm" @click="copyCode">
            <AppIcon :name="copied ? 'check' : 'copy'" :size="14" />
            {{ copied ? 'Copied' : 'Copy code' }}
          </button>
          <button type="button" class="btn btn--sm btn--ghost" @click="openPage">Open the page</button>
        </div>
      </div>
      <p v-else-if="prompt" class="sso__hint">
        No browser came up?
        <button type="button" class="sso__link" @click="openPage">Open the page again</button>
        or
        <button type="button" class="sso__link" @click="useCode">sign in with a code</button>
        instead.
      </p>
    </div>
  </div>
</template>

<style scoped>
.sso {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
}
.sso__error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--danger);
}
.sso__error .icon {
  flex: 0 0 auto;
  margin-top: 2px;
}
.sso__wait {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
}
.sso__line {
  display: flex;
  align-items: center;
  gap: 10px;
}
.sso__waiting {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text-primary);
}
.sso__device {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sso__hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted);
}
.sso__url {
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-all;
}
.sso__code-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sso__code {
  padding: 4px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.08em;
}
.sso__link {
  padding: 0;
  border: none;
  background: none;
  color: var(--accent-fg);
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.sso__link:focus-visible {
  outline: none;
  border-radius: 2px;
  box-shadow: 0 0 0 2px var(--accent-ring);
}
</style>
