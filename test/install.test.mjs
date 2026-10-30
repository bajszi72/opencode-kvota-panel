import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { backupConfiguration, configDirectory, findOpenCode, install, installationPlan, parseOptions, parsePlugins, readInventory } from "../install.mjs"

const target = "github:bajszi72/opencode-kvota-panel#v0.1.1"
const backend = { id: "@slkiser/opencode-quota.server", source: { type: "package", target: "@slkiser/opencode-quota@latest", version: "6.0.0" }, state: { status: "active" } }
const panel = { id: "opencode-kvota-panel", source: { type: "local", path: "/example/existing-panel" }, state: { status: "active" } }

test("fresh install adds the backend before the panel", () => {
  assert.deepEqual(installationPlan([], target).map((item) => item.target), ["@slkiser/opencode-quota@6", target])
})

test("an existing compatible backend is kept without adding another entry", () => {
  assert.deepEqual(installationPlan([backend], target).map((item) => item.target), [target])
})

test("an existing local panel is kept; only its missing dependency is added", () => {
  assert.deepEqual(installationPlan([panel], target).map((item) => item.target), ["@slkiser/opencode-quota@6"])
})

test("repeated installation does nothing", () => {
  assert.deepEqual(installationPlan([backend, panel], target), [])
})

test("incompatible, unversioned, failed, and duplicate installations are not replaced", () => {
  for (const version of ["5.0.2", "7.0.0", undefined]) {
    assert.throws(() => installationPlan([{ ...backend, source: { version } }], target), /not verified as 6.x/)
  }
  assert.throws(() => installationPlan([{ ...panel, state: { status: "failed" } }], target), /not active/)
  assert.throws(() => installationPlan([backend, backend], target), /Duplicate/)
})

test("inventory accepts a list or data envelope and rejects invalid responses", () => {
  assert.deepEqual(parsePlugins(JSON.stringify([backend])), [backend])
  assert.deepEqual(parsePlugins(JSON.stringify({ data: [backend] })), [backend])
  for (const input of ['{}', 'null', '[null]', '[{}]', 'not json']) assert.throws(() => parsePlugins(input))
})

test("options reject unknown or incomplete flags", () => {
  assert.equal(parseOptions(["--dry-run"]).dryRun, true)
  assert.equal(parseOptions(["--opencode", "/example/My OpenCode"]).binary, "/example/My OpenCode")
  for (const args of [["--opencode"], ["--opencode", "--dry-run"], ["--unknown"]]) assert.throws(() => parseOptions(args))
})

test("finds the Desktop CLI on macOS when the PATH binary is old or unavailable", () => {
  const paths = []
  const result = findOpenCode({}, { env: {}, home: "/example/home", platform: "darwin", runner: (file) => {
    paths.push(file)
    return file === "opencode" ? "1.3.0" : "opencode v2.2.2"
  } })
  assert.equal(result, "/Applications/OpenCode.app/Contents/Resources/opencode-cli")
  assert.equal(paths.length, 2)
})

test("an explicit CLI selection is respected and unsupported versions are rejected", () => {
  const args = { env: {}, home: "/example", platform: "linux" }
  for (const version of ["2.1.4", "1.3.0", "3.0.0", "invalid"]) {
    assert.throws(() => findOpenCode({ binary: "/chosen" }, { ...args, runner: () => version }), /OpenCode 2.2.0/)
  }
  assert.equal(findOpenCode({}, { ...args, env: { OPENCODE_BIN: "/selected" }, runner: (file) => {
    assert.equal(file, "/selected")
    return "opencode v2.2.0"
  } }), "/selected")
})

test("configuration directory honors custom and XDG locations", () => {
  assert.equal(configDirectory({}, "/example/home"), "/example/home/.config/opencode")
  assert.equal(configDirectory({ XDG_CONFIG_HOME: "/xdg" }, "/example/home"), "/xdg/opencode")
  assert.equal(configDirectory({ OPENCODE_CONFIG_DIR: "/custom", XDG_CONFIG_HOME: "/xdg" }, "/example/home"), "/custom")
})

function harness(plugins, argv = [], failureTarget) {
  const calls = [], logs = []
  const active = [...plugins]
  let backups = 0
  const options = {
    argv, env: {}, home: "/example/home", platform: "linux", panelTarget: target,
    runner: (binary, args, opts) => {
      calls.push({ binary, args, options: opts })
      if (args[0] === "--version") return "opencode v2.2.2"
      if (args[0] === "api") return JSON.stringify(args[2] === "/api/config"
        ? [{ type: "document", info: { plugins: active.map((p) => p.source.target ?? p.source.path) } }]
        : active)
      if (args[2] === failureTarget) throw new Error("simulated network failure")
      active.push(args[2] === "@slkiser/opencode-quota@6"
        ? { ...backend, source: { ...backend.source, target: args[2] } }
        : { ...panel, source: { type: "package", target: args[2], version: "0.1.1" } })
      return "Installed"
    },
    backup: async () => { backups++; return [] },
    log: (text) => logs.push(text),
  }
  return { options, calls, logs, backups: () => backups }
}

