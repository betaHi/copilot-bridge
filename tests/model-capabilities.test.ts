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

  test("claude-opus 1M display aliases resolve to base upstream ids", () => {
    expect(resolveModelId("claude-opus-4.6-1m")).toBe("claude-opus-4.6")
    expect(resolveModelId("claude-opus-4.6-[1m]")).toBe("claude-opus-4.6")
    expect(resolveModelId("claude-opus-4.7-1m")).toBe("claude-opus-4.7")
    expect(resolveModelId("claude-opus-4.7-[1m]")).toBe("claude-opus-4.7")
    expect(resolveModelId("claude-opus-4.7-1m-internal")).toBe(
      "claude-opus-4.7",
    )
    expect(resolveModelId("claude-opus-4.8-1m")).toBe("claude-opus-4.8")
    expect(resolveModelId("claude-opus-4.8-[1m]")).toBe("claude-opus-4.8")
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

  test("GPT chat tool+reasoning workaround is model-specific", () => {
    expect(
      getModelCapability("gpt-5.4")?.requiresResponsesForChatReasoningTools,
    ).toBe(true)

    for (const id of ["gpt-5.5", "gpt-5.3-codex", "gpt-5-mini"]) {
      expect(
        getModelCapability(id)?.requiresResponsesForChatReasoningTools,
      ).toBeUndefined()
    }
  })

  test("Claude/Gemini are flagged as chat-completions fallback", () => {
    for (const id of [
      "claude-opus-4.7",
      "claude-opus-4.7-1m-internal",
      "claude-opus-4.7-1m",
      "claude-opus-4.8",
      "claude-opus-4.6",
      "claude-opus-4.6-1m",
      "gemini-3.1-pro-preview",
      "gemini-3-flash-preview",
    ]) {
      expect(getModelCapability(id)?.fallback).toBe("chat-completions")
    }
  })

  test("claude-opus-4.7 family places reasoning under output_config.effort", () => {
    for (const id of [
      "claude-opus-4.7",
      "claude-opus-4.7-1m-internal",
      "claude-opus-4.7-1m",
      "claude-opus-4.7-[1m]",
    ]) {
      expect(getModelCapability(id)?.reasoningField).toBe(
        "output_config.effort",
      )
    }
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

  test("Codex CLI minimal effort maps to the lowest upstream effort", () => {
    expect(clampReasoningEffort("gpt-5.4", "minimal")).toEqual({
      effort: "low",
      changed: true,
      reason: "unsupported-effort",
    })
  })

  test("claude-opus-4.7 supports low through max efforts", () => {
    expect(clampReasoningEffort("claude-opus-4.7", "low")).toEqual({
      effort: "low",
      changed: false,
    })
    expect(clampReasoningEffort("claude-opus-4.7", "high")).toEqual({
      effort: "high",
      changed: false,
    })
    expect(clampReasoningEffort("claude-opus-4.7", "xhigh")).toEqual({
      effort: "xhigh",
      changed: false,
    })
    expect(clampReasoningEffort("claude-opus-4.7", "max")).toEqual({
      effort: "max",
      changed: false,
    })
  })

  test("claude 4.6 family supports max but not xhigh", () => {
    for (const model of [
      "claude-opus-4.6",
      "claude-opus-4.6-1m",
      "claude-sonnet-4.6",
    ]) {
      expect(clampReasoningEffort(model, "max")).toEqual({
        effort: "max",
        changed: false,
      })
      expect(clampReasoningEffort(model, "xhigh")).toEqual({
        effort: "max",
        changed: true,
        reason: "unsupported-effort",
      })
    }
  })

  test("claude-opus-4.8 supports its live upstream effort range", () => {
    expect(clampReasoningEffort("claude-opus-4.8", undefined)).toEqual({
      effort: "medium",
      changed: false,
    })
    expect(clampReasoningEffort("claude-opus-4.8", "high")).toEqual({
      effort: "high",
      changed: false,
    })
    expect(clampReasoningEffort("claude-opus-4.8", "xhigh")).toEqual({
      effort: "xhigh",
      changed: false,
    })
    expect(clampReasoningEffort("claude-opus-4.8", "max")).toEqual({
      effort: "max",
      changed: false,
    })
    expect(clampReasoningEffort("claude-opus-4.8", "none")).toEqual({
      effort: "low",
      changed: true,
      reason: "unsupported-effort",
    })
  })

  test("retired claude-opus-4.7 fixed-effort ids are no longer supported aliases", () => {
    expect(resolveModelId("claude-opus-4.7-high")).toBe(
      "claude-opus-4.7-high",
    )
    expect(resolveModelId("claude-opus-4.7-xhigh")).toBe(
      "claude-opus-4.7-xhigh",
    )
    expect(getModelCapability("claude-opus-4.7-high")).toBeUndefined()
    expect(getModelCapability("claude-opus-4.7-xhigh")).toBeUndefined()
  })

  test("retired claude-sonnet-4 id is no longer a supported alias", () => {
    expect(resolveModelId("claude-sonnet-4")).toBe("claude-sonnet-4")
    expect(getModelCapability("claude-sonnet-4")).toBeUndefined()
  })

  test("claude-opus-4.7 1M keeps its default effort", () => {
    expect(clampReasoningEffort("claude-opus-4.7-1m", undefined)).toEqual({
      effort: "medium",
      changed: false,
    })
  })

  test("claude-opus-4.7 effort variants clamp to advertised upstream efforts", () => {
    expect(clampReasoningEffort("claude-opus-4.7-1m", "max")).toEqual({
      effort: "max",
      changed: false,
    })
  })
})
