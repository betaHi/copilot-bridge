import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { accessSync, constants } from "node:fs"
import path from "node:path"

import type {
  AnthropicAssistantContentBlock,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamEventData,
  AnthropicWebSearchResultBlock,
} from "~/bridges/claude/anthropic-types"
import type { BridgeConfig } from "~/lib/config"
import {
  fetchCopilot,
  getCopilotProviderContext,
} from "~/providers/copilot/client"

const ANTHROPIC_WEB_SEARCH_TOOL_PATTERN = /^web_search_\d{8}$/
const DEFAULT_SEARXNG_BASE_URL = "http://localhost:8080"
const SEARCH_RESULT_LIMIT = 8
const SEARXNG_READINESS_TIMEOUT_MS = 800
const SEARXNG_TIMEOUT_MS = 10_000
const COPILOT_CLI_READINESS_TIMEOUT_MS = 15_000
const COPILOT_CLI_TIMEOUT_MS = 90_000
const COPILOT_CHAT_WRAPPER_PATH_PATTERN = /github\.copilot-chat[/\\]copilotCli/

interface ResponsesWebSearchResponse {
  id: string
  created_at: number
  model: string
  output?: Array<ResponsesOutputItem>
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
}

type ResponsesOutputItem =
  | {
      type: "web_search_call"
      action?: {
        query?: string
        queries?: Array<string>
      }
    }
  | {
      type: "message"
      content?: Array<{
        type?: string
        text?: string
      }>
    }
  | Record<string, unknown>

export interface SearchResult {
  snippet?: string
  title: string
  url: string
}

export interface SearchExecutionResult {
  id: string
  inputTokens: number
  model: string
  outputTokens: number
  query: string
  results: Array<SearchResult>
  text: string
}

interface CommandExecutionResult {
  stdout: string
  stderr: string
}

interface CommandExecutionFailure extends CommandExecutionResult {
  error: unknown
}

interface WebSearchOptions {
  backend?: string
  copilotCliModel: string
}

export interface WebSearchExecutionRequest {
  clientName: string
  configurationHint?: string
  maxOutputTokens?: number | null
  requestedQuery: string
  searchInput: string
  temperature?: number | null
  topP?: number | null
}

type WebSearchBackend =
  | { type: "not-configured" }
  | { type: "copilot-http"; model: string }
  | { type: "copilot-cli" }
  | { type: "searxng" }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const isAnthropicNativeWebSearchTool = (tool: unknown): boolean => {
  if (!isRecord(tool)) {
    return false
  }

  return (
    tool.name === "web_search"
    && typeof tool.type === "string"
    && ANTHROPIC_WEB_SEARCH_TOOL_PATTERN.test(tool.type)
  )
}

export const hasAnthropicNativeWebSearch = (
  payload: AnthropicMessagesPayload,
): boolean => payload.tools?.some(isAnthropicNativeWebSearchTool) ?? false

const textFromContent = (
  content: AnthropicMessagesPayload["messages"][number]["content"],
): string => {
  if (typeof content === "string") {
    return content
  }

  return content
    .flatMap((block) => {
      if (block.type === "text") return [block.text]
      if (block.type === "tool_result") return [block.content]
      return []
    })
    .join("\n\n")
}

const buildSearchInput = (payload: AnthropicMessagesPayload): string => {
  const systemText =
    typeof payload.system === "string" ? payload.system
    : Array.isArray(payload.system) ? payload.system.map((block) => block.text).join("\n\n")
    : ""

  const messages = payload.messages
    .map((message) => `${message.role}: ${textFromContent(message.content)}`)
    .join("\n\n")

  return [
    "You are fulfilling an Anthropic web_search server tool request for Claude Code.",
    "Search the web using the provided web_search_preview tool.",
    "Return useful search results as plain text lines in this exact shape:",
    "1. Title - https://example.com/page",
    "Include only real source URLs from the search results.",
    systemText ? `System context:\n${systemText}` : "",
    `Conversation:\n${messages}`,
  ]
    .filter(Boolean)
    .join("\n\n")
}

const createAnthropicSearchExecutionRequest = (
  payload: AnthropicMessagesPayload,
): WebSearchExecutionRequest => ({
  clientName: "Claude",
  maxOutputTokens: payload.max_tokens,
  requestedQuery: getRequestedQuery(payload),
  searchInput: buildSearchInput(payload),
  temperature: payload.temperature,
  topP: payload.top_p,
})

