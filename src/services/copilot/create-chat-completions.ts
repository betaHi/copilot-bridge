import consola from "consola"
import { events } from "fetch-event-stream"

import type { BridgeConfig } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { getClaudeSettingsEnv } from "~/lib/claude-settings"
import { fetchCopilot, getCopilotProviderContext } from "~/providers/copilot/client"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/providers/copilot/chat-types"

import {
  buildResponsesRequestPayload,
  shouldUseResponsesApiForModel,
  translateResponsesStreamToChatCompletionStream,
  translateResponsesToChatCompletion,
  type ResponsesApiResponse,
  type ResponsesReasoningEffort,
} from "./responses"

const usesMaxCompletionTokens = (modelId: string): boolean =>
  modelId.startsWith("gpt-5")

const isClaudeOpus47Model = (modelId: string): boolean =>
  modelId === "claude-opus-4.7"

type ClaudeOpus47Effort = NonNullable<
  NonNullable<ChatCompletionsPayload["output_config"]>["effort"]
>

const MAX_USER_LENGTH = 64

const defaultReasoningEffort = (
  modelId: string,
): ChatCompletionsPayload["reasoning_effort"] =>
  usesMaxCompletionTokens(modelId) ? "medium" : undefined

const getAllowedReasoningEfforts = (
  modelId: string,
): Array<
  Exclude<ChatCompletionsPayload["reasoning_effort"], null | undefined>
> => {
  if (modelId.startsWith("gpt-5.5")) {
    return ["none", "low", "medium", "high", "xhigh"]
  }

  if (modelId.startsWith("gpt-5.4-mini")) {
    return ["none", "low", "medium"]
  }

  if (modelId.startsWith("gpt-5.4") || modelId.startsWith("gpt-5.3-codex")) {
    return ["low", "medium", "high", "xhigh"]
  }

  if (usesMaxCompletionTokens(modelId)) {
    return ["low", "medium", "high", "xhigh"]
  }

  return []
}

export const sanitizeReasoningEffortForModel = (
  modelId: string,
  reasoningEffort: ChatCompletionsPayload["reasoning_effort"],
): ChatCompletionsPayload["reasoning_effort"] => {
  if (!reasoningEffort) {
    return undefined
  }

  return getAllowedReasoningEfforts(modelId).includes(reasoningEffort) ?
      reasoningEffort
    : undefined
}

