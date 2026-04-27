import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const SETTINGS_DIR = path.join(os.homedir(), ".config", "copilot-bridge")
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json")

export interface CodexSettings {
  enabled: boolean
  providerId: string
  providerName: string
  setAsDefault: boolean
  configPath: string
}

export interface ClaudeSettings {
  enabled: boolean
  configPath: string
}

export interface BridgeSettings {
  host: string
  port: number
  codex: CodexSettings
  claude: ClaudeSettings
}

const DEFAULT_SETTINGS: BridgeSettings = {
  host: "127.0.0.1",
  port: 4142,
  codex: {
    enabled: true,
    providerId: "bridge",
    providerName: "Copilot Bridge",
    setAsDefault: true,
    configPath: path.join(os.homedir(), ".codex", "config.toml"),
  },
  claude: {
    enabled: true,
    configPath: path.join(os.homedir(), ".claude", "settings.json"),
  },
}

export const SETTINGS_PATHS = { SETTINGS_DIR, SETTINGS_FILE }

function deepMerge<T>(base: T, override: unknown): T {
  if (
    typeof base !== "object"
    || base === null
    || Array.isArray(base)
    || typeof override !== "object"
    || override === null
    || Array.isArray(override)
  ) {
    return (override ?? base) as T
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    out[key] = deepMerge((base as Record<string, unknown>)[key], value)
  }
  return out as T
}

export async function loadSettings(): Promise<BridgeSettings> {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, "utf8")
    const parsed = JSON.parse(raw) as unknown
    return deepMerge(DEFAULT_SETTINGS, parsed)
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      codex: { ...DEFAULT_SETTINGS.codex },
      claude: { ...DEFAULT_SETTINGS.claude },
    }
  }
}

export async function ensureSettingsFile(): Promise<BridgeSettings> {
  const settings = await loadSettings()
  try {
    await fs.access(SETTINGS_FILE)
  } catch {
    await fs.mkdir(SETTINGS_DIR, { recursive: true })
    await fs.writeFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`)
  }
  return settings
}

export async function saveSettings(settings: BridgeSettings): Promise<void> {
  await fs.mkdir(SETTINGS_DIR, { recursive: true })
  await fs.writeFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`)
}
