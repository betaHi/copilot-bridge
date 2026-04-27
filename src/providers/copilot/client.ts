import { randomUUID } from "node:crypto"

import type { BridgeConfig } from "~/lib/config"
import { BridgeNotImplementedError } from "~/lib/error"

const COPILOT_VERSION = "0.26.7"
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`
const API_VERSION = "2025-04-01"

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

  if (!headers.has("content-type") && init.body !== undefined) {
    headers.set("content-type", "application/json")
  }

  if (!headers.has("accept")) {
    headers.set("accept", "application/json")
  }

  return fetch(`${provider.baseUrl}${path}`, {
    ...init,
    headers,
  })
}
