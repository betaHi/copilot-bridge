import { describe, expect, test } from "bun:test"

import {
  buildClaudeLaunchCommand,
  pickClaudeLaunchDefaults,
} from "~/lib/claude-launch"

describe("pickClaudeLaunchDefaults", () => {
  test("prefers the caller's existing model when it is available", () => {
    expect(
      pickClaudeLaunchDefaults(
        ["gpt-5.3-codex", "gpt-5.4-mini", "claude-haiku-4.5"],
        "claude-haiku-4.5",
      ),
    ).toEqual({ model: "claude-haiku-4.5" })
  })

  test("falls back to stable defaults when no preferred model is available", () => {
    expect(
      pickClaudeLaunchDefaults(["gpt-5.3-codex", "gpt-5.4-mini"], "missing"),
    ).toEqual({ model: "gpt-5.3-codex" })
  })

  test("handles empty model lists without throwing", () => {
    expect(pickClaudeLaunchDefaults([], undefined)).toEqual({
      model: "gpt-5.3-codex",
    })
  })
})

describe("buildClaudeLaunchCommand", () => {
  test("builds a one-shot Claude launch command with an explicit model", () => {
    const command = buildClaudeLaunchCommand({
      baseUrl: "http://127.0.0.1:4142",
      model: "gpt-5.3-codex",
    })

    expect(command).toContain("ANTHROPIC_BASE_URL='http://127.0.0.1:4142'")
    expect(command).toContain("ANTHROPIC_AUTH_TOKEN='dummy'")
    expect(command).toContain("DISABLE_NON_ESSENTIAL_MODEL_CALLS='1'")
    expect(command).toEndWith("&& claude --model 'gpt-5.3-codex'")
  })

  test("quotes shell-sensitive values safely", () => {
    const command = buildClaudeLaunchCommand({
      baseUrl: "http://127.0.0.1:4142/o'hare",
      model: "model'one",
    })

    expect(command).toContain("ANTHROPIC_BASE_URL='http://127.0.0.1:4142/o'\\''hare'")
    expect(command).toEndWith("&& claude --model 'model'\\''one'")
  })
})