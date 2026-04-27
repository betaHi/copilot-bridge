import { describe, expect, test } from "bun:test"

import type { ChatCompletionsPayload } from "~/providers/copilot/chat-types"
import type { Model } from "~/providers/copilot/get-models"
import { getTokenCount } from "~/lib/tokenizer"

const fakeModel = (tokenizer: string): Model => ({
  id: "claude-opus-4.7",
  name: "Claude Opus 4.7",
  object: "model",
  vendor: "Anthropic",
  version: "1",
  preview: false,
  model_picker_enabled: true,
  capabilities: {
    family: "claude-opus-4.7",
    object: "model_capabilities",
    tokenizer,
    type: "chat",
    limits: {},
    supports: { tool_calls: true },
  },
})

describe("getTokenCount", () => {
  test("returns positive input tokens for a text-only message using o200k_base", async () => {
    const payload: ChatCompletionsPayload = {
      model: "claude-opus-4.7",
      messages: [
        {
          role: "user",
          content: "Hello world from copilot-bridge tokenizer test",
        },
      ],
    }

    const result = await getTokenCount(payload, fakeModel("o200k_base"))
    expect(result.input).toBeGreaterThan(5)
    expect(result.output).toBe(0)
  })

  test("counts assistant messages as output tokens", async () => {
    const payload: ChatCompletionsPayload = {
      model: "claude-opus-4.7",
      messages: [
        { role: "user", content: "Question" },
        { role: "assistant", content: "Answer goes here" },
      ],
    }

    const result = await getTokenCount(payload, fakeModel("o200k_base"))
    expect(result.input).toBeGreaterThan(0)
    expect(result.output).toBeGreaterThan(0)
  })

  test("includes tool definitions in input token count", async () => {
    const base: ChatCompletionsPayload = {
      model: "claude-opus-4.7",
      messages: [{ role: "user", content: "Use a tool" }],
    }

    const withoutTools = await getTokenCount(base, fakeModel("o200k_base"))
    const withTools = await getTokenCount(
      {
        ...base,
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Look up the weather",
              parameters: {
                type: "object",
                properties: {
                  city: { type: "string", description: "Target city" },
                },
              },
            },
          },
        ],
      },
      fakeModel("o200k_base"),
    )

    expect(withTools.input).toBeGreaterThan(withoutTools.input)
  })
})
