import { resolveUpstreamModelId } from "~/lib/models-resolver"
import type { ClaudeSettings } from "~/lib/claude-settings"
import { sanitizeReasoningEffortForModel } from "~/services/copilot/create-chat-completions"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
  TextPart,
  Tool,
  ToolCall,
} from "~/providers/copilot/chat-types"

import {
  type AnthropicAssistantContentBlock,
  type AnthropicAssistantMessage,
  type AnthropicMessage,
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicTextBlock,
  type AnthropicThinkingBlock,
  type AnthropicTool,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type AnthropicUserContentBlock,
  type AnthropicUserMessage,
} from "~/bridges/claude/anthropic-types"
import { mapOpenAIStopReasonToAnthropic } from "~/bridges/claude/utils"
import {
  createAnthropicToolNameMapper,
  getToolNameMapperOptionsForModel,
  type AnthropicToolNameMapper,
} from "~/bridges/claude/tool-names"

const normalizeClaudeModelAlias = (model: string): string => {
  const trimmed = model.trim().toLowerCase()

  if (trimmed === "opus[1m]") {
    return "claude-opus-4.7-1m"
  }

  const claudeOpusOneMillionMatch = trimmed.match(
    /^claude-opus-(\d)[.-](\d)(?:-\d{8})?-?\[1m\]$/,
  )
  if (claudeOpusOneMillionMatch) {
    const [, major, minor] = claudeOpusOneMillionMatch
    return `claude-opus-${major}.${minor}-1m`
  }

  const claudeOpusOneMillionStrippedByClaudeCodeMatch = trimmed.match(
    /^claude-opus-(\d)[.-](\d)-$/,
  )
  if (claudeOpusOneMillionStrippedByClaudeCodeMatch) {
    const [, major, minor] = claudeOpusOneMillionStrippedByClaudeCodeMatch
    return `claude-opus-${major}.${minor}-1m`
  }

  const normalized = trimmed.replace(/\[1m\]$/, "")
  const prefixed = normalized.startsWith("opus-") ? `claude-${normalized}` : normalized

  if (prefixed === "opus") {
    return "claude-opus"
  }

  if (prefixed === "sonnet") {
    return "claude-sonnet"
  }

  if (prefixed === "haiku") {
    return "claude-haiku"
  }

  const claudeSnapshotMatch = prefixed.match(
    /^claude-(opus|sonnet|haiku)-(\d)-(\d)((?:-[a-z0-9]+)*?)(?:-\d{8})?$/,
  )
  if (claudeSnapshotMatch) {
    const [, family, major, minor, suffix = ""] = claudeSnapshotMatch
    return `claude-${family}-${major}.${minor}${suffix}`
  }

  return prefixed
}

function normalizeClaudeReasoningEffortForRouting(
  value: string | undefined,
): ClaudeOpus47Effort | undefined {
  switch (value?.toLowerCase()) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max": {
      return value.toLowerCase() as ClaudeOpus47Effort
    }
    default: {
      return undefined
    }
  }
}

const getEnvValueCaseInsensitive = (
  env: Record<string, string>,
  key: string,
): string | undefined => {
  const direct = env[key]
  if (typeof direct === "string") {
    return direct
  }
  const lower = key.toLowerCase()
  const matched = Object.entries(env).find(([k]) => k.toLowerCase() === lower)
  return matched?.[1]
}

const getConfiguredClaudeReasoningEffort = (
  settings: Pick<ClaudeSettings, "env"> | undefined,
): string | undefined =>
  process.env.MODEL_REASONING_EFFORT
  ?? getEnvValueCaseInsensitive(settings?.env ?? {}, "MODEL_REASONING_EFFORT")

