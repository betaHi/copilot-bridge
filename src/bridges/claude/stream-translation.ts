import type {
  AnthropicStreamEventData,
  AnthropicStreamState,
} from "~/bridges/claude/anthropic-types"
import {
  createAnthropicToolNameMapper,
  type AnthropicToolNameMapper,
} from "~/bridges/claude/tool-names"
import { mapOpenAIStopReasonToAnthropic } from "~/bridges/claude/utils"
import type { ChatCompletionChunk } from "~/providers/copilot/chat-types"

function isToolBlockOpen(state: AnthropicStreamState): boolean {
  if (!state.contentBlockOpen) {
    return false
  }

  return Object.values(state.toolCalls).some(
    (tc) => tc.anthropicBlockIndex === state.contentBlockIndex,
  )
}

export function translateChunkToAnthropicEvents(
  chunk: ChatCompletionChunk,
  state: AnthropicStreamState,
  toolNameMapper: AnthropicToolNameMapper = createAnthropicToolNameMapper(
    undefined,
  ),
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []

  if (chunk.choices.length === 0) {
    return events
  }

  const choice = chunk.choices[0]
  const { delta } = choice

  if (!state.messageStartSent) {
    events.push({
      type: "message_start",
      message: {
        id: chunk.id,
        type: "message",
        role: "assistant",
        content: [],
        model: chunk.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens:
            (chunk.usage?.prompt_tokens ?? 0)
            - (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
          output_tokens: 0,
          ...(chunk.usage?.prompt_tokens_details?.cached_tokens !== undefined && {
            cache_read_input_tokens: chunk.usage.prompt_tokens_details.cached_tokens,
          }),
        },
      },
    })
    state.messageStartSent = true
  }

  if (delta.content) {
    if (isToolBlockOpen(state)) {
      events.push({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      })
      state.contentBlockIndex++
      state.contentBlockOpen = false
    }

    if (!state.contentBlockOpen) {
      events.push({
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: {
          type: "text",
          text: "",
        },
      })
      state.contentBlockOpen = true
    }

    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: {
        type: "text_delta",
        text: delta.content,
      },
    })
  }

  if (delta.tool_calls) {
    for (const toolCall of delta.tool_calls) {
      if (toolCall.id && toolCall.function?.name) {
        if (state.contentBlockOpen) {
          events.push({
            type: "content_block_stop",
            index: state.contentBlockIndex,
          })
          state.contentBlockIndex++
          state.contentBlockOpen = false
        }

        const toolName = toolNameMapper.toAnthropic(toolCall.function.name)
        const anthropicBlockIndex = state.contentBlockIndex
        state.toolCalls[toolCall.index] = {
          id: toolCall.id,
          name: toolName,
          anthropicBlockIndex,
        }

        events.push({
          type: "content_block_start",
          index: anthropicBlockIndex,
          content_block: {
            type: "tool_use",
            id: toolCall.id,
            name: toolName,
            input: {},
          },
        })
        state.contentBlockOpen = true
      }

      if (toolCall.function?.arguments) {
        const toolCallInfo = state.toolCalls[toolCall.index]
        if (toolCallInfo) {
          events.push({
            type: "content_block_delta",
            index: toolCallInfo.anthropicBlockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: toolCall.function.arguments,
            },
          })
        }
      }
    }
  }

  if (choice.finish_reason) {
    if (state.contentBlockOpen) {
      events.push({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      })
      state.contentBlockOpen = false
    }

    events.push(
      {
        type: "message_delta",
        delta: {
          stop_reason: mapOpenAIStopReasonToAnthropic(choice.finish_reason),
          stop_sequence: null,
        },
        usage: {
          input_tokens:
            (chunk.usage?.prompt_tokens ?? 0)
            - (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
          output_tokens: chunk.usage?.completion_tokens ?? 0,
          ...(chunk.usage?.prompt_tokens_details?.cached_tokens !== undefined && {
            cache_read_input_tokens: chunk.usage.prompt_tokens_details.cached_tokens,
          }),
        },
      },
      {
        type: "message_stop",
      },
    )
  }

  return events
}

export function translateErrorToAnthropicErrorEvent(): AnthropicStreamEventData {
  return {
    type: "error",
    error: {
      type: "api_error",
      message: "An unexpected error occurred during streaming.",
    },
  }
}
