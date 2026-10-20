<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  ConnectionConfig,
  DEFAULT_SQLSERVER_OPTIONS,
  DEFAULT_SSH_CONFIG,
  DEFAULT_SSM_CONFIG,
  SavedConnection,
  type SsmTarget
} from '@shared/types'
import type { SsmInstance, SsmPreflight } from '@shared/ipc'
import { ACCENT_SWATCHES } from '@shared/accent'
import { parseAwsCredentials } from '@shared/aws/credentials'
import { isLoopbackHost } from '@shared/hosts'
import type { TablePlusImport } from '@shared/tableplus'
import { AWS_REGIONS, describeRegion, isRegionLike } from '@shared/aws/regions'
import { api } from '../lib/api'
import { useReadOnlyStore } from '../stores/readOnly'
import AppIcon from './AppIcon.vue'
import AwsCredentialsBox from './AwsCredentialsBox.vue'
import TablePlusPanel from './TablePlusPanel.vue'

const props = defineProps<{
  connection: SavedConnection | null
  busy?: boolean
  /** Open with the name selected — what a fresh copy needs changed first. */
  selectName?: boolean
  /** Groups already in use, offered beside the field that makes new ones. */
  groups?: string[]
  /** Open a new connection with the TablePlus steps showing rather than folded. */
  tablePlusOpen?: boolean
  /** Names already saved, so a paste from TablePlus can say when it repeats one. */
  savedNames?: string[]
}>()
const emit = defineEmits<{
  (event: 'save', value: Partial<ConnectionConfig> & { name: string }): void
  /** Save these edits as a second connection, leaving this one as it was. */
  (event: 'duplicate', value: Partial<ConnectionConfig> & { name: string }): void
  (event: 'test', value: Partial<ConnectionConfig>): void
  (event: 'cancel'): void
}>()

type Section = 'general' | 'tunnel' | 'advanced'
const section = ref<Section>('general')

const nameInput = ref<HTMLInputElement | null>(null)

onMounted(() => {
  if (!props.selectName) return
  nameInput.value?.focus()
  // Selected rather than just focused: "Prod (copy)" is a starting point to
  // type over, not something to edit a word at a time.
  nameInput.value?.select()
})

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

