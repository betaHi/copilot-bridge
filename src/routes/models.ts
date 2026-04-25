import { Hono } from "hono"

import type { BridgeEnv } from "~/lib/config"
import { BridgeNotImplementedError } from "~/lib/error"
import {
  fetchCopilot,
  getCopilotProviderContext,
} from "~/providers/copilot/client"

export const modelRoutes = new Hono<BridgeEnv>()

modelRoutes.get("/", async (c) => {
  const config = c.get("config")
  const provider = getCopilotProviderContext(config)
  const search = new URL(c.req.url).search

  try {
    const upstream = await fetchCopilot(provider, `/models${search}`, {
      method: "GET",
      headers: {
        accept: c.req.header("accept") ?? "application/json",
      },
    })

    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    })
  } catch (error) {
    if (error instanceof BridgeNotImplementedError) {
      return c.json(
        {
          error: {
            type: error.name,
            message: error.message,
          },
        },
        500,
      )
    }

    throw error
  }
})
