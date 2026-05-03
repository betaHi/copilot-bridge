import consola from "consola"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "~/bridges/claude/anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
  translateModelName,
} from "~/bridges/claude/non-stream-translation"
import {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "~/bridges/claude/stream-translation"
import {
  createAnthropicToolNameMapper,
  getToolNameMapperOptionsForModel,
} from "~/bridges/claude/tool-names"
import { getClaudeSettings } from "~/lib/claude-settings"
import type { BridgeEnv } from "~/lib/config"
import { BridgeNotImplementedError, HTTPError } from "~/lib/error"
import { checkRateLimit, RateLimitError } from "~/lib/rate-limit"
import { resolveModel } from "~/lib/models-resolver"
import { runtimeState } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/providers/copilot/chat-types"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"

export const messageRoutes = new Hono<BridgeEnv>()

const isNonStreamingResponse = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse =>
  typeof response === "object"
  && response !== null
  && Object.hasOwn(response, "choices")

messageRoutes.post("/", async (c) => {
  const config = c.get("config")
  try {
    await checkRateLimit()
  } catch (error) {
    if (error instanceof RateLimitError) {
      return c.json({ error: { message: error.message } }, 429)
    }
    throw error
  }
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  const claudeSettings = await getClaudeSettings()
  const effectivePayload =
    runtimeState.modelOverride ?
      { ...anthropicPayload, model: runtimeState.modelOverride }
    : anthropicPayload
  const upstreamModel = translateModelName(effectivePayload.model, claudeSettings)
  const toolNameMapper = createAnthropicToolNameMapper(anthropicPayload.tools, {
    ...getToolNameMapperOptionsForModel(upstreamModel),
  })
  const openAIPayload = translateToOpenAI(
    effectivePayload,
    claudeSettings,
    toolNameMapper,
  )

  try {
    const response = await createChatCompletions(config, openAIPayload, {
      client: "claude",
    })

    if (isNonStreamingResponse(response)) {
      return c.json(translateToAnthropic(response, toolNameMapper))
    }

    return streamSSE(c, async (stream) => {
      const streamState: AnthropicStreamState = {
        messageStartSent: false,
        contentBlockIndex: 0,
        contentBlockOpen: false,
        thinkingBlockOpen: false,
        toolCalls: {},
      }

      try {
        for await (const rawEvent of response) {
          if (rawEvent.data === "[DONE]") {
            break
          }

          if (!rawEvent.data) {
            continue
          }

          let chunk: ChatCompletionChunk
          try {
            chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
          } catch {
            continue
          }

          const events = translateChunkToAnthropicEvents(
            chunk,
            streamState,
            toolNameMapper,
          )
          for (const event of events) {
            await stream.writeSSE({
              event: event.type,
              data: JSON.stringify(event),
            })
          }
        }
      } catch (error) {
        consola.error("Error during Anthropic stream translation:", error)
        const errorEvent = translateErrorToAnthropicErrorEvent()
        await stream.writeSSE({
          event: errorEvent.type,
          data: JSON.stringify(errorEvent),
        })
      }
    })
  } catch (error) {
    if (error instanceof BridgeNotImplementedError) {
      return c.json(
        { error: { type: error.name, message: error.message } },
        501,
      )
    }

    if (error instanceof HTTPError) {
      const text = await error.response.text().catch(() => "")
      return new Response(text, {
        status: error.response.status,
        headers: {
          "content-type":
            error.response.headers.get("content-type") ?? "application/json",
        },
      })
    }

    throw error
  }
})

messageRoutes.post("/count_tokens", async (c) => {
  try {
    const anthropicBeta = c.req.header("anthropic-beta")
    const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
    const claudeSettings = await getClaudeSettings()
    const effectivePayload =
      runtimeState.modelOverride ?
        { ...anthropicPayload, model: runtimeState.modelOverride }
      : anthropicPayload
    const openAIPayload = translateToOpenAI(effectivePayload, claudeSettings)

    const selectedModel = resolveModel(openAIPayload.model)

    if (!selectedModel) {
      consola.warn(
        `Model ${openAIPayload.model} not found in registry, returning fallback token count`,
      )
      return c.json({ input_tokens: 1 })
    }

    const tokenCount = await getTokenCount(openAIPayload, selectedModel)
    const effectiveModelId = selectedModel.id

    if (anthropicPayload.tools && anthropicPayload.tools.length > 0) {
      let mcpToolExist = false
      if (anthropicBeta?.startsWith("claude-code")) {
        mcpToolExist = anthropicPayload.tools.some((tool) =>
          tool.name.startsWith("mcp__"),
        )
      }
      if (!mcpToolExist) {
        if (effectiveModelId.startsWith("claude")) {
          tokenCount.input += 346
        } else if (effectiveModelId.startsWith("grok")) {
          tokenCount.input += 480
        }
      }
    }

    let finalTokenCount = tokenCount.input + tokenCount.output
    if (effectiveModelId.startsWith("claude")) {
      finalTokenCount = Math.round(finalTokenCount * 1.15)
    } else if (effectiveModelId.startsWith("grok")) {
      finalTokenCount = Math.round(finalTokenCount * 1.03)
    }

    return c.json({ input_tokens: Math.max(1, finalTokenCount) })
  } catch (error) {
    consola.error("Error counting tokens:", error)
    return c.json({ input_tokens: 1 })
  }
})
