import { Panel, Plugin, Slot, Style, type PanelTab } from "@opencode/plugin/gui"
import en from "./i18n/en"
import hu from "./i18n/hu"
import { createQuota } from "./quota"
import css from "./style.css?inline"
import { HeaderItem, QuotaTab, TabLabel } from "./view"

// The built-in context usage sits at 10 in the session header and the details menu at 20; below 10 renders first.
const HEADER_ORDER = 5

/**
 * OpenCode Desktop: a "Quota" tab in the session's side region, beside Context, with the quotas opencode-quota's
 * server plugin reports. The tab is pinned, so every session lists it; its label, and an item in the session header
 * before the context usage, show the 5-hour quota left for the session's model.
 */
export default Plugin.define({
  i18n: { en, hu },
  setup(ctx) {
    ctx.add(Style, css)
    const quota = createQuota(ctx)

    // One tab object for every session; the label reads the routed session from its state.
    const tab: PanelTab = {
      id: "main",
      get title() {
        return ctx.t("tab.title")
      },
      pinned: true,
      label: (state) => <TabLabel ctx={ctx} quota={quota} session={state.session} />,
    }

    ctx.add(Panel, {
      id: "main",
      region: "side",
      list: () => [tab],
      render: (props) => <QuotaTab ctx={ctx} quota={quota} session={props.session} />,
    })

    ctx.add(Slot, {
      at: "session.header",
      order: HEADER_ORDER,
      render: (input) => <HeaderItem ctx={ctx} quota={quota} session={input.session} active={input.active} />,
    })
  },
})
