// Model capability registry for copilot-bridge.
// Source: GitHub Copilot Responses API model + reasoning_effort matrix.
// Keep this tightly scoped to what we use to validate / clamp requests.

export type ReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"

export type TextVerbosity = "low" | "medium" | "high"

export interface ModelCapability {
  id: string
  // Optional aliases that resolve to this canonical id (e.g. trimming a
  // "-preview" suffix). Requests using an alias get their model rewritten
  // to the canonical id before being forwarded upstream.
  aliases?: ReadonlyArray<string>
  // If undefined, the model does not accept a reasoning parameter at all
  // and the bridge will strip any reasoning.* fields from the request.
  reasoning?: {
    supported: ReadonlyArray<ReasoningEffort>
    default: ReasoningEffort
  }
  textVerbosity?: {
    supported: ReadonlyArray<TextVerbosity>
    default: TextVerbosity
  }
  // When set, /v1/responses requests for this model are translated to
  // upstream /v1/chat/completions because Copilot does not expose the
  // Responses API for this model.
  fallback?: "chat-completions"
  // Where to place the reasoning effort on the upstream chat payload.
  // - "reasoning_effort" (default for gpt-5 family / most claude)
  // - "output_config.effort" (claude-opus-4.7 family)
  // Has no effect when reasoning is undefined.
  reasoningField?: "reasoning_effort" | "output_config.effort"
}

export const MODEL_CAPABILITIES: ReadonlyArray<ModelCapability> = [
  {
    id: "gpt-5.5",
    reasoning: {
      supported: ["none", "low", "medium", "high", "xhigh"],
      default: "medium",
    },
  },
  {
    id: "gpt-5.4",
    reasoning: {
      supported: ["low", "medium", "high", "xhigh"],
      default: "medium",
    },
  },
  {
    id: "gpt-5.4-mini",
    reasoning: {
      supported: ["none", "low", "medium"],
      default: "medium",
    },
  },
  {
    id: "gpt-5.3-codex",
    reasoning: {
      supported: ["low", "medium", "high", "xhigh"],
      default: "medium",
    },
  },
  {
    id: "gpt-5.2",
    reasoning: {
      supported: ["low", "medium", "high", "xhigh"],
      default: "medium",
    },
  },
  {
    id: "gpt-5.2-codex",
    reasoning: {
      supported: ["low", "medium", "high", "xhigh"],
      default: "medium",
    },
    textVerbosity: {
      supported: ["medium"],
      default: "medium",
    },
  },
  {
    id: "gpt-5-mini",
    reasoning: {
      supported: ["low", "medium", "high"],
      default: "medium",
    },
  },
  // Claude family — Copilot does not expose /v1/responses for Claude, so we
  // translate to /v1/chat/completions. Only opus-4.7 places effort under
  // output_config.effort; the others use the standard reasoning_effort.
  {
    id: "claude-opus-4.7",
    fallback: "chat-completions",
    reasoningField: "output_config.effort",
    reasoning: {
      supported: ["low", "medium", "high", "xhigh", "max"],
      default: "medium",
    },
  },
  {
    id: "claude-opus-4.6",
    fallback: "chat-completions",
    reasoning: {
      supported: ["low", "medium", "high"],
      default: "medium",
    },
  },
  {
    id: "claude-opus-4.6-1m",
    fallback: "chat-completions",
    reasoning: {
      supported: ["low", "medium", "high"],
      default: "medium",
    },
  },
  {
    id: "claude-opus-4.5",
    fallback: "chat-completions",
  },
  {
    id: "claude-sonnet-4.6",
    fallback: "chat-completions",
    reasoning: {
      supported: ["low", "medium", "high"],
      default: "medium",
    },
  },
  {
    id: "claude-sonnet-4.5",
    fallback: "chat-completions",
  },
  {
    id: "claude-sonnet-4",
    fallback: "chat-completions",
  },
  {
    id: "claude-haiku-4.5",
    fallback: "chat-completions",
  },
  // Gemini family currently does not accept a reasoning parameter on the
  // Copilot Responses endpoint — bridge strips reasoning.* before forwarding.
  {
    id: "gemini-3.1-pro-preview",
    fallback: "chat-completions",
    aliases: ["gemini-3.1-pro"],
  },
  {
    id: "gemini-3-flash-preview",
    fallback: "chat-completions",
    aliases: ["gemini-3-flash"],
  },
  {
    id: "gemini-2.5-pro",
    fallback: "chat-completions",
  },
  // Legacy GPT-4.x — chat-only upstream, no reasoning parameter accepted.
  {
    id: "gpt-4.1",
    fallback: "chat-completions",
  },
  {
    id: "gpt-4o",
    fallback: "chat-completions",
  },
]

