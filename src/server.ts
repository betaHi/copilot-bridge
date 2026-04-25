import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { logger } from "hono/logger"

import type { BridgeConfig, BridgeEnv } from "~/lib/config"
import { modelRoutes } from "~/routes/models"
import { responsesRoutes } from "~/routes/responses"

export const createServer = (config: BridgeConfig) => {
  const app = new Hono<BridgeEnv>()

  app.use(logger())
  app.use("*", async (c, next) => {
    c.set("config", config)
    await next()
  })

  app.get("/", (c) =>
    c.json({
      name: "copilot-bridge",
      status: "ok",
      bridge_mode: config.bridgeMode,
    }),
  )

  app.get("/healthz", (c) => c.json({ ok: true }))
  app.route("/v1/models", modelRoutes)
  app.route("/v1/responses", responsesRoutes)

  return app
}

export const startServer = (config: BridgeConfig) =>
  serve({
    fetch: createServer(config).fetch,
    hostname: config.host,
    port: config.port,
  })
