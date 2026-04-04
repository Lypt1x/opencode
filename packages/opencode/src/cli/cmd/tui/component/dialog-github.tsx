import { createMemo, createSignal, onMount } from "solid-js"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "../context/sdk"
import { useSync } from "@tui/context/sync"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { Clipboard } from "@tui/util/clipboard"
import { useToast } from "../ui/toast"
import type { ProviderAuthAuthorization } from "@opencode-ai/sdk/v2"
import { DialogModel } from "./dialog-model"
import { fetchAllQuotas, type QuotaInfo } from "@tui/util/quota"

const PROVIDER_ID = "github-copilot"

async function fetchAccounts(sdk: ReturnType<typeof useSDK>) {
  const res = await sdk.fetch(`${sdk.url}/auth/${PROVIDER_ID}/accounts`)
  if (!res.ok) return {} as Record<string, unknown>
  return (await res.json()) as Record<string, unknown>
}

async function fetchActive(sdk: ReturnType<typeof useSDK>) {
  const res = await sdk.fetch(`${sdk.url}/auth`)
  if (!res.ok) return undefined
  const all = (await res.json()) as Record<string, unknown>
  return all[PROVIDER_ID] as Record<string, unknown> | undefined
}

function labelFromKey(key: string) {
  return key.slice(PROVIDER_ID.length + 1)
}

function formatQuota(q: QuotaInfo | undefined) {
  if (!q) return undefined
  const parts: string[] = []
  if (q.name) parts.push(q.name)
  if (q.username) parts.push(`(@${q.username})`)
  if (q.unlimited) parts.push("· unlimited")
  else if (q.percent >= 0) parts.push(`· ${Math.round(q.percent)}% left`)
  return parts.join(" ") || undefined
}

export function DialogGitHub() {
  const dialog = useDialog()
  const sdk = useSDK()
  const [accounts, setAccounts] = createSignal<Record<string, unknown>>({})
  const [active, setActive] = createSignal<Record<string, unknown> | undefined>()

  onMount(async () => {
    const [accts, act] = await Promise.all([fetchAccounts(sdk), fetchActive(sdk)])
    setAccounts(accts)
    setActive(act)
  })

  const options = createMemo(() => {
    const base = [
      {
        title: "Add account",
        value: "add",
        description: "Login with a new GitHub Copilot account",
        category: "Actions",
        onSelect: () => dialog.replace(() => <AddAccount />),
      },
    ]

    const accts = accounts()
    const labels = Object.keys(accts).map(labelFromKey)

    if (labels.length > 0 || active()) {
      base.push({
        title: "Switch account",
        value: "switch",
        description: "Switch to a different account",
        category: "Actions",
        onSelect: () => dialog.replace(() => <SwitchAccount />),
      })
      base.push({
        title: "Remove account",
        value: "remove",
        description: "Remove a saved account",
        category: "Actions",
        onSelect: () => dialog.replace(() => <RemoveAccount />),
      })
    }

    return base
  })

  return <DialogSelect title="GitHub Copilot accounts" options={options()} />
}

