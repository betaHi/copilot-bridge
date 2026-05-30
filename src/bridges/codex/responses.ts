import { z } from "zod"

import {
  clampReasoningEffort,
  getModelCapability,
  isTextVerbosity,
  resolveModelId,
} from "~/lib/model-capabilities"

const codexResponsesRequestSchema = z
  .object({
    model: z.string().min(1),
    stream: z.boolean().optional(),
  })
  .passthrough()

export type CodexResponsesRequest = z.infer<typeof codexResponsesRequestSchema>

interface ReasoningField {
  effort?: unknown
  [key: string]: unknown
}

interface TextField {
  verbosity?: unknown
  [key: string]: unknown
}

const removeReasoningEffort = (reasoning: ReasoningField): ReasoningField | undefined => {
  const next = { ...reasoning }
  delete next.effort

  return Object.keys(next).length > 0 ? next : undefined
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const normalizeCodexResponsesRequest = (
  payload: CodexResponsesRequest,
  configuredReasoningEffort?: unknown,
): CodexResponsesRequest => {
  const parsed = codexResponsesRequestSchema.parse(payload) as CodexResponsesRequest
    & { reasoning?: ReasoningField; text?: TextField }

  const canonical = resolveModelId(parsed.model)
  const capability = getModelCapability(canonical)
  if (!capability) return parsed

  const next = { ...parsed, model: canonical } as typeof parsed

  if (!capability.reasoning) {
    if ("reasoning" in next) {
      delete (next as Record<string, unknown>).reasoning
    }
    return next
  }

  if ("reasoning" in next) {
    if (!isPlainObject(next.reasoning)) {
      const effort = configuredReasoningEffort
      if (effort === undefined || effort === null) {
        delete (next as Record<string, unknown>).reasoning
      } else {
        const clamped = clampReasoningEffort(canonical, effort)
        if (clamped) {
          next.reasoning = { effort: clamped.effort }
        }
      }
    } else {
      const incoming = next.reasoning as ReasoningField
      const effort = incoming.effort ?? configuredReasoningEffort
      if (effort === undefined || effort === null) {
        const reasoning = removeReasoningEffort(incoming)
        if (reasoning) {
          next.reasoning = reasoning
        } else {
          delete (next as Record<string, unknown>).reasoning
        }
      } else {
        const clamped = clampReasoningEffort(canonical, effort)
        if (clamped) {
          next.reasoning = { ...incoming, effort: clamped.effort }
        }
      }
    }
  } else if (
    configuredReasoningEffort !== undefined && configuredReasoningEffort !== null
  ) {
    const clamped = clampReasoningEffort(
      canonical,
      configuredReasoningEffort,
    )
    if (clamped) {
      next.reasoning = { effort: clamped.effort }
    }
  }

  const text = isPlainObject(next.text) ? (next.text as TextField) : undefined
  if (text && capability.textVerbosity && "verbosity" in text) {
    const { supported, default: defaultVerbosity } = capability.textVerbosity
    const verbosity = text.verbosity
    next.text = {
      ...text,
      verbosity:
        isTextVerbosity(verbosity) && supported.includes(verbosity) ?
          verbosity
        : defaultVerbosity,
    }
  }

  return next
}
