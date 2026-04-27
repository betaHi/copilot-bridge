import fs from "node:fs/promises"

import type { BridgeConfig } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { PATHS } from "~/lib/paths"

const COPILOT_VERSION = "0.26.7"
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`
const GITHUB_API_VERSION = "2022-11-28"
const GITHUB_API_BASE_URL = "https://api.github.com"

export interface QuotaDetail {
  entitlement: number
  overage_count: number
  overage_permitted: boolean
  percent_remaining: number
  quota_id: string
  quota_remaining: number
  remaining: number
  unlimited: boolean
}

export interface CopilotUsageResponse {
  access_type_sku: string
  analytics_tracking_id: string
  assigned_date: string
  can_signup_for_limited: boolean
  chat_enabled: boolean
  copilot_plan: string
  organization_login_list: Array<unknown>
  organization_list: Array<unknown>
  quota_reset_date: string
  quota_snapshots: {
    chat: QuotaDetail
    completions: QuotaDetail
    premium_interactions: QuotaDetail
  }
}

const readGitHubToken = async (): Promise<string> => {
  const token = await fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")
  return token.trim()
}

export const getCopilotUsage = async (
  config: BridgeConfig,
): Promise<CopilotUsageResponse> => {
  const githubToken = await readGitHubToken()
  const response = await fetch(
    `${GITHUB_API_BASE_URL}/copilot_internal/user`,
    {
      headers: {
        accept: "application/json",
        authorization: `token ${githubToken}`,
        "editor-plugin-version": EDITOR_PLUGIN_VERSION,
        "editor-version": `vscode/${config.vsCodeVersion}`,
        "user-agent": USER_AGENT,
        "x-github-api-version": GITHUB_API_VERSION,
        "x-vscode-user-agent-library-version": "electron-fetch",
      },
    },
  )

  if (!response.ok) {
    throw new HTTPError("Failed to get Copilot usage", response)
  }

  return (await response.json()) as CopilotUsageResponse
}
