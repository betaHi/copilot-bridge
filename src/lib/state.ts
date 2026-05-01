import type { ModelsResponse } from "~/providers/copilot/get-models"

export interface RuntimeState {
  debug?: boolean
  modelOverride?: string
  models?: ModelsResponse
  rateLimitSeconds?: number
  rateLimitWait?: boolean
  lastRequestTimestamp?: number
}

export const runtimeState: RuntimeState = {}