const getRequestedQuery = (payload: AnthropicMessagesPayload): string => {
  const lastUserMessage = [...payload.messages]
    .reverse()
    .find((message) => message.role === "user")
  const rawText = lastUserMessage ? textFromContent(lastUserMessage.content) : ""
  const cleaned = rawText
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const searchMatch = cleaned.match(/\bsearch(?:\s+the\s+web)?(?:\s+for)?\s+(.+)$/i)
  return searchMatch?.[1]?.trim() || cleaned || "web search"
}

const getSearchQuery = (
  response: ResponsesWebSearchResponse,
  request: WebSearchExecutionRequest,
): string => {
  for (const item of response.output ?? []) {
    if (item.type !== "web_search_call") continue
    const action = isRecord(item.action) ? item.action : undefined
    const queries = Array.isArray(action?.queries) ? action.queries : []
    const query =
      typeof action?.query === "string" ? action.query
      : typeof queries[0] === "string" ? queries[0]
      : undefined
    if (query) return query
  }

  return request.requestedQuery.slice(0, 200)
}

const getResponseText = (response: ResponsesWebSearchResponse): string =>
  (response.output ?? [])
    .flatMap((item) => {
      if (item.type !== "message") return []
      const content = Array.isArray(item.content) ? item.content : []
      return content.flatMap((part) => {
        if (!isRecord(part)) return []
        return part.type === "output_text" && typeof part.text === "string" ?
            [part.text]
          : []
      })
    })
    .join("\n")
    .trim()

const cleanTitle = (line: string, url: string): string => {
  const beforeUrl = line.slice(0, line.indexOf(url))
  const cleaned = beforeUrl
    .replace(/^\s*(?:[-*]|\d+[.)])\s*/, "")
    .replace(/\s*(?:[-–—:|])\s*$/, "")
    .trim()
  return cleaned || new URL(url).hostname
}

const parseSearchResults = (text: string): Array<SearchResult> => {
  const results: Array<SearchResult> = []
  const seenUrls = new Set<string>()

  for (const line of text.split(/\r?\n/)) {
    const markdownMatch = line.match(/\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/)
    const url = markdownMatch?.[2] ?? line.match(/https?:\/\/[^\s)]+/)?.[0]
    if (!url || seenUrls.has(url)) {
      continue
    }

    seenUrls.add(url)
    results.push({
      title: markdownMatch?.[1]?.trim() || cleanTitle(line, url),
      url,
    })

    if (results.length >= SEARCH_RESULT_LIMIT) {
      break
    }
  }

  return results
}

const formatSearchResultsText = (
  results: Array<SearchResult>,
  query: string,
): string => {
  if (results.length === 0) {
    return ""
  }

  return [
    `Web search results for query: "${query}"`,
    "",
    ...results.map((result, index) => {
      const snippet = result.snippet ? `\n   ${result.snippet}` : ""
      return `${index + 1}. ${result.title} - ${result.url}${snippet}`
    }),
  ].join("\n")
}

const buildSearchResultBlock = (
  toolUseId: string,
  results: Array<SearchResult>,
): AnthropicWebSearchResultBlock => ({
  type: "web_search_tool_result",
  tool_use_id: toolUseId,
  content:
    results.length > 0 ?
      results.map((result) => ({
        type: "web_search_result" as const,
        title: result.title,
        url: result.url,
        encrypted_content: "",
        page_age: null,
      }))
    : {
        type: "web_search_tool_result_error",
        error_code: "unavailable",
      },
})

const createAnthropicWebSearchResponse = (
  search: SearchExecutionResult,
): AnthropicResponse => {
  const toolUseId = `srvtoolu_${randomUUID().replaceAll("-", "")}`
  const content: Array<AnthropicAssistantContentBlock> = [
    {
      type: "server_tool_use",
      id: toolUseId,
      name: "web_search",
      input: { query: search.query },
    },
    buildSearchResultBlock(toolUseId, search.results),
  ]

  if (search.text) {
    content.push({ type: "text", text: search.text })
  }

  return {
    id: search.id,
    type: "message",
    role: "assistant",
    content,
    model: search.model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: search.inputTokens,
      output_tokens: search.outputTokens,
      server_tool_use: { web_search_requests: 1 },
    },
  }
}

const createFailedSearchExecution = (
  request: WebSearchExecutionRequest,
  model: string,
  message: string,
): SearchExecutionResult => ({
  id: `msg_${randomUUID().replaceAll("-", "")}`,
  inputTokens: 0,
  model,
  outputTokens: 0,
  query: request.requestedQuery,
  results: [],
  text: message,
})