const routeClaudeOpus47ByEffort = (
  model: string,
  requestedEffort: string | undefined,
): string => {
  if (model !== "claude-opus-4.7") {
    return model
  }

  switch (normalizeClaudeReasoningEffortForRouting(requestedEffort)) {
    case "high": {
      return "claude-opus-4.7-high"
    }
    case "xhigh":
    case "max": {
      return "claude-opus-4.7-xhigh"
    }
    default: {
      return model
    }
  }
}

const getConfiguredClaudeDefaultModel = (
  settings: Pick<ClaudeSettings, "env" | "model"> | undefined,
): string | undefined => {
  if (!settings) {
    return undefined
  }

  const env = settings.env ?? {}
  const topLevelModel = settings.model?.trim()
  const anthropicModel = env.ANTHROPIC_MODEL

  if (!topLevelModel) {
    return anthropicModel
  }

  switch (topLevelModel.toLowerCase()) {
    case "opus[1m]": {
      return env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? topLevelModel
    }
    case "opus": {
      return env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? topLevelModel
    }
    case "sonnet": {
      return env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? topLevelModel
    }
    case "haiku": {
      return (
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL
        ?? env.ANTHROPIC_SMALL_FAST_MODEL
        ?? topLevelModel
      )
    }
    default: {
      return topLevelModel
    }
  }
}

const resolveClaudeRequestedModel = (
  model: string,
  settings: Pick<ClaudeSettings, "env" | "model"> | undefined,
): string => {
  if (model.trim().toLowerCase() !== "definitely-not-a-real-model") {
    return model
  }

  return getConfiguredClaudeDefaultModel(settings) ?? model
}

export function translateModelName(
  model: string,
  settings?: Pick<ClaudeSettings, "env" | "model">,
  requestedReasoningEffort?: string,
): string {
  const requestedModel = resolveClaudeRequestedModel(model, settings)
  const normalizedModel = normalizeClaudeModelAlias(requestedModel)
  const routedModel = routeClaudeOpus47ByEffort(
    normalizedModel,
    requestedReasoningEffort ?? getConfiguredClaudeReasoningEffort(settings),
  )
  return resolveUpstreamModelId(routedModel)
}

function isClaudeModel(modelId: string): boolean {
  return modelId.startsWith("claude-")
}

function isClaudeOpus47Model(modelId: string): boolean {
  return modelId.startsWith("claude-opus-4.7")
}

type ClaudeOpus47Effort = NonNullable<
  NonNullable<ChatCompletionsPayload["output_config"]>["effort"]
>

function normalizeClaudeEffort(
  value: string | undefined,
): ClaudeOpus47Effort | undefined {
  switch (value?.toLowerCase()) {
    case "low": {
      return "low"
    }
    case "medium": {
      return "medium"
    }
    case "high": {
      return "high"
    }
    case "xhigh": {
      return "xhigh"
    }
    case "max": {
      return "max"
    }
    default: {
      return undefined
    }
  }
}

function getClaudeOpus47Effort(
  payload: AnthropicMessagesPayload,
): ClaudeOpus47Effort | undefined {
  const explicitEffort = normalizeClaudeEffort(payload.reasoning_effort)
  if (explicitEffort) {
    return explicitEffort
  }

  if (payload.thinking?.type !== "enabled") {
    return undefined
  }

  const budgetTokens = payload.thinking.budget_tokens
  if (budgetTokens === undefined) {
    return "medium"
  }

  if (budgetTokens <= 2_048) {
    return "low"
  }

  if (budgetTokens <= 8_192) {
    return "medium"
  }

  if (budgetTokens <= 24_576) {
    return "high"
  }

  return "xhigh"
}

function translateThinking(
  payload: AnthropicMessagesPayload,
  settings?: Pick<ClaudeSettings, "env" | "model">,
): ChatCompletionsPayload["thinking"] {
  const modelId = translateModelName(payload.model, settings, payload.reasoning_effort)

  if (!isClaudeOpus47Model(modelId)) {
    return undefined
  }

  if (payload.thinking?.type === "adaptive") {
    return { type: "adaptive" }
  }

  return payload.thinking?.type === "enabled" ? { type: "adaptive" } : undefined
}

