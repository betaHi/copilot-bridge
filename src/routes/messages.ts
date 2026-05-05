import consola from "consola"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

import {
  type AnthropicMessagesPayload,
  type AnthropicResponse,
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
import {
  createAnthropicWebSearchResponse,
  createClaudeWebSearchExecution,
  getClaudeWebSearchToolCallFromChatResponse,
  getWebSearchResultText,
  hasAnthropicNativeWebSearch,
  isSupportedWebSearchBackend,
  prepareAnthropicWebSearchDecisionPayload,
  type SearchExecutionResult,
  webSearchResponseToEvents,
} from "~/bridges/claude/web-search"
import { getClaudeSettings, getUserClaudeSettings } from "~/lib/claude-settings"
import type { BridgeEnv } from "~/lib/config"
import { BridgeNotImplementedError, HTTPError } from "~/lib/error"
import { checkRateLimit, RateLimitError } from "~/lib/rate-limit"
import { resolveModel } from "~/lib/models-resolver"
import { runtimeState } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  Message,
} from "~/providers/copilot/chat-types"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"

export const messageRoutes = new Hono<BridgeEnv>()

const isNonStreamingResponse = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse =>
  typeof response === "object"
  && response !== null
  && Object.hasOwn(response, "choices")

const createWebSearchResultContextMessage = (
  search: SearchExecutionResult,
): Message => ({
  role: "system",
  content: [
    "Trusted bridge retrieval context: the assistant selected web_search, and copilot-bridge executed it.",
    "Use this context for the final answer. Do not describe it as user-provided or injected. Do not call web_search again.",
    "If the user requested a specific output format, answer using only matching information from this context.",
    "If the user asked for a URL only, output only that URL with no surrounding text.",
    "",
    `Query: ${search.query}`,
    "",
    getWebSearchResultText(search),
  ].join("\n"),
})

const createFinalWebSearchPayload = (
  payload: ChatCompletionsPayload,
  search: SearchExecutionResult,
): ChatCompletionsPayload => {
  const messages = payload.messages.flatMap<Message>((message) => {
    if (message.role === "tool") {
      return [
        {
          role: "developer",
          content: [
            "Prior local tool result from the conversation:",
            String(message.content ?? ""),
          ].join("\n"),
        },
      ]
    }

    if (message.tool_calls && message.tool_calls.length > 0) {
      return message.content ? [{ ...message, tool_calls: undefined }] : []
    }

    return [message]
  })

  return {
    ...payload,
    stream: false,
    tools: undefined,
    tool_choice: undefined,
    messages: [
      ...messages,
      createWebSearchResultContextMessage(search),
    ],
  }
}

const mergeWebSearchAndFinalResponse = (
  searchResponse: ReturnType<typeof createAnthropicWebSearchResponse>,
  finalResponse: ReturnType<typeof translateToAnthropic>,
) => ({
  ...finalResponse,
  content: [...searchResponse.content.slice(0, 2), ...finalResponse.content],
  usage: {
    ...finalResponse.usage,
    input_tokens:
      searchResponse.usage.input_tokens + finalResponse.usage.input_tokens,
    output_tokens:
      searchResponse.usage.output_tokens + finalResponse.usage.output_tokens,
    server_tool_use: { web_search_requests: 1 },
  },
})

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
  const userClaudeSettings = await getUserClaudeSettings()
  const effectivePayload =
    runtimeState.modelOverride ?
      { ...anthropicPayload, model: runtimeState.modelOverride }
    : anthropicPayload

  try {
    const upstreamModel = translateModelName(effectivePayload.model, claudeSettings)

    const toolNameMapper = createAnthropicToolNameMapper(anthropicPayload.tools, {
      ...getToolNameMapperOptionsForModel(upstreamModel),
    })
    const webSearchBackend = userClaudeSettings.env.COPILOT_WEB_SEARCH_BACKEND
    const shouldLetModelDecideWebSearch =
      hasAnthropicNativeWebSearch(effectivePayload)
      && isSupportedWebSearchBackend(webSearchBackend)
    const decisionPayload =
      shouldLetModelDecideWebSearch ?
        prepareAnthropicWebSearchDecisionPayload(effectivePayload)
      : effectivePayload
    const openAIPayload = translateToOpenAI(
      decisionPayload,
      claudeSettings,
      toolNameMapper,
    )
    if (shouldLetModelDecideWebSearch) {
      openAIPayload.stream = false
    }
    const response = await createChatCompletions(config, openAIPayload, {
      client: "claude",
    })

    if (isNonStreamingResponse(response)) {
      const webSearchToolCall = shouldLetModelDecideWebSearch ?
        getClaudeWebSearchToolCallFromChatResponse(response, toolNameMapper)
      : undefined
      let anthropicResponse: AnthropicResponse

      if (webSearchToolCall) {
        const search = await createClaudeWebSearchExecution(
          config,
          effectivePayload,
          {
            backend: webSearchBackend,
            copilotCliModel: upstreamModel,
          },
          webSearchToolCall.query,
        )
        const searchResponse = createAnthropicWebSearchResponse(search)

        const finalResponse = await createChatCompletions(
          config,
          createFinalWebSearchPayload(
            openAIPayload,
            search,
          ),
          { client: "claude" },
        )

        if (!isNonStreamingResponse(finalResponse)) {
          throw new HTTPError(
            "Claude web search final answer request unexpectedly streamed",
            new Response("Claude web search final answer request unexpectedly streamed", {
              status: 502,
              headers: { "content-type": "text/plain" },
            }),
          )
        }

        const finalAnthropicResponse = translateToAnthropic(
          finalResponse,
          toolNameMapper,
        )

        anthropicResponse = mergeWebSearchAndFinalResponse(
          searchResponse,
          finalAnthropicResponse,
        )
      } else {
        anthropicResponse = translateToAnthropic(response, toolNameMapper)
      }

      if (!effectivePayload.stream) {
        return c.json(anthropicResponse)
      }

      return streamSSE(c, async (stream) => {
        for (const event of webSearchResponseToEvents(anthropicResponse)) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          })
        }
      })
    }

    if (shouldLetModelDecideWebSearch) {
      throw new HTTPError(
        "Claude web search model-decision request unexpectedly streamed",
        new Response("Claude web search model-decision request unexpectedly streamed", {
          status: 502,
          headers: { "content-type": "text/plain" },
        }),
      )
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
