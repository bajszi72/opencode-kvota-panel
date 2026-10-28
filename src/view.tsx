import { createMemo, For, onCleanup, Show } from "solid-js"
import { createKeyed, type Context, type MountedSession } from "@opencode/plugin/gui"
import {
  createFormat,
  headline,
  level,
  percentLeft,
  providerViews,
  rowNames,
  thresholds,
  type Format,
  type ProviderView,
  type Thresholds,
} from "./format"
import type { Quota, QuotaRow, QuotaSession } from "./quota"

type Props = { readonly ctx: Context; readonly quota: Quota; readonly session: MountedSession }

function quotaSession(session: MountedSession): QuotaSession | undefined {
  return session.id ? { id: session.id, directory: session.directory } : undefined
}

// Keeps the routed session's quota loading while the component shows and is active; another routed session takes
// its place.
function useWatch(props: Props & { readonly active?: boolean }) {
  createKeyed(
    () => props.active !== false && quotaSession(props.session),
    (session) => onCleanup(props.quota.watch(session)),
    { equals: (a, b) => a.id === b.id && a.directory === b.directory },
  )
}

function useHeadline(props: Props) {
  return createMemo(() => {
    const snapshot = props.quota.latest()

    return snapshot ? headline(snapshot, props.quota.models()[props.session.id] ?? []) : undefined
  })
}

/** The tab's trigger: its title and the 5-hour quota left for the session's model. */
export function TabLabel(props: Props) {
  useWatch(props)
  const top = useHeadline(props)

  return (
    <span class="kvota-label">
      <span>{props.ctx.t("tab.title")}</span>
      <Show when={top()}>{(item) => <span class={`kvota-value kvota-${item().level}`}>{item().percent}%</span>}</Show>
    </span>
  )
}

/**
 * The session header item before the context usage: the same quota as the tab label, with the row in its tooltip.
 * A click opens the Quota tab. Hidden timelines stay mounted with `active` false; they load nothing.
 */
export function HeaderItem(props: Props & { readonly active: boolean }) {
  useWatch(props)
  const format = createFormat(props.ctx)
  const top = useHeadline(props)

  const tooltip = () => {
    const item = top()
    const snapshot = props.quota.latest()

    if (!item || !snapshot) return ""
    const name = item.row.account ? `${item.provider.label} (${item.row.account})` : item.provider.label
    const reset = format.reset(item.row, props.quota.now())

    return [
      `${name}: ${format.rowLabel(item.row, rowNames(snapshot))}, ${props.ctx.t("percent.left", { percent: item.percent })}`,
      ...(reset ? [reset] : []),
      props.ctx.t("header.hint"),
    ].join("\n")
  }

  return (
    <Show when={top()}>
      {(item) => (
        // The app's own button style, as the context usage button beside it has.
        <button
          type="button"
          data-component="button-v2"
          data-variant="ghost-muted"
          data-size="normal"
          class="kvota-header"
          title={tooltip()}
          aria-label={tooltip()}
          onClick={() => props.ctx.layout.open(`${props.ctx.id}:main`, props.session)}
        >
          <span>{props.ctx.t("tab.title")}</span>
          <span class={`kvota-value kvota-${item().level}`}>{item().percent}%</span>
        </button>
      )}
    </Show>
  )
}

function Row(props: {
  readonly ctx: Context
  readonly row: QuotaRow
  readonly format: Format
  readonly limits: Thresholds
  readonly names: Readonly<Record<string, string>>
  readonly now: number
}) {
  const percent = () => percentLeft(props.row)

  return (
    <div class="kvota-row">
      <div class="kvota-line">
        <span>{props.format.rowLabel(props.row, props.names)}</span>
        <Show
          when={percent() !== undefined}
          fallback={
            <span class={`kvota-value kvota-${props.format.valueLevel(props.row) ?? "plain"}`}>
              {props.format.value(props.row)}
            </span>
          }
        >
          <span class={`kvota-value kvota-${level(percent()!, props.limits)}`}>
            {props.ctx.t("percent.left", { percent: percent()! })}
          </span>
        </Show>
      </div>
      <Show when={percent() !== undefined}>
        <div class="kvota-bar">
          <div class={`kvota-fill kvota-${level(percent()!, props.limits)}`} style={{ width: `${percent()}%` }} />
        </div>
      </Show>
      <Show when={props.format.reset(props.row, props.now)}>{(text) => <div class="kvota-muted">{text()}</div>}</Show>
    </div>
  )
}

