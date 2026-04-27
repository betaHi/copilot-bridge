import { Hono } from "hono"
import { streamSSE, type SSEMessage } from "hono/streaming"

import type { BridgeEnv } from "~/lib/config"
import { BridgeNotImplementedError, HTTPError } from "~/lib/error"
import { checkRateLimit, RateLimitError } from "~/lib/rate-limit"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/providers/copilot/chat-types"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"

export const chatCompletionRoutes = new Hono<BridgeEnv>()

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse =>
  typeof response === "object"
  && response !== null
  && Object.hasOwn(response, "choices")

chatCompletionRoutes.post("/", async (c) => {
  try {
    await checkRateLimit()
    const payload = await c.req.json<ChatCompletionsPayload>()
    const response = await createChatCompletions(c.var.config, payload)

    if (isNonStreaming(response)) {
      return c.json(response)
    }

    return streamSSE(c, async (stream) => {
      for await (const chunk of response) {
        await stream.writeSSE(chunk as SSEMessage)
      }
    })
  } catch (error) {
    if (error instanceof RateLimitError) {
      return c.json({ error: { message: error.message } }, 429)
    }
    if (error instanceof BridgeNotImplementedError) {
      return c.json(
        { error: { type: error.name, message: error.message } },
        501,
      )
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