function AddAccount() {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()

  const methods = createMemo(() => sync.data.provider_auth[PROVIDER_ID] ?? [])

  onMount(async () => {
    const ms = methods()
    if (ms.length === 0) {
      toast.show({ variant: "error", message: "No auth methods available for GitHub Copilot" })
      dialog.clear()
      return
    }

    let index = 0
    if (ms.length > 1) {
      const picked = await new Promise<number | null>((resolve) => {
        dialog.replace(
          () => (
            <DialogSelect
              title="Select auth method"
              options={ms.map((x, i) => ({
                title: x.label,
                value: i,
              }))}
              onSelect={(option) => resolve(option.value)}
            />
          ),
          () => resolve(null),
        )
      })
      if (picked == null) return
      index = picked
    }

    const method = ms[index]
    if (method.type === "oauth") {
      let inputs: Record<string, string> | undefined
      if (method.prompts?.length) {
        inputs = (await promptInputs(dialog, method.prompts)) ?? undefined
        if (!inputs) return
      }

      const result = await sdk.client.provider.oauth.authorize({
        providerID: PROVIDER_ID,
        method: index,
        inputs,
      })
      if (result.error) {
        toast.show({ variant: "error", message: JSON.stringify(result.error) })
        dialog.clear()
        return
      }
      if (result.data?.method === "auto") {
        dialog.replace(() => (
          <OAuthAutoWait providerID={PROVIDER_ID} title={method.label} index={index} authorization={result.data!} />
        ))
      }
      if (result.data?.method === "code") {
        dialog.replace(() => (
          <OAuthCodeEntry providerID={PROVIDER_ID} title={method.label} index={index} authorization={result.data!} />
        ))
      }
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text>Loading auth methods...</text>
    </box>
  )
}

async function promptInputs(
  dialog: ReturnType<typeof useDialog>,
  prompts: {
    type: string
    key: string
    message: string
    placeholder?: string
    options?: { label: string; value: string; hint?: string }[]
    when?: { key: string; op: string; value: string }
  }[],
) {
  const inputs: Record<string, string> = {}
  for (const prompt of prompts) {
    if (prompt.when) {
      const val = inputs[prompt.when.key]
      if (val === undefined) continue
      const match = prompt.when.op === "eq" ? val === prompt.when.value : val !== prompt.when.value
      if (!match) continue
    }

    if (prompt.type === "select" && prompt.options) {
      const value = await new Promise<string | null>((resolve) => {
        dialog.replace(
          () => (
            <DialogSelect
              title={prompt.message}
              options={prompt.options!.map((x) => ({
                title: x.label,
                value: x.value,
                description: x.hint,
              }))}
              onSelect={(option) => resolve(option.value)}
            />
          ),
          () => resolve(null),
        )
      })
      if (value === null) return null
      inputs[prompt.key] = value
      continue
    }

    const value = await new Promise<string | null>((resolve) => {
      dialog.replace(
        () => <DialogPrompt title={prompt.message} placeholder={prompt.placeholder} onConfirm={(v) => resolve(v)} />,
        () => resolve(null),
      )
    })
    if (value === null) return null
    inputs[prompt.key] = value
  }
  return inputs
}

function OAuthAutoWait(props: {
  providerID: string
  title: string
  index: number
  authorization: ProviderAuthAuthorization
}) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()

  useKeyboard((evt) => {
    if (evt.name === "c" && !evt.ctrl && !evt.meta) {
      const code = props.authorization.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0] ?? props.authorization.url
      Clipboard.copy(code)
        .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
        .catch(toast.error)
    }
  })

  onMount(async () => {
    const result = await sdk.client.provider.oauth.callback({
      providerID: props.providerID,
      method: props.index,
    })
    if (result.error) {
      dialog.clear()
      return
    }
    dialog.replace(() => <LabelAccount providerID={props.providerID} />)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        <text fg={theme.primary}>{props.authorization.url}</text>
        <text fg={theme.textMuted}>{props.authorization.instructions}</text>
      </box>
      <text fg={theme.textMuted}>Waiting for authorization...</text>
      <text fg={theme.text}>
        c <span style={{ fg: theme.textMuted }}>copy</span>
      </text>
    </box>
  )
}

function OAuthCodeEntry(props: {
  providerID: string
  title: string
  index: number
  authorization: ProviderAuthAuthorization
}) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const [error, setError] = createSignal(false)

  return (
    <DialogPrompt
      title={props.title}
      placeholder="Authorization code"
      onConfirm={async (value) => {
        const { error } = await sdk.client.provider.oauth.callback({
          providerID: props.providerID,
          method: props.index,
          code: value,
        })
        if (!error) {
          dialog.replace(() => <LabelAccount providerID={props.providerID} />)
          return
        }
        setError(true)
      }}
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>{props.authorization.instructions}</text>
          <text fg={theme.primary}>{props.authorization.url}</text>
          {error() && <text fg={theme.error}>Invalid code</text>}
        </box>
      )}
    />
  )
}