function Provider(props: {
  readonly ctx: Context
  readonly view: ProviderView
  readonly format: Format
  readonly limits: Thresholds
  readonly names: Readonly<Record<string, string>>
  readonly now: number
}) {
  const provider = () => props.view.provider
  const empty = () => props.view.groups.length === 0

  return (
    <section class="kvota-provider">
      <div class="kvota-provider-head">
        <span>{provider().label}</span>
        <Show when={props.view.current}>
          <span class="kvota-badge">{props.ctx.t("current")}</span>
        </Show>
      </div>
      <For each={props.view.groups}>
        {(group) => (
          <>
            <Show when={group.account}>{(account) => <div class="kvota-account">{account()}</div>}</Show>
            <For each={group.rows}>
              {(row) => (
                <Row
                  ctx={props.ctx}
                  row={row}
                  format={props.format}
                  limits={props.limits}
                  names={props.names}
                  now={props.now}
                />
              )}
            </For>
          </>
        )}
      </For>
      <Show when={provider().error}>
        {(error) => (
          <div class={empty() ? "kvota-error" : "kvota-muted"}>
            {empty()
              ? props.format.error(error())
              : props.ctx.t("error.stale", { reason: props.format.error(error()) })}
          </div>
        )}
      </Show>
      <Show when={empty() && !provider().error && provider().refreshing}>
        <div class="kvota-muted">{props.ctx.t("head.refreshing")}</div>
      </Show>
    </section>
  )
}

/** The tab's content: every provider's quota, with a refresh button. */
export function QuotaTab(props: Props) {
  useWatch(props)
  const format = createFormat(props.ctx)
  const snapshot = () => props.quota.latest()
  const views = createMemo(() => {
    const current = snapshot()

    return current ? providerViews(current, props.quota.models()[props.session.id] ?? []) : undefined
  })
  const updated = createMemo(() => {
    const times = (snapshot()?.providers ?? []).flatMap((provider) => (provider.okAtMs ? [provider.okAtMs] : []))

    return times.length > 0 ? Math.max(...times) : undefined
  })
  const busy = () => props.quota.refreshing() || !!snapshot()?.providers.some((provider) => provider.refreshing)

  return (
    <div class="kvota-root">
      <div class="kvota" data-scrollable>
        <div class="kvota-head">
          <span>
            {updated()
              ? props.ctx.t("head.updated", { time: format.clock(updated()!, props.quota.now()) })
              : props.ctx.t("head.never")}
          </span>
          <button
            type="button"
            class="kvota-button"
            disabled={busy()}
            onClick={() => void props.quota.refresh(quotaSession(props.session))}
          >
            {busy() ? props.ctx.t("head.refreshing") : props.ctx.t("head.refresh")}
          </button>
        </div>
        <Show when={props.quota.failure()}>{(message) => <div class="kvota-error">{message()}</div>}</Show>
        <Show when={views()} fallback={<div class="kvota-muted">{props.ctx.t("loading")}</div>}>
          {(list) => (
            <Show when={list().length > 0} fallback={<div class="kvota-muted">{props.ctx.t("empty")}</div>}>
              <For each={list()}>
                {(view) => (
                  <Provider
                    ctx={props.ctx}
                    view={view}
                    format={format}
                    limits={thresholds(snapshot()!)}
                    names={rowNames(snapshot()!)}
                    now={props.quota.now()}
                  />
                )}
              </For>
            </Show>
          )}
        </Show>
      </div>
    </div>
  )
}