function translateOutputConfig(
  payload: AnthropicMessagesPayload,
  settings?: Pick<ClaudeSettings, "env" | "model">,
): ChatCompletionsPayload["output_config"] {
  const modelId = translateModelName(payload.model, settings, payload.reasoning_effort)

  if (!isClaudeOpus47Model(modelId)) {
    return undefined
  }

  const effort = getClaudeOpus47Effort(payload)

  return effort ? { effort } : undefined
}

function normalizeReasoningEffort(
  value: string,
): ChatCompletionsPayload["reasoning_effort"] {
  switch (value.toLowerCase()) {
    case "none": {
      return "none"
    }
    case "low": {
      return "low"
    }
    case "medium": {
      return "medium"
    }
    case "high": {
      return "high"
    }
    case "xhigh": {
      return "xhigh"
    }
    case "max": {
      return "max"
    }
    default: {
      return undefined
    }
  }
}

function translateReasoningEffort(
  payload: AnthropicMessagesPayload,
  settings?: Pick<ClaudeSettings, "env" | "model">,
): ChatCompletionsPayload["reasoning_effort"] {
  const modelId = translateModelName(payload.model, settings, payload.reasoning_effort)

  if (isClaudeOpus47Model(modelId)) {
    return undefined
  }

  if (payload.reasoning_effort) {
    const requested = normalizeReasoningEffort(payload.reasoning_effort)
    return sanitizeReasoningEffortForModel(modelId, requested)
  }

  if (isClaudeModel(modelId)) {
    return undefined
  }

  if (payload.thinking?.type !== "enabled") {
    return undefined
  }

  const budgetTokens = payload.thinking.budget_tokens
  if (budgetTokens === undefined) {
    return sanitizeReasoningEffortForModel(modelId, "medium")
  }

  if (budgetTokens <= 2_048) {
    return sanitizeReasoningEffortForModel(modelId, "low")
  }

  if (budgetTokens <= 8_192) {
    return sanitizeReasoningEffortForModel(modelId, "medium")
  }

  if (budgetTokens <= 24_576) {
    return sanitizeReasoningEffortForModel(modelId, "high")
  }

  return sanitizeReasoningEffortForModel(modelId, "xhigh")
}

export function translateToOpenAI(
  payload: AnthropicMessagesPayload,
  settings?: Pick<ClaudeSettings, "env" | "model">,
  toolNameMapper?: AnthropicToolNameMapper,
): ChatCompletionsPayload {
  const model = translateModelName(payload.model, settings, payload.reasoning_effort)
  const mapper = toolNameMapper ?? createAnthropicToolNameMapper(payload.tools, {
    ...getToolNameMapperOptionsForModel(model),
  })
  const tools = translateAnthropicToolsToOpenAI(payload.tools, mapper)

  return {
    model,
    messages: translateAnthropicMessagesToOpenAI(
      payload.messages,
      payload.system,
      mapper,
    ),
    max_tokens: payload.max_tokens,
    stop: payload.stop_sequences,
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    thinking: translateThinking(payload, settings),
    output_config: translateOutputConfig(payload, settings),
    reasoning_effort: translateReasoningEffort(payload, settings),
    user: payload.metadata?.user_id,
    tools,
    tool_choice:
      tools && tools.length > 0 ?
        translateAnthropicToolChoiceToOpenAI(payload.tool_choice, mapper)
      : undefined,
  }
}

function translateAnthropicMessagesToOpenAI(
  anthropicMessages: Array<AnthropicMessage>,
  system: string | Array<AnthropicTextBlock> | undefined,
  toolNameMapper: AnthropicToolNameMapper,
): Array<Message> {
  const systemMessages = handleSystemPrompt(system)
  const otherMessages = anthropicMessages.flatMap((message) =>
    message.role === "user" ? handleUserMessage(message) : handleAssistantMessage(message, toolNameMapper),
  )
  return [...systemMessages, ...otherMessages]
}

