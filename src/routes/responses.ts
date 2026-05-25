import { Hono } from "hono"
import consola from "consola"

import {
  CODEX_WEB_SEARCH_AVAILABILITY_MESSAGE,
  chatResponseToResponsesJson,
  responsesPayloadToChatPayload,
  responsesJsonToSse,
  synthesizeResponsesSseFromChat,
  type ResponsesApiResult,
  type ResponsesRequestLike,
} from "~/bridges/codex/chat-fallback"
import {
  createCodexWebSearchCallOutputItem,
  createCodexWebSearchExecution,
  getCodexWebSearchResultText,
  hasCodexNativeWebSearch,
  isCodexNativeWebSearchRequested,
  isCodexNativeWebSearchTool,
} from "~/bridges/codex/web-search"
import {
  isSupportedWebSearchBackend,
  type SearchExecutionResult,
} from "~/bridges/claude/web-search"
import { normalizeResponsesSseStream } from "~/bridges/codex/normalize-stream"
import { normalizeCodexResponsesRequest } from "~/bridges/codex/responses"
import type { BridgeEnv } from "~/lib/config"
import {
  normalizeCodexConfigReasoningEffort,
  readCodexUserConfigFromDisk,
  type CodexUserConfig,
} from "~/lib/codex-config"
import { CODEX_DEFAULTS } from "~/lib/defaults"
import { BridgeNotImplementedError } from "~/lib/error"
import { getModelCapability } from "~/lib/model-capabilities"
import { checkRateLimit, RateLimitError } from "~/lib/rate-limit"
import { runtimeState } from "~/lib/state"
import {
  summarizeToolsForDiagnostics,
  type ToolDiagnostics,
} from "~/lib/upstream-diagnostics"
import {
  fetchCopilot,
  getCopilotProviderContext,
} from "~/providers/copilot/client"

export const responsesRoutes = new Hono<BridgeEnv>()

type ResponsesRequestDiagnostics = {
  has_instructions: boolean
  input_item_count?: number
  input_kind?: string
  max_output_tokens?: unknown
  reasoning_effort?: unknown
  stream?: boolean
  tool_choice?: unknown
  tools?: ToolDiagnostics
}

const summarizeResponsesRequestForDiagnostics = (
  payload: ResponsesRequestLike,
): ResponsesRequestDiagnostics => ({
  has_instructions: Boolean(payload.instructions),
  input_item_count: Array.isArray(payload.input) ? payload.input.length : undefined,
  input_kind:
    typeof payload.input === "string" ? "string"
    : Array.isArray(payload.input) ? "array"
    : payload.input === undefined ? undefined
    : typeof payload.input,
  max_output_tokens: payload.max_output_tokens,
  reasoning_effort: payload.reasoning?.effort,
  stream: payload.stream ?? undefined,
  tool_choice: payload.tool_choice,
  tools: summarizeToolsForDiagnostics(payload.tools),
})

const logResponsesUpstreamError = async (
  message: string,
  response: Response,
  context: {
    model: string
    request: ResponsesRequestLike
    route: string
  },
): Promise<void> => {
  if (!runtimeState.debug) {
    return
  }

  const errorBody = await response.clone().text().catch(() => "")

  consola.error(message, {
    route: context.route,
    model: context.model,
    status: response.status,
    statusText: response.statusText,
    body: errorBody || undefined,
    request: JSON.stringify(
      summarizeResponsesRequestForDiagnostics(context.request),
    ),
  })
}

const readCodexUserConfig = async (): Promise<CodexUserConfig> => {
  const configPath = process.env.CODEX_CONFIG_PATH ?? CODEX_DEFAULTS.configPath
  return readCodexUserConfigFromDisk(configPath)
}

const getCodexWebSearchQueryFromChatResponse = (
  chatJson: Parameters<typeof chatResponseToResponsesJson>[1],
): string | undefined => {
  const toolCall = chatJson.choices
    .flatMap((choice) => choice.message.tool_calls ?? [])
    .find((call) => call.function.name === "web_search")
  if (!toolCall) {
    return undefined
  }

  try {
    const parsed = JSON.parse(toolCall.function.arguments) as unknown
    if (
      typeof parsed === "object"
      && parsed !== null
      && !Array.isArray(parsed)
      && typeof (parsed as { query?: unknown }).query === "string"
    ) {
      return (parsed as { query: string }).query
    }
  } catch {
    return toolCall.function.arguments
  }

  return toolCall.function.arguments
}

