import { describe, expect, test } from "bun:test"

import { normalizeCodexResponsesRequest } from "~/bridges/codex/responses"

describe("codex /v1/responses request normalizer", () => {
  test("rewrites alias to canonical model id", () => {
    const out = normalizeCodexResponsesRequest({
      model: "gemini-3.1-pro",
      stream: false,
    } as never)
    expect(out.model).toBe("gemini-3.1-pro-preview")
  })

  test("strips reasoning for models without reasoning support (gemini)", () => {
    const out = normalizeCodexResponsesRequest({
      model: "gemini-3-flash-preview",
      reasoning: { effort: "high" },
    } as never) as Record<string, unknown>
    expect(out.reasoning).toBeUndefined()
  })

  test("clamps unsupported effort and preserves other reasoning fields", () => {
    const out = normalizeCodexResponsesRequest({
      model: "gpt-5.4-mini",
      reasoning: { effort: "xhigh", summary: "auto" },
    } as never) as { reasoning?: { effort?: string; summary?: string } }
    expect(out.reasoning?.effort).toBe("medium")
    expect(out.reasoning?.summary).toBe("auto")
  })

  test("accepts Codex CLI minimal effort and maps it to the lowest upstream effort", () => {
    const out = normalizeCodexResponsesRequest({
      model: "gpt-5.4",
      reasoning: { effort: "minimal", summary: "auto" },
    } as never) as { reasoning?: { effort?: string; summary?: string } }

    expect(out.reasoning?.effort).toBe("low")
    expect(out.reasoning?.summary).toBe("auto")
  })

  test("clamps unsupported Codex text verbosity and preserves text fields", () => {
    const out = normalizeCodexResponsesRequest({
      model: "gpt-5.2-codex",
      reasoning: { effort: "medium", summary: "auto" },
      text: { verbosity: "low", format: { type: "text" } },
    } as never) as {
      reasoning?: { effort?: string; summary?: string }
      text?: { verbosity?: string; format?: { type?: string } }
    }

    expect(out.reasoning?.effort).toBe("medium")
    expect(out.reasoning?.summary).toBe("auto")
    expect(out.text?.verbosity).toBe("medium")
    expect(out.text?.format?.type).toBe("text")
  })

  test("leaves unknown model untouched (no capability match)", () => {
    const out = normalizeCodexResponsesRequest({
      model: "totally-unknown",
      reasoning: { effort: "high" },
    } as never) as { model: string; reasoning?: { effort?: string } }
    expect(out.model).toBe("totally-unknown")
    expect(out.reasoning?.effort).toBe("high")
  })
})