const parseWebSearchBackend = (backend: string | undefined): WebSearchBackend => {
  const value = backend?.trim()
  if (!value) {
    return { type: "not-configured" }
  }

  const normalized = value.toLowerCase()
  if (normalized === "searxng") {
    return { type: "searxng" }
  }

  if (normalized === "copilot-cli" || normalized === "copilot" || normalized === "cli") {
    return { type: "copilot-cli" }
  }

  return { type: "copilot-http", model: value }
}

const createNotConfiguredSearchExecution = (
  request: WebSearchExecutionRequest,
): SearchExecutionResult =>
  createFailedSearchExecution(
    request,
    "web_search",
    [
      `${request.clientName} web search is not configured.`,
      request.configurationHint ?? "Set COPILOT_WEB_SEARCH_BACKEND in ~/.claude/settings.json to a Copilot Responses search model id such as gpt-5.5, searxng, or copilot-cli.",
    ].join("\n"),
  )

const buildWebSearchRequestPayload = (
  request: WebSearchExecutionRequest,
  model: string,
) => ({
  model,
  input: request.searchInput,
  tools: [{ type: "web_search_preview" }],
  max_output_tokens: Math.max(
    256,
    Math.min(request.maxOutputTokens ?? 1024, 1200),
  ),
  temperature: request.temperature,
  top_p: request.topP,
})

const createCopilotSearchExecution = async (
  config: BridgeConfig,
  request: WebSearchExecutionRequest,
  model: string,
): Promise<SearchExecutionResult> => {
  const provider = getCopilotProviderContext(config)
  const response = await fetchCopilot(
    provider,
    "/responses",
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(buildWebSearchRequestPayload(request, model)),
    },
    { initiator: "agent" },
  )

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    return createFailedSearchExecution(
      request,
      model,
      [
        `Copilot HTTP web search is not available for model ${model}.`,
        detail ? `Upstream response: ${detail}` : "",
        request.configurationHint ?? "Set COPILOT_WEB_SEARCH_BACKEND in ~/.claude/settings.json to a Copilot Responses search model id such as gpt-5.5, searxng, or copilot-cli.",
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }

  const upstream = (await response.json()) as ResponsesWebSearchResponse
  const text = getResponseText(upstream)
  const query = getSearchQuery(upstream, request)

  return {
    id: upstream.id,
    inputTokens: upstream.usage?.input_tokens ?? 0,
    model: upstream.model,
    outputTokens: upstream.usage?.output_tokens ?? 0,
    query,
    results: parseSearchResults(text),
    text,
  }
}

const isCommandExecutionFailure = (
  error: unknown,
): error is CommandExecutionFailure => isRecord(error) && "error" in error

