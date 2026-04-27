import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import {
  applyCodexConfig,
  readCodexUserConfig,
  readCodexUserConfigFromDisk,
} from "~/lib/codex-config"
import type { CodexDefaults } from "~/lib/defaults"

const baseSettings: CodexDefaults = {
  providerId: "bridge",
  providerName: "Copilot Bridge",
  setAsDefault: true,
  configPath: "/tmp/unused",
}

const tmpDirs: Array<string> = []
afterEach(async () => {
  // best-effort cleanup; tmp files are tiny
  while (tmpDirs.length > 0) tmpDirs.pop()
})

const makeConfigPath = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-cfg-"))
  tmpDirs.push(dir)
  return path.join(dir, "config.toml")
}

describe("readCodexUserConfig", () => {
  test("parses model + reasoning effort from top section", () => {
    const out = readCodexUserConfig(`model = "claude-opus-4.7"
model_reasoning_effort = "high"

[other]
foo = 1
`)
    expect(out.model).toBe("claude-opus-4.7")
    expect(out.modelReasoningEffort).toBe("high")
  })

  test("ignores values inside the managed block", () => {
    const out = readCodexUserConfig(`# >>> copilot-bridge managed (do not edit) >>>
model_provider = "bridge"
model = "should-be-ignored"
# <<< copilot-bridge managed (do not edit) <<<
`)
    expect(out.model).toBeUndefined()
  })

  test("ignores keys appearing inside [tables]", () => {
    const out = readCodexUserConfig(`[model_providers.bridge]
model = "not-a-top-level"
`)
    expect(out.model).toBeUndefined()
  })

  test("returns empty object when file is empty", () => {
    expect(readCodexUserConfig("")).toEqual({})
  })
})

describe("applyCodexConfig", () => {
  test("creates fresh file with only managed block when no model passed", async () => {
    const p = await makeConfigPath()
    const r = await applyCodexConfig({
      configPath: p,
      baseUrl: "http://127.0.0.1:4242/v1",
      settings: baseSettings,
    })
    expect(r.created).toBe(true)
    expect(r.changed).toBe(true)
    const content = await readFile(p, "utf8")
    expect(content).toContain('model_provider = "bridge"')
    expect(content).toContain("[model_providers.bridge]")
    expect(content).toContain("prefer_websockets = false")
    // model is NOT inside the managed block anymore
    const managedStart = content.indexOf(">>> copilot-bridge managed")
    const managedEnd = content.indexOf("<<< copilot-bridge managed")
    expect(content.slice(managedStart, managedEnd)).not.toMatch(/^model = /m)
  })

  test("writes model + effort into user-owned area, not managed block", async () => {
    const p = await makeConfigPath()
    await applyCodexConfig({
      configPath: p,
      baseUrl: "http://127.0.0.1:4242/v1",
      settings: baseSettings,
      model: "claude-opus-4.7",
      modelReasoningEffort: "high",
    })
    const content = await readFile(p, "utf8")
    expect(content).toMatch(/^model = "claude-opus-4\.7"$/m)
    expect(content).toMatch(/^model_reasoning_effort = "high"$/m)
    const managedStart = content.indexOf(">>> copilot-bridge managed")
    expect(content.slice(0, managedStart)).toContain('model = "claude-opus-4.7"')
  })

  test("preserves user's pre-existing top-level keys when adding managed block", async () => {
    const p = await makeConfigPath()
    await writeFile(
      p,
      `model = "user-pinned"
model_reasoning_effort = "max"

[history]
persistence = "save-all"
`,
    )
    await applyCodexConfig({
      configPath: p,
      baseUrl: "http://127.0.0.1:4242/v1",
      settings: baseSettings,
      // do not pass model — user's choice must survive
    })
    const content = await readFile(p, "utf8")
    expect(content).toMatch(/^model = "user-pinned"$/m)
    expect(content).toMatch(/^model_reasoning_effort = "max"$/m)
    expect(content).toContain("[history]")
    expect(content).toContain('persistence = "save-all"')
    expect(content).toContain("model_provider = \"bridge\"")
  })

  test("idempotent — running twice with same input does not change file", async () => {
    const p = await makeConfigPath()
    const first = await applyCodexConfig({
      configPath: p,
      baseUrl: "http://127.0.0.1:4242/v1",
      settings: baseSettings,
      model: "gpt-5.3-codex",
    })
    expect(first.changed).toBe(true)
    const second = await applyCodexConfig({
      configPath: p,
      baseUrl: "http://127.0.0.1:4242/v1",
      settings: baseSettings,
      model: "gpt-5.3-codex",
    })
    expect(second.changed).toBe(false)
  })

  test("updates existing top-level model in place rather than duplicating", async () => {
    const p = await makeConfigPath()
    await applyCodexConfig({
      configPath: p,
      baseUrl: "http://127.0.0.1:4242/v1",
      settings: baseSettings,
      model: "gpt-5.3-codex",
    })
    await applyCodexConfig({
      configPath: p,
      baseUrl: "http://127.0.0.1:4242/v1",
      settings: baseSettings,
      model: "claude-opus-4.7",
    })
    const content = await readFile(p, "utf8")
    const matches = content.match(/^model = "/gm) ?? []
    expect(matches).toHaveLength(1)
    expect(content).toContain('model = "claude-opus-4.7"')
  })

  test("readCodexUserConfigFromDisk on missing file returns empty object", async () => {
    const r = await readCodexUserConfigFromDisk("/tmp/definitely-missing-cfg.toml")
    expect(r).toEqual({})
  })

  test("upgrades file with legacy markers to new markers without duplicating", async () => {
    const p = await makeConfigPath()
    await writeFile(
      p,
      `model = "claude-opus-4.7"

# >>> copilot-bridge managed (do not edit) >>>
model_provider = "bridge"

[model_providers.bridge]
name = "Copilot Bridge"
base_url = "http://old/v1"
wire_api = "responses"
prefer_websockets = false
requires_openai_auth = false
# <<< copilot-bridge managed (do not edit) <<<
`,
    )
    await applyCodexConfig({
      configPath: p,
      baseUrl: "http://127.0.0.1:4242/v1",
      settings: baseSettings,
    })
    const content = await readFile(p, "utf8")
    // Old markers must be gone, new markers must appear exactly once.
    expect(content).not.toContain("# >>> copilot-bridge managed (do not edit)")
    const newBeginCount = (
      content.match(/copilot-bridge managed block — auto-generated/g) ?? []
    ).length
    expect(newBeginCount).toBe(1)
    expect(content).toContain("base_url = \"http://127.0.0.1:4242/v1\"")
    // User's top-level model survives the upgrade.
    expect(content).toMatch(/^model = "claude-opus-4\.7"$/m)
  })
})