function LabelAccount(props: { providerID: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()

  return (
    <DialogPrompt
      title="Name this account"
      placeholder="e.g. work, personal"
      onConfirm={async (label) => {
        if (!label.trim()) {
          toast.show({ variant: "error", message: "Account name cannot be empty" })
          return
        }
        const name = label.trim().toLowerCase().replace(/\s+/g, "-")
        const active = await fetchActive(sdk)
        if (active) {
          await sdk.fetch(`${sdk.url}/auth/${encodeURIComponent(`${props.providerID}:${name}`)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(active),
          })
        }
        toast.show({ variant: "success", message: `Account "${name}" added` })
        dialog.replace(() => <DialogModel providerID={props.providerID} />)
        sdk.client.instance.dispose()
      }}
    />
  )
}

function SwitchAccount() {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const [options, setOptions] = createSignal<{ title: string; value: string; description?: string }[]>([])
  const [current, setCurrent] = createSignal<string | undefined>()

  onMount(async () => {
    const [accts, active, quotas] = await Promise.all([fetchAccounts(sdk), fetchActive(sdk), fetchAllQuotas(sdk)])
    const labels = Object.keys(accts).map(labelFromKey)
    if (labels.length === 0) {
      toast.show({ variant: "warning", message: "No saved accounts to switch to" })
      dialog.clear()
      return
    }
    if (active) {
      const refresh = (active as Record<string, unknown>).refresh
      for (const [key, val] of Object.entries(accts)) {
        if ((val as Record<string, unknown>).refresh === refresh) {
          setCurrent(labelFromKey(key))
          break
        }
      }
    }
    setOptions(
      labels.map((l) => {
        const q = quotas[l] as QuotaInfo | undefined
        return { title: l, value: l, description: formatQuota(q) }
      }),
    )
  })

  return (
    <DialogSelect
      title="Switch to account"
      options={options()}
      current={current()}
      onSelect={async (option) => {
        const res = await sdk.fetch(`${sdk.url}/auth/${PROVIDER_ID}/activate/${encodeURIComponent(option.value)}`, {
          method: "POST",
        })
        if (!res.ok) {
          toast.show({ variant: "error", message: "Failed to switch account" })
          dialog.clear()
          return
        }
        toast.show({ variant: "success", message: `Switched to "${option.value}"` })
        dialog.clear()
        sdk.client.instance.dispose()
      }}
    />
  )
}

function RemoveAccount() {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const [options, setOptions] = createSignal<{ title: string; value: string }[]>([])

  onMount(async () => {
    const accts = await fetchAccounts(sdk)
    const active = await fetchActive(sdk)
    const labels = Object.keys(accts).map(labelFromKey)

    const all = [...labels.map((l) => ({ title: l, value: `${PROVIDER_ID}:${l}` }))]

    if (active) {
      all.unshift({ title: "(active account)", value: PROVIDER_ID })
    }

    if (all.length === 0) {
      toast.show({ variant: "warning", message: "No accounts to remove" })
      dialog.clear()
      return
    }
    setOptions(all)
  })

  return (
    <DialogSelect
      title="Remove account"
      options={options()}
      onSelect={async (option) => {
        const confirmed = await DialogConfirm.show(
          dialog,
          "Confirm removal",
          `Are you sure you want to remove "${option.title}"?`,
        )
        if (!confirmed) return
        await sdk.client.auth.remove({ providerID: option.value })
        toast.show({ variant: "success", message: `Removed "${option.title}"` })
        dialog.clear()
        sdk.client.instance.dispose()
      }}
    />
  )
}
