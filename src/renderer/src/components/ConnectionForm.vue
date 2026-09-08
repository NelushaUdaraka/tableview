<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  ConnectionConfig,
  DEFAULT_SQLSERVER_OPTIONS,
  DEFAULT_SSH_CONFIG,
  DEFAULT_SSM_CONFIG,
  SavedConnection
} from '@shared/types'
import type { SsmInstance, SsmPreflight } from '@shared/ipc'
import { parseAwsCredentials } from '@shared/aws/credentials'
import { AWS_REGIONS, describeRegion, isRegionLike } from '@shared/aws/regions'
import { api } from '../lib/api'

const props = defineProps<{ connection: SavedConnection | null; busy?: boolean }>()
const emit = defineEmits<{
  (event: 'save', value: Partial<ConnectionConfig> & { name: string }): void
  (event: 'test', value: Partial<ConnectionConfig>): void
  (event: 'cancel'): void
}>()

type Section = 'general' | 'tunnel' | 'advanced'
const section = ref<Section>('general')

/** Exactly one transport is active; the radio keeps the flags in step. */
type TunnelKind = 'none' | 'ssh' | 'ssm'
const preflight = ref<SsmPreflight | null>(null)
const checkingSsm = ref(false)
/** Pasted text lives here until Save hands it to the main process. */
const credentialText = ref('')
const clearedCredentials = ref(false)
/** The account's instances, for picking the bastion instead of typing its ID. */
const instances = ref<SsmInstance[]>([])
const instancesRegion = ref('')
const instancesWarning = ref('')
const instancesError = ref('')
const instancesLoaded = ref(false)
const loadingInstances = ref(false)

const COLORS = ['', '#f0a91d', '#58a6ff', '#3fb950', '#f85149', '#bc8cff', '#ff7b72']

function blank(): Partial<ConnectionConfig> & { name: string } {
  return {
    name: '',
    color: '',
    host: 'localhost',
    port: 1433,
    database: '',
    authType: 'sql',
    username: '',
    password: '',
    domain: '',
    savePassword: true,
    options: { ...DEFAULT_SQLSERVER_OPTIONS },
    ssh: { ...DEFAULT_SSH_CONFIG },
    ssm: { ...DEFAULT_SSM_CONFIG }
  }
}

const form = reactive(blank())
/** Blank means "keep what is stored"; the placeholder says so. */
const passwordTouched = ref(false)
const sshPasswordTouched = ref(false)
const sshPassphraseTouched = ref(false)

watch(
  () => props.connection,
  (connection) => {
    Object.assign(form, blank())
    credentialText.value = ''
    clearedCredentials.value = false
    resetInstances()
    passwordTouched.value = false
    sshPasswordTouched.value = false
    sshPassphraseTouched.value = false
    if (!connection) return

    Object.assign(form, {
      id: connection.id,
      name: connection.name,
      color: connection.color ?? '',
      host: connection.host,
      port: connection.port,
      database: connection.database ?? '',
      authType: connection.authType,
      username: connection.username ?? '',
      password: '',
      domain: connection.domain ?? '',
      savePassword: connection.savePassword,
      options: { ...DEFAULT_SQLSERVER_OPTIONS, ...connection.options },
      ssh: { ...DEFAULT_SSH_CONFIG, ...connection.ssh, password: '', passphrase: '' },
      ssm: { ...DEFAULT_SSM_CONFIG, ...connection.ssm }
    })
  },
  { immediate: true }
)

const isWindowsAuth = computed(() => form.authType === 'windows')

const tunnelKind = computed<TunnelKind>(() => {
  if (form.ssm!.enabled) return 'ssm'
  if (form.ssh!.enabled) return 'ssh'
  return 'none'
})

function setTunnelKind(kind: TunnelKind): void {
  form.ssh!.enabled = kind === 'ssh'
  form.ssm!.enabled = kind === 'ssm'
  preflight.value = null
  resetInstances()
}

function forgetCredentials(): void {
  clearedCredentials.value = true
  credentialText.value = ''
  preflight.value = null
  resetInstances()
}

