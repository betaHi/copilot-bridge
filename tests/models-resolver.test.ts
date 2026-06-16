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

  test("maps 1m Claude snapshot aliases to the current base model id", () => {
    expect(resolveUpstreamModelId("claude-opus-4-6-1m-20260401", [])).toBe(
      "claude-opus-4.6",
    )
  })

  test("maps Claude opus 4.7 1M aliases to the base upstream id", () => {
    expect(resolveUpstreamModelId("claude-opus-4.7-1m", [])).toBe(
      "claude-opus-4.7",
    )
    expect(resolveUpstreamModelId("claude-opus-4-7-1m-internal", [])).toBe(
      "claude-opus-4.7",
    )
  })

  test("maps Claude opus 4.8 1M display aliases to the base upstream id", () => {
    expect(resolveUpstreamModelId("claude-opus-4.8-1m", [])).toBe(
      "claude-opus-4.8",
    )
    expect(resolveUpstreamModelId("claude-opus-4.8-[1m]", [])).toBe(
      "claude-opus-4.8",
    )
    expect(resolveUpstreamModelId("claude-opus-4-8-1m", [])).toBe(
      "claude-opus-4.8",
    )
  })

  test("normalizes Claude snapshot aliases even when the date suffix is omitted", () => {
    expect(resolveUpstreamModelId("claude-sonnet-4-6", [])).toBe(
      "claude-sonnet-4.6",
    )
  })

  test("does not upcast retired Claude major-only ids to a newer minor", () => {
    const models: Array<Model> = [
      {
        id: "claude-sonnet-4.6",
        name: "Claude Sonnet 4.6",
        object: "model",
        vendor: "Anthropic",
        version: "1",
        preview: false,
        model_picker_enabled: true,
        capabilities: {
          family: "claude-sonnet-4.6",
          limits: {},
          object: "model_capabilities",
          supports: { tool_calls: true },
          tokenizer: "o200k_base",
          type: "chat",
        },
      },
    ]

    expect(resolveUpstreamModelId("claude-sonnet-4", models)).toBe(
      "claude-sonnet-4",
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

  test("does not upcast an exact GPT minor version to a different available minor", () => {
    const models: Array<Model> = [
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        object: "model",
        vendor: "OpenAI",
        version: "1",
        preview: false,
        model_picker_enabled: true,
        capabilities: {
          family: "gpt-5.4",
          limits: {},
          object: "model_capabilities",
          supports: { tool_calls: true },
          tokenizer: "o200k_base",
          type: "chat",
        },
      },
    ]

    expect(resolveUpstreamModelId("gpt-5.2", models)).toBe("gpt-5.2")
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