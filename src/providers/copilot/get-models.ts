import type { BridgeConfig } from "~/lib/config"
import { HTTPError } from "~/lib/error"

import { fetchCopilot, getCopilotProviderContext } from "./client"

export const getModels = async (
  config: BridgeConfig,
): Promise<ModelsResponse> => {
  const provider = getCopilotProviderContext(config)
  const response = await fetchCopilot(provider, "/models", {
    method: "GET",
    headers: { accept: "application/json" },
  })

  if (!response.ok) throw new HTTPError("Failed to get models", response)

  return (await response.json()) as ModelsResponse
}

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

interface ModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
}

interface ModelSupports {
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  dimensions?: boolean
}

interface ModelCapabilities {
  family: string
  limits: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
}

export interface Model {
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled: boolean
  name: string
  object: string
  preview: boolean
  vendor: string
  version: string
  policy?: {
    state: string
    terms: string
  }
}