async function runSsmCheck(): Promise<void> {
  checkingSsm.value = true
  try {
    // Send any freshly typed block so the check works before saving.
    preflight.value = await api.checkSsmPrerequisites(
      { ...form.ssm!, credentialsText: credentialText.value || undefined },
      form.id
    )
  } catch (error) {
    preflight.value = {
      awsCli: { ok: false, error: error instanceof Error ? error.message : String(error) },
      plugin: { ok: false },
      credentials: { ok: false }
    }
  } finally {
    checkingSsm.value = false
  }
}

const usesPastedCredentials = computed(() => form.ssm!.credentialSource === 'pasted')

/** What is already stored against this connection, if anything. */
const storedCredentials = computed(() =>
  clearedCredentials.value ? null : (props.connection?.ssm?.credentialSummary ?? null)
)

const credentialSummary = computed(() => {
  const summary = storedCredentials.value
  if (!summary) return null
  const parts = [summary.accessKeyId]
  if (summary.region) parts.push(summary.region)
  if (summary.temporary) parts.push('temporary')
  return parts.filter(Boolean).join(' · ')
})

const credentialSavedAt = computed(() => {
  const summary = storedCredentials.value
  if (!summary?.savedAt) return ''
  return `saved ${new Date(summary.savedAt).toLocaleString()}`
})

const hasCredentials = computed(
  () => Boolean(storedCredentials.value) || credentialText.value.trim().length > 0
)

/**
 * The bastion instance picker.
 *
 * An instance ID is not a durable setting: every redeploy of the bastion hands
 * back a different one, so a saved connection quietly points at something that
 * no longer exists. Once the credentials and the region are in place the form
 * asks the account what is actually there, and the ID becomes a choice from a
 * list rather than something to remember.
 */
function resetInstances(): void {
  instances.value = []
  instancesRegion.value = ''
  instancesWarning.value = ''
  instancesError.value = ''
  instancesLoaded.value = false
}

async function loadInstances(): Promise<void> {
  loadingInstances.value = true
  instancesError.value = ''
  try {
    // Send any freshly typed block so the list works before saving.
    const result = await api.listSsmInstances(
      { ...form.ssm!, credentialsText: credentialText.value || undefined },
      form.id
    )
    instances.value = result.instances
    instancesRegion.value = result.region ?? ''
    instancesWarning.value = result.warning ?? ''
    instancesLoaded.value = true
  } catch (error) {
    resetInstances()
    instancesError.value = error instanceof Error ? error.message : String(error)
  } finally {
    loadingInstances.value = false
  }
}

/** `web-bastion — i-0123… · running · 10.0.2.11 · SSM Online` */
function instanceLabel(instance: SsmInstance): string {
  const parts = [
    instance.name ? `${instance.name} — ${instance.instanceId}` : instance.instanceId
  ]
  if (instance.state !== 'unknown') parts.push(instance.state)
  if (instance.privateIpAddress) parts.push(instance.privateIpAddress)
  parts.push(instance.ssmManaged ? `SSM ${instance.ssmPingStatus ?? 'registered'}` : 'not in SSM')
  return parts.join(' · ')
}

/** A region carried by the pasted block, which the CLI would use anyway. */
const pastedRegion = computed(() => {
  const text = credentialText.value.trim()
  if (!text) return ''
  return parseAwsCredentials(text).credentials?.region ?? ''
})

/** What the lookup will actually run against — the field, then the credentials. */
const effectiveRegion = computed(
  () => form.ssm!.region?.trim() || pastedRegion.value || storedCredentials.value?.region || ''
)

const regionLooksWrong = computed(() => {
  const region = form.ssm!.region?.trim()
  return Boolean(region) && !isRegionLike(region!)
})

const fetchBlockedReason = computed(() => {
  if (!usesPastedCredentials.value) return ''
  if (!hasCredentials.value) return 'Paste your AWS credentials first'
  // Without a profile to fall back on, the region has to be explicit.
  if (!effectiveRegion.value) return 'Choose the region the bastion runs in'
  return ''
})

const selectedInstance = computed(
  () =>
    instances.value.find((instance) => instance.instanceId === form.ssm!.instanceId?.trim()) ??
    null
)

