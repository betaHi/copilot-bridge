import { Hono } from "hono"
import consola from "consola"

import {
  chatResponseToResponsesJson,
  responsesPayloadToChatPayload,
  synthesizeResponsesSseFromChat,
  type ResponsesRequestLike,
} from "~/bridges/codex/chat-fallback"
import {
  codexWebSearchResponseToSse,
  createCodexWebSearchResponse,
  isCodexNativeWebSearchRequested,
} from "~/bridges/codex/web-search"
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

  try {
    if (capability?.fallback === "chat-completions") {
      if (isCodexNativeWebSearchRequested(payload)) {
        const response = await createCodexWebSearchResponse(config, payload, {
          backend: codexUserConfig.webSearchBackend,
        })

        if (payload.stream) {
          return new Response(codexWebSearchResponseToSse(response), {
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

      const chatPayload = responsesPayloadToChatPayload(payload, capability)
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
      if (requestedWebSearchQuery) {
        const response = await createCodexWebSearchResponse(config, payload, {
          backend: codexUserConfig.webSearchBackend,
          requestedQuery: requestedWebSearchQuery,
        })

        if (payload.stream) {
          return new Response(codexWebSearchResponseToSse(response), {
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