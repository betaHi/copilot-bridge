import { describe, expect, test } from "bun:test"

import {
  clampReasoningEffort,
  getModelCapability,
  resolveModelId,
} from "~/lib/model-capabilities"

describe("model-capabilities: alias + capability lookup", () => {
  test("gemini aliases resolve to canonical preview ids", () => {
    expect(resolveModelId("gemini-3.1-pro")).toBe("gemini-3.1-pro-preview")
    expect(resolveModelId("gemini-3-flash")).toBe("gemini-3-flash-preview")
  })

  test("unknown model is returned unchanged", () => {
    expect(resolveModelId("totally-unknown")).toBe("totally-unknown")
  })

  test("GPT-5 family is true passthrough (no fallback flag)", () => {
    for (const id of ["gpt-5.4", "gpt-5.5", "gpt-5.3-codex", "gpt-5.4-mini"]) {
      const cap = getModelCapability(id)
      expect(cap).toBeDefined()
      expect(cap?.fallback).toBeUndefined()
    }
  })

  test("Claude/Gemini are flagged as chat-completions fallback", () => {
    for (const id of [
      "claude-opus-4.7",
      "claude-opus-4.6",
      "claude-opus-4.6-1m",
      "gemini-3.1-pro-preview",
      "gemini-3-flash-preview",
    ]) {
      expect(getModelCapability(id)?.fallback).toBe("chat-completions")
    }
  })

  test("claude-opus-4.7 places reasoning under output_config.effort", () => {
    expect(getModelCapability("claude-opus-4.7")?.reasoningField).toBe(
      "output_config.effort",
    )
  })
})

describe("model-capabilities: clampReasoningEffort", () => {
  test("returns undefined for models without reasoning support (gemini)", () => {
    expect(clampReasoningEffort("gemini-3-flash-preview", "high")).toBeUndefined()
  })

  test("supported value passes through unchanged", () => {
    expect(clampReasoningEffort("gpt-5.5", "xhigh")).toEqual({
      effort: "xhigh",
      changed: false,
    })
  })

  test("undefined falls back to default without changed flag", () => {
    expect(clampReasoningEffort("gpt-5.4", undefined)).toEqual({
      effort: "medium",
      changed: false,
    })
  })

  test("unsupported effort clamps to nearest higher supported value", () => {
    // gpt-5.4-mini supports none/low/medium; "high" should clamp to medium.
    const out = clampReasoningEffort("gpt-5.4-mini", "high")
    expect(out?.effort).toBe("medium")
    expect(out?.changed).toBe(true)
    expect(out?.reason).toBe("unsupported-effort")
  })

  test("claude-opus-4.7 accepts max", () => {
    expect(clampReasoningEffort("claude-opus-4.7", "max")).toEqual({
      effort: "max",
      changed: false,
    })
  })
})