/** The redeploy case: a saved ID that the region no longer knows about. */
const instanceIdMissing = computed(
  () =>
    instancesLoaded.value &&
    instances.value.length > 0 &&
    Boolean(form.ssm!.instanceId?.trim()) &&
    !selectedInstance.value
)

/**
 * What the picker shows.
 *
 * Reads back as unset whenever the ID in the field is not one of the fetched
 * instances — the redeployed case — so the select prompts instead of sitting
 * blank, and choosing the prompt does not wipe an ID typed by hand.
 */
const pickedInstanceId = computed({
  get: () => (selectedInstance.value ? selectedInstance.value.instanceId : ''),
  set: (value: string) => {
    if (value) form.ssm!.instanceId = value
  }
})

const selectedInstanceWarning = computed(() => {
  const instance = selectedInstance.value
  if (!instance) return ''
  if (!instance.ssmManaged) {
    return 'Systems Manager does not know this instance, so a session cannot start on it. Check the SSM agent and the instance profile.'
  }
  if (instance.ssmPingStatus && instance.ssmPingStatus !== 'Online') {
    return `Systems Manager last saw this instance as ${instance.ssmPingStatus} — the agent may be down.`
  }
  return ''
})

// A block for another account, or another region, means another list.
watch(pastedRegion, (region) => {
  if (region && !form.ssm!.region?.trim()) form.ssm!.region = region
})
watch(
  () => [
    form.ssm!.region,
    form.ssm!.profile,
    form.ssm!.credentialSource,
    form.ssm!.awsCliPath,
    credentialText.value
  ],
  () => resetInstances()
)

const ssmHostLabel = computed(() =>
  form.ssm!.mode === 'remote-host'
    ? 'The Server above is resolved from the bastion, so use the address the instance can reach (an RDS endpoint, say).'
    : 'Forwards to the port above on the bastion itself, for SQL Server running on that instance.'
)
const usesSshPassword = computed(() => form.ssh!.enabled && form.ssh!.authMode === 'password')
const usesSshKey = computed(() => form.ssh!.enabled && form.ssh!.authMode === 'privateKey')

const passwordPlaceholder = computed(() =>
  props.connection?.hasSavedPassword && !passwordTouched.value ? '•••••• (saved)' : ''
)
const sshPasswordPlaceholder = computed(() =>
  props.connection?.hasSavedSshPassword && !sshPasswordTouched.value ? '•••••• (saved)' : ''
)
const sshPassphrasePlaceholder = computed(() =>
  props.connection?.hasSavedSshPassphrase && !sshPassphraseTouched.value ? '•••••• (saved)' : ''
)

const nameError = computed(() => (form.name.trim() ? '' : 'A name is required'))
const hostError = computed(() => (form.host?.trim() ? '' : 'A server is required'))
const ssmError = computed(() => {
  if (!form.ssm!.enabled) return ''
  if (usesPastedCredentials.value && !hasCredentials.value) {
    return 'Paste your AWS credentials below, or switch to letting the AWS CLI resolve them'
  }
  if (!form.ssm!.instanceId?.trim()) return 'An instance ID is required'
  if (!/^(i|mi)-[0-9a-f]{8,17}$/i.test(form.ssm!.instanceId.trim())) {
    return 'Expected an ID like i-0123456789abcdef0'
  }
  return ''
})

const canSubmit = computed(
  () => !nameError.value && !hostError.value && !ssmError.value && !props.busy
)

/** Omits untouched secrets so the main process keeps the stored value. */
function payload(): Partial<ConnectionConfig> & { name: string } {
  const ssh = { ...form.ssh! }
  if (!sshPasswordTouched.value) delete ssh.password
  if (!sshPassphraseTouched.value) delete ssh.passphrase

  const ssm = { ...form.ssm! }
  // undefined = leave stored credentials alone; '' = forget them.
  if (credentialText.value.trim()) ssm.credentialsText = credentialText.value
  else if (clearedCredentials.value) ssm.credentialsText = ''
  else delete ssm.credentialsText

  const out: Partial<ConnectionConfig> & { name: string } = {
    ...form,
    ssm,
    name: form.name.trim(),
    host: form.host?.trim(),
    port: Number(form.port) || 1433,
    database: form.database?.trim() || undefined,
    color: form.color || undefined,
    ssh
  }
  if (!passwordTouched.value) delete out.password
  return out
}