const CAPABILITY_BY_ID = new Map(
  MODEL_CAPABILITIES.flatMap((m) => {
    const entries: Array<readonly [string, ModelCapability]> = [[m.id, m]]
    for (const alias of m.aliases ?? []) entries.push([alias, m])
    return entries
  }),
)

// Resolve any alias to the canonical upstream id. Returns the input
// unchanged when no mapping is found.
export const resolveModelId = (modelId: string): string =>
  CAPABILITY_BY_ID.get(modelId)?.id ?? modelId

export const getModelCapability = (
  modelId: string,
): ModelCapability | undefined => CAPABILITY_BY_ID.get(modelId)

export const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  value === "none"
  || value === "low"
  || value === "medium"
  || value === "high"
  || value === "xhigh"
  || value === "max"

export const isTextVerbosity = (value: unknown): value is TextVerbosity =>
  value === "low" || value === "medium" || value === "high"

const normalizeRequestedReasoningEffort = (requested: unknown): unknown =>
  requested === "minimal" ? "low" : requested

export interface NormalizedReasoning {
  effort: ReasoningEffort
  changed: boolean
  reason?: "unsupported-model" | "unsupported-effort"
}

// Clamp a requested effort to what the model supports. Returns undefined
// when the model does not accept reasoning at all (caller should strip it).
export const clampReasoningEffort = (
  modelId: string,
  requested: unknown,
): NormalizedReasoning | undefined => {
  const capability = getModelCapability(modelId)
  if (!capability?.reasoning) return undefined

  const { supported, default: defaultEffort } = capability.reasoning

  if (requested === undefined || requested === null) {
    return { effort: defaultEffort, changed: false }
  }

  const normalizedRequested = normalizeRequestedReasoningEffort(requested)

  if (!isReasoningEffort(normalizedRequested)) {
    return {
      effort: defaultEffort,
      changed: true,
      reason: "unsupported-effort",
    }
  }

  if (supported.includes(normalizedRequested)) {
    return {
      effort: normalizedRequested,
      changed: normalizedRequested !== requested,
      reason:
        normalizedRequested !== requested ? "unsupported-effort" : undefined,
    }
  }

  // Pick the closest supported value by ordering low<medium<high<xhigh<max,
  // treat 'none' as below 'low'. If requested exceeds max supported, fall to
  // the highest supported; if below the lowest, fall to the lowest.
  const order: ReadonlyArray<ReasoningEffort> = [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]
  const reqIdx = order.indexOf(normalizedRequested)
  const supportedSorted = [...supported].sort(
    (a, b) => order.indexOf(a) - order.indexOf(b),
  )
  const lowest = supportedSorted[0]
  const highest = supportedSorted[supportedSorted.length - 1]
  const fallback =
    reqIdx > order.indexOf(highest) ? highest
    : reqIdx < order.indexOf(lowest) ? lowest
    : (supportedSorted.find((e) => order.indexOf(e) >= reqIdx) ?? defaultEffort)

  return { effort: fallback, changed: true, reason: "unsupported-effort" }
}
