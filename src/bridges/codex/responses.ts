import { z } from "zod"

import {
  clampReasoningEffort,
  getModelCapability,
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

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const normalizeCodexResponsesRequest = (
  payload: CodexResponsesRequest,
): CodexResponsesRequest => {
  const parsed = codexResponsesRequestSchema.parse(payload) as CodexResponsesRequest
    & { reasoning?: ReasoningField }

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

  const incoming: ReasoningField | undefined =
    isPlainObject(next.reasoning) ? (next.reasoning as ReasoningField) : undefined
  const clamped = clampReasoningEffort(canonical, incoming?.effort)
  if (clamped) {
    next.reasoning = { ...(incoming ?? {}), effort: clamped.effort }
  }

  return next
}
