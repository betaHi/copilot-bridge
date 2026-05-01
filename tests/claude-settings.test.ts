import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { applyClaudeConfig } from "~/lib/claude-settings"

const tmpDirs: Array<string> = []

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

const makeSettingsPath = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "claude-settings-"))
  tmpDirs.push(dir)
  return path.join(dir, "settings.json")
}

describe("applyClaudeConfig", () => {
  test("preserves existing ANTHROPIC_MODEL", async () => {
    const configPath = await makeSettingsPath()
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          env: {
            ANTHROPIC_BASE_URL: "http://127.0.0.1:1111",
            ANTHROPIC_AUTH_TOKEN: "custom",
            ANTHROPIC_MODEL: "claude-sonnet-4.6",
          },
        },
        null,
        2,
      )}\n`,
    )

    await applyClaudeConfig({
      baseUrl: "http://127.0.0.1:4142",
      configPath,
    })

    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      env: Record<string, string>
    }

    expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4142")
    expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe("custom")
    expect(parsed.env.ANTHROPIC_MODEL).toBe("claude-sonnet-4.6")
  })
})