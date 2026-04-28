import { describe, expect, test } from "bun:test"

import { resolveUpstreamModelId } from "~/lib/models-resolver"
import type { Model } from "~/providers/copilot/get-models"

describe("models-resolver: Claude snapshot aliases", () => {
  test("maps claude-opus-4.6 snapshot ids to the canonical model id", () => {
    expect(resolveUpstreamModelId("claude-opus-4-6-20260401", [])).toBe(
      "claude-opus-4.6",
    )
  })

  test("maps claude-sonnet-4.6 snapshot ids to the canonical model id", () => {
    expect(resolveUpstreamModelId("claude-sonnet-4-6-20260401", [])).toBe(
      "claude-sonnet-4.6",
    )
  })

  test("preserves 1m Claude snapshot aliases", () => {
    expect(resolveUpstreamModelId("claude-opus-4-6-1m-20260401", [])).toBe(
      "claude-opus-4.6-1m",
    )
  })

  test("normalizes Claude snapshot aliases even when the date suffix is omitted", () => {
    expect(resolveUpstreamModelId("claude-sonnet-4-6", [])).toBe(
      "claude-sonnet-4.6",
    )
  })

  test("leaves malformed Claude snapshot ids unchanged", () => {
    expect(resolveUpstreamModelId("claude-opus-4-20260401", [])).toBe(
      "claude-opus-4-20260401",
    )
    expect(resolveUpstreamModelId("claude-opus-4-x-20260401", [])).toBe(
      "claude-opus-4-x-20260401",
    )
  })

  test("prefers an exact upstream model match over canonical alias fallback", () => {
    const models: Array<Model> = [
      {
        id: "claude-opus-4-6-20260401",
        name: "Claude Opus 4.6 Snapshot",
        object: "model",
        vendor: "Anthropic",
        version: "1",
        preview: false,
        model_picker_enabled: true,
        capabilities: {
          family: "claude-opus-4.6",
          limits: {},
          object: "model_capabilities",
          supports: { tool_calls: true },
          tokenizer: "o200k_base",
          type: "chat",
        },
      },
      {
        id: "claude-opus-4.6",
        name: "Claude Opus 4.6",
        object: "model",
        vendor: "Anthropic",
        version: "1",
        preview: false,
        model_picker_enabled: true,
        capabilities: {
          family: "claude-opus-4.6",
          limits: {},
          object: "model_capabilities",
          supports: { tool_calls: true },
          tokenizer: "o200k_base",
          type: "chat",
        },
      },
    ]

    expect(resolveUpstreamModelId("claude-opus-4-6-20260401", models)).toBe(
      "claude-opus-4-6-20260401",
    )
  })

  test("does not upcast an exact Claude version to a different available minor version", () => {
    const models: Array<Model> = [
      {
        id: "claude-opus-4.7",
        name: "Claude Opus 4.7",
        object: "model",
        vendor: "Anthropic",
        version: "1",
        preview: false,
        model_picker_enabled: true,
        capabilities: {
          family: "claude-opus-4.7",
          limits: {},
          object: "model_capabilities",
          supports: { tool_calls: true },
          tokenizer: "o200k_base",
          type: "chat",
        },
      },
    ]

    expect(resolveUpstreamModelId("claude-opus-4-6-20260401", models)).toBe(
      "claude-opus-4.6",
    )
  })

  test("uses an advertised snapshot id when only snapshot ids are available upstream", () => {
    const models: Array<Model> = [
      {
        id: "claude-opus-4-6-20260401",
        name: "Claude Opus 4.6 Snapshot",
        object: "model",
        vendor: "Anthropic",
        version: "1",
        preview: false,
        model_picker_enabled: true,
        capabilities: {
          family: "claude-opus-4.6",
          limits: {},
          object: "model_capabilities",
          supports: { tool_calls: true },
          tokenizer: "o200k_base",
          type: "chat",
        },
      },
    ]

    expect(resolveUpstreamModelId("claude-opus-4.6", models)).toBe(
      "claude-opus-4-6-20260401",
    )
  })
})