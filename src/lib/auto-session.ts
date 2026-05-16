import consola from "consola"

import type { BridgeConfig } from "~/lib/config"
import { runtimeState } from "~/lib/state"

interface AutoSessionResponse {
  session_token: string
  available_models?: Array<string>
  expires_at?: number | string
}

const AUTO_MODE_BODY = { auto_mode: { model_hints: ["auto"] } }
const FALLBACK_REFRESH_SECONDS = 30 * 60

const parseExpiresAt = (value: number | string | undefined): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string") {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) {
      return numeric
    }
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed / 1000)
    }
  }
  return undefined
}

export const fetchAutoSession = async (
  config: BridgeConfig,
): Promise<AutoSessionResponse> => {
  if (!config.copilotToken) {
    throw new Error(
      "COPILOT_TOKEN is not configured; cannot start auto mode",
    )
  }

  const response = await fetch(`${config.copilotBaseUrl}/models/session`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.copilotToken}`,
      "content-type": "application/json",
      "x-github-api-version": "2025-10-01",
      "copilot-integration-id": "vscode-chat",
    },
    body: JSON.stringify(AUTO_MODE_BODY),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(
      `Failed to acquire auto-mode session token: ${response.status} ${response.statusText}\n${text}`,
    )
  }

  return (await response.json()) as AutoSessionResponse
}

const applyAutoSession = async (config: BridgeConfig) => {
  const data = await fetchAutoSession(config)
  runtimeState.autoSessionToken = data.session_token
  runtimeState.autoExpiresAt = parseExpiresAt(data.expires_at)
  runtimeState.autoAvailableModels = data.available_models
  return data
}

const scheduleAutoSessionRefresh = (config: BridgeConfig) => {
  const now = Math.floor(Date.now() / 1000)
  const expiresAt =
    runtimeState.autoExpiresAt ?? now + FALLBACK_REFRESH_SECONDS
  const refreshIn = Math.max(expiresAt - now - 60, 60)

  const timer = setTimeout(async () => {
    try {
      await applyAutoSession(config)
      consola.debug("Refreshed Copilot auto-mode session token")
    } catch (error) {
      consola.error("Failed to refresh auto-mode session token:", error)
    } finally {
      scheduleAutoSessionRefresh(config)
    }
  }, refreshIn * 1000)

  if (typeof timer.unref === "function") {
    timer.unref()
  }
}

export const enableAutoMode = async (
  config: BridgeConfig,
): Promise<AutoSessionResponse> => {
  const data = await applyAutoSession(config)
  runtimeState.autoMode = true
  scheduleAutoSessionRefresh(config)
  return data
}
