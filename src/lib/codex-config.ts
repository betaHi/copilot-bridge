import fs from "node:fs/promises"
import path from "node:path"

import type { CodexSettings } from "./settings"

const BEGIN_MARK =
  "# >>> copilot-bridge managed block — auto-generated, do not edit between markers >>>"
const END_MARK =
  "# <<< copilot-bridge managed block — edits outside this block are preserved <<<"

// Legacy markers from earlier releases. We still recognize and strip them so
// upgrading users do not end up with duplicate managed blocks.
const LEGACY_BEGIN_MARK = "# >>> copilot-bridge managed (do not edit) >>>"
const LEGACY_END_MARK = "# <<< copilot-bridge managed (do not edit) <<<"

// Top-level keys that the user (or codex itself) is the owner of.
// We never put these in our managed block to avoid TOML duplicate-key errors.
const USER_OWNED_SCALARS = ["model", "model_reasoning_effort"] as const
type UserScalar = (typeof USER_OWNED_SCALARS)[number]

interface ApplyCodexConfigInput {
  baseUrl: string
  settings: CodexSettings
  /** Optional model to write into the user-owned area of the file. */
  model?: string
  /** Optional reasoning effort to write into the user-owned area. */
  modelReasoningEffort?: string
}

interface ApplyResult {
  configPath: string
  changed: boolean
  created: boolean
}

export interface CodexUserConfig {
  model?: string
  modelReasoningEffort?: string
}

function tomlEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function buildManagedBlock(input: ApplyCodexConfigInput): string {
  const { baseUrl, settings } = input
  const lines: Array<string> = []
  lines.push(BEGIN_MARK)
  if (settings.setAsDefault) {
    lines.push(`model_provider = "${tomlEscape(settings.providerId)}"`)
  }
  lines.push("")
  lines.push(`[model_providers.${settings.providerId}]`)
  lines.push(`name = "${tomlEscape(settings.providerName)}"`)
  lines.push(`base_url = "${tomlEscape(baseUrl)}"`)
  lines.push(`wire_api = "responses"`)
  lines.push(`prefer_websockets = false`)
  lines.push(`requires_openai_auth = false`)
  lines.push(END_MARK)
  return lines.join("\n")
}

function stripManagedBlock(content: string): string {
  let next = content
  for (const [begin, end] of [
    [BEGIN_MARK, END_MARK],
    [LEGACY_BEGIN_MARK, LEGACY_END_MARK],
  ]) {
    while (true) {
      const beginIdx = next.indexOf(begin)
      if (beginIdx === -1) break
      const endIdx = next.indexOf(end, beginIdx)
      if (endIdx === -1) break
      const before = next.slice(0, beginIdx).replace(/\n*$/, "")
      const after = next.slice(endIdx + end.length).replace(/^\n+/, "")
      if (before.length === 0) next = after
      else if (after.length === 0) next = `${before}\n`
      else next = `${before}\n\n${after}`
    }
  }
  return next
}

// Lines belonging to the first (top-level) TOML section: from the start of
// the file up to the first line that begins with `[`. This is where
// codex's own `model = ...` and `model_reasoning_effort = ...` live.
function splitTopSection(content: string): {
  top: string
  rest: string
} {
  const lines = content.split("\n")
  let cut = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      cut = i
      break
    }
  }
  return {
    top: lines.slice(0, cut).join("\n"),
    rest: lines.slice(cut).join("\n"),
  }
}

const scalarRegex = (key: string) =>
  new RegExp(`^\\s*${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*$`, "m")

export function readCodexUserConfig(content: string): CodexUserConfig {
  const stripped = stripManagedBlock(content)
  const { top } = splitTopSection(stripped)
  const out: CodexUserConfig = {}
  const m = top.match(scalarRegex("model"))
  if (m) out.model = m[1]
  const e = top.match(scalarRegex("model_reasoning_effort"))
  if (e) out.modelReasoningEffort = e[1]
  return out
}

function setTopScalar(
  topSection: string,
  key: UserScalar,
  value: string | undefined,
): string {
  const re = scalarRegex(key)
  if (value === undefined) {
    // Leave the existing value as-is when caller did not provide one.
    return topSection
  }
  const line = `${key} = "${tomlEscape(value)}"`
  if (re.test(topSection)) {
    return topSection.replace(re, line)
  }
  // Insert at the very top of the file, before any existing content.
  if (topSection.length === 0) return `${line}\n`
  // Keep a single blank line between our inserted scalars and existing content.
  return `${line}\n${topSection.startsWith("\n") ? "" : ""}${topSection}`
}

function applyUserScalars(
  content: string,
  input: ApplyCodexConfigInput,
): string {
  const { top, rest } = splitTopSection(content)
  let nextTop = top
  nextTop = setTopScalar(nextTop, "model", input.model)
  nextTop = setTopScalar(
    nextTop,
    "model_reasoning_effort",
    input.modelReasoningEffort,
  )
  if (nextTop === top) return content
  if (rest.length === 0) {
    return nextTop.endsWith("\n") ? nextTop : `${nextTop}\n`
  }
  const sep = nextTop.endsWith("\n") ? "" : "\n"
  return `${nextTop}${sep}${rest}`
}

export async function applyCodexConfig(
  input: ApplyCodexConfigInput & { configPath: string },
): Promise<ApplyResult> {
  const { configPath } = input
  let existing = ""
  let created = false
  try {
    existing = await fs.readFile(configPath, "utf8")
  } catch {
    created = true
  }

  let stripped = stripManagedBlock(existing)
  stripped = applyUserScalars(stripped, input)
  const block = buildManagedBlock(input)
  const trimmed = stripped.replace(/\n+$/, "")
  const next =
    trimmed.length === 0 ? `${block}\n` : `${trimmed}\n\n${block}\n`

  if (next === existing) {
    return { configPath, changed: false, created: false }
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, next)
  return { configPath, changed: true, created }
}

export async function readCodexUserConfigFromDisk(
  configPath: string,
): Promise<CodexUserConfig> {
  try {
    const content = await fs.readFile(configPath, "utf8")
    return readCodexUserConfig(content)
  } catch {
    return {}
  }
}
