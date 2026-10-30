# OpenCode Quota Panel

[Download the latest release](https://github.com/bajszi72/opencode-kvota-panel/releases/latest) · [MIT license](LICENSE)

An OpenCode Desktop plugin that adds a **Quota** tab to the session's side panel, next to the Context tab.

- **The tab label** is always visible and shows how much of the 5-hour limit is left for the session's model, for example "Quota 42%". With several accounts (e.g. two OpenAI accounts) it shows the lower one. If the provider has no 5-hour limit, it shows that provider's tightest percentage limit; balance-only providers do not get a header percentage. It is green at 50% and above, yellow at 20–49%, and red below 20%. The thresholds come from opencode-quota's `colors.warningBelow` and `colors.lowBelow` settings.
- **The session header** shows the same number before the built-in token/cost indicator ("Quota 26%"). Hover over it to see which provider and which limit it refers to, and when it resets. Click it to open the Quota tab.
- **The tab content** lists each provider's limits (5-hour, weekly, monthly) with balances, reset times and errors. The **Refresh** button queries the providers again right away.

The data comes from the server part of [opencode-quota](https://github.com/slkiser/opencode-quota) 6.x (the `slkiser.opencode-quota` RPC), so that plugin must be installed. The panel asks for the latest state once a minute. opencode-quota queries the providers at its own pace (every 5 minutes by default), so the panel adds no provider requests. opencode-quota's TUI sidebar settings (`sidebar.hidden`, `sidebar.providerOrder`, `sidebar.names`, `words.detail`) apply here too.

## Requirements

- OpenCode Desktop **2.2.0** (the version this plugin was built and tested with).
- [opencode-quota](https://github.com/slkiser/opencode-quota) **6.x**, configured with the providers you use. The installer below installs and globally enables it if it is missing; this panel does not replace it.
- For automatic installation: **Node.js 22+**, an OpenCode V2 CLI, **Git**, and internet access. No compilation or separate `npm install` is needed. The installer can find the bundled Desktop CLI on macOS, or you can pass `--opencode /path/to/opencode`.
- Provider sign-ins are managed by OpenCode and opencode-quota. The installer does not sign in to providers or handle API keys.

## Installation

### Automatic installation, including the quota backend (recommended)

Download and extract `opencode-kvota-panel-0.1.1.tgz` from [Releases](https://github.com/bajszi72/opencode-kvota-panel/releases/latest). In the extracted `package` directory, run:

```bash
node install.mjs
```

This explicitly installs **both** global OpenCode plugins using the supported CLI commands:

```bash
opencode plugin add '@slkiser/opencode-quota@6'
opencode plugin add 'github:bajszi72/opencode-kvota-panel#v0.1.1'
```

The installer first checks the active plugin inventory. It keeps an existing compatible backend, as well as any existing panel installation (including a local development checkout), rather than adding duplicate entries or updating them. It backs up existing global JSON/JSONC configuration before changes and delegates configuration edits to OpenCode, preserving comments and unrelated settings. Configured but inactive plugins and incompatible or unverifiable backend versions stop installation with instructions instead of being silently replaced.

The Git-hosted panel includes its prebuilt GUI, so **no build dependencies are installed**. The extracted download is only used to launch the installer; the installed panel lives in OpenCode's package cache. Provider sign-ins still need to be configured separately.

Preview the plan without installing anything:

```bash
node install.mjs --dry-run
```

Select a specific CLI if it is not on your PATH:

```bash
node install.mjs --opencode /path/to/opencode
```

The installer is an explicit command, not an npm `postinstall` hook. Merely downloading the archive or loading the GUI does not change your configuration. If installation fails after one plugin succeeds, that successful step is kept; the installer does not automatically roll back unrelated configuration. A later run checks the inventory again and installs only what is missing.

### Manual local installation (no build tools required)

Download `opencode-kvota-panel-0.1.1.tgz` from [Releases](https://github.com/bajszi72/opencode-kvota-panel/releases/latest), then run the following in the directory containing the download (macOS/Linux):

```bash
mkdir -p "$HOME/.local/share/opencode-plugins/opencode-kvota-panel"
tar -xzf opencode-kvota-panel-0.1.1.tgz \
  -C "$HOME/.local/share/opencode-plugins/opencode-kvota-panel" --strip-components=1
```

Add the extracted directory's **absolute path** to the `plugins` list in your global `~/.config/opencode/opencode.json`. Replace `/absolute/path/to/opencode-kvota-panel` below with the actual path (`~` is not expanded there). Preserve your existing plugins:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "@slkiser/opencode-quota@6",
    "/absolute/path/to/opencode-kvota-panel"
  ]
}
```

OpenCode watches its configuration and reloads the plugin after you save. If the GUI does not appear, use **Reload** for this plugin under **Settings › Extensions › Plugins**. To disable it, turn off its GUI there or remove its entry from the configuration.

`opencode plugin add` accepts npm registry and Git packages, not `.tgz` files, so the release download is installed as an extracted local directory.

### From the Git repository (no build required)

The repository includes the prebuilt GUI bundle. Clone a release and add the clone's absolute path to the configuration as above:

```bash
git clone --branch v0.1.1 https://github.com/bajszi72/opencode-kvota-panel.git
```

Avoid configuring both the extracted release and a clone at the same time: they are the same plugin.

## Language

The interface follows the Desktop app's language. It has English and Hungarian text (`src/i18n/en.ts`, `src/i18n/hu.ts`); every other language shows English. Dates, amounts and durations are formatted for the Desktop app's language too.

## Development

```bash
npm install --legacy-peer-deps
npm test        # installer tests; no real provider credentials or user configuration are used
npm run typecheck
npm run bundle  # writes gui-experimental.cjs to the directory root; OpenCode loads this file
npm run dev     # rebuilds on change; the Desktop app reloads it on its own
npm run package # tests, typecheck, bundle, then dist/opencode-kvota-panel-<version>.tgz
```

There are deliberately no `build`, `prepare`, `prepack` or install lifecycle scripts: npm treats those names as a reason to install development dependencies when consuming a Git package. `bundle` and `package` are explicit maintainer commands; Git consumers receive the committed prebuilt GUI without rebuilding it.

The package holds the built `gui-experimental.cjs`, the dependency-aware `install.mjs`, `package.json`, the MIT license and this README. The GUI source and tests are available in this repository. `"private": true` in `package.json` prevents accidental publication to the npm registry; it does not prevent sharing this repository or its release archive.

The source is in `src/`: `gui.tsx` registers the tab and the header item, `quota.ts` fetches the data, `format.ts` formats it and `view.tsx` renders it.

## Limitations

- It is built on OpenCode 2.2.0's experimental Desktop plugin interface (`./gui-experimental`). An OpenCode update may break it.
- A plugin cannot add to the built-in Context tab's content, so this is a separate tab. The tab is pinned: it cannot be closed, only turned off with the plugin.
- It works only in the Desktop app, not in the web interface or the terminal TUI. In the TUI, opencode-quota's own sidebar panel shows the quota.

## Privacy

This GUI plugin reads quota snapshots from opencode-quota through OpenCode's local RPC interface. It does not read provider credentials or send telemetry. The main display may include account names supplied by opencode-quota, so redact them before sharing screenshots.

## License and credits

[MIT](LICENSE). Quota collection is provided by [opencode-quota](https://github.com/slkiser/opencode-quota); the desktop interface is provided by [OpenCode](https://opencode.ai). This is an independent community plugin, not an official OpenCode or opencode-quota release.