async function browseForKey(): Promise<void> {
  const file = await api.openFile([
    { name: 'Private keys', extensions: ['pem', 'key', 'ppk', ''] },
    { name: 'All files', extensions: ['*'] }
  ])
  if (file) form.ssh!.privateKeyPath = file
}
</script>

<template>
  <form class="form" @submit.prevent="canSubmit && emit('save', payload())">
    <nav class="form__tabs">
      <button
        v-for="tab in (['general', 'tunnel', 'advanced'] as Section[])"
        :key="tab"
        type="button"
        class="form__tab"
        :class="{ 'form__tab--active': section === tab }"
        @click="section = tab"
      >
        {{ tab === 'tunnel' ? 'Tunnel' : tab === 'general' ? 'General' : 'Advanced' }}
        <span v-if="tab === 'tunnel' && tunnelKind !== 'none'" class="form__dot"></span>
      </button>
    </nav>

    <!-- General -------------------------------------------------------- -->
    <section v-show="section === 'general'" class="form__section">
      <div class="row">
        <label class="field" style="flex: 2">
          <span class="field__label">Connection name</span>
          <input v-model="form.name" class="input" placeholder="Production reporting" />
          <span v-if="nameError" class="field__hint error-text">{{ nameError }}</span>
        </label>
        <div class="field" style="flex: 0 0 auto">
          <span class="field__label">Colour</span>
          <div class="swatches">
            <button
              v-for="color in COLORS"
              :key="color || 'none'"
              type="button"
              class="swatch"
              :class="{ 'swatch--active': form.color === color, 'swatch--none': !color }"
              :style="color ? { background: color } : {}"
              :title="color || 'None'"
              @click="form.color = color"
            ></button>
          </div>
        </div>
      </div>

      <div class="row">
        <label class="field" style="flex: 3">
          <span class="field__label">Server</span>
          <input v-model="form.host" class="input" placeholder="localhost" />
          <span v-if="hostError" class="field__hint error-text">{{ hostError }}</span>
        </label>
        <label class="field" style="flex: 1">
          <span class="field__label">Port</span>
          <input v-model.number="form.port" class="input" type="number" min="1" max="65535" />
        </label>
        <label class="field" style="flex: 2">
          <span class="field__label">Database</span>
          <input v-model="form.database" class="input" placeholder="(default)" />
        </label>
      </div>

      <label class="field">
        <span class="field__label">Authentication</span>
        <select v-model="form.authType" class="select">
          <option value="sql">SQL Server login</option>
          <option value="windows">Windows / NTLM</option>
          <option value="azure-ad-password">Azure AD password</option>
        </select>
      </label>

      <div class="row">
        <label v-if="isWindowsAuth" class="field" style="flex: 1">
          <span class="field__label">Domain</span>
          <input v-model="form.domain" class="input" placeholder="CORP" />
        </label>
        <label class="field" style="flex: 1">
          <span class="field__label">User</span>
          <input v-model="form.username" class="input" autocomplete="off" placeholder="sa" />
        </label>
        <label class="field" style="flex: 1">
          <span class="field__label">Password</span>
          <input
            v-model="form.password"
            class="input"
            type="password"
            autocomplete="new-password"
            :placeholder="passwordPlaceholder"
            @input="passwordTouched = true"
          />
        </label>
      </div>

      <label class="checkbox">
        <input v-model="form.savePassword" type="checkbox" />
        <span>Remember password (encrypted with the OS keystore when available)</span>
      </label>
    </section>

    <!-- Tunnel ---------------------------------------------------------- -->
    <section v-show="section === 'tunnel'" class="form__section">
      <div class="field">
        <span class="field__label">Tunnel</span>
        <div class="seg">
          <button
            v-for="choice in ([
              { id: 'none', label: 'None', hint: 'Connect straight to the server' },
              { id: 'ssh', label: 'SSH', hint: 'Forward through a bastion over SSH' },
              { id: 'ssm', label: 'AWS SSM', hint: 'Session Manager port forwarding' }
            ] as { id: TunnelKind; label: string; hint: string }[])"
            :key="choice.id"
            type="button"
            class="seg__opt form__seg-opt"
            :class="{ 'seg__opt--on': tunnelKind === choice.id }"
            :title="choice.hint"
            @click="setTunnelKind(choice.id)"
          >
            {{ choice.label }}
          </button>
        </div>
      </div>

      <!-- AWS SSM -->
      <fieldset v-if="tunnelKind === 'ssm'" class="form__group">
        <p class="hint">
          Starts <code>aws ssm start-session</code> for you and points the connection at the local
          port it opens — no separate terminal, and the session closes when you disconnect.
        </p>

        <label class="field">
          <span class="field__label">AWS credentials</span>
          <select v-model="form.ssm!.credentialSource" class="select">
            <option value="pasted">Paste credentials into the app</option>
            <option value="cli">Let the AWS CLI resolve them (profile, SSO, env)</option>
          </select>
        </label>

        <!-- Pasted credentials, stored with this connection -->
        <div v-if="usesPastedCredentials" class="creds">
          <div v-if="storedCredentials" class="creds__current">
            <span class="creds__mark creds__mark--ok">✓</span>
            <div class="creds__info">
              <div class="creds__key mono">{{ credentialSummary }}</div>
              <div class="creds__arn">{{ credentialSavedAt }}</div>
            </div>
            <button type="button" class="btn btn--sm btn--ghost" @click="forgetCredentials">
              Forget
            </button>
          </div>

          <label class="field">
            <span class="field__label">
              {{ storedCredentials ? 'Replace with a new block' : 'Paste the block from the AWS access portal' }}
            </span>
            <textarea
              v-model="credentialText"
              class="textarea creds__box"
              rows="4"
              spellcheck="false"
              autocomplete="off"
              placeholder="export AWS_ACCESS_KEY_ID=&quot;ASIA…&quot;&#10;export AWS_SECRET_ACCESS_KEY=&quot;…&quot;&#10;export AWS_SESSION_TOKEN=&quot;…&quot;"
            ></textarea>
            <span class="field__hint">
              Any of the portal's formats works — bash, PowerShell, cmd, or a credentials-file
              stanza. Saved with this connection and encrypted; re-paste when they expire.
            </span>
          </label>
        </div>

        <div class="row">
          <label v-if="!usesPastedCredentials" class="field" style="flex: 1">
            <span class="field__label">AWS profile</span>
            <input
              v-model="form.ssm!.profile"
              class="input"
              placeholder="(default)"
              spellcheck="false"
            />
          </label>
          <label class="field" style="flex: 1">
            <span class="field__label">Region</span>
            <input
              v-model="form.ssm!.region"
              class="input"
              list="ssm-regions"
              placeholder="(profile default)"
              spellcheck="false"
            />
            <datalist id="ssm-regions">
              <option v-for="region in AWS_REGIONS" :key="region.code" :value="region.code">
                {{ region.label }}
              </option>
            </datalist>
            <span v-if="regionLooksWrong" class="field__hint warn-text">
              That does not look like a region code — expected something like eu-west-2.
            </span>
            <span v-else class="field__hint">Instances are listed one region at a time.</span>
          </label>
          <label class="field" style="flex: 1">
            <span class="field__label">Local port</span>
            <input
              v-model.number="form.ssm!.localPort"
              class="input"
              type="number"
              min="0"
              max="65535"
              placeholder="auto"
            />
            <span class="field__hint">Blank picks a free one.</span>
          </label>
        </div>

        <div class="row">
          <label class="field" style="flex: 2">
            <span class="field__label">Bastion instance ID</span>
            <input
              v-model="form.ssm!.instanceId"
              class="input mono"
              placeholder="i-0123456789abcdef0"
              spellcheck="false"
            />
            <span v-if="ssmError" class="field__hint error-text">{{ ssmError }}</span>
          </label>
          <label class="field" style="flex: 1">
            <span class="field__label">Forward to</span>
            <select v-model="form.ssm!.mode" class="select">
              <option value="remote-host">A remote host</option>
              <option value="instance">The instance itself</option>
            </select>
          </label>
        </div>

        <!-- Pick the bastion from the account rather than remembering its ID -->
        <div class="field instances">
          <span class="field__label">
            Instances{{ instancesRegion ? ` in ${describeRegion(instancesRegion)}` : '' }}
            <span v-if="instancesLoaded" class="instances__count">{{ instances.length }} found</span>
          </span>
          <div class="instances__row">
            <select
              v-model="pickedInstanceId"
              class="select instances__select"
              :disabled="!instances.length"
            >
              <option value="">
                {{ instances.length ? 'Pick the bastion…' : 'Fetch to list the instances here' }}
              </option>
              <option
                v-for="instance in instances"
                :key="instance.instanceId"
                :value="instance.instanceId"
              >
                {{ instanceLabel(instance) }}
              </option>
            </select>
            <button
              type="button"
              class="btn btn--sm instances__fetch"
              :disabled="loadingInstances || Boolean(fetchBlockedReason)"
              :title="fetchBlockedReason"
              @click="loadInstances"
            >
              <span v-if="loadingInstances" class="spinner"></span>
              {{ instancesLoaded ? 'Refresh' : 'Fetch instances' }}
            </button>
          </div>

          <span v-if="instancesError" class="field__hint error-text">{{ instancesError }}</span>
          <span v-else-if="fetchBlockedReason" class="field__hint">
            {{ fetchBlockedReason }} — then fetch the list and pick the bastion by name.
          </span>
          <span v-else-if="instanceIdMissing" class="field__hint warn-text">
            {{ form.ssm!.instanceId }} is not in this region any more — it was probably replaced.
            Pick the current bastion from the list.
          </span>
          <span v-else-if="selectedInstanceWarning" class="field__hint warn-text">
            {{ selectedInstanceWarning }}
          </span>
          <span v-else-if="selectedInstance" class="field__hint">
            Selected {{ instanceLabel(selectedInstance) }}
          </span>
          <span v-else-if="instancesLoaded && !instances.length" class="field__hint">
            Nothing in this region. Check the region and that the credentials belong to the right
            account.
          </span>
          <span v-else class="field__hint">
            Instance IDs change whenever the bastion is redeployed — fetch the list and pick it by
            name instead of remembering the ID.
          </span>
          <span v-if="instancesWarning" class="field__hint warn-text">{{ instancesWarning }}</span>
        </div>

        <p class="hint">{{ ssmHostLabel }}</p>

        <label class="field">
          <span class="field__label">AWS CLI path</span>
          <input
            v-model="form.ssm!.awsCliPath"
            class="input mono"
            placeholder="aws (found on PATH)"
            spellcheck="false"
          />
        </label>

        <div class="preflight">
          <button type="button" class="btn btn--sm" :disabled="checkingSsm" @click="runSsmCheck">
            <span v-if="checkingSsm" class="spinner"></span>
            Check prerequisites
          </button>
          <div v-if="preflight" class="preflight__results">
            <div
              v-for="row in ([
                { key: 'awsCli', label: 'AWS CLI' },
                { key: 'plugin', label: 'Session Manager plugin' },
                { key: 'credentials', label: 'Credentials' }
              ] as { key: 'awsCli' | 'plugin' | 'credentials'; label: string }[])"
              :key="row.key"
              class="preflight__row"
            >
              <span
                class="preflight__mark"
                :class="preflight[row.key].ok ? 'preflight__mark--ok' : 'preflight__mark--bad'"
              >
                {{ preflight[row.key].ok ? '✓' : '✕' }}
              </span>
              <span class="preflight__label">{{ row.label }}</span>
              <span class="preflight__detail truncate">
                {{ preflight[row.key].detail ?? preflight[row.key].error }}
              </span>
            </div>
          </div>
        </div>
      </fieldset>

      <!-- SSH -->
      <fieldset v-else-if="tunnelKind === 'ssh'" class="form__group">
        <p class="hint">
          The Server and Port on the General tab are resolved <em>from the SSH server</em>, so use
          the address the bastion can reach.
        </p>

        <div class="row">
          <label class="field" style="flex: 3">
            <span class="field__label">SSH host</span>
            <input v-model="form.ssh!.host" class="input" placeholder="bastion.example.com" />
          </label>
          <label class="field" style="flex: 1">
            <span class="field__label">SSH port</span>
            <input v-model.number="form.ssh!.port" class="input" type="number" min="1" max="65535" />
          </label>
        </div>

        <div class="row">
          <label class="field" style="flex: 1">
            <span class="field__label">SSH user</span>
            <input v-model="form.ssh!.username" class="input" autocomplete="off" />
          </label>
          <label class="field" style="flex: 1">
            <span class="field__label">Authenticate with</span>
            <select v-model="form.ssh!.authMode" class="select">
              <option value="password">Password</option>
              <option value="privateKey">Private key</option>
              <option value="agent">SSH agent</option>
            </select>
          </label>
        </div>

        <label v-if="usesSshPassword" class="field">
          <span class="field__label">SSH password</span>
          <input
            v-model="form.ssh!.password"
            class="input"
            type="password"
            autocomplete="new-password"
            :placeholder="sshPasswordPlaceholder"
            @input="sshPasswordTouched = true"
          />
        </label>

        <template v-if="usesSshKey">
          <label class="field">
            <span class="field__label">Private key file</span>
            <div class="row">
              <input v-model="form.ssh!.privateKeyPath" class="input" placeholder="~/.ssh/id_ed25519" />
              <button type="button" class="btn" @click="browseForKey">Browse…</button>
            </div>
          </label>
          <label class="field">
            <span class="field__label">Key passphrase</span>
            <input
              v-model="form.ssh!.passphrase"
              class="input"
              type="password"
              autocomplete="new-password"
              :placeholder="sshPassphrasePlaceholder"
              @input="sshPassphraseTouched = true"
            />
          </label>
        </template>

        <p v-if="form.ssh!.authMode === 'agent'" class="hint">
          Uses <code>SSH_AUTH_SOCK</code>, or Pageant on Windows.
        </p>

        <label class="field" style="max-width: 220px">
          <span class="field__label">Keepalive (ms)</span>
          <input
            v-model.number="form.ssh!.keepaliveIntervalMs"
            class="input"
            type="number"
            min="0"
            step="1000"
          />
        </label>
      </fieldset>

      <p v-else class="hint">
        The connection goes straight to the server on the General tab.
      </p>
    </section>

    <!-- Advanced ------------------------------------------------------- -->
    <section v-show="section === 'advanced'" class="form__section">
      <div class="row">
        <label class="checkbox">
          <input v-model="form.options!.encrypt" type="checkbox" />
          <span>Encrypt connection (TLS)</span>
        </label>
        <label class="checkbox">
          <input v-model="form.options!.trustServerCertificate" type="checkbox" />
          <span>Trust server certificate</span>
        </label>
      </div>

      <div class="row">
        <label class="field" style="flex: 1">
          <span class="field__label">Named instance</span>
          <input v-model="form.options!.instanceName" class="input" placeholder="SQLEXPRESS" />
          <span class="field__hint">Resolved over UDP 1434; not available through a tunnel.</span>
        </label>
        <label class="field" style="flex: 1">
          <span class="field__label">Application name</span>
          <input v-model="form.options!.applicationName" class="input" />
        </label>
      </div>

      <div class="row">
        <label class="field" style="flex: 1">
          <span class="field__label">Connect timeout (ms)</span>
          <input v-model.number="form.options!.connectTimeoutMs" class="input" type="number" min="1000" step="1000" />
        </label>
        <label class="field" style="flex: 1">
          <span class="field__label">Request timeout (ms)</span>
          <input v-model.number="form.options!.requestTimeoutMs" class="input" type="number" min="0" step="1000" />
        </label>
      </div>

      <div class="row">
        <label class="field" style="flex: 1">
          <span class="field__label">Pool min</span>
          <input v-model.number="form.options!.poolMin" class="input" type="number" min="0" max="50" />
        </label>
        <label class="field" style="flex: 1">
          <span class="field__label">Pool max</span>
          <input v-model.number="form.options!.poolMax" class="input" type="number" min="1" max="100" />
        </label>
      </div>

      <label class="checkbox">
        <input v-model="form.options!.readOnlyIntent" type="checkbox" />
        <span>Read-only intent (route to a readable secondary)</span>
      </label>
    </section>

    <footer class="form__foot">
      <button type="button" class="btn btn--muted" :disabled="busy" @click="emit('test', payload())">
        <span v-if="busy" class="spinner"></span>
        Test connection
      </button>
      <div style="flex: 1"></div>
      <button type="button" class="btn btn--muted" @click="emit('cancel')">Cancel</button>
      <button type="submit" class="btn btn--primary" :disabled="!canSubmit">Save</button>
    </footer>
  </form>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
