import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"

import type { BridgeConfig, BridgeEnv } from "~/lib/config"
import { chatCompletionRoutes } from "~/routes/chat-completions"
import { embeddingRoutes } from "~/routes/embeddings"
import { messageRoutes } from "~/routes/messages"
import { modelRoutes } from "~/routes/models"
import { responsesRoutes } from "~/routes/responses"
import { usageRoutes } from "~/routes/usage"

export const createServer = (config: BridgeConfig) => {
  const app = new Hono<BridgeEnv>()

  app.use(logger())
  app.use("*", cors())
  app.use("*", async (c, next) => {
    c.set("config", config)
    await next()
  })

  app.get("/", (c) =>
    c.json({
      name: "copilot-bridge",
      status: "ok",
    }),
  )

  app.get("/healthz", (c) => c.json({ ok: true }))
  app.route("/v1/models", modelRoutes)
  app.route("/v1/responses", responsesRoutes)
  app.route("/v1/messages", messageRoutes)
  app.route("/v1/chat/completions", chatCompletionRoutes)
  app.route("/v1/embeddings", embeddingRoutes)
  app.route("/usage", usageRoutes)

  return app
}

export const startServer = (config: BridgeConfig) =>
  serve({
    fetch: createServer(config).fetch,
    hostname: config.host,
    port: config.port,
  })