function blank(): Partial<ConnectionConfig> & { name: string } {
  return {
    name: '',
    group: '',
    color: '',
    host: 'localhost',
    port: 1433,
    database: '',
    authType: 'sql',
    username: '',
    password: '',
    domain: '',
    savePassword: true,
    readOnly: false,
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
/** The last paste from TablePlus, for what the form still has to ask about. */
const fromTablePlus = ref<TablePlusImport | null>(null)

/** Everything back to a blank new connection. */
function resetForm(): void {
  Object.assign(form, blank())
  // `blank()` has no id to assign over the old one. A form that was editing a
  // saved connection and is reused for a new one — File → New Connection or
  // Import from TablePlus over the open dialog — would otherwise save over it.
  delete form.id
  credentialText.value = ''
  clearedCredentials.value = false
  resetInstances()
  passwordTouched.value = false
  sshPasswordTouched.value = false
  sshPassphraseTouched.value = false
  fromTablePlus.value = null
}

watch(
  () => props.connection,
  (connection) => {
    resetForm()
    if (!connection) return

    Object.assign(form, {
      id: connection.id,
      name: connection.name,
      group: connection.group ?? '',
      color: connection.color ?? '',
      host: connection.host,
      port: connection.port,
      database: connection.database ?? '',
      authType: connection.authType,
      username: connection.username ?? '',
      password: '',
      domain: connection.domain ?? '',
      savePassword: connection.savePassword,
      readOnly: connection.readOnly === true,
      options: { ...DEFAULT_SQLSERVER_OPTIONS, ...connection.options },
      ssh: { ...DEFAULT_SSH_CONFIG, ...connection.ssh, password: '', passphrase: '' },
      ssm: { ...DEFAULT_SSM_CONFIG, ...connection.ssm }
    })
  },
  { immediate: true }
)

const readOnlyPrompt = useReadOnlyStore()

/**
 * Unticking read-only on a connection saved that way asks first, the same
 * question every read-only toggle asks; ticking it, or unticking a box ticked
 * in this sitting, just happens.
 */
async function onReadOnlyChange(event: Event): Promise<void> {
  const box = event.target as HTMLInputElement
  if (box.checked || !props.connection?.readOnly) {
    form.readOnly = box.checked
    return
  }
  box.checked = true
  if (await readOnlyPrompt.confirmWritable(props.connection)) form.readOnly = false
}

/**
 * A connection pasted from TablePlus replaces the whole form, the way a pasted
 * AWS block replaces its box: two connections half-mixed is worse than either.
 * A secret counts as typed only when the URL carried one, so a URL with no
 * password stores none and the connect asks for it.
 */
function applyTablePlus(result: TablePlusImport): void {
  resetForm()
  Object.assign(form, { ...result.connection, ssh: { ...result.connection.ssh } })
  passwordTouched.value = result.connection.password !== ''
  sshPasswordTouched.value = Boolean(result.connection.ssh.password)
  sshPassphraseTouched.value = Boolean(result.connection.ssh.passphrase)
  fromTablePlus.value = result
}

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

/** The same description, minus a name the sentence around it already gave. */
function instanceDetail(instance: SsmInstance): string {
  const prefix = instance.name ? `${instance.name} — ` : ''
  const label = instanceLabel(instance)
  return prefix && label.startsWith(prefix) ? label.slice(prefix.length) : label
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

/**
 * How the bastion is found.
 *
 * Absent means by ID, which is what every connection saved before naming
 * existed meant. Written back explicitly so the choice is stored once made.
 */
const ssmTarget = computed<SsmTarget>({
  get: () => form.ssm!.target ?? 'instance-id',
  set: (value) => {
    form.ssm!.target = value
  }
})
const findsByName = computed(() => ssmTarget.value === 'name')

/** AWS matches its own wildcards; anything holding one is left to it. */
const nameLooksLikeAPattern = computed(() => {
  const name = form.ssm!.instanceName?.trim() ?? ''
  return name.includes('*') || name.includes('?')
})

const selectedInstance = computed(
  () =>
    instances.value.find((instance) => instance.instanceId === form.ssm!.instanceId?.trim()) ??
    null
)

/**
 * What the name in the field matches in the list that was fetched.
 *
 * The same answer the connection will get when it opens, so it is matched the
 * way EC2 matches it: exactly, case and all. A pattern is left to AWS rather
 * than half-reproduced here — better to say nothing than something the lookup
 * will not agree with.
 */
const nameMatches = computed<SsmInstance[]>(() => {
  const name = form.ssm!.instanceName?.trim()
  if (!name || nameLooksLikeAPattern.value) return []
  return instances.value.filter((instance) => instance.name?.trim() === name)
})

/**
 * A name that is right but for its case, which EC2 will not match.
 *
 * Worth calling out by itself: it is the one wrong name that looks right, and
 * the connection fails at the moment it is opened rather than here.
 */
const nameCaseMismatch = computed(() => {
  const name = form.ssm!.instanceName?.trim().toLowerCase()
  if (!name || nameLooksLikeAPattern.value || nameMatches.value.length > 0) return null
  return (
    instances.value.find((instance) => instance.name?.trim().toLowerCase() === name)?.name ?? null
  )
})

/** The one a session would start on: reachable first, then running. */
const nameMatch = computed(() => nameMatches.value[0] ?? null)

/** The redeploy case: a saved ID that the region no longer knows about. */
const instanceIdMissing = computed(
  () =>
    !findsByName.value &&
    instancesLoaded.value &&
    instances.value.length > 0 &&
    Boolean(form.ssm!.instanceId?.trim()) &&
    !selectedInstance.value
)

/** Its twin for a named bastion: a name nothing in the region answers to. */
const instanceNameMissing = computed(
  () =>
    findsByName.value &&
    instancesLoaded.value &&
    instances.value.length > 0 &&
    Boolean(form.ssm!.instanceName?.trim()) &&
    !nameLooksLikeAPattern.value &&
    !nameMatch.value
)

/**
 * What the picker shows.
 *
 * Reads back as unset whenever the ID in the field is not one of the fetched
 * instances — the redeployed case — so the select prompts instead of sitting
 * blank, and choosing the prompt does not wipe an ID typed by hand.
 */
const pickedInstanceId = computed({
  get: () => {
    if (findsByName.value) return nameMatch.value?.instanceId ?? ''
    return selectedInstance.value ? selectedInstance.value.instanceId : ''
  },
  set: (value: string) => {
    const instance = instances.value.find((entry) => entry.instanceId === value)
    if (!instance) return
    // Picking from the list sets whichever of the two the connection is going
    // to be saved with — a name the bastion will still answer to after it is
    // replaced, or the ID of the instance that is there now.
    if (!findsByName.value) {
      form.ssm!.instanceId = instance.instanceId
      return
    }
    // An instance with no Name tag cannot be named; its option is disabled.
    if (instance.name?.trim()) form.ssm!.instanceName = instance.name.trim()
  }
})

/** The instance this connection would actually start a session on. */
const targetInstance = computed(() =>
  findsByName.value ? nameMatch.value : selectedInstance.value
)

const selectedInstanceWarning = computed(() => {
  const instance = targetInstance.value
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
    : 'Forwards to the port above on the bastion itself — only right when SQL Server runs on that instance. For a database elsewhere (an RDS endpoint, say) pick "A remote host", or the session opens and then drops every connection.'
)
const usesSshPassword = computed(() => form.ssh!.enabled && form.ssh!.authMode === 'password')
const usesSshKey = computed(() => form.ssh!.enabled && form.ssh!.authMode === 'privateKey')
/** TablePlus wanted a key file, which never travels in its URL, and none is chosen yet. */
const keyFileMissing = computed(
  () =>
    Boolean(fromTablePlus.value?.keyFileNeeded) &&
    usesSshKey.value &&
    !form.ssh!.privateKeyPath?.trim()
)

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

/**
 * A relayed Server address is resolved by the far end, so a loopback one names
 * the bastion rather than this machine — a setting that reads as correct and
 * then forwards to a port nothing is listening on.
 */
const hostWarning = computed(() => {
  const relayed =
    (form.ssm!.enabled && form.ssm!.mode === 'remote-host') || form.ssh!.enabled
  if (!relayed || !isLoopbackHost(form.host)) return ''
  const relay = form.ssm!.enabled ? 'the bastion' : 'the SSH host'
  return `"${form.host}" is resolved from ${relay}, so this forwards to ${relay} itself. Use the database's own address if it runs elsewhere.`
})
const ssmError = computed(() => {
  if (!form.ssm!.enabled) return ''
  if (usesPastedCredentials.value && !hasCredentials.value) {
    return 'Paste your AWS credentials below, or switch to letting the AWS CLI resolve them'
  }
  if (findsByName.value) {
    return form.ssm!.instanceName?.trim() ? '' : 'A bastion name is required'
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
    // Always a string, so emptying the field takes a connection out of its
    // group rather than reading as "leave it where it was".
    group: form.group?.trim() ?? '',
    host: form.host?.trim(),
    port: Number(form.port) || 1433,
    database: form.database?.trim() || undefined,
    // Always a string, so picking the default swatch clears a stored colour
    // rather than reading as "leave it alone".
    color: form.color ?? '',
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
      <TablePlusPanel
        v-if="!connection"
        :open="tablePlusOpen ?? false"
        :name="form.name"
        :saved-names="savedNames ?? []"
        :key-file-chosen="Boolean(form.ssh?.privateKeyPath?.trim())"
        @fill="applyTablePlus"
      />

      <div class="row">
        <label class="field" style="flex: 2">
          <span class="field__label">Connection name</span>
          <input
            ref="nameInput"
            v-model="form.name"
            class="input"
            placeholder="Production reporting"
          />
          <span v-if="nameError" class="field__hint error-text">{{ nameError }}</span>
        </label>
        <div class="field" style="flex: 0 0 auto">
          <!-- Not decoration: this is the accent the whole window takes while
               the connection is open, so production never looks like staging. -->
          <span class="field__label">Colour</span>
          <div class="swatches">
            <button
              v-for="swatch in ACCENT_SWATCHES"
              :key="swatch.hex || 'none'"
              type="button"
              class="swatch"
              :class="{
                'swatch--active': (form.color ?? '') === swatch.hex,
                'swatch--none': !swatch.hex
              }"
              :style="swatch.hex ? { background: swatch.hex } : {}"
              :title="swatch.label"
              :aria-label="swatch.label"
              :aria-pressed="(form.color ?? '') === swatch.hex"
              @click="form.color = swatch.hex"
            ></button>
          </div>
          <span class="field__hint">Accents the window this connection opens in.</span>
        </div>
      </div>

      <div class="row">
        <label class="field" style="flex: 2">
          <span class="field__label">Group</span>
          <!-- A list of what exists, not a list of what is allowed: typing a
               name no connection carries yet is how a group gets made. -->
          <input
            v-model="form.group"
            class="input"
            list="connection-groups"
            placeholder="(none)"
            autocomplete="off"
          />
          <datalist id="connection-groups">
            <option v-for="name in groups ?? []" :key="name" :value="name"></option>
          </datalist>
          <span class="field__hint">Files this connection under a heading in the list.</span>
        </label>
      </div>

      <div class="row">
        <label class="field" style="flex: 3">
          <span class="field__label">Server</span>
          <input v-model="form.host" class="input" placeholder="localhost" />
          <span v-if="hostError" class="field__hint error-text">{{ hostError }}</span>
          <span v-else-if="hostWarning" class="field__hint warn-text">{{ hostWarning }}</span>
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

      <div class="form__toggle">
        <label class="checkbox">
          <input :checked="form.readOnly" type="checkbox" @change="onReadOnlyChange" />
          <span>Read-only</span>
        </label>
        <span class="field__hint form__toggle-hint">
          Table edits, truncate and drop are switched off, and a statement that would change
          anything is stopped before it is sent. A safety net for the window you took for
          staging — the login itself can still write.
        </span>
      </div>
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
            <AppIcon class="creds__mark creds__mark--ok" name="circle-check" :size="16" />
            <div class="creds__info">
              <div class="creds__key mono">{{ credentialSummary }}</div>
              <div class="creds__arn">{{ credentialSavedAt }}</div>
            </div>
            <button type="button" class="btn btn--sm btn--ghost" @click="forgetCredentials">
              Forget
            </button>
          </div>

          <AwsCredentialsBox
            v-model="credentialText"
            :label="
              storedCredentials
                ? 'Replace with a new block'
                : 'Paste the block from the AWS access portal'
            "
            hint="Any of the portal's formats works — bash, PowerShell, cmd, or a credentials-file stanza. Saved with this connection and encrypted; re-paste when they expire."
          />
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
          <label class="field" style="flex: 0 0 auto">
            <span class="field__label">Find the bastion by</span>
            <select v-model="ssmTarget" class="select">
              <option value="instance-id">Instance ID</option>
              <option value="name">Name tag</option>
            </select>
          </label>
          <label v-if="findsByName" class="field" style="flex: 2">
            <span class="field__label">Bastion name</span>
            <input
              v-model="form.ssm!.instanceName"
              class="input"
              placeholder="prod-bastion"
              spellcheck="false"
            />
            <span v-if="ssmError" class="field__hint error-text">{{ ssmError }}</span>
            <span v-else class="field__hint">
              The instance's Name tag, looked up each time this connection opens — so a
              redeployed bastion needs no edit here.
            </span>
          </label>
          <label v-else class="field" style="flex: 2">
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
                :disabled="findsByName && !instance.name"
              >
                {{ instanceLabel(instance) }}
                <template v-if="findsByName && !instance.name"> — no Name tag</template>
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
            Pick the current bastion from the list, or find it by its Name tag instead.
          </span>
          <span v-else-if="nameCaseMismatch" class="field__hint warn-text">
            Name tags match exactly — this region has “{{ nameCaseMismatch }}”, not
            “{{ form.ssm!.instanceName }}”.
          </span>
          <span v-else-if="instanceNameMissing" class="field__hint warn-text">
            Nothing here is named “{{ form.ssm!.instanceName }}”. Pick the bastion from the list to
            fill the name in, or check the region.
          </span>
          <span v-else-if="selectedInstanceWarning" class="field__hint warn-text">
            {{ selectedInstanceWarning }}
          </span>
          <!-- In name mode the list is what the name resolves to today, which is
               the same answer the connection will get when it opens. -->
          <span v-else-if="findsByName && nameMatch" class="field__hint">
            “{{ form.ssm!.instanceName }}” is {{ instanceDetail(nameMatch) }}
            <template v-if="nameMatches.length > 1">
              — and {{ nameMatches.length - 1 }} other{{ nameMatches.length > 2 ? 's' : '' }}
              answer to it; the one a session can reach is used.
            </template>
          </span>
          <span v-else-if="findsByName && nameLooksLikeAPattern" class="field__hint">
            AWS matches the pattern when the connection opens, so this cannot be shown here.
          </span>
          <span v-else-if="selectedInstance" class="field__hint">
            Selected {{ instanceLabel(selectedInstance) }}
          </span>
          <span v-else-if="instancesLoaded && !instances.length" class="field__hint">
            Nothing in this region. Check the region and that the credentials belong to the right
            account.
          </span>
          <span v-else-if="findsByName" class="field__hint">
            Fetch the list and pick the bastion to fill its name in.
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
              <AppIcon
                class="preflight__mark"
                :class="preflight[row.key].ok ? 'preflight__mark--ok' : 'preflight__mark--bad'"
                :name="preflight[row.key].ok ? 'circle-check' : 'circle-x'"
                :size="14"
              />
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
            <span v-if="keyFileMissing" class="field__hint warn-text">
              TablePlus does not put the key file in the URL. Choose it here.
            </span>
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

      <div class="row">
        <label class="field" style="flex: 1">
          <span class="field__label">Keepalive (ms)</span>
          <input
            v-model.number="form.options!.keepAliveIntervalMs"
            class="input"
            type="number"
            min="0"
            step="5000"
          />
          <span class="field__hint">
            Sends one row down an idle connection this often, so a tunnel or a
            firewall does not drop it for want of traffic. 0 turns it off.
          </span>
        </label>
        <div class="field" style="flex: 1"></div>
      </div>

      <div class="form__toggle">
        <label class="checkbox">
          <input v-model="form.options!.readOnlyIntent" type="checkbox" />
          <span>Read-only intent (route to a readable secondary)</span>
        </label>
        <span class="field__hint form__toggle-hint">
          Where to connect, not what to allow: on its own it stops nothing. Read-only on the
          General tab is what refuses writes.
        </span>
      </div>
    </section>

    <footer class="form__foot">
      <button type="button" class="btn btn--muted" :disabled="busy" @click="emit('test', payload())">
        <span v-if="busy" class="spinner"></span>
        Test connection
      </button>
      <div style="flex: 1"></div>
      <button
        v-if="connection"
        type="button"
        class="btn btn--muted"
        :disabled="!canSubmit"
        title="Keep this connection as it is and save these settings as a second one"
        @click="emit('duplicate', payload())"
      >
        Save as copy
      </button>
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
/* Underlined tabs, set in from the dialog's edge like its title. */
.form__tabs {
  display: flex;
  align-items: stretch;
  gap: 4px;
  height: 42px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border-subtle);
  flex: 0 0 auto;
}
.form__tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: color var(--transition);
}
.form__tab::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: transparent;
  transition: background-color var(--transition);
}
.form__tab:hover {
  color: var(--text-primary);
}
.form__tab--active {
  color: var(--text-primary);
}
.form__tab--active::after {
  background: var(--accent);
}
.form__dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
.form__seg-opt {
  height: 28px;
  padding: 0 14px;
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
  /* A fieldset defaults to min-width: min-content and will not shrink past it,
     so one long unbreakable value — an SSO role ARN, say — widens the dialog
     and puts a scrollbar under it instead of being truncated. */
  min-width: 0;
}
.form__group:disabled {
  opacity: 0.45;
}
.form__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px 12px 20px;
  border-top: 1px solid var(--border-subtle);
  background: color-mix(in srgb, var(--bg-app) 55%, var(--bg-overlay));
  flex: 0 0 auto;
}
.form__foot .btn {
  height: var(--h-control-lg);
}
/* A checkbox with a sentence under it, lined up with the checkbox's label. */
.form__toggle {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.form__toggle-hint {
  padding-left: 26px;
}
.row {
  display: flex;
  gap: 14px;
  /* Top-aligned, so a hint or an error under one field extends downwards
     instead of pushing its neighbour's control out of line. */
  align-items: flex-start;
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.55;
}
.hint code {
  padding: 1px 4px;
  border-radius: var(--radius-xs);
  background: color-mix(in srgb, var(--text-primary) 8%, transparent);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
}

/* --- credentials and instances: soft panels inside the form --------------- */
.creds {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--bg-app) 60%, var(--bg-overlay));
}
.creds__current {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px 9px 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
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
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
}
.creds__actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.instances {
  padding: 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--bg-app) 60%, var(--bg-overlay));
}
.instances__row {
  display: flex;
  gap: 8px;
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
  height: var(--h-field);
  white-space: nowrap;
}
.instances__count {
  margin-left: 8px;
  color: var(--text-muted);
  font-weight: 400;
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
  padding: 8px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
}
.preflight__row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 26px;
  font-size: 12px;
  min-width: 0;
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
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
}

/* Round swatches with a ring around the chosen one. */
.swatches {
  display: flex;
  gap: 8px;
  height: var(--h-field);
  align-items: center;
}
.swatch {
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.18);
  cursor: pointer;
  transition: box-shadow var(--transition), transform var(--transition);
}
.swatch:hover {
  transform: scale(1.12);
}
/* No colour of its own: the window keeps the app's accent, so that is what it shows. */
.swatch--none {
  background: var(--accent-default);
}
.swatch--active {
  box-shadow:
    0 0 0 2px var(--bg-overlay),
    0 0 0 4px var(--text-primary);
}
.swatch:focus-visible {
  outline-offset: 4px;
}
</style>