/* Full-bleed micro-caps tabs, matching the results and sidebar panels. */
.form__tabs {
  display: flex;
  align-items: stretch;
  height: var(--h-tabstrip);
  border-bottom: var(--rule) solid var(--border-strong);
  background: var(--bg-app);
  flex: 0 0 auto;
}
.form__tab {
  position: relative;
  padding: 0 18px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.form__tab + .form__tab {
  border-left: 1px solid var(--border-subtle);
}
.form__tab:hover {
  color: var(--text-primary);
}
.form__tab--active {
  background: var(--bg-surface);
  color: var(--text-primary);
  box-shadow: inset 0 -2px 0 var(--accent);
}
.form__dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: 8px;
  background: var(--accent);
}
.form__seg-opt {
  height: 32px;
  padding: 0 16px;
  font-size: 13px;
}
.form__section {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 20px;
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.form__group {
  display: flex;
  flex-direction: column;
  gap: 18px;
  margin: 0;
  padding: 0;
  border: none;
}
.form__group:disabled {
  opacity: 0.45;
}
.form__foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 20px;
  border-top: var(--rule) solid var(--border-strong);
  background: var(--bg-app);
  flex: 0 0 auto;
}
.form__foot .btn {
  height: var(--h-control-lg);
}
.row {
  display: flex;
  gap: 16px;
  align-items: flex-end;
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.55;
}
.hint code {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
}

