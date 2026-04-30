import { createHash } from "node:crypto"

import type { AnthropicTool } from "~/bridges/claude/anthropic-types"

const STRICT_TOOL_NAME_CHARS_PATTERN = /^[A-Za-z0-9_-]+$/
const DOTTED_TOOL_NAME_CHARS_PATTERN = /^[A-Za-z0-9_.-]+$/
const DEFAULT_TOOL_NAME_MAX_LENGTH = 64
const EXTENDED_TOOL_NAME_MAX_LENGTH = 128
const HASH_LENGTH = 10

export interface AnthropicToolNameMapper {
  toAnthropic(name: string): string
  toOpenAI(name: string): string
}

interface ToolNameMapperOptions {
  allowDots?: boolean
  maxNameLength?: number
}

export const getToolNameMapperOptionsForModel = (
  modelId: string,
): Required<ToolNameMapperOptions> => {
  const normalized = modelId
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/, "-1m")
    .replace(/[._]/g, "-")

  if (/^claude-opus-4-(?:6|7)(?:$|-)/.test(normalized)) {
    return { allowDots: false, maxNameLength: EXTENDED_TOOL_NAME_MAX_LENGTH }
  }

  if (/^claude-sonnet-4(?:$|-\d{8}$)/.test(normalized)) {
    return { allowDots: false, maxNameLength: EXTENDED_TOOL_NAME_MAX_LENGTH }
  }

  if (normalized.startsWith("gemini-")) {
    return { allowDots: true, maxNameLength: EXTENDED_TOOL_NAME_MAX_LENGTH }
  }

  if (
    /^gpt-5-(?:2|4)(?:$|-)/.test(normalized)
    || /^gpt-5-(?:2|3)-codex(?:$|-)/.test(normalized)
    || /^gpt-5-4-mini(?:$|-)/.test(normalized)
    || /^gpt-5-5(?:$|-)/.test(normalized)
  ) {
    return { allowDots: false, maxNameLength: EXTENDED_TOOL_NAME_MAX_LENGTH }
  }

  if (normalized.startsWith("gpt-")) {
    return { allowDots: true, maxNameLength: EXTENDED_TOOL_NAME_MAX_LENGTH }
  }

  return { allowDots: false, maxNameLength: DEFAULT_TOOL_NAME_MAX_LENGTH }
}

export const getClaudeToolNameMaxLength = (modelId: string): number =>
  getToolNameMapperOptionsForModel(modelId).maxNameLength

const makeHash = (value: string): string =>
  createHash("sha1").update(value).digest("hex").slice(0, HASH_LENGTH)

const getAllowedNamePattern = (allowDots: boolean): RegExp =>
  allowDots ? DOTTED_TOOL_NAME_CHARS_PATTERN : STRICT_TOOL_NAME_CHARS_PATTERN

const cleanToolName = (name: string, allowDots: boolean): string => {
  const invalidCharsPattern = allowDots ? /[^A-Za-z0-9_.-]/g : /[^A-Za-z0-9_-]/g
  const cleaned = name.replace(invalidCharsPattern, "_").replace(/_+/g, "_")
  return cleaned.replace(/^_+|_+$/g, "") || "tool"
}

const isValidToolName = (
  name: string,
  maxNameLength: number,
  allowDots: boolean,
): boolean =>
  name.length > 0
  && name.length <= maxNameLength
  && getAllowedNamePattern(allowDots).test(name)

const makeValidToolName = (
  name: string,
  maxNameLength: number,
  allowDots: boolean,
): string => {
  if (isValidToolName(name, maxNameLength, allowDots)) {
    return name
  }

  const cleaned = cleanToolName(name, allowDots)
  if (cleaned.length <= maxNameLength) {
    return cleaned
  }

  const hash = makeHash(name)
  const prefixLength = maxNameLength - hash.length - 1
  return `${cleaned.slice(0, prefixLength)}_${hash}`
}

const makeUniqueToolName = (
  name: string,
  used: Set<string>,
  maxNameLength: number,
  allowDots: boolean,
): string => {
  const candidate = makeValidToolName(name, maxNameLength, allowDots)
  if (!used.has(candidate)) {
    return candidate
  }

  for (let index = 2; ; index++) {
    const suffix = `_${makeHash(`${name}:${index}`)}`
    const prefixLength = maxNameLength - suffix.length
    const next = `${cleanToolName(name, allowDots).slice(0, prefixLength)}${suffix}`
    if (!used.has(next)) {
      return next
    }
  }
}

export const createAnthropicToolNameMapper = (
  tools: Array<AnthropicTool> | undefined,
  options: ToolNameMapperOptions = {},
): AnthropicToolNameMapper => {
  const maxNameLength = options.maxNameLength ?? DEFAULT_TOOL_NAME_MAX_LENGTH
  const allowDots = options.allowDots ?? false
  const anthropicToOpenAI = new Map<string, string>()
  const openAIToAnthropic = new Map<string, string>()
  const used = new Set<string>()

  for (const tool of tools ?? []) {
    if (anthropicToOpenAI.has(tool.name)) {
      continue
    }

    const openAIName = makeUniqueToolName(
      tool.name,
      used,
      maxNameLength,
      allowDots,
    )
    used.add(openAIName)
    anthropicToOpenAI.set(tool.name, openAIName)
    openAIToAnthropic.set(openAIName, tool.name)
  }

  return {
    toAnthropic: (name) => openAIToAnthropic.get(name) ?? name,
    toOpenAI: (name) =>
      anthropicToOpenAI.get(name)
      ?? makeValidToolName(name, maxNameLength, allowDots),
  }
}