function handleSystemPrompt(
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  if (!system) {
    return []
  }

  if (typeof system === "string") {
    return [{ role: "system", content: system }]
  }

  return [{ role: "system", content: system.map((block) => block.text).join("\n\n") }]
}

function handleUserMessage(message: AnthropicUserMessage): Array<Message> {
  const newMessages: Array<Message> = []

  if (Array.isArray(message.content)) {
    const toolResultBlocks = message.content.filter(
      (block): block is AnthropicToolResultBlock => block.type === "tool_result",
    )
    const otherBlocks = message.content.filter((block) => block.type !== "tool_result")

    for (const block of toolResultBlocks) {
      newMessages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: mapContent(block.content),
      })
    }

    if (otherBlocks.length > 0) {
      newMessages.push({
        role: "user",
        content: mapContent(otherBlocks),
      })
    }
  } else {
    newMessages.push({
      role: "user",
      content: mapContent(message.content),
    })
  }

  return newMessages
}

function handleAssistantMessage(
  message: AnthropicAssistantMessage,
  toolNameMapper: AnthropicToolNameMapper,
): Array<Message> {
  if (!Array.isArray(message.content)) {
    return [{ role: "assistant", content: mapContent(message.content) }]
  }

  const toolUseBlocks = message.content.filter(
    (block): block is AnthropicToolUseBlock => block.type === "tool_use",
  )
  const textBlocks = message.content.filter(
    (block): block is AnthropicTextBlock => block.type === "text",
  )
  const thinkingBlocks = message.content.filter(
    (block): block is AnthropicThinkingBlock => block.type === "thinking",
  )

  const allTextContent = [
    ...textBlocks.map((b) => b.text),
    ...thinkingBlocks.map((b) => b.thinking),
  ].join("\n\n")

  return toolUseBlocks.length > 0
    ? [
        {
          role: "assistant",
          content: allTextContent || null,
          tool_calls: toolUseBlocks.map((toolUse) => ({
            id: toolUse.id,
            type: "function",
            function: {
              name: toolNameMapper.toOpenAI(toolUse.name),
              arguments: JSON.stringify(toolUse.input),
            },
          })),
        },
      ]
    : [{ role: "assistant", content: mapContent(message.content) }]
}

function mapContent(
  content:
    | string
    | Array<AnthropicUserContentBlock | AnthropicAssistantContentBlock>,
): string | Array<ContentPart> | null {
  if (typeof content === "string") {
    return content
  }

  if (!Array.isArray(content)) {
    return null
  }

  const hasImage = content.some((block) => block.type === "image")
  if (!hasImage) {
    return content
      .filter(
        (block): block is AnthropicTextBlock | AnthropicThinkingBlock =>
          block.type === "text" || block.type === "thinking",
      )
      .map((block) => (block.type === "text" ? block.text : block.thinking))
      .join("\n\n")
  }

  const contentParts: Array<ContentPart> = []
  for (const block of content) {
    switch (block.type) {
      case "text": {
        contentParts.push({ type: "text", text: block.text })
        break
      }
      case "thinking": {
        contentParts.push({ type: "text", text: block.thinking })
        break
      }
      case "image": {
        contentParts.push({
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        })
        break
      }
    }
  }

  return contentParts
}

function translateAnthropicToolsToOpenAI(
  anthropicTools: Array<AnthropicTool> | undefined,
  toolNameMapper: AnthropicToolNameMapper,
): Array<Tool> | undefined {
  if (!anthropicTools || anthropicTools.length === 0) {
    return undefined
  }

  const tools = anthropicTools.flatMap((tool) => {
    if (!tool.input_schema) {
      return []
    }

    return [{
      type: "function" as const,
      function: {
        name: toolNameMapper.toOpenAI(tool.name),
        description: tool.description,
        parameters: tool.input_schema,
      },
    }]
  })

  return tools.length > 0 ? tools : undefined
}

