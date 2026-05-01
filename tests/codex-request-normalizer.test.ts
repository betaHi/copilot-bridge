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

  test("rewrites public Claude opus 4.7 1M alias to upstream model id", () => {
    const out = normalizeCodexResponsesRequest({
      model: "claude-opus-4.7-1m",
      reasoning: { effort: "high" },
    } as never) as { model: string; reasoning?: { effort?: string } }

    expect(out.model).toBe("claude-opus-4.7-1m-internal")
    expect(out.reasoning?.effort).toBe("high")
  })

  test("routes base Claude opus 4.7 to reasoning variants for Codex efforts", () => {
    const high = normalizeCodexResponsesRequest({
      model: "claude-opus-4.7",
      reasoning: { effort: "high" },
    } as never) as { model: string; reasoning?: { effort?: string } }
    const xhigh = normalizeCodexResponsesRequest({
      model: "claude-opus-4.7",
      reasoning: { effort: "xhigh" },
    } as never) as { model: string; reasoning?: { effort?: string } }
    const max = normalizeCodexResponsesRequest({
      model: "claude-opus-4.7",
      reasoning: { effort: "max" },
    } as never) as { model: string; reasoning?: { effort?: string } }

    expect(high.model).toBe("claude-opus-4.7-high")
    expect(high.reasoning?.effort).toBe("high")
    expect(xhigh.model).toBe("claude-opus-4.7-xhigh")
    expect(xhigh.reasoning?.effort).toBe("xhigh")
    expect(max.model).toBe("claude-opus-4.7-xhigh")
    expect(max.reasoning?.effort).toBe("xhigh")
  })

  test("strips reasoning for models without reasoning support (gemini)", () => {
    const out = normalizeCodexResponsesRequest({
      model: "gemini-3-flash-preview",
      reasoning: { effort: "high" },
    } as never) as Record<string, unknown>
    expect(out.reasoning).toBeUndefined()
  })

  test("does not infer reasoning effort when omitted", () => {
    const out = normalizeCodexResponsesRequest({
      model: "gpt-5.4",
      input: "hello",
    } as never) as { reasoning?: { effort?: string } }

    expect(out.reasoning).toBeUndefined()
  })

  test("preserves reasoning metadata without adding effort when effort is omitted", () => {
    const out = normalizeCodexResponsesRequest({
      model: "gpt-5.4",
      reasoning: { summary: "auto" },
    } as never) as { reasoning?: { effort?: string; summary?: string } }

    expect(out.reasoning?.effort).toBeUndefined()
    expect(out.reasoning?.summary).toBe("auto")
  })

  test("strips null reasoning effort instead of forwarding it", () => {
    const out = normalizeCodexResponsesRequest({
      model: "gpt-5.4",
      reasoning: { effort: null, summary: "auto" },
    } as never) as { reasoning?: { effort?: string; summary?: string } }

    expect(out.reasoning?.effort).toBeUndefined()
    expect(out.reasoning?.summary).toBe("auto")
  })

  test("strips invalid reasoning shapes for reasoning-capable models", () => {
    const out = normalizeCodexResponsesRequest({
      model: "gpt-5.4",
      reasoning: "high",
    } as never) as { reasoning?: unknown }

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

  test("normalizes text verbosity even when reasoning effort is omitted", () => {
    const out = normalizeCodexResponsesRequest({
      model: "gpt-5.2-codex",
      text: { verbosity: "low", format: { type: "text" } },
    } as never) as {
      reasoning?: { effort?: string }
      text?: { verbosity?: string; format?: { type?: string } }
    }

    expect(out.reasoning).toBeUndefined()
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
