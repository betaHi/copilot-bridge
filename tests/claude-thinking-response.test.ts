import { describe, expect, test } from "bun:test"

import type { AnthropicStreamState } from "~/bridges/claude/anthropic-types"
import { translateToAnthropic } from "~/bridges/claude/non-stream-translation"
import { translateChunkToAnthropicEvents } from "~/bridges/claude/stream-translation"
import { MODEL_CAPABILITIES } from "~/lib/model-capabilities"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/providers/copilot/chat-types"
import {
  shouldUseResponsesApiForModel,
  translateResponsesStreamToChatCompletionStream,
  translateResponsesToChatCompletion,
} from "~/services/copilot/responses"

const modelIds = Array.from(
  new Set(
    MODEL_CAPABILITIES.flatMap((capability) => [
      capability.id,
      ...(capability.aliases ?? []),
    ]),
  ),
)

const reasoningFields = ["reasoning_text", "reasoning_content"] as const

const responsesOnlyModelIds = modelIds.filter((model) =>
  shouldUseResponsesApiForModel(model),
)

type ReasoningField = (typeof reasoningFields)[number]

const streamState = (): AnthropicStreamState => ({
  messageStartSent: false,
  contentBlockIndex: 0,
  contentBlockOpen: false,
  thinkingBlockOpen: false,
  toolCalls: {},
})

const nonStreamingResponse = (
  model: string,
  field: ReasoningField,
): ChatCompletionResponse => ({
  id: `chatcmpl-${model}-${field}`,
  object: "chat.completion",
  created: 1700000000,
  model,
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: `final text from ${model}`,
        [field]: `thinking from ${model} via ${field}`,
      },
      finish_reason: "stop",
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
})