const normalizeReasoningEffort = (
  value: string | undefined | null,
): ChatCompletionsPayload["reasoning_effort"] => {
  switch (value?.toLowerCase()) {
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

const normalizeClaudeOpus47Effort = (
  value: string | undefined | null,
): ClaudeOpus47Effort | undefined => {
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

const getRequestedReasoningEffort = (
  payload: ChatCompletionsPayload,
  claudeSettingsEnv: Record<string, string>,
): ChatCompletionsPayload["reasoning_effort"] => {
  const requestedReasoningEffort =
    payload.reasoning_effort
    ?? normalizeReasoningEffort(process.env.COPILOT_REASONING_EFFORT)
    ?? normalizeReasoningEffort(claudeSettingsEnv.COPILOT_REASONING_EFFORT)

  return (
    sanitizeReasoningEffortForModel(payload.model, requestedReasoningEffort)
    ?? defaultReasoningEffort(payload.model)
  )
}

const getRequestedClaudeOpus47Effort = (
  payload: ChatCompletionsPayload,
  claudeSettingsEnv: Record<string, string>,
): ClaudeOpus47Effort | undefined => {
  if (!isClaudeOpus47Model(payload.model)) {
    return undefined
  }

  return (
    payload.output_config?.effort
    ?? normalizeClaudeOpus47Effort(payload.reasoning_effort)
    ?? normalizeClaudeOpus47Effort(process.env.COPILOT_REASONING_EFFORT)
    ?? normalizeClaudeOpus47Effort(claudeSettingsEnv.COPILOT_REASONING_EFFORT)
  )
}

export const sanitizeUserIdentifier = (
  user: string | null | undefined,
): string | undefined => {
  if (!user) {
    return undefined
  }

  return user.slice(0, MAX_USER_LENGTH)
}

type ChatCompletionsRequestPayload = Omit<
  ChatCompletionsPayload,
  "max_tokens"
> & {
  max_tokens?: number | null
  max_completion_tokens?: number | null
}

const buildRequestPayload = (
  payload: ChatCompletionsPayload,
  claudeSettingsEnv: Record<string, string>,
): ChatCompletionsRequestPayload => {
  const requestedReasoningEffort = getRequestedReasoningEffort(
    payload,
    claudeSettingsEnv,
  )
  const requestedClaudeOpus47Effort = getRequestedClaudeOpus47Effort(
    payload,
    claudeSettingsEnv,
  )

  const reasoningEffort =
    (
      usesMaxCompletionTokens(payload.model)
      && payload.tools !== null
      && payload.tools !== undefined
      && payload.tools.length > 0
    ) ?
      undefined
    : requestedReasoningEffort

  if (
    !usesMaxCompletionTokens(payload.model)
    || payload.max_tokens === null
    || payload.max_tokens === undefined
  ) {
    const sanitizedPayload = {
      ...payload,
      output_config:
        requestedClaudeOpus47Effort ?
          {
            ...payload.output_config,
            effort: requestedClaudeOpus47Effort,
          }
        : payload.output_config,
      reasoning_effort:
        isClaudeOpus47Model(payload.model) ? undefined : (
          payload.reasoning_effort
        ),
      user: sanitizeUserIdentifier(payload.user),
    }

    return reasoningEffort === null || reasoningEffort === undefined ?
        sanitizedPayload
      : { ...sanitizedPayload, reasoning_effort: reasoningEffort }
  }

  return {
    ...payload,
    max_tokens: undefined,
    max_completion_tokens: payload.max_tokens,
    reasoning_effort: reasoningEffort,
    user: sanitizeUserIdentifier(payload.user),
  }
}

const isAgentInitiator = (
  messages: ChatCompletionsPayload["messages"],
): "agent" | "user" =>
  messages.some((msg) => msg.role === "assistant" || msg.role === "tool") ?
    "agent"
  : "user"

const messagesIncludeImage = (
  messages: ChatCompletionsPayload["messages"],
): boolean =>
  messages.some(
    (msg) =>
      typeof msg.content !== "string"
      && msg.content?.some((part) => part.type === "image_url"),
  )

export const createChatCompletions = async (
  config: BridgeConfig,
  payload: ChatCompletionsPayload,
) => {
  const provider = getCopilotProviderContext(config)
  const enableVision = messagesIncludeImage(payload.messages)
  const initiator = isAgentInitiator(payload.messages)
  const claudeSettingsEnv = await getClaudeSettingsEnv()
  const requestPayload = buildRequestPayload(payload, claudeSettingsEnv)

  if (shouldUseResponsesApiForModel(payload.model)) {
    return createResponses(provider, payload, claudeSettingsEnv, {
      vision: enableVision,
      initiator,
    })
  }

  const response = await fetchCopilot(
    provider,
    "/chat/completions",
    {
      method: "POST",
      headers: {
        accept: payload.stream ? "text/event-stream" : "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(requestPayload),
    },
    { vision: enableVision, initiator },
  )

  if (!response.ok) {
    if (await shouldRetryWithResponses(response)) {
      return createResponses(provider, payload, claudeSettingsEnv, {
        vision: enableVision,
        initiator,
      })
    }

    consola.error("Failed to create chat completions", response)
    throw new HTTPError("Failed to create chat completions", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}

async function createResponses(
  provider: ReturnType<typeof getCopilotProviderContext>,
  payload: ChatCompletionsPayload,
  claudeSettingsEnv: Record<string, string>,
  options: { vision: boolean; initiator: "agent" | "user" },
) {
  const reasoningEffort = getRequestedReasoningEffort(
    payload,
    claudeSettingsEnv,
  ) as ResponsesReasoningEffort | undefined

  const response = await fetchCopilot(
    provider,
    "/responses",
    {
      method: "POST",
      headers: {
        accept: payload.stream ? "text/event-stream" : "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(
        buildResponsesRequestPayload(payload, reasoningEffort),
      ),
    },
    { vision: options.vision, initiator: options.initiator },
  )

  if (!response.ok) {
    consola.error("Failed to create responses", response)
    throw new HTTPError("Failed to create responses", response)
  }

  if (payload.stream) {
    return translateResponsesStreamToChatCompletionStream(events(response))
  }

  return translateResponsesToChatCompletion(
    (await response.json()) as ResponsesApiResponse,
  )
}

async function shouldRetryWithResponses(response: Response): Promise<boolean> {
  try {
    const errorBody = (await response.clone().json()) as {
      error?: {
        code?: string
      }
    }

    return errorBody.error?.code === "unsupported_api_for_model"
  } catch {
    return false
  }
}