/* --- credentials and instances: ruled boxes on the input ground ----------- */
.creds {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--border-strong);
  background: var(--bg-app);
}
.creds__current {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--border-strong);
  background: var(--bg-input);
}
.creds__mark {
  font-weight: 700;
}
.creds__mark--ok {
  color: var(--success);
}
.creds__mark--bad {
  color: var(--danger);
}
.creds__info {
  flex: 1;
  min-width: 0;
}
.creds__key {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-secondary);
}
.creds__arn {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 2px;
}
.creds__box {
  font-size: 11px;
  line-height: 1.5;
}
.creds__actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.instances {
  padding: 12px;
  border: 1px solid var(--border-strong);
  background: var(--bg-app);
}
.instances__row {
  display: flex;
  gap: 10px;
  align-items: center;
}
.instances__select {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 12px;
}
.instances__fetch {
  flex: 0 0 auto;
  white-space: nowrap;
}
.instances__count {
  margin-left: 8px;
  color: var(--text-dim);
  font-weight: 400;
  letter-spacing: 0;
}
.warn-text {
  color: var(--warning);
}

.preflight {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}
.preflight__results {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  background: var(--bg-input);
}
.preflight__row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 11px;
  line-height: 1.8;
  min-width: 0;
}
.preflight__mark {
  flex: 0 0 auto;
  font-weight: 700;
}
.preflight__mark--ok {
  color: var(--success);
}
.preflight__mark--bad {
  color: var(--danger);
}
.preflight__label {
  flex: 0 0 150px;
  color: var(--text-secondary);
}
.preflight__detail {
  flex: 1;
  min-width: 0;
  color: var(--text-dim);
  font-family: var(--font-mono);
}

/* Square swatches — nothing in this system is round. */
.swatches {
  display: flex;
  gap: 6px;
  height: var(--h-field);
  align-items: center;
}
.swatch {
  width: 22px;
  height: 22px;
  border: 2px solid transparent;
  border-radius: 0;
  cursor: pointer;
  padding: 0;
}
.swatch--none {
  background: var(--bg-input);
  border-color: var(--border-strong);
}
.swatch--active {
  outline: 2px solid var(--text-primary);
  outline-offset: 1px;
}
</style>