const canExecute = (filePath: string): boolean => {
  try {
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const copilotExecutableNames = (): Array<string> =>
  process.platform === "win32" ?
    ["copilot.exe", "copilot.cmd", "copilot.bat", "copilot"]
  : ["copilot"]

const findCopilotCliCommand = (): string => {
  const candidates = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((directory) =>
      copilotExecutableNames().map((name) => path.join(directory, name)),
    )
    .filter(canExecute)

  return (
    candidates.find((candidate) => !COPILOT_CHAT_WRAPPER_PATH_PATTERN.test(candidate))
    ?? candidates[0]
    ?? "copilot"
  )
}

const runCopilotCliCommand = (
  args: Array<string>,
  timeout: number,
): Promise<CommandExecutionResult> =>
  new Promise((resolve, reject) => {
    const child = execFile(
      findCopilotCliCommand(),
      args,
      { encoding: "utf8", timeout },
      (error, stdout, stderr) => {
        if (error) {
          reject({ error, stdout, stderr })
          return
        }

        resolve({ stdout, stderr })
      },
    )
    child.stdin?.end("n\n")
  })

const commandOutput = (result: CommandExecutionResult): string =>
  [result.stdout, result.stderr].filter(Boolean).join("\n").trim()

const commandFailureDetail = (error: unknown): string => {
  if (isCommandExecutionFailure(error)) {
    const output = commandOutput(error)
    const message = error.error instanceof Error ? error.error.message : String(error.error)
    return [message, output ? `Output: ${output.slice(0, 500)}` : ""]
      .filter(Boolean)
      .join("\n")
  }

  return error instanceof Error ? error.message : String(error)
}

const looksLikeCopilotCliInstallPrompt = (text: string): boolean =>
  /(?:cannot find|install)\s+github\s+copilot\s+cli/i.test(text)
  || /install\s+github\s+copilot\s+cli\?/i.test(text)

const looksLikeCopilotCliAuthMissing = (text: string): boolean =>
  /no authentication information found/i.test(text)
  || /start 'copilot' and run the '\/login' command/i.test(text)
  || /set the copilot_github_token, gh_token, or github_token environment variable/i.test(text)

const checkCopilotCliAvailable = async (): Promise<string | undefined> => {
  try {
    const result = await runCopilotCliCommand(
      ["--version"],
      COPILOT_CLI_READINESS_TIMEOUT_MS,
    )
    const output = commandOutput(result)

    return looksLikeCopilotCliInstallPrompt(output) ?
        [
          "GitHub Copilot CLI is not installed.",
          output ? `Output: ${output.slice(0, 500)}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      : undefined
  } catch (error) {
    const detail = commandFailureDetail(error)
    return [
      looksLikeCopilotCliInstallPrompt(detail) ?
        "GitHub Copilot CLI is not installed."
      : "GitHub Copilot CLI is not available.",
      detail ? `Error: ${detail}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  }
}

const createCopilotCliSearchExecution = async (
  request: WebSearchExecutionRequest,
  model: string,
): Promise<SearchExecutionResult> => {
  const query = request.requestedQuery
  const unavailableReason = await checkCopilotCliAvailable()

  if (unavailableReason) {
    return createFailedSearchExecution(
      request,
      "copilot-cli",
      [
        unavailableReason,
        "Install and sign in to GitHub Copilot CLI yourself, or set COPILOT_WEB_SEARCH_BACKEND to a Copilot Responses search model id such as gpt-5.5 or to searxng.",
      ].join("\n"),
    )
  }

  const prompt = `Do a single web search for '${query}' and return useful results as plain text lines in this exact shape: 1. Title - https://example.com/page. No follow-up searches.`
  const args = [
    "-s",
    "-p",
    prompt,
    "--allow-tool",
    "web_search",
    "--available-tools",
    "web_search",
    "--model",
    model,
    "--max-autopilot-continues",
    "1",
  ]

  try {
    const result = await runCopilotCliCommand(args, COPILOT_CLI_TIMEOUT_MS)
    const text = commandOutput(result)
    const results = parseSearchResults(text)

    if (results.length === 0) {
      return createFailedSearchExecution(
        request,
        "copilot-cli",
        [
          "GitHub Copilot CLI web search did not return search results.",
          text ? `Output: ${text.slice(0, 500)}` : "",
          "Install and sign in to GitHub Copilot CLI yourself, or set COPILOT_WEB_SEARCH_BACKEND to a Copilot Responses search model id such as gpt-5.5 or to searxng.",
        ]
          .filter(Boolean)
          .join("\n"),
      )
    }

    return {
      id: `msg_${randomUUID().replaceAll("-", "")}`,
      inputTokens: 0,
      model: "copilot-cli",
      outputTokens: 0,
      query,
      results,
      text,
    }
  } catch (error) {
    const detail = commandFailureDetail(error)
    const authMessage = looksLikeCopilotCliAuthMissing(detail) ?
      [
        "GitHub Copilot CLI is not authenticated.",
        detail ? `Error: ${detail}` : "",
        "Run `copilot` and enter `/login`, sign in with GitHub CLI, or set COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN.",
      ]
        .filter(Boolean)
        .join("\n")
    : undefined

    if (authMessage) {
      return createFailedSearchExecution(request, "copilot-cli", authMessage)
    }

    return createFailedSearchExecution(
      request,
      "copilot-cli",
      [
        "GitHub Copilot CLI web search is not available.",
        detail ? `Error: ${detail}` : "",
        "Install and sign in to GitHub Copilot CLI yourself, or set COPILOT_WEB_SEARCH_BACKEND to a Copilot Responses search model id such as gpt-5.5 or to searxng.",
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }
}

const createSearxngUrl = (query: string): URL => {
  const url = new URL("/search", DEFAULT_SEARXNG_BASE_URL)
  url.searchParams.set("q", query)
  url.searchParams.set("format", "json")
  return url
}

const checkSearxngAvailable = async (): Promise<string | undefined> => {
  const response = await fetch(DEFAULT_SEARXNG_BASE_URL, {
    headers: { accept: "text/html,application/json" },
    signal: AbortSignal.timeout(SEARXNG_READINESS_TIMEOUT_MS),
  }).catch((error: unknown) => error)

  if (response instanceof Response) {
    return undefined
  }

  const detail = response instanceof Error ? response.message : String(response)
  return [
    "Local SearXNG web search is not available.",
    detail ? `Error: ${detail}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

const createSearxngSearchExecution = async (
  request: WebSearchExecutionRequest,
): Promise<SearchExecutionResult> => {
  const query = request.requestedQuery
  const unavailableReason = await checkSearxngAvailable()

  if (unavailableReason) {
    return createFailedSearchExecution(
      request,
      "searxng",
      [
        unavailableReason,
        "Start SearXNG at http://localhost:8080 yourself, or set COPILOT_WEB_SEARCH_BACKEND to a Copilot Responses search model id such as gpt-5.5 or to copilot-cli.",
      ].join("\n"),
    )
  }

  const response = await fetch(createSearxngUrl(query), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(SEARXNG_TIMEOUT_MS),
  }).catch((error: unknown) => error)

  if (!(response instanceof Response)) {
    const detail = response instanceof Error ? response.message : String(response)
    return createFailedSearchExecution(
      request,
      "searxng",
      [
        "Local SearXNG web search is not available.",
        detail ? `Error: ${detail}` : "",
        "Start SearXNG at http://localhost:8080 yourself, or set COPILOT_WEB_SEARCH_BACKEND to a Copilot Responses search model id such as gpt-5.5 or to copilot-cli.",
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    return createFailedSearchExecution(
      request,
      "searxng",
      [
        `Local SearXNG web search failed with HTTP ${response.status}.`,
        detail ? `Response: ${detail.slice(0, 500)}` : "",
        "Start SearXNG at http://localhost:8080 yourself, or set COPILOT_WEB_SEARCH_BACKEND to a Copilot Responses search model id such as gpt-5.5 or to copilot-cli.",
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }

  const data = (await response.json()) as { results?: Array<Record<string, unknown>> }
  const results = (data.results ?? [])
    .flatMap((result): Array<SearchResult> => {
      const title = typeof result.title === "string" ? result.title.trim() : ""
      const url = typeof result.url === "string" ? result.url.trim() : ""
      const snippet = typeof result.content === "string" ? result.content.trim() : undefined
      return title && url ? [{ title, url, snippet }] : []
    })
    .slice(0, SEARCH_RESULT_LIMIT)

  return {
    id: `msg_${randomUUID().replaceAll("-", "")}`,
    inputTokens: 0,
    model: "searxng",
    outputTokens: 0,
    query,
    results,
    text: formatSearchResultsText(results, query),
  }
}

export async function createWebSearchExecution(
  config: BridgeConfig,
  request: WebSearchExecutionRequest,
  options: WebSearchOptions,
): Promise<SearchExecutionResult> {
  const backend = parseWebSearchBackend(options.backend)
  return backend.type === "not-configured" ? createNotConfiguredSearchExecution(request)
    : backend.type === "searxng" ?
      await createSearxngSearchExecution(request)
    : backend.type === "copilot-cli" ?
      await createCopilotCliSearchExecution(request, options.copilotCliModel)
    : await createCopilotSearchExecution(config, request, backend.model)
}

export async function createClaudeWebSearchResponse(
  config: BridgeConfig,
  payload: AnthropicMessagesPayload,
  options: WebSearchOptions,
): Promise<AnthropicResponse> {
  const search = await createWebSearchExecution(
    config,
    createAnthropicSearchExecutionRequest(payload),
    options,
  )

  return createAnthropicWebSearchResponse(search)
}

export const webSearchResponseToEvents = (
  response: AnthropicResponse,
): Array<AnthropicStreamEventData> => {
  const events: Array<AnthropicStreamEventData> = [
    {
      type: "message_start",
      message: {
        ...response,
        content: [],
        stop_reason: null,
        stop_sequence: null,
      },
    },
  ]

  response.content.forEach((block, index) => {
    events.push({
      type: "content_block_start",
      index,
      content_block:
        block.type === "text" ? { type: "text", text: "" }
        : block,
    })

    if (block.type === "text" && block.text) {
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text },
      })
    } else if (block.type === "server_tool_use") {
      events.push({
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input),
        },
      })
    }

    events.push({ type: "content_block_stop", index })
  })

  events.push(
    {
      type: "message_delta",
      delta: {
        stop_reason: response.stop_reason,
        stop_sequence: response.stop_sequence,
      },
      usage: { output_tokens: response.usage.output_tokens },
    },
    { type: "message_stop" },
  )

  return events
}