function translateAnthropicToolChoiceToOpenAI(
  anthropicToolChoice: AnthropicMessagesPayload["tool_choice"],
  toolNameMapper: AnthropicToolNameMapper,
): ChatCompletionsPayload["tool_choice"] {
  if (!anthropicToolChoice) {
    return undefined
  }

  switch (anthropicToolChoice.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      return "required"
    }
    case "tool": {
      if (anthropicToolChoice.name) {
        return {
          type: "function",
          function: { name: toolNameMapper.toOpenAI(anthropicToolChoice.name) },
        }
      }
      return undefined
    }
    case "none": {
      return "none"
    }
    default: {
      return undefined
    }
  }
}

export function translateToAnthropic(
  response: ChatCompletionResponse,
  toolNameMapper: AnthropicToolNameMapper = createAnthropicToolNameMapper(
    undefined,
  ),
): AnthropicResponse {
  const allThinkingBlocks: Array<AnthropicThinkingBlock> = []
  const allTextBlocks: Array<AnthropicTextBlock> = []
  const allToolUseBlocks: Array<AnthropicToolUseBlock> = []
  let stopReason: "stop" | "length" | "tool_calls" | "content_filter" | null = null

  stopReason = response.choices[0]?.finish_reason ?? stopReason

  for (const choice of response.choices) {
    allThinkingBlocks.push(
      ...getAnthropicThinkingBlocks(
        choice.message.reasoning_text ?? choice.message.reasoning_content,
      ),
    )
    allTextBlocks.push(...getAnthropicTextBlocks(choice.message.content))
    allToolUseBlocks.push(
      ...getAnthropicToolUseBlocks(choice.message.tool_calls, toolNameMapper),
    )

    if (choice.finish_reason === "tool_calls" || stopReason === "stop") {
      stopReason = choice.finish_reason
    }
  }

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    content: [...allThinkingBlocks, ...allTextBlocks, ...allToolUseBlocks],
    stop_reason: mapOpenAIStopReasonToAnthropic(stopReason),
    stop_sequence: null,
    usage: {
      input_tokens:
        (response.usage?.prompt_tokens ?? 0)
        - (response.usage?.prompt_tokens_details?.cached_tokens ?? 0),
      output_tokens: response.usage?.completion_tokens ?? 0,
      ...(response.usage?.prompt_tokens_details?.cached_tokens !== undefined && {
        cache_read_input_tokens: response.usage.prompt_tokens_details.cached_tokens,
      }),
    },
  }
}

function getAnthropicThinkingBlocks(
  reasoningContent: string | null | undefined,
): Array<AnthropicThinkingBlock> {
  if (!reasoningContent) {
    return []
  }

  return [{ type: "thinking", thinking: reasoningContent }]
}

function getAnthropicTextBlocks(
  messageContent: Message["content"],
): Array<AnthropicTextBlock> {
  if (typeof messageContent === "string") {
    return [{ type: "text", text: messageContent }]
  }

  if (Array.isArray(messageContent)) {
    return messageContent
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => ({ type: "text", text: part.text }))
  }

  return []
}

function getAnthropicToolUseBlocks(
  toolCalls: Array<ToolCall> | undefined,
  toolNameMapper: AnthropicToolNameMapper,
): Array<AnthropicToolUseBlock> {
  if (!toolCalls) {
    return []
  }

  return toolCalls.map((toolCall) => ({
    type: "tool_use",
    id: toolCall.id,
    name: toolNameMapper.toAnthropic(toolCall.function.name),
    input: safeJsonParse(toolCall.function.arguments),
  }))
}

function safeJsonParse(input: string): Record<string, unknown> {
  try {
    return JSON.parse(input) as Record<string, unknown>
  } catch {
    return { raw: input }
  }
}