const getCodexWebSearchQueryFromResponsesResult = (
  responseJson: ResponsesApiResult,
): string | undefined => {
  const functionCall = responseJson.output.find(
    (item) => item.type === "function_call" && item.name === "web_search",
  )
  if (!functionCall || functionCall.type !== "function_call") {
    return undefined
  }

  try {
    const parsed = JSON.parse(functionCall.arguments) as unknown
    if (
      typeof parsed === "object"
      && parsed !== null
      && !Array.isArray(parsed)
      && typeof (parsed as { query?: unknown }).query === "string"
    ) {
      return (parsed as { query: string }).query
    }
  } catch {
    return functionCall.arguments
  }

  return functionCall.arguments
}

type ChatFallbackPayload = ReturnType<typeof responsesPayloadToChatPayload>
type ChatFallbackMessage = ChatFallbackPayload["messages"][number]

const createCodexWebSearchContextMessage = (
  search: SearchExecutionResult,
): ChatFallbackMessage => ({
  role: "system",
  content: [
    "Trusted bridge retrieval context: the assistant selected web_search, and copilot-bridge executed it.",
    "Use this context for the final answer. Do not describe it as user-provided or injected. Do not call web_search again.",
    "If the user requested a specific output format, answer using only matching information from this context.",
    "If the user asked for a URL only, output only that URL with no surrounding text.",
    "",
    `Query: ${search.query}`,
    "",
    getCodexWebSearchResultText(search),
  ].join("\n"),
})

const createCodexWebSearchFinalInstructionMessage = (): ChatFallbackMessage => ({
  role: "user",
  content: "Answer the user's last request now using the trusted bridge retrieval context. If the user asked for a URL only, output only that URL with no surrounding text.",
})