const streamChunk = (
  model: string,
  field: ReasoningField,
  delta: Record<string, unknown>,
  finish_reason: ChatCompletionChunk["choices"][number]["finish_reason"] = null,
): ChatCompletionChunk => ({
  id: `chunk-${model}-${field}`,
  object: "chat.completion.chunk",
  created: 1700000000,
  model,
  choices: [
    {
      index: 0,
      delta: delta as ChatCompletionChunk["choices"][number]["delta"],
      finish_reason,
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
})

const collectResponseStreamChunks = async (
  responseEvents: AsyncIterable<{ data: string }>,
): Promise<Array<ChatCompletionChunk>> => {
  const chunks: Array<ChatCompletionChunk> = []
  for await (const rawEvent of translateResponsesStreamToChatCompletionStream(
    responseEvents,
  )) {
    if (!rawEvent.data || rawEvent.data === "[DONE]") continue
    chunks.push(JSON.parse(rawEvent.data) as ChatCompletionChunk)
  }

  return chunks
}

describe("Claude response thinking translation", () => {
  test("preserves non-streaming upstream reasoning for every supported model id and alias", () => {
    for (const model of modelIds) {
      for (const field of reasoningFields) {
        const translated = translateToAnthropic(nonStreamingResponse(model, field))

        expect(translated.model).toBe(model)
        expect(translated.content).toEqual([
          {
            type: "thinking",
            thinking: `thinking from ${model} via ${field}`,
          },
          { type: "text", text: `final text from ${model}` },
        ])
      }
    }
  })

  test("emits streaming thinking before text for every supported model id and alias", () => {
    for (const model of modelIds) {
      for (const field of reasoningFields) {
        const state = streamState()
        const events = [
          ...translateChunkToAnthropicEvents(
            streamChunk(model, field, {
              role: "assistant",
              [field]: `stream thinking from ${model} via ${field}`,
            }),
            state,
          ),
          ...translateChunkToAnthropicEvents(
            streamChunk(model, field, { content: `stream text from ${model}` }),
            state,
          ),
          ...translateChunkToAnthropicEvents(
            streamChunk(model, field, {}, "stop"),
            state,
          ),
        ]

        expect(events).toContainEqual({
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        })
        expect(events).toContainEqual({
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: `stream thinking from ${model} via ${field}`,
          },
        })
        expect(events).toContainEqual({ type: "content_block_stop", index: 0 })
        expect(events).toContainEqual({
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "" },
        })
        expect(events).toContainEqual({
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: `stream text from ${model}` },
        })
        expect(events.at(-1)).toEqual({ type: "message_stop" })
      }
    }
  })

  test("closes a streaming thinking block before starting a tool_use block", () => {
    const state = streamState()
    const events = [
      ...translateChunkToAnthropicEvents(
        streamChunk("claude-opus-4.7", "reasoning_text", {
          role: "assistant",
          reasoning_text: "need a tool",
        }),
        state,
      ),
      ...translateChunkToAnthropicEvents(
        streamChunk("claude-opus-4.7", "reasoning_text", {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "lookup_docs", arguments: "" },
            },
          ],
        }),
        state,
      ),
      ...translateChunkToAnthropicEvents(
        streamChunk("claude-opus-4.7", "reasoning_text", {
          tool_calls: [
            { index: 0, function: { arguments: "{}" } },
          ],
        }),
        state,
      ),
      ...translateChunkToAnthropicEvents(
        streamChunk("claude-opus-4.7", "reasoning_text", {}, "tool_calls"),
        state,
      ),
    ]

    expect(events).toContainEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "need a tool" },
    })
    expect(events).toContainEqual({ type: "content_block_stop", index: 0 })
    expect(events).toContainEqual({
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "call_1",
        name: "lookup_docs",
        input: {},
      },
    })
    expect(events).toContainEqual({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: "{}" },
    })
    expect(events.at(-1)).toEqual({ type: "message_stop" })
  })

  test("preserves non-streaming Responses API reasoning summaries for every Responses-only model", () => {
    for (const model of responsesOnlyModelIds) {
      const chatResponse = translateResponsesToChatCompletion({
        id: `resp-${model}`,
        created_at: 1700000000,
        model,
        output: [
          {
            type: "reasoning",
            summary: [
              { type: "summary_text", text: `responses thinking from ${model}` },
            ],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: `responses text from ${model}` }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      })
      const translated = translateToAnthropic(chatResponse)

      expect(translated.content).toEqual([
        { type: "thinking", thinking: `responses thinking from ${model}` },
        { type: "text", text: `responses text from ${model}` },
      ])
    }
  })

  test("preserves streaming Responses API reasoning deltas for every Responses-only model", async () => {
    for (const model of responsesOnlyModelIds) {
      async function* responseEvents() {
        yield {
          data: JSON.stringify({
            type: "response.created",
            response: {
              id: `resp-stream-${model}`,
              created_at: 1700000000,
              model,
            },
          }),
        }
        yield {
          data: JSON.stringify({
            type: "response.reasoning_summary_text.delta",
            delta: `responses stream thinking from ${model}`,
          }),
        }
        yield {
          data: JSON.stringify({
            type: "response.output_text.delta",
            delta: `responses stream text from ${model}`,
          }),
        }
        yield {
          data: JSON.stringify({
            type: "response.completed",
            response: {
              id: `resp-stream-${model}`,
              created_at: 1700000000,
              model,
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [
                    { type: "output_text", text: `responses stream text from ${model}` },
                  ],
                },
              ],
              usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
            },
          }),
        }
        yield { data: "[DONE]" }
      }

      const state = streamState()
      const events = []
      for await (const rawEvent of translateResponsesStreamToChatCompletionStream(
        responseEvents(),
      )) {
        if (!rawEvent.data || rawEvent.data === "[DONE]") continue
        events.push(
          ...translateChunkToAnthropicEvents(JSON.parse(rawEvent.data), state),
        )
      }

      expect(events).toContainEqual({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "thinking_delta",
          thinking: `responses stream thinking from ${model}`,
        },
      })
      expect(events).toContainEqual({
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: `responses stream text from ${model}` },
      })
      expect(events.at(-1)).toEqual({ type: "message_stop" })
    }
  })

  test("uses Responses output_text.done as a fallback without duplicating deltas", async () => {
    async function* responseEvents() {
      yield {
        data: JSON.stringify({
          type: "response.created",
          response: {
            id: "resp-output-done",
            created_at: 1700000000,
            model: "gpt-5.3-codex",
          },
        }),
      }
      yield {
        data: JSON.stringify({
          type: "response.output_text.delta",
          output_index: 0,
          delta: "hello ",
        }),
      }
      yield {
        data: JSON.stringify({
          type: "response.output_text.done",
          output_index: 0,
          text: "hello world",
        }),
      }
      yield {
        data: JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp-output-done",
            created_at: 1700000000,
            model: "gpt-5.3-codex",
            output: [],
          },
        }),
      }
    }

    const chunks = await collectResponseStreamChunks(responseEvents())
    const contentDeltas = chunks
      .map((chunk) => chunk.choices[0]?.delta.content)
      .filter((content): content is string => Boolean(content))

    expect(contentDeltas).toEqual(["hello ", "world"])
  })

  test("uses Responses output_item.done as a message fallback when text deltas are absent", async () => {
    async function* responseEvents() {
      yield {
        data: JSON.stringify({
          type: "response.created",
          response: {
            id: "resp-item-message-done",
            created_at: 1700000000,
            model: "gpt-5.3-codex",
          },
        }),
      }
      yield {
        data: JSON.stringify({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "fallback text" }],
          },
        }),
      }
      yield {
        data: JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp-item-message-done",
            created_at: 1700000000,
            model: "gpt-5.3-codex",
            output: [],
          },
        }),
      }
    }

    const chunks = await collectResponseStreamChunks(responseEvents())
    const contentDeltas = chunks
      .map((chunk) => chunk.choices[0]?.delta.content)
      .filter((content): content is string => Boolean(content))

    expect(contentDeltas).toEqual(["fallback text"])
  })

  test("uses Responses function_call_arguments.done as a tool argument fallback", async () => {
    async function* responseEvents() {
      yield {
        data: JSON.stringify({
          type: "response.created",
          response: {
            id: "resp-tool-args-done",
            created_at: 1700000000,
            model: "gpt-5.3-codex",
          },
        }),
      }
      yield {
        data: JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            call_id: "call_1",
            name: "lookup",
            arguments: "{\"query\":",
          },
        }),
      }
      yield {
        data: JSON.stringify({
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: "\"docs\"",
        }),
      }
      yield {
        data: JSON.stringify({
          type: "response.function_call_arguments.done",
          output_index: 0,
          arguments: "{\"query\":\"docs\"}",
        }),
      }
      yield {
        data: JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp-tool-args-done",
            created_at: 1700000000,
            model: "gpt-5.3-codex",
            output: [{ type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"query\":\"docs\"}" }],
          },
        }),
      }
    }

    const chunks = await collectResponseStreamChunks(responseEvents())
    const argumentDeltas = chunks
      .flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? [])
      .map((toolCall) => toolCall.function?.arguments)
      .filter((args): args is string => args !== undefined)

    expect(argumentDeltas).toEqual(["{\"query\":", "\"docs\"", "}"])
  })

  test("uses Responses output_item.done as a tool fallback when add/delta events are absent", async () => {
    async function* responseEvents() {
      yield {
        data: JSON.stringify({
          type: "response.created",
          response: {
            id: "resp-tool-item-done",
            created_at: 1700000000,
            model: "gpt-5.3-codex",
          },
        }),
      }
      yield {
        data: JSON.stringify({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            call_id: "call_1",
            name: "lookup",
            arguments: "{}",
          },
        }),
      }
      yield {
        data: JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp-tool-item-done",
            created_at: 1700000000,
            model: "gpt-5.3-codex",
            output: [{ type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" }],
          },
        }),
      }
    }

    const chunks = await collectResponseStreamChunks(responseEvents())
    const toolCalls = chunks.flatMap(
      (chunk) => chunk.choices[0]?.delta.tool_calls ?? [],
    )

    expect(toolCalls).toEqual([
      {
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: "lookup", arguments: "{}" },
      },
    ])
  })

  test("uses Responses output_item.done as a reasoning summary fallback", async () => {
    async function* responseEvents() {
      yield {
        data: JSON.stringify({
          type: "response.created",
          response: {
            id: "resp-reasoning-item-done",
            created_at: 1700000000,
            model: "gpt-5.3-codex",
          },
        }),
      }
      yield {
        data: JSON.stringify({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "fallback thinking" }],
          },
        }),
      }
      yield {
        data: JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp-reasoning-item-done",
            created_at: 1700000000,
            model: "gpt-5.3-codex",
            output: [],
          },
        }),
      }
    }

    const chunks = await collectResponseStreamChunks(responseEvents())
    const reasoningDeltas = chunks
      .map((chunk) => chunk.choices[0]?.delta.reasoning_text)
      .filter((reasoning): reasoning is string => Boolean(reasoning))

    expect(reasoningDeltas).toEqual(["fallback thinking"])
  })

  test("ignores empty or null Responses reasoning summaries", async () => {
    async function* responseEvents() {
      yield {
        data: JSON.stringify({
          type: "response.created",
          response: {
            id: "resp-empty-reasoning",
            created_at: 1700000000,
            model: "gpt-5.3-codex",
          },
        }),
      }
      yield {
        data: JSON.stringify({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "reasoning",
            summary: [
              { type: "summary_text", text: "" },
              { type: "summary_text", text: null },
            ],
          },
        }),
      }
      yield {
        data: JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp-empty-reasoning",
            created_at: 1700000000,
            model: "gpt-5.3-codex",
            reasoning: { summary: null },
            output: [
              {
                type: "reasoning",
                summary: [],
              },
            ],
          },
        }),
      }
    }

    const chunks = await collectResponseStreamChunks(responseEvents())
    const reasoningDeltas = chunks
      .map((chunk) => chunk.choices[0]?.delta.reasoning_text)
      .filter((reasoning): reasoning is string => Boolean(reasoning))

    expect(reasoningDeltas).toEqual([])
  })
})
