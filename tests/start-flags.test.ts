import { describe, expect, test } from "bun:test"

import { parseArgs } from "citty"

import { start } from "~/start"

const startArgs = start.args as NonNullable<Parameters<typeof parseArgs>[1]>

describe("start CLI boolean flags", () => {
  test("defaults setup flags on and prompting on", () => {
    const parsed = parseArgs([], startArgs)

    expect(parsed["claude-setup"]).toBe(true)
    expect(parsed["codex-setup"]).toBe(true)
    expect(parsed.prompt).toBe(true)
  })

  test("supports --no-* negation for setup and prompt flags", () => {
    const parsed = parseArgs(
      ["--no-claude-setup", "--no-codex-setup", "--no-prompt"],
      startArgs,
    )

    expect(parsed["claude-setup"]).toBe(false)
    expect(parsed["codex-setup"]).toBe(false)
    expect(parsed.prompt).toBe(false)
  })
})