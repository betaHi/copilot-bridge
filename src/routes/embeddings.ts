import { Hono } from "hono"

import type { BridgeEnv } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { checkRateLimit, RateLimitError } from "~/lib/rate-limit"
import {
  createEmbeddings,
  type EmbeddingRequest,
} from "~/providers/copilot/create-embeddings"

export const embeddingRoutes = new Hono<BridgeEnv>()

embeddingRoutes.post("/", async (c) => {
  try {
    await checkRateLimit()
    const payload = await c.req.json<EmbeddingRequest>()
    const response = await createEmbeddings(c.var.config, payload)
    return c.json(response)
  } catch (error) {
    if (error instanceof RateLimitError) {
      return c.json({ error: { message: error.message } }, 429)
    }
    if (error instanceof HTTPError) {
      const text = await error.response.text().catch(() => "")
      return new Response(text, {
        status: error.response.status,
        headers: {
          "content-type":
            error.response.headers.get("content-type") ?? "application/json",
        },
      })
    }
    throw error
  }
})
