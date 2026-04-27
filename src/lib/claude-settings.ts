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