test("installer uses only supported commands and a neutral working directory", async () => {
  const h = harness([])
  await install(h.options)
  assert.deepEqual(h.calls.map((call) => call.args), [
    ["--version"], ["api", "get", "/api/config"], ["api", "get", "/api/plugin"],
    ["plugin", "add", "@slkiser/opencode-quota@6"], ["plugin", "add", target],
    ["api", "get", "/api/config"], ["api", "get", "/api/plugin"],
  ])
  assert.ok(h.calls.every((call) => call.options.cwd === "/example/home"))
  assert.equal(h.backups(), 1)
})

test("dry run performs no plugin writes or configuration backup", async () => {
  const h = harness([], ["--dry-run"])
  await install(h.options)
  assert.ok(h.calls.every((call) => call.args[0] !== "plugin"))
  assert.equal(h.backups(), 0)
  assert.ok(h.logs.some((line) => line.startsWith("Dry run:")))
})

test("an installed compatible pair is a no-op", async () => {
  const h = harness([backend, panel])
  await install(h.options)
  assert.equal(h.backups(), 0)
  assert.ok(h.calls.every((call) => call.args[0] !== "plugin"))
})

test("backend install failure stops before the panel is added", async () => {
  const h = harness([], [], "@slkiser/opencode-quota@6")
  await assert.rejects(install(h.options), /simulated network failure/)
  assert.equal(h.calls.filter((call) => call.args[0] === "plugin").length, 1)
})

test("panel installation failure is reported without claiming success or undoing the backend", async () => {
  const h = harness([], [], target)
  await assert.rejects(install(h.options), /simulated network failure/)
  assert.deepEqual(h.calls.filter((call) => call.args[0] === "plugin").map((call) => call.args[2]), ["@slkiser/opencode-quota@6", target])
  assert.ok(!h.logs.some((line) => line.startsWith("Both quota plugins are installed")))
})

test("the default Git target is pinned to the installer's package version", async () => {
  const h = harness([backend])
  delete h.options.panelTarget
  await install(h.options)
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(h.calls.find((call) => call.args[0] === "plugin").args[2], `github:bajszi72/opencode-kvota-panel#v${manifest.version}`)
})

test("Git installation never triggers npm's build/dependency preparation path", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(manifest.workspaces, undefined)
  // Pacote installs development dependencies for Git packages with any of these keys,
  // even though our package already contains a complete prebuilt GUI.
  for (const key of ["postinstall", "build", "preinstall", "install", "prepack", "prepare"])
    assert.equal(manifest.scripts?.[key], undefined, key)
  assert.ok(manifest.files.includes("gui-experimental.cjs"))
  assert.ok(manifest.files.includes("install.mjs"))
})

test("inventory failure stops before backup or installation", async () => {
  const h = harness([])
  const original = h.options.runner
  h.options.runner = (...args) => args[1][0] === "api" ? "{}" : original(...args)
  await assert.rejects(install(h.options), /Unexpected configuration inventory/)
  assert.equal(h.backups(), 0)
})

test("a cached backend still loading at service startup is not mistaken for a missing dependency", async () => {
  let reads = 0, waits = 0
  const result = await readInventory("opencode", { cwd: "/example/home" }, {
    runner: (_binary, args) => JSON.stringify(args[2] === "/api/config"
      ? [{ type: "document", info: { plugins: [backend.source.target] } }]
      : (++reads === 1 ? [] : [backend])),
    pause: async () => { waits++ }, attempts: 3,
  })
  assert.deepEqual(result, [backend])
  assert.equal(waits, 1)
})

test("post-install checks wait for the requested panel even if the config view is briefly stale", async () => {
  let reads = 0
  const installedPanel = { ...panel, source: { type: "package", target } }
  const result = await readInventory("opencode", { cwd: "/example/home" }, {
    expectedTargets: [target],
    runner: (_binary, args) => JSON.stringify(args[2] === "/api/config" ? [] : (++reads === 1 ? [] : [installedPanel])),
    pause: async () => {}, attempts: 3,
  })
  assert.deepEqual(result, [installedPanel])
})

test("readiness timeout stops instead of creating duplicate plugin entries", async () => {
  await assert.rejects(readInventory("opencode", { cwd: "/example/home" }, {
    runner: (_binary, args) => JSON.stringify(args[2] === "/api/config"
      ? [{ type: "document", info: { plugins: [backend.source.target] } }] : []),
    pause: async () => {}, attempts: 2,
  }), /still loading or disabled/)
})

test("help neither invokes OpenCode nor backs up configuration", async () => {
  const h = harness([], ["--help"])
  await install(h.options)
  assert.equal(h.calls.length, 0)
  assert.equal(h.backups(), 0)
})

test("JSONC is backed up byte for byte, with private permissions, without changing the original", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-installer-test-"))
  try {
    await mkdir(join(dir, ".opencode"))
    const content = '// preserve comments and unrelated settings\n{"plugins": [], "model": "example/model",}\n'
    const source = join(dir, "opencode.jsonc")
    await writeFile(source, content)
    const first = await backupConfiguration(dir)
    const second = await backupConfiguration(dir)
    assert.equal(first.length, 1)
    assert.notEqual(first[0], second[0])
    assert.equal(await readFile(first[0], "utf8"), content)
    assert.equal(await readFile(source, "utf8"), content)
    if (process.platform !== "win32") assert.equal((await stat(first[0])).mode & 0o777, 0o600)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
