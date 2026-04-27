import { Hono } from "hono"

import type { BridgeEnv } from "~/lib/config"
import { getCopilotUsage } from "~/providers/github/get-copilot-usage"

export const usageRoutes = new Hono<BridgeEnv>()

usageRoutes.get("/", async (c) => {
  // Allow the static usage viewer at https://betahi.github.io/copilot-bridge
  // (and local dev) to call this endpoint cross-origin.
  c.header("access-control-allow-origin", "*")
  c.header("access-control-allow-methods", "GET, OPTIONS")
  c.header("access-control-allow-headers", "*")

  try {
    const usage = await getCopilotUsage(c.var.config)
    return c.json(usage)
  } catch (error) {
    console.error("Error fetching Copilot usage:", error)
    return c.json({ error: "Failed to fetch Copilot usage" }, 500)
  }
})

usageRoutes.options("/", (c) => {
  c.header("access-control-allow-origin", "*")
  c.header("access-control-allow-methods", "GET, OPTIONS")
  c.header("access-control-allow-headers", "*")
  return c.body(null, 204)
})
