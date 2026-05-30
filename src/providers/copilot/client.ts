import { randomUUID } from "node:crypto"
import { appendFile } from "node:fs/promises"

import type { BridgeConfig } from "~/lib/config"
import { BridgeNotImplementedError } from "~/lib/error"
import { runtimeState } from "~/lib/state"

const COPILOT_VERSION = "0.26.7"
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`
const API_VERSION = "2025-04-01"
const AUTO_MODE_API_VERSION = "2025-10-01"
const MAX_FETCH_ATTEMPTS = 2

export interface CopilotProviderContext {
  baseUrl: string
  token: string | undefined
  vsCodeVersion: string
}

export const getCopilotProviderContext = (
  config: BridgeConfig,
): CopilotProviderContext => ({
  baseUrl: config.copilotBaseUrl,
  token: config.copilotToken,
  vsCodeVersion: config.vsCodeVersion,
})

export interface FetchCopilotOptions {
  vision?: boolean
  initiator?: "agent" | "user"
}

const shouldRetryResponse = (response: Response): boolean =>
  response.status >= 500 && response.status <= 599

const buildHeaders = (
  provider: CopilotProviderContext,
  path: string,
  init: RequestInit,
  options: FetchCopilotOptions,
): Headers => {
  const headers = new Headers(init.headers)

  headers.set("authorization", `Bearer ${provider.token}`)
  headers.set("copilot-integration-id", "vscode-chat")
  headers.set("editor-version", `vscode/${provider.vsCodeVersion}`)
  headers.set("editor-plugin-version", EDITOR_PLUGIN_VERSION)
  headers.set("user-agent", USER_AGENT)
  headers.set("openai-intent", "conversation-panel")
  headers.set("x-github-api-version", API_VERSION)
  headers.set("x-request-id", randomUUID())
  headers.set("x-vscode-user-agent-library-version", "electron-fetch")

  if (options.vision) {
    headers.set("copilot-vision-request", "true")
  }

  if (options.initiator) {
    headers.set("x-initiator", options.initiator)
  }

  if (runtimeState.autoSessionToken && (path.startsWith("/chat/completions") || path.startsWith("/responses"))) {
    headers.set("copilot-session-token", runtimeState.autoSessionToken),
    headers.set("x-github-api-version", AUTO_MODE_API_VERSION)
  }

  if (!headers.has("content-type") && init.body !== undefined) {
    headers.set("content-type", "application/json")
  }

  if (!headers.has("accept")) {
    headers.set("accept", "application/json")
  }

  return headers
}

const parseTraceBody = (body: RequestInit["body"]): unknown => {
  if (typeof body !== "string") {
    return undefined
  }

  try {
    return JSON.parse(body) as unknown
  } catch {
    return body
  }
}

const traceCopilotRequest = async (
  path: string,
  init: RequestInit,
  options: FetchCopilotOptions,
  attempt: number,
) => {
  const traceFile = process.env.COPILOT_BRIDGE_TRACE_REQUESTS_FILE
  if (!traceFile) {
    return
  }

  await appendFile(
    traceFile,
    `${JSON.stringify({
      attempt,
      body: parseTraceBody(init.body),
      method: init.method ?? "GET",
      options,
      path,
      timestamp: new Date().toISOString(),
    })}\n`,
  )
}

export const fetchCopilot = async (
  provider: CopilotProviderContext,
  path: string,
  init: RequestInit,
  options: FetchCopilotOptions = {},
) => {
  if (!provider.token) {
    throw new BridgeNotImplementedError(
      "COPILOT_TOKEN is not configured for copilot-bridge.",
    )
  }

  let lastError: unknown

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      await traceCopilotRequest(path, init, options, attempt)
      const response = await fetch(`${provider.baseUrl}${path}`, {
        ...init,
        headers: buildHeaders(provider, path, init, options),
      })

      if (!shouldRetryResponse(response) || attempt === MAX_FETCH_ATTEMPTS) {
        return response
      }
    } catch (error) {
      lastError = error
      if (attempt === MAX_FETCH_ATTEMPTS) {
        throw error
      }
    }
  }

  throw lastError
}
