import os from "node:os"
import path from "node:path"

/**
 * Static defaults for the bridge. Previously these lived in
 * `~/.config/copilot-bridge/settings.json`, but that file ended up being a
 * silent third source of truth (alongside `~/.codex/config.toml` and
 * `~/.claude/settings.json`) which caused subtle port-mismatch bugs. The
 * bridge now relies on these defaults plus CLI flags only — every other
 * persisted state lives in the consumer config files (codex / claude).
 */

export interface CodexDefaults {
  providerId: string
  providerName: string
  setAsDefault: boolean
  configPath: string
}

export const DEFAULT_HOST = "127.0.0.1"
export const DEFAULT_PORT = 4142

export const CODEX_DEFAULTS: CodexDefaults = {
  providerId: "bridge",
  providerName: "Copilot Bridge",
  setAsDefault: true,
  configPath: path.join(os.homedir(), ".codex", "config.toml"),
}

export const CLAUDE_CONFIG_PATH = path.join(
  os.homedir(),
  ".claude",
  "settings.json",
)
