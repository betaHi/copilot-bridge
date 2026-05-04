import { randomUUID } from "node:crypto"

import {
  createWebSearchExecution,
  type SearchExecutionResult,
  type WebSearchExecutionRequest,
} from "~/bridges/claude/web-search"
import type { BridgeConfig } from "~/lib/config"

import type { ResponsesRequestLike } from "./chat-fallback"

interface CodexWebSearchOptions {
  backend?: string
  requestedQuery?: string
}

interface ResponsesOutputTextPart {
  type: "output_text"
  text: string
  annotations: []
}

type CodexWebSearchOutputItem =
  | {
      id: string
      type: "web_search_call"
      status: "completed"
      action: {
        type: "search"
        query: string
      }
    }
  | {
      id: string
      type: "message"
      role: "assistant"
      status: "completed"
      content: Array<ResponsesOutputTextPart>
    }

interface CodexWebSearchResponse {
  id: string
  object: "response"
  status: "completed"
  created_at: number
  model: string
  output: Array<CodexWebSearchOutputItem>
  usage: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const textFromContent = (content: unknown): string => {
  if (typeof content === "string") {
    return content
  }

  if (!Array.isArray(content)) {
    return ""
  }

  return content
    .flatMap((part) => {
      if (!isRecord(part)) return []
      if (
        (part.type === "input_text" || part.type === "output_text" || part.type === "text")
        && typeof part.text === "string"
      ) {
        return [part.text]
      }
      return []
    })
    .join("\n")
}

const inputItemsFromRequest = (
  request: ResponsesRequestLike,
): Array<Record<string, unknown>> => {
  if (typeof request.input === "string") {
    return [{ role: "user", content: request.input }]
  }

  return Array.isArray(request.input) ? (request.input as Array<unknown>).filter(isRecord) : []
}

const getRequestedQuery = (request: ResponsesRequestLike): string => {
  const lastUserItem = [...inputItemsFromRequest(request)]
    .reverse()
    .find((item) => item.role === "user")
  const rawText = textFromContent(lastUserItem?.content)
  const cleaned = rawText
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const searchMatch = cleaned.match(/\bsearch(?:\s+the\s+web)?(?:\s+for)?\s+(.+)$/i)
  return searchMatch?.[1]?.trim() || cleaned || "web search"
}

const buildSearchInput = (
  request: ResponsesRequestLike,
  requestedQuery: string,
): string => {
  const items = inputItemsFromRequest(request)
  const conversation = items
    .flatMap((item) => {
      const role = typeof item.role === "string" ? item.role : item.type
      const text = textFromContent(item.content ?? item.output)
      return role && text ? [`${role}: ${text}`] : []
    })
    .join("\n\n")

  return [
    "You are fulfilling an OpenAI Responses web_search hosted tool request for Codex CLI.",
    "Search the web using the configured bridge web-search backend.",
    "Return useful search results as plain text lines in this exact shape:",
    "1. Title - https://example.com/page",
    "Include only real source URLs from the search results.",
    `Search query:\n${requestedQuery}`,
    request.instructions ? `Instructions:\n${request.instructions}` : "",
    conversation ? `Conversation:\n${conversation}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
}

const createExecutionRequest = (
  request: ResponsesRequestLike,
  requestedQuery?: string,
): WebSearchExecutionRequest => {
  const query = requestedQuery?.trim() || getRequestedQuery(request)
  return {
    clientName: "Codex",
    configurationHint: "Set COPILOT_WEB_SEARCH_BACKEND in ~/.codex/config.toml to a Copilot Responses search model id such as gpt-5.5, searxng, or copilot-cli.",
    maxOutputTokens: request.max_output_tokens,
    requestedQuery: query,
    searchInput: buildSearchInput(request, query),
    temperature: request.temperature,
    topP: request.top_p,
  }
}

export const isCodexNativeWebSearchTool = (tool: unknown): boolean => {
  if (!isRecord(tool)) {
    return false
  }

  return tool.type === "web_search" || tool.type === "web_search_preview"
}

const isCodexNativeWebSearchToolChoice = (toolChoice: unknown): boolean => {
  if (!isRecord(toolChoice)) {
    return false
  }

  return toolChoice.type === "web_search" || toolChoice.type === "web_search_preview"
}

const hasOnlyCodexNativeWebSearchTools = (
  tools: ResponsesRequestLike["tools"],
): boolean => {
  if (!Array.isArray(tools) || tools.length === 0) {
    return false
  }

  return tools.every(isCodexNativeWebSearchTool)
}

export const hasCodexNativeWebSearch = (
  request: ResponsesRequestLike,
): boolean => request.tools?.some(isCodexNativeWebSearchTool) ?? false

export const isCodexNativeWebSearchRequested = (
  request: ResponsesRequestLike,
): boolean => {
  if (!hasCodexNativeWebSearch(request)) {
    return false
  }

  if (isCodexNativeWebSearchToolChoice(request.tool_choice)) {
    return true
  }

  return request.tool_choice === "required"
    && hasOnlyCodexNativeWebSearchTools(request.tools)
}

const fallbackSearchText = (search: SearchExecutionResult): string => {
  if (search.text) {
    return search.text
  }

  if (search.results.length === 0) {
    return "Web search did not return search results."
  }

  return [
    `Web search results for query: "${search.query}"`,
    "",
    ...search.results.map(
      (result, index) => `${index + 1}. ${result.title} - ${result.url}`,
    ),
  ].join("\n")
}

const buildCodexWebSearchResponse = (
  request: ResponsesRequestLike,
  search: SearchExecutionResult,
): CodexWebSearchResponse => {
  const text = fallbackSearchText(search)
  const output: Array<CodexWebSearchOutputItem> = [
    {
      id: `ws_${randomUUID()}`,
      type: "web_search_call",
      status: "completed",
      action: { type: "search", query: search.query },
    },
    {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    },
  ]

  return {
    id: search.id.startsWith("resp_") ? search.id : `resp_${randomUUID()}`,
    object: "response",
    status: "completed",
    created_at: Math.floor(Date.now() / 1000),
    model: request.model,
    output,
    usage: {
      input_tokens: search.inputTokens,
      output_tokens: search.outputTokens,
      total_tokens: search.inputTokens + search.outputTokens,
    },
  }
}

const sse = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

export const codexWebSearchResponseToSse = (
  response: CodexWebSearchResponse,
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  const baseResponse = {
    id: response.id,
    object: response.object,
    created_at: response.created_at,
    model: response.model,
    status: "in_progress",
    output: [] as unknown[],
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(sse(event, data)))

      push("response.created", { type: "response.created", response: baseResponse })
      push("response.in_progress", {
        type: "response.in_progress",
        response: baseResponse,
      })

      response.output.forEach((item, index) => {
        push("response.output_item.added", {
          type: "response.output_item.added",
          output_index: index,
          item,
        })

        if (item.type === "message") {
          const part = { type: "output_text", text: "", annotations: [] }
          push("response.content_part.added", {
            type: "response.content_part.added",
            item_id: item.id,
            output_index: index,
            content_index: 0,
            part,
          })
          const text = item.content[0]?.text ?? ""
          if (text) {
            push("response.output_text.delta", {
              type: "response.output_text.delta",
              item_id: item.id,
              output_index: index,
              content_index: 0,
              delta: text,
            })
          }
          push("response.output_text.done", {
            type: "response.output_text.done",
            item_id: item.id,
            output_index: index,
            content_index: 0,
            text,
          })
          push("response.content_part.done", {
            type: "response.content_part.done",
            item_id: item.id,
            output_index: index,
            content_index: 0,
            part: item.content[0],
          })
        }

        push("response.output_item.done", {
          type: "response.output_item.done",
          output_index: index,
          item,
        })
      })

      push("response.completed", {
        type: "response.completed",
        response: { ...response, status: "completed" },
      })
      controller.close()
    },
  })
}

export async function createCodexWebSearchResponse(
  config: BridgeConfig,
  request: ResponsesRequestLike,
  options: CodexWebSearchOptions,
): Promise<CodexWebSearchResponse> {
  const search = await createWebSearchExecution(
    config,
    createExecutionRequest(request, options.requestedQuery),
    {
      backend: options.backend,
      copilotCliModel: request.model,
    },
  )

  return buildCodexWebSearchResponse(request, search)
}
