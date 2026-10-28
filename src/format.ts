import type { Context } from "@opencode/plugin/gui"
import type { Amount, ProviderSnapshot, QuotaError, QuotaRow, QuotaSnapshot } from "./quota"

/** How much is left: from the TUI's warning and low thresholds (`colors.warningBelow`, `colors.lowBelow`). */
export type Level = "good" | "warn" | "low"

export type Thresholds = { readonly warn: number; readonly low: number }

/** One account's rows of a provider. */
export type RowGroup = { readonly account?: string; readonly rows: readonly QuotaRow[] }

/** A provider as the panel shows it. */
export type ProviderView = {
  readonly provider: ProviderSnapshot
  /** It serves the session's current model. */
  readonly current: boolean
  readonly groups: readonly RowGroup[]
}

// opencode-quota's own settings, so the panel hides, orders and colours like its TUI sidebar.
function setting<T>(snapshot: QuotaSnapshot, key: string, fallback: T): T {
  const value = snapshot.settings?.values?.[key]

  return value === undefined || value === null ? fallback : (value as T)
}

export function thresholds(snapshot: QuotaSnapshot): Thresholds {
  return { warn: setting(snapshot, "colors.warningBelow", 50), low: setting(snapshot, "colors.lowBelow", 20) }
}

export function level(percent: number, limits: Thresholds): Level {
  return percent < limits.low ? "low" : percent < limits.warn ? "warn" : "good"
}

/** Percent left as shown: rounded, and kept between 0 and 100 (over quota reports below 0). */
export function percentLeft(row: QuotaRow) {
  return row.percentRemaining === undefined ? undefined : Math.max(0, Math.min(100, Math.round(row.percentRemaining)))
}

export function rowNames(snapshot: QuotaSnapshot) {
  return setting<Readonly<Record<string, string>>>(snapshot, "sidebar.names", {})
}

function groupByAccount(rows: readonly QuotaRow[]) {
  const groups: { account?: string; rows: QuotaRow[] }[] = []

  for (const row of rows) {
    const group = groups.find((item) => item.account === row.account)

    if (group) group.rows.push(row)
    else groups.push({ account: row.account, rows: [row] })
  }

  return groups
}

/** The providers and rows to show, with the TUI sidebar's hidden list, provider order and detail level. */
export function providerViews(snapshot: QuotaSnapshot, current: readonly string[]): ProviderView[] {
  const hidden = new Set(setting<readonly string[]>(snapshot, "sidebar.hidden", []))
  const order = setting<readonly string[]>(snapshot, "sidebar.providerOrder", [])
  const detailed = setting<string>(snapshot, "words.detail", "summary") === "detailed"
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length)

  return snapshot.providers
    .filter((provider) => !hidden.has(provider.providerId))
    .map((provider, index) => ({ provider, index }))
    .sort((a, b) => rank(a.provider.providerId) - rank(b.provider.providerId) || a.index - b.index)
    .map(({ provider }) => ({
      provider,
      current: current.includes(provider.providerId),
      groups: groupByAccount(
        provider.rows.filter((row) => !hidden.has(row.id) && (detailed || row.prominence === "primary")),
      ),
    }))
    .filter((view) => view.groups.length > 0 || view.provider.error || view.provider.refreshing)
}

/**
 * The 5-hour quota left for the session's model, for the tab label: the lowest of its 5-hour rows (one per account).
 * A provider without a 5-hour window shows its lowest percent left instead.
 */
export function headline(snapshot: QuotaSnapshot, current: readonly string[]) {
  const rows = providerViews(snapshot, current)
    .filter((view) => view.current)
    .flatMap((view) => view.groups.flatMap((group) => group.rows.map((row) => ({ provider: view.provider, row }))))
    .filter((item) => percentLeft(item.row) !== undefined)
  const fiveHour = rows.filter((item) => item.row.window === "five_hour")
  const candidates = fiveHour.length > 0 ? fiveHour : rows

  if (candidates.length === 0) return undefined
  const lowest = candidates.reduce((a, b) => (percentLeft(b.row)! < percentLeft(a.row)! ? b : a))
  const percent = percentLeft(lowest.row)!

  return { ...lowest, percent, level: level(percent, thresholds(snapshot)) }
}

