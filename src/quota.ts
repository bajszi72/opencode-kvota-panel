import { createSignal, onCleanup } from "solid-js"
import type { Context } from "@opencode/plugin/gui"

/**
 * The parts of opencode-quota 6's snapshot (`QuotaSnapshot`, version 6, in its dist/core/types.d.ts) this panel
 * reads. Its server plugin builds the snapshot; this side only reads it.
 */
export type Amount = {
  readonly decimal: string
  readonly unit:
    | { readonly kind: "currency"; readonly code: string }
    | { readonly kind: "count"; readonly unit: string }
    | { readonly kind: "custom"; readonly symbol: string }
}

export type QuotaRow = {
  readonly id: string
  readonly providerId: string
  readonly account?: string
  readonly label: string
  readonly type: "quota" | "budget" | "usage" | "balance" | "status"
  readonly window?: string
  readonly prominence: "primary" | "supplementary"
  readonly percentRemaining?: number
  readonly amount?: Amount
  readonly remaining?: Amount
  readonly flag?: boolean
  readonly text?: string
  readonly resetsAt?: string
}

export type QuotaError = {
  readonly code: string
  readonly status?: number
  readonly tool?: string
  readonly missing?: boolean
}

export type ProviderSnapshot = {
  readonly providerId: string
  readonly label: string
  readonly rows: readonly QuotaRow[]
  readonly okAtMs?: number
  readonly error?: QuotaError
  readonly refreshing: boolean
}

export type QuotaSnapshot = {
  readonly providers: readonly ProviderSnapshot[]
  /** Only in an answer about a session: the providers serving its current model. */
  readonly currentModelProviderIds?: readonly string[]
  readonly settings?: { readonly values?: Readonly<Record<string, unknown>> }
  readonly serverId: string
  readonly revision: number
}

type Snapshot = { readonly snapshot: QuotaSnapshot }
type SnapshotInput = { readonly sessionID?: string }
type RefreshInput = { readonly reason: "poll" | "turn" | "manual"; readonly sessionID?: string }
type CallOptions = { readonly location?: { readonly directory?: string }; readonly signal?: AbortSignal }

type Schema<T> = {
  readonly "~standard": {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => { readonly value: T }
    readonly types?: { readonly input: T; readonly output: T }
  }
}

// Passes values through as they are: the server checks both directions with its own schemas.
function schema<T>(): Schema<T> {
  return { "~standard": { version: 1, vendor: "opencode-kvota-panel", validate: (value) => ({ value: value as T }) } }
}

/** opencode-quota's RPC, `slkiser.opencode-quota` in 6.x: only the methods and the event this panel uses. */
const QuotaRpc = {
  id: "slkiser.opencode-quota",
  events: { changed: { schema: schema<Snapshot>() } },
  methods: {
    snapshot: { input: schema<SnapshotInput>(), output: schema<Snapshot>() },
    refresh: { input: schema<RefreshInput>(), output: schema<Snapshot>() },
  },
}

/** A session a surface shows: an answer about it names the providers serving its model. */
export type QuotaSession = { readonly id: string; readonly directory: string }

const POLL_MS = 60_000
const CLOCK_MS = 30_000
const CALL_TIMEOUT_MS = 60_000

export type Quota = ReturnType<typeof createQuota>

/**
 * The quota the panel shows, kept in signals. While a surface shows a session, it asks the server for a snapshot
 * every minute and applies every `changed` event; the server refreshes the providers at its own pace (5 minutes by
 * default), so this adds no provider requests.
 */
export function createQuota(ctx: Context) {
  const [latest, setLatest] = createSignal<QuotaSnapshot>()
  const [models, setModels] = createSignal<Readonly<Record<string, readonly string[]>>>({})
  const [failure, setFailure] = createSignal<string>()
  const [refreshing, setRefreshing] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  const watched = new Map<string, { session: QuotaSession; count: number }>()
  const loading = new Set<string>()
  // Answers can arrive out of order. The higher revision wins; a new server id (OpenCode restarted its service)
  // always wins, and from then on the old server's answers are ignored.
  const retired = new Set<string>()
  let events: AbortController | undefined

  // The client changes when the server restarts, so it is read for each call.
  const rpc = () => ctx.client.rpc(QuotaRpc)

  function apply(next: QuotaSnapshot, sessionID?: string) {
    const { currentModelProviderIds, ...shared } = next

    if (retired.has(shared.serverId)) return
    const current = latest()

    if (current && current.serverId !== shared.serverId) retired.add(current.serverId)

    if (!current || current.serverId !== shared.serverId || current.revision < shared.revision) setLatest(shared)

    if (sessionID) setModels((all) => ({ ...all, [sessionID]: currentModelProviderIds ?? [] }))
    setFailure(undefined)
  }

  function report(error: unknown) {
    if (ctx.signal.aborted) return
    const detail = typeof error === "object" && error !== null ? (error as { type?: unknown; message?: unknown }) : {}
    const message = typeof detail.message === "string" ? detail.message : String(error)

    setFailure(
      detail.type === "rpc.unavailable" ? ctx.t("error.unavailable") : ctx.t("error.load", { message: message }),
    )
    // After a server restart the event subscription belongs to the old client; the next load subscribes again.
    events?.abort()
    events = undefined
  }

  // A session whose folder no longer exists has no location on the server; the default location answers then.
  async function ask(send: (options: CallOptions) => Promise<Snapshot>, directory: string | undefined) {
    const options = (location?: string): CallOptions => ({
      ...(location ? { location: { directory: location } } : {}),
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
    })

    try {
      return await send(options(directory))
    } catch (error) {
      if (!directory || ctx.signal.aborted) throw error

      return send(options())
    }
  }

  function subscribe() {
    if (events) return
    events = new AbortController()

    try {
      // The client types this event's data as unknown; it is the `changed` event's snapshot.
      rpc().events.on("changed", (event) => apply((event.data as Snapshot).snapshot), {
        signal: AbortSignal.any([events.signal, ctx.signal]),
      })
    } catch (error) {
      report(error)
    }
  }

  function load(session: QuotaSession) {
    if (loading.has(session.id)) return
    loading.add(session.id)
    subscribe()
    ask((options) => rpc().snapshot({ sessionID: session.id }, options), session.directory)
      .then((output) => apply(output.snapshot, session.id), report)
      .finally(() => loading.delete(session.id))
  }

  /** Asks every provider again now, as `/quota` does. */
  async function refresh(session: QuotaSession | undefined) {
    if (refreshing()) return
    setRefreshing(true)

    try {
      const input: RefreshInput = session ? { reason: "manual", sessionID: session.id } : { reason: "manual" }
      const output = await ask((options) => rpc().refresh(input, options), session?.directory)

      apply(output.snapshot, session?.id)
    } catch (error) {
      report(error)
    } finally {
      setRefreshing(false)
    }
  }

  /** Keeps a session's quota loading while a surface shows it. Returns the release. */
  function watch(session: QuotaSession) {
    const entry = watched.get(session.id)

    if (entry) {
      entry.session = session
      entry.count += 1
    } else watched.set(session.id, { session, count: 1 })
    load(session)

    return () => {
      const current = watched.get(session.id)

      if (!current) return

      if (current.count > 1) current.count -= 1
      else watched.delete(session.id)
    }
  }

  const poll = setInterval(() => {
    for (const { session } of watched.values()) load(session)
  }, POLL_MS)
  const clock = setInterval(() => setNow(Date.now()), CLOCK_MS)

  onCleanup(() => {
    clearInterval(poll)
    clearInterval(clock)
    events?.abort()
  })

  return { latest, models, failure, refreshing, now, watch, refresh }
}
