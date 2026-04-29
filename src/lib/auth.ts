import fs from "node:fs/promises"

import consola from "consola"

import type { BridgeConfig } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { PATHS, ensurePaths } from "~/lib/paths"
import { runtimeState } from "~/lib/state"
import { getModels } from "~/providers/copilot/get-models"

const COPILOT_VERSION = "0.26.7"
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`
const GITHUB_API_VERSION = "2022-11-28"

const GITHUB_API_BASE_URL = "https://api.github.com"
const GITHUB_BASE_URL = "https://github.com"
const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
const GITHUB_APP_SCOPES = ["read:user"].join(" ")

interface DeviceCodeResponse {
  device_code: string
  expires_in: number
  interval: number
  user_code: string
  verification_uri: string
}

interface AccessTokenResponse {
  access_token?: string
}

interface CopilotTokenResponse {
  refresh_in: number
  token: string
}

interface GitHubUserResponse {
  login: string
}

interface AuthOptions {
  force?: boolean
  showToken?: boolean
}

const standardHeaders = () => ({
  accept: "application/json",
  "content-type": "application/json",
})

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const readGitHubToken = async () => {
  const token = await fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")
  return token.trim()
}

const writeGitHubToken = (token: string) =>
  fs.writeFile(PATHS.GITHUB_TOKEN_PATH, `${token.trim()}\n`, { mode: 0o600 })

const githubHeaders = (githubToken: string, vsCodeVersion: string) => ({
  ...standardHeaders(),
  authorization: `token ${githubToken}`,
  "editor-plugin-version": EDITOR_PLUGIN_VERSION,
  "editor-version": `vscode/${vsCodeVersion}`,
  "user-agent": USER_AGENT,
  "x-github-api-version": GITHUB_API_VERSION,
  "x-vscode-user-agent-library-version": "electron-fetch",
})

const getDeviceCode = async (): Promise<DeviceCodeResponse> => {
  const response = await fetch(`${GITHUB_BASE_URL}/login/device/code`, {
    method: "POST",
    headers: standardHeaders(),
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: GITHUB_APP_SCOPES,
    }),
  })

  if (!response.ok) {
    throw new HTTPError("Failed to get device code", response)
  }

  return (await response.json()) as DeviceCodeResponse
}

const pollAccessToken = async (
  deviceCode: DeviceCodeResponse,
): Promise<string> => {
  const sleepDuration = (deviceCode.interval + 1) * 1000

  while (true) {
    const response = await fetch(`${GITHUB_BASE_URL}/login/oauth/access_token`, {
      method: "POST",
      headers: standardHeaders(),
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    })

    if (!response.ok) {
      await sleep(sleepDuration)
      continue
    }

    const json = (await response.json()) as AccessTokenResponse
    if (json.access_token) {
      return json.access_token
    }

    await sleep(sleepDuration)
  }
}

const getGitHubUser = async (
  githubToken: string,
  vsCodeVersion: string,
): Promise<GitHubUserResponse> => {
  const response = await fetch(`${GITHUB_API_BASE_URL}/user`, {
    headers: githubHeaders(githubToken, vsCodeVersion),
  })

  if (!response.ok) {
    throw new HTTPError("Failed to get GitHub user", response)
  }

  return (await response.json()) as GitHubUserResponse
}

const getCopilotToken = async (
  githubToken: string,
  vsCodeVersion: string,
): Promise<CopilotTokenResponse> => {
  const response = await fetch(
    `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`,
    {
      headers: githubHeaders(githubToken, vsCodeVersion),
    },
  )

  if (!response.ok) {
    throw new HTTPError("Failed to get Copilot token", response)
  }

  return (await response.json()) as CopilotTokenResponse
}

const isCopilotTokenError = (error: unknown): boolean =>
  error instanceof HTTPError && error.message === "Failed to get Copilot token"

const ensureGitHubToken = async (
  config: BridgeConfig,
  options: AuthOptions = {},
) => {
  await ensurePaths()

  const existingToken = options.force ? "" : await readGitHubToken()
  if (existingToken) {
    return existingToken
  }

  const deviceCode = await getDeviceCode()
  consola.info(
    `Open ${deviceCode.verification_uri} and enter code ${deviceCode.user_code}`,
  )

  const githubToken = await pollAccessToken(deviceCode)
  await writeGitHubToken(githubToken)

  if (options.showToken) {
    consola.info("GitHub token:", githubToken)
  }

  const user = await getGitHubUser(githubToken, config.vsCodeVersion)
  consola.success(`Logged in as ${user.login}`)

  return githubToken
}

export const setupBridgeAuth = async (
  config: BridgeConfig,
  options: AuthOptions = {},
) => {
  if (config.copilotToken) {
    if (options.showToken) {
      consola.info("Using COPILOT_TOKEN from environment")
    }
    await loadModels(config)
    return
  }

  let githubToken = await ensureGitHubToken(config, options)
  const applyCopilotToken = async () => {
    const { refresh_in, token } = await getCopilotToken(
      githubToken,
      config.vsCodeVersion,
    )

    config.copilotToken = token
    if (options.showToken) {
      consola.info("Copilot token:", token)
    }

    return refresh_in
  }

  let refreshIn: number
  try {
    refreshIn = await applyCopilotToken()
  } catch (error) {
    if (options.force || !isCopilotTokenError(error)) {
      throw error
    }

    consola.warn(
      "Cached GitHub auth could not get a Copilot token; running device auth again.",
    )
    githubToken = await ensureGitHubToken(config, {
      ...options,
      force: true,
    })
    refreshIn = await applyCopilotToken()
  }
  const refreshInterval = Math.max(refreshIn - 60, 60) * 1000

  setInterval(async () => {
    try {
      await applyCopilotToken()
      consola.debug("Refreshed Copilot token")
    } catch (error) {
      consola.error("Failed to refresh Copilot token:", error)
    }
  }, refreshInterval)

  await loadModels(config)
}

const loadModels = async (config: BridgeConfig) => {
  try {
    runtimeState.models = await getModels(config)
    consola.success(
      `Loaded ${runtimeState.models.data.length} Copilot models`,
    )
  } catch (error) {
    consola.warn("Failed to load Copilot models:", error)
  }
}

export const runBridgeAuth = async (
  config: BridgeConfig,
  options: AuthOptions = {},
) => {
  const githubToken = await ensureGitHubToken(config, {
    ...options,
    force: true,
  })

  const user = await getGitHubUser(githubToken, config.vsCodeVersion)
  consola.success(`GitHub token written to ${PATHS.GITHUB_TOKEN_PATH}`)
  consola.info(`Logged in as ${user.login}`)
}