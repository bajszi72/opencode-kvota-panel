#!/usr/bin/env node
// Explicit installer: never runs as an npm postinstall hook or from the GUI.
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const BACKEND = "@slkiser/opencode-quota"
const BACKEND_ID = `${BACKEND}.server`
const PANEL_ID = "opencode-kvota-panel"
const REPOSITORY = "github:bajszi72/opencode-kvota-panel"

export function parseOptions(argv) {
  const options = { dryRun: false, help: false, binary: undefined }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") options.dryRun = true
    else if (argv[i] === "--help" || argv[i] === "-h") options.help = true
    else if (argv[i] === "--opencode" && argv[i + 1] && !argv[i + 1].startsWith("--")) options.binary = argv[++i]
    else throw new Error(`Unknown or incomplete option: ${argv[i]}. Use --help.`)
  }
  return options
}

export function parsePlugins(text) {
  const result = JSON.parse(text)
  const plugins = Array.isArray(result) ? result : result?.data
  if (!Array.isArray(plugins) || plugins.some((plugin) => !plugin || typeof plugin.id !== "string"))
    throw new Error("Unexpected plugin inventory; no configuration changes were made.")
  return plugins
}

function configuredTargets(text, home) {
  const result = JSON.parse(text)
  const sources = Array.isArray(result) ? result : result?.data
  if (!Array.isArray(sources)) throw new Error("Unexpected configuration inventory; stopping before installation.")
  return sources.flatMap((source) => {
    if (source.type !== "document") return []
    const entries = source.info?.plugins ?? []
    if (!Array.isArray(entries)) throw new Error("Unexpected plugin configuration.")
    return entries.flatMap((entry) => {
      const target = typeof entry === "string" ? entry : entry?.package
      if (typeof target !== "string" || target.startsWith("-") || target.includes("*")) return []
      if (target.startsWith("file://")) return [fileURLToPath(target)]
      if (target.startsWith(".")) return [resolve(source.path ? dirname(source.path) : home, target)]
      return [target]
    })
  })
}

/** Cached plugins load asynchronously after service start/config edits. Wait rather than treating them as missing. */
export async function readInventory(binary, options, {
  runner = runCommand, pause = delay, expectedTargets = [], attempts = 60,
} = {}) {
  const targets = [...new Set([
    ...configuredTargets(runner(binary, ["api", "get", "/api/config"], options), options.cwd),
    ...expectedTargets,
  ])]
  for (let attempt = 0; attempt < attempts; attempt++) {
    const plugins = parsePlugins(runner(binary, ["api", "get", "/api/plugin"], options))
    if (targets.every((target) => plugins.some((plugin) => {
      const source = plugin.source?.target ?? plugin.source?.path
      const matches = plugin.id === target || source === target ||
        (source && isAbsolute(source) && isAbsolute(target) && resolve(source) === resolve(target))
      return matches && ["active", "failed"].includes(plugin.state?.status)
    }))) return plugins
    if (attempt + 1 < attempts) await pause(500)
  }
  throw new Error("Configured plugins are still loading or disabled. Check OpenCode's plugin settings and try again; no duplicate entries will be added.")
}

export function installationPlan(plugins, panelTarget) {
  const backend = plugins.filter((plugin) => plugin.id === BACKEND_ID)
  const panel = plugins.filter((plugin) => plugin.id === PANEL_ID)
  if (backend.length > 1 || panel.length > 1)
    throw new Error("Duplicate quota plugins found. Resolve them before running the installer.")
  for (const plugin of [...backend, ...panel]) {
    if (plugin.state?.status !== "active")
      throw new Error(`${plugin.id} is already configured but is not active. Check Settings > Extensions > Plugins first.`)
  }
  if (backend.length && !/^6\./.test(backend[0].source?.version ?? ""))
    throw new Error("An existing opencode-quota installation is not verified as 6.x. Update it manually; the installer will not replace or downgrade it.")
  return [
    ...(!backend.length ? [{ name: "opencode-quota 6.x", target: `${BACKEND}@6` }] : []),
    ...(!panel.length ? [{ name: "OpenCode Quota Panel", target: panelTarget }] : []),
  ]
}