const WINDOWS = new Set([
  "rpm",
  "hour",
  "five_hour",
  "session",
  "day",
  "week",
  "month",
  "year",
  "mcp",
  "code_review",
])
// Labels that only name the window, such as "5h" or "Weekly": the panel names the window in its own words.
const WINDOW_LABELS = new Set(["5h", "1h", "hourly", "daily", "weekly", "monthly", "yearly", "session"])
const LABELS: Readonly<Record<string, string>> = {
  balance: "label.balance",
  granted: "label.granted",
  "topped up": "label.toppedUp",
  budget: "label.budget",
  "auto reload": "label.autoReload",
}
const ERRORS = new Set([
  "not_configured",
  "login_expired",
  "no_plan",
  "rate_limited",
  "timeout",
  "network",
  "provider_error",
  "bad_response",
  "no_data",
  "local_tool",
  "internal",
])
const DAY_MS = 86_400_000

export type Format = ReturnType<typeof createFormat>

export function createFormat(ctx: Context) {
  const locale = () => ctx.locale.locale()
  const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase(locale()) + text.slice(1)
  const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0)
  const unit = (count: number, name: string) =>
    new Intl.NumberFormat(locale(), { style: "unit", unit: name, unitDisplay: "long" }).format(count)

  function rowLabel(row: QuotaRow, names: Readonly<Record<string, string>>) {
    if (names[row.id]) return names[row.id]
    const name = row.label.trim().toLowerCase()
    const window = row.window && WINDOWS.has(row.window) ? ctx.t(`window.${row.window}`) : undefined

    if (row.type === "usage") return capitalize(window ? ctx.t("row.spendWindow", { window }) : ctx.t("row.spend"))

    if (LABELS[name]) return ctx.t(LABELS[name])

    if (window && WINDOW_LABELS.has(name)) return capitalize(ctx.t("row.window", { window }))

    if (window) return ctx.t("row.named", { name: row.label, window })

    return row.label
  }

  function amount(value: Amount) {
    const number = Number(value.decimal)

    if (value.unit.kind === "currency") {
      try {
        return new Intl.NumberFormat(locale(), { style: "currency", currency: value.unit.code }).format(number)
      } catch {
        // Not an ISO currency code.
        return `${value.decimal} ${value.unit.code}`
      }
    }
    const text = new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format(number)

    return `${text} ${value.unit.kind === "count" ? value.unit.unit : value.unit.symbol}`
  }

  /** The value of a row without a percentage: an amount, a yes/no status or a text. */
  function value(row: QuotaRow) {
    if (row.amount) return amount(row.amount)

    if (row.remaining) return amount(row.remaining)

    if (row.flag !== undefined) return ctx.t(row.flag ? "flag.on" : "flag.off")

    return row.text ?? ""
  }

  /** A used-up balance shows as low; other value rows have no level. */
  function valueLevel(row: QuotaRow): Level | undefined {
    return row.type === "balance" && row.amount && Number(row.amount.decimal) <= 0 ? "low" : undefined
  }

  function clock(ms: number, now: number) {
    const time = new Intl.DateTimeFormat(locale(), { hour: "numeric", minute: "2-digit" }).format(ms)
    const days = Math.round((startOfDay(ms) - startOfDay(now)) / DAY_MS)

    if (days === 0) return ctx.t("day.today", { time })

    if (days === 1) return ctx.t("day.tomorrow", { time })
    const date = new Intl.DateTimeFormat(locale(), { month: "short", day: "numeric" }).format(ms)

    return ctx.t("day.other", { date, time })
  }

  // The two largest units, e.g. "1 day 3 hours" or "1 hour 28 minutes".
  function span(ms: number) {
    const minutes = Math.max(1, Math.round(ms / 60_000))
    const days = Math.floor(minutes / 1440)
    const hours = Math.floor((minutes % 1440) / 60)
    const rest = minutes % 60

    if (days) return hours ? `${unit(days, "day")} ${unit(hours, "hour")}` : unit(days, "day")

    if (hours) return rest ? `${unit(hours, "hour")} ${unit(rest, "minute")}` : unit(hours, "hour")

    return unit(rest, "minute")
  }

  function reset(row: QuotaRow, now: number) {
    const at = row.resetsAt ? Date.parse(row.resetsAt) : NaN

    if (!Number.isFinite(at)) return undefined

    if (at <= now) return ctx.t("reset.due")

    return ctx.t("reset.at", { when: clock(at, now), span: span(at - now) })
  }

  function error(value: QuotaError) {
    if (value.code === "local_tool")
      return ctx.t(value.missing ? "error.local_tool_missing" : "error.local_tool", { tool: value.tool ?? "?" })

    return ctx.t(`error.${ERRORS.has(value.code) ? value.code : "internal"}`, {
      status: value.status ? ` (HTTP ${value.status})` : "",
    })
  }

  return { rowLabel, value, valueLevel, clock, reset, error }
}
