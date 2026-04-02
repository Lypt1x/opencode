import { createSignal, onCleanup, onMount } from "solid-js"
import { useSDK } from "@tui/context/sdk"

const PROVIDER_ID = "github-copilot"
const POLL_MS = 60_000

export type QuotaInfo = {
  username: string
  name?: string
  label?: string
  plan: string
  percent: number
  remaining: number
  entitlement: number
  unlimited: boolean
  reset: string
}

export function useQuota() {
  const sdk = useSDK()
  const [quota, set] = createSignal<QuotaInfo | undefined>()

  async function refresh() {
    try {
      const res = await sdk.fetch(`${sdk.url}/auth/${PROVIDER_ID}/quota`)
      if (!res.ok) return
      set((await res.json()) as QuotaInfo)
    } catch {}
  }

  onMount(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    onCleanup(() => clearInterval(id))
    const unsub = sdk.event.listen((e) => {
      if (e.details.type === "server.instance.disposed") refresh()
    })
    onCleanup(unsub)
  })

  return { quota, refresh }
}

export async function fetchAllQuotas(sdk: ReturnType<typeof useSDK>) {
  try {
    const res = await sdk.fetch(`${sdk.url}/auth/${PROVIDER_ID}/quota/all`)
    if (!res.ok) return {}
    return (await res.json()) as Record<string, QuotaInfo>
  } catch {
    return {}
  }
}
