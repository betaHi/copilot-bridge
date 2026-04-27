import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import consola from "consola"

interface ClaudeSettingsFile {
  env?: Record<string, unknown>
}

const getClaudeSettingsPaths = (): Array<string> => {
  const cwd = process.cwd()
  const home = process.env.HOME ?? os.homedir()

  return [
    path.join(home, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.local.json"),
  ]
}

const readClaudeSettingsFile = async (
  filePath: string,
): Promise<ClaudeSettingsFile | undefined> => {
  try {
    const content = await fs.readFile(filePath, "utf8")
    return JSON.parse(content) as ClaudeSettingsFile
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined
    }
    consola.warn(`Failed to read Claude settings from ${filePath}:`, error)
    return undefined
  }
}

/**
 * Read just the `ANTHROPIC_BASE_URL` from a single Claude settings file.
 * Used at startup so the user can pin the bridge port by editing one place
 * instead of passing `--port` every time.
 */
export const readClaudeBaseUrl = async (
  configPath: string,
): Promise<string | undefined> => {
  const settings = await readClaudeSettingsFile(configPath)
  const value = settings?.env?.ANTHROPIC_BASE_URL
  return typeof value === "string" ? value : undefined
}

/**
 * Parse the port from an `ANTHROPIC_BASE_URL`-style string. Returns
 * `undefined` if the URL is malformed or has no explicit port.
 */
export const parsePortFromBaseUrl = (
  baseUrl: string | undefined,
): number | undefined => {
  if (!baseUrl) return undefined
  try {
    const url = new URL(baseUrl)
    if (!url.port) return undefined
    const port = Number.parseInt(url.port, 10)
    return Number.isFinite(port) && port > 0 ? port : undefined
  } catch {
    return undefined
  }
}

export const getClaudeSettingsEnv = async (): Promise<
  Record<string, string>
> => {
  const merged: Record<string, string> = {}

  for (const filePath of getClaudeSettingsPaths()) {
    const settings = await readClaudeSettingsFile(filePath)
    if (!settings?.env) continue

    for (const [key, value] of Object.entries(settings.env)) {
      if (typeof value === "string") merged[key] = value
    }
  }

  return merged
}

interface ApplyClaudeConfigInput {
  baseUrl: string
  configPath: string
}

interface ApplyClaudeResult {
  configPath: string
  changed: boolean
  created: boolean
  previousBaseUrl?: string
}

/**
 * Update `~/.claude/settings.json` so its env block points Claude Code at the
 * running bridge. Preserves all unrelated keys (model overrides, plugins,
 * marketplaces, etc.). Sets a dummy auth token only if none is present.
 */
export async function applyClaudeConfig(
  input: ApplyClaudeConfigInput,
): Promise<ApplyClaudeResult> {
  const { configPath, baseUrl } = input

  let raw = ""
  let created = false
  try {
    raw = await fs.readFile(configPath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      created = true
    } else {
      throw error
    }
  }

  let parsed: Record<string, unknown> = {}
  if (raw.trim().length > 0) {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        parsed = {}
      }
    } catch {
      // Refuse to overwrite a malformed file; bail without changes.
      return { configPath, changed: false, created: false }
    }
  }

  const env: Record<string, unknown> =
    typeof parsed.env === "object"
    && parsed.env !== null
    && !Array.isArray(parsed.env)
      ? { ...(parsed.env as Record<string, unknown>) }
      : {}

  const previousBaseUrl =
    typeof env.ANTHROPIC_BASE_URL === "string"
      ? (env.ANTHROPIC_BASE_URL as string)
      : undefined

  env.ANTHROPIC_BASE_URL = baseUrl
  if (typeof env.ANTHROPIC_AUTH_TOKEN !== "string" || !env.ANTHROPIC_AUTH_TOKEN) {
    env.ANTHROPIC_AUTH_TOKEN = "dummy"
  }

  const next: Record<string, unknown> = { ...parsed, env }
  const serialized = `${JSON.stringify(next, null, 2)}\n`

  if (serialized === raw) {
    return { configPath, changed: false, created: false, previousBaseUrl }
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, serialized)
  return { configPath, changed: true, created, previousBaseUrl }
}
