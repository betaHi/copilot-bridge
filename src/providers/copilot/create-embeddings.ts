import type { BridgeConfig } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { fetchCopilot, getCopilotProviderContext } from "./client"

export interface EmbeddingRequest {
  input: string | Array<string>
  model: string
}

export interface Embedding {
  object: string
  embedding: Array<number>
  index: number
}

export interface EmbeddingResponse {
  object: string
  data: Array<Embedding>
  model: string
  usage: {
    prompt_tokens: number
    total_tokens: number
  }
}

export const createEmbeddings = async (
  config: BridgeConfig,
  payload: EmbeddingRequest,
): Promise<EmbeddingResponse> => {
  const provider = getCopilotProviderContext(config)
  const response = await fetchCopilot(provider, "/embeddings", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new HTTPError("Failed to create embeddings", response)
  }

  return (await response.json()) as EmbeddingResponse
}