const createFinalCodexWebSearchChatPayload = (
  payload: ChatFallbackPayload,
  search: SearchExecutionResult,
): ChatFallbackPayload => {
  const messages = payload.messages
    .filter(
      (message) =>
        message.content !== CODEX_WEB_SEARCH_AVAILABILITY_MESSAGE,
    )
    .flatMap<ChatFallbackMessage>((message) => {
      if (message.role === "tool") {
        return [
          {
            role: "system",
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
    tools: undefined,
    tool_choice: undefined,
    messages: [
      ...messages,
      createCodexWebSearchContextMessage(search),
      createCodexWebSearchFinalInstructionMessage(),
    ],
  }
}

const mergeCodexWebSearchAndFinalResponse = (
  request: ResponsesRequestLike,
  search: SearchExecutionResult,
  finalChatResponse: Parameters<typeof chatResponseToResponsesJson>[1],
): ResponsesApiResult => {
  const finalResponse = chatResponseToResponsesJson(request, finalChatResponse)

  return {
    ...finalResponse,
    output: [createCodexWebSearchCallOutputItem(search), ...finalResponse.output],
    usage: {
      input_tokens: search.inputTokens + (finalResponse.usage?.input_tokens ?? 0),
      output_tokens: search.outputTokens + (finalResponse.usage?.output_tokens ?? 0),
      total_tokens:
        search.inputTokens
        + search.outputTokens
        + (finalResponse.usage?.total_tokens ?? 0),
    },
  }
}

const codexWebSearchFunctionTool = {
  type: "function",
  name: "web_search",
  description: "Search the web for current or external information.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The web search query to run.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
} as const

const createCodexNativeWebSearchDecisionPayload = (
  payload: ResponsesRequestLike,
): ResponsesRequestLike => ({
  ...payload,
  stream: false,
  tools: payload.tools?.map((tool) =>
    isCodexNativeWebSearchTool(tool) ? codexWebSearchFunctionTool : tool,
  ),
  tool_choice:
    typeof payload.tool_choice === "object"
    && payload.tool_choice !== null
    && !Array.isArray(payload.tool_choice)
    && isCodexNativeWebSearchTool(payload.tool_choice) ?
      { type: "function", name: "web_search" }
    : payload.tool_choice,
})

const inputItemsFromResponsesPayload = (
  payload: ResponsesRequestLike,
): Exclude<ResponsesRequestLike["input"], string | undefined> => {
  if (typeof payload.input === "string") {
    return [{ role: "user", content: payload.input }]
  }

  return Array.isArray(payload.input) ? payload.input : []
}

const createCodexNativeWebSearchContextInputItem = (
  search: SearchExecutionResult,
): Exclude<ResponsesRequestLike["input"], string | undefined>[number] => ({
  type: "message",
  role: "system",
  content: [
    {
      type: "input_text",
      text: [
        "Trusted bridge retrieval context: the assistant selected web_search, and copilot-bridge executed it.",
        "Use this context for the final answer. Do not describe it as user-provided or injected. Do not call web_search again.",
        "If the user requested a specific output format, answer using only matching information from this context.",
        "If the user asked for a URL only, output only that URL with no surrounding text.",
        "",
        `Query: ${search.query}`,
        "",
        getCodexWebSearchResultText(search),
      ].join("\n"),
    },
  ],
})

const createCodexNativeWebSearchFinalInstructionInputItem = ():
  Exclude<ResponsesRequestLike["input"], string | undefined>[number] => ({
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: "Answer the user's last request now using the trusted bridge retrieval context. If the user asked for a URL only, output only that URL with no surrounding text.",
      },
    ],
  })

const createFinalCodexNativeWebSearchPayload = (
  payload: ResponsesRequestLike,
  search: SearchExecutionResult,
): ResponsesRequestLike => ({
  ...payload,
  stream: false,
  tools: undefined,
  tool_choice: undefined,
  input: [
    ...inputItemsFromResponsesPayload(payload),
    createCodexNativeWebSearchContextInputItem(search),
    createCodexNativeWebSearchFinalInstructionInputItem(),
  ],
})

const mergeCodexNativeWebSearchAndFinalResponse = (
  search: SearchExecutionResult,
  finalResponse: ResponsesApiResult,
): ResponsesApiResult => ({
  ...finalResponse,
  output: [createCodexWebSearchCallOutputItem(search), ...finalResponse.output],
  usage: {
    input_tokens: search.inputTokens + (finalResponse.usage?.input_tokens ?? 0),
    output_tokens: search.outputTokens + (finalResponse.usage?.output_tokens ?? 0),
    total_tokens:
      search.inputTokens
      + search.outputTokens
      + (finalResponse.usage?.total_tokens ?? 0),
  },
})

responsesRoutes.post("/", async (c) => {
  try {
    await checkRateLimit()
  } catch (error) {
    if (error instanceof RateLimitError) {
      return c.json({ error: { message: error.message } }, 429)
    }
    throw error
  }
  const rawPayload = (await c.req.json()) as ResponsesRequestLike
  const effectiveRawPayload =
    runtimeState.modelOverride ?
      { ...rawPayload, model: runtimeState.modelOverride }
    : rawPayload
  const codexUserConfig = await readCodexUserConfig()
  const configuredReasoningEffort = normalizeCodexConfigReasoningEffort(
    codexUserConfig.modelReasoningEffort,
  )
  const payload = normalizeCodexResponsesRequest(
    effectiveRawPayload as unknown as Parameters<typeof normalizeCodexResponsesRequest>[0],
    configuredReasoningEffort,
  ) as unknown as ResponsesRequestLike
  const config = c.get("config")
  const provider = getCopilotProviderContext(config)
  const search = new URL(c.req.url).search

  const capability = getModelCapability(payload.model)
  const isWebSearchBackendSupported = isSupportedWebSearchBackend(
    codexUserConfig.webSearchBackend,
  )

  try {
    if (capability?.fallback === "chat-completions") {
      const chatPayload = responsesPayloadToChatPayload(payload, capability)
      const createCodexWebSearchFinalResponse = async (
        requestedQuery?: string,
      ): Promise<Response> => {
        const searchResult = await createCodexWebSearchExecution(config, payload, {
          backend: codexUserConfig.webSearchBackend,
          requestedQuery,
        })
        const finalPayload = createFinalCodexWebSearchChatPayload(
          chatPayload,
          searchResult,
        )
        const finalUpstream = await fetchCopilot(
          provider,
          `/chat/completions${search}`,
          {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify(finalPayload),
          },
        )

        if (!finalUpstream.ok) {
          await logResponsesUpstreamError(
            "Failed to create final chat completions after web search",
            finalUpstream,
            {
              model: payload.model,
              request: payload,
              route: "/chat/completions",
            },
          )
          const text = await finalUpstream.text()
          return new Response(text, {
            status: finalUpstream.status,
            headers: { "content-type": finalUpstream.headers.get("content-type") ?? "application/json" },
          })
        }

        const finalChatJson = (await finalUpstream.json()) as Parameters<
          typeof chatResponseToResponsesJson
        >[1]
        const response = mergeCodexWebSearchAndFinalResponse(
          payload,
          searchResult,
          finalChatJson,
        )

        if (payload.stream) {
          return new Response(responsesJsonToSse(response), {
            status: 200,
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
              connection: "keep-alive",
            },
          })
        }

        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }

      if (isWebSearchBackendSupported && isCodexNativeWebSearchRequested(payload)) {
        return createCodexWebSearchFinalResponse()
      }

      const upstream = await fetchCopilot(provider, `/chat/completions${search}`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(chatPayload),
      })

      if (!upstream.ok) {
        await logResponsesUpstreamError(
          "Failed to create chat completions",
          upstream,
          {
            model: payload.model,
            request: payload,
            route: "/chat/completions",
          },
        )
        const text = await upstream.text()
        return new Response(text, {
          status: upstream.status,
          headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
        })
      }

      const chatJson = (await upstream.json()) as Parameters<
        typeof chatResponseToResponsesJson
      >[1]

      const requestedWebSearchQuery = getCodexWebSearchQueryFromChatResponse(chatJson)
      if (isWebSearchBackendSupported && requestedWebSearchQuery) {
        return createCodexWebSearchFinalResponse(requestedWebSearchQuery)
      }

      if (payload.stream) {
        const stream = synthesizeResponsesSseFromChat(payload, chatJson)
        return new Response(stream, {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        })
      }

      const responsesJson = chatResponseToResponsesJson(payload, chatJson)
      return new Response(JSON.stringify(responsesJson), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }

    const createCodexNativeWebSearchFinalResponse = async (
      requestedQuery?: string,
    ): Promise<Response> => {
      const searchResult = await createCodexWebSearchExecution(config, payload, {
        backend: codexUserConfig.webSearchBackend,
        requestedQuery,
      })
      const finalPayload = createFinalCodexNativeWebSearchPayload(
        payload,
        searchResult,
      )
      const finalUpstream = await fetchCopilot(provider, `/responses${search}`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(finalPayload),
      })

      if (!finalUpstream.ok) {
        await logResponsesUpstreamError(
          "Failed to create final responses after web search",
          finalUpstream,
          {
            model: payload.model,
            request: payload,
            route: "/responses",
          },
        )
        const text = await finalUpstream.text()
        return new Response(text, {
          status: finalUpstream.status,
          headers: { "content-type": finalUpstream.headers.get("content-type") ?? "application/json" },
        })
      }

      const finalResponseJson = (await finalUpstream.json()) as ResponsesApiResult
      const response = mergeCodexNativeWebSearchAndFinalResponse(
        searchResult,
        finalResponseJson,
      )

      if (payload.stream) {
        return new Response(responsesJsonToSse(response), {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        })
      }

      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }

    if (isWebSearchBackendSupported && hasCodexNativeWebSearch(payload)) {
      if (isCodexNativeWebSearchRequested(payload)) {
        return createCodexNativeWebSearchFinalResponse()
      }

      const decisionPayload = createCodexNativeWebSearchDecisionPayload(payload)
      const decisionUpstream = await fetchCopilot(provider, `/responses${search}`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(decisionPayload),
      })

      if (!decisionUpstream.ok) {
        await logResponsesUpstreamError(
          "Failed to create responses web search decision",
          decisionUpstream,
          {
            model: payload.model,
            request: decisionPayload,
            route: "/responses",
          },
        )
        const text = await decisionUpstream.text()
        return new Response(text, {
          status: decisionUpstream.status,
          headers: { "content-type": decisionUpstream.headers.get("content-type") ?? "application/json" },
        })
      }

      const decisionJson = (await decisionUpstream.json()) as ResponsesApiResult
      const requestedWebSearchQuery = getCodexWebSearchQueryFromResponsesResult(decisionJson)
      if (requestedWebSearchQuery) {
        return createCodexNativeWebSearchFinalResponse(requestedWebSearchQuery)
      }

      if (payload.stream) {
        return new Response(responsesJsonToSse(decisionJson), {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        })
      }

      return new Response(JSON.stringify(decisionJson), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }

    const upstream = await fetchCopilot(provider, `/responses${search}`, {
      method: "POST",
      headers: {
        accept: c.req.header("accept") ?? "application/json",
        "content-type": c.req.header("content-type") ?? "application/json",
      },
      body: JSON.stringify(payload),
    })

    const contentType = upstream.headers.get("content-type") ?? ""

    if (!upstream.ok) {
      await logResponsesUpstreamError("Failed to create responses", upstream, {
        model: payload.model,
        request: payload,
        route: "/responses",
      })
    }

    if (payload.stream && upstream.body && contentType.includes("text/event-stream")) {
      return new Response(normalizeResponsesSseStream(upstream.body), {
        status: upstream.status,
        headers: upstream.headers,
      })
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    })
  } catch (error) {
    if (error instanceof BridgeNotImplementedError) {
      return c.json(
        {
          error: {
            type: error.name,
            message: error.message,
          },
        },
        501,
      )
    }

    throw error
  }
})