export function runCommand(binary, args, options) {
  const result = spawnSync(binary, args, {
    ...options, encoding: "utf8", shell: false, timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw new Error(`Could not run ${binary}: ${result.error.code ?? result.error.message}`)
  if (result.status !== 0)
    throw new Error(`${binary} ${args.join(" ")} failed (exit ${result.status ?? result.signal}).\n${(result.stderr || result.stdout || "").trim().slice(0, 2000)}`)
  return result.stdout ?? ""
}

export function findOpenCode(options, { env, home, platform, runner }) {
  const explicit = options.binary || env.OPENCODE_BIN
  const candidates = explicit ? [explicit] : [
    "opencode",
    ...(platform === "darwin" ? [
      "/Applications/OpenCode.app/Contents/Resources/opencode-cli",
      join(home, "Applications/OpenCode.app/Contents/Resources/opencode-cli"),
    ] : []),
  ]
  for (const binary of candidates) {
    try {
      const version = runner(binary, ["--version"], { env, cwd: home })
      const match = /\b(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)\b/.exec(version)
      if (match && Number(match[1]) === 2 && Number(match[2]) >= 2) return binary
    } catch (error) {
      if (explicit) throw error
    }
  }
  throw new Error("OpenCode 2.2.0 or newer (V2) is required. Install OpenCode Desktop first, or pass --opencode /path/to/opencode.")
}

export function configDirectory(env, home) {
  return env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode")
}

/** Snapshot the same candidate files the OpenCode CLI may edit. Never print their contents. */
export async function backupConfiguration(directory) {
  const backups = []
  for (const relative of ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"]) {
    const source = join(directory, relative)
    let bytes
    try { bytes = await readFile(source) } catch (error) {
      if (error.code === "ENOENT") continue
      throw error
    }
    const destination = `${source}.backup-quota-installer-${randomUUID()}`
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 })
    backups.push(destination)
  }
  return backups
}

export async function install({
  argv = process.argv.slice(2), env = process.env, home = homedir(), platform = process.platform,
  runner = runCommand, backup = backupConfiguration, log = console.log, panelTarget, pause = delay,
} = {}) {
  const options = parseOptions(argv)
  if (options.help) {
    log("Usage: node install.mjs [--dry-run] [--opencode /path/to/opencode]\n\nInstalls and globally enables opencode-quota 6.x and this panel using OpenCode's CLI.\nPreserves active compatible installations and unrelated settings; backs up existing configuration.\nRequires Node.js 22+, OpenCode Desktop 2.2.0+, internet access, and Git for the panel download.\n--dry-run checks the plan without installing plugins or editing configuration.\nOPENCODE_BIN can also select the OpenCode executable.")
    return
  }
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node.js 22 or newer is required.")
  const binary = findOpenCode(options, { env, home, platform, runner })
  // A neutral working directory avoids the current project's plugin overrides.
  const commandOptions = { env: { ...env, NO_COLOR: "1" }, cwd: home }
  const plugins = await readInventory(binary, commandOptions, { runner, pause })
  const manifest = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"))
  const target = panelTarget ?? `${REPOSITORY}#v${manifest.version}`
  const plan = installationPlan(plugins, target)
  if (!plan.length) {
    log("Both quota plugins are already active. Keeping your existing installations; nothing to change.")
    return
  }
  log("Installation plan:")
  for (const step of plan) log(`  ${step.name}: ${step.target}`)
  log("Existing active quota plugins, their settings and provider sign-ins will be preserved.")
  if (options.dryRun) {
    log("Dry run: no plugins installed and no configuration files changed.")
    return
  }
  for (const path of await backup(configDirectory(env, home))) log(`Configuration backup: ${path}`)
  for (const step of plan) {
    log(`Installing ${step.name}...`)
    const output = runner(binary, ["plugin", "add", step.target], commandOptions)
    if (output.trim()) log(output.trim())
  }
  const installed = await readInventory(binary, commandOptions, { runner, pause, expectedTargets: plan.map((step) => step.target) })
  // This also validates that the backend is 6.x and that neither quota plugin failed activation.
  if (installationPlan(installed, target).length) throw new Error("Installation commands completed, but both quota plugins could not be verified as active.")
  log("Both quota plugins are installed, globally configured and active.\nIf the GUI is not visible, use Reload in Settings > Extensions > Plugins.\nProvider sign-in is still your responsibility; this installer does not handle credentials.")
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  install().catch((error) => {
    console.error(`Installation stopped: ${error.message}\nAny successful earlier steps are kept; the installer does not roll back unrelated configuration.`)
    process.exitCode = 1
  })
}
