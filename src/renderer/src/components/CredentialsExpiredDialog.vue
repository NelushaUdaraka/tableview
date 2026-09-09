<script setup lang="ts">
/**
 * Fixing expired AWS credentials where you hit them.
 *
 * Temporary portal credentials last a few hours, so they run out mid-session
 * far more often than they are first set up. Sending the user back through the
 * connection form to fix that loses whatever they were doing; this takes the
 * paste, saves it against the connection, and retries the thing that failed.
 */
import { computed, nextTick, ref, watch } from 'vue'
import BaseModal from './BaseModal.vue'
import { parseAwsCredentials, isExpired } from '@shared/aws/credentials'
import { useConnectionStore } from '../stores/connections'
import { useCredentialsStore } from '../stores/credentials'
import { useToastStore } from '../stores/toasts'

const credentials = useCredentialsStore()
const connections = useConnectionStore()
const toasts = useToastStore()

const text = ref('')
const saving = ref(false)
const box = ref<HTMLTextAreaElement | null>(null)

const prompt = computed(() => credentials.prompt)

/** Credentials resolved by the CLI have nothing to paste — they need a login. */
const usesPastedCredentials = computed(
  () => prompt.value?.connection.ssm?.credentialSource === 'pasted'
)

const profileHint = computed(() => {
  const profile = prompt.value?.connection.ssm?.profile?.trim()
  return profile ? `aws sso login --profile ${profile}` : 'aws sso login'
})

const parsed = computed(() => (text.value.trim() ? parseAwsCredentials(text.value) : null))

/** What is wrong with what has been pasted so far, if anything. */
const pasteError = computed(() => {
  const result = parsed.value
  if (!result) return ''
  if (!result.credentials) return result.error ?? 'That block could not be read'
  // Pasting the block that just expired is an easy mistake to make.
  if (isExpired(result.credentials)) return 'That block has already expired — copy a fresh one'
  return ''
})

const pasteSummary = computed(() => {
  const found = parsed.value?.credentials
  if (!found) return ''
  const parts = [found.accessKeyId.slice(0, 4) + '…' + found.accessKeyId.slice(-4)]
  if (found.region) parts.push(found.region)
  if (found.expiration) parts.push(`expires ${new Date(found.expiration).toLocaleTimeString()}`)
  return parts.join(' · ')
})

const canSave = computed(
  () => usesPastedCredentials.value && Boolean(parsed.value?.credentials) && !pasteError.value
)

// A dialog that opens with the caret already in the box is one paste from done.
watch(prompt, (value) => {
  if (!value) return
  text.value = ''
  void nextTick(() => box.value?.focus())
})

async function save(): Promise<void> {
  const current = prompt.value
  if (!current || !canSave.value) return

  saving.value = true
  try {
    await connections.save({
      id: current.connection.id,
      name: current.connection.name,
      ssm: { ...current.connection.ssm, credentialsText: text.value }
    })
    credentials.dismiss()
    toasts.success('Credentials updated')
    await current.retry?.()
  } catch (error) {
    toasts.fromError('Could not save the credentials', error)
  } finally {
    saving.value = false
  }
}

/** For CLI-resolved credentials: the user refreshes outside, then retries. */
async function retryOnly(): Promise<void> {
  const current = prompt.value
  credentials.dismiss()
  await current?.retry?.()
}
</script>

<template>
  <BaseModal
    v-if="prompt"
    kicker="AWS credentials"
    title="These credentials have expired"
    :subtitle="prompt.connection.name"
    width="560px"
    @close="credentials.dismiss()"
  >
    <p class="expired__why">{{ prompt.message }}</p>

    <label v-if="usesPastedCredentials" class="field">
      <span class="field__label">Paste a fresh block from the AWS access portal</span>
      <textarea
        ref="box"
        v-model="text"
        class="textarea expired__box"
        rows="5"
        spellcheck="false"
        autocomplete="off"
        placeholder="export AWS_ACCESS_KEY_ID=&quot;ASIA…&quot;&#10;export AWS_SECRET_ACCESS_KEY=&quot;…&quot;&#10;export AWS_SESSION_TOKEN=&quot;…&quot;"
      ></textarea>
      <span v-if="pasteError" class="field__hint error-text">{{ pasteError }}</span>
      <span v-else-if="pasteSummary" class="field__hint mono">{{ pasteSummary }}</span>
      <span v-else class="field__hint">
        Any of the portal's formats works — bash, PowerShell, cmd, or a credentials-file stanza.
        It replaces the block saved with this connection.
      </span>
    </label>

    <div v-else class="expired__cli">
      <p>
        This connection lets the AWS CLI resolve its credentials, so there is nothing to paste.
        Refresh them and try again:
      </p>
      <code class="expired__cmd mono">{{ profileHint }}</code>
    </div>

    <template #footer>
      <button class="btn" @click="credentials.dismiss()">Cancel</button>
      <div class="expired__spacer"></div>
      <button
        v-if="usesPastedCredentials"
        class="btn btn--primary"
        :disabled="!canSave || saving"
        @click="save"
      >
        <span v-if="saving" class="spinner"></span>
        Save and retry
      </button>
      <button v-else class="btn btn--primary" @click="retryOnly">Retry</button>
    </template>
  </BaseModal>
</template>

<style scoped>
.expired__why {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.expired__box {
  min-height: 96px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
}
.expired__cli p {
  margin: 0 0 10px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.expired__cmd {
  display: block;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 12px;
  user-select: text;
}
.expired__spacer {
  flex: 1;
}
</style>
