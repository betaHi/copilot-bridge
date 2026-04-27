import { Hono } from "hono"

import {
  chatResponseToResponsesJson,
  responsesPayloadToChatPayload,
  synthesizeResponsesSseFromChat,
  type ResponsesRequestLike,
} from "~/bridges/codex/chat-fallback"
import { normalizeResponsesSseStream } from "~/bridges/codex/normalize-stream"
import { normalizeCodexResponsesRequest } from "~/bridges/codex/responses"
import type { BridgeEnv } from "~/lib/config"
import { BridgeNotImplementedError } from "~/lib/error"
import { getModelCapability } from "~/lib/model-capabilities"
import { checkRateLimit, RateLimitError } from "~/lib/rate-limit"
import {
  fetchCopilot,
  getCopilotProviderContext,
} from "~/providers/copilot/client"

export const responsesRoutes = new Hono<BridgeEnv>()

responsesRoutes.post("/", async (c) => {
  try {
    await checkRateLimit()
  } catch (error) {
    if (error instanceof RateLimitError) {
      return c.json({ error: { message: error.message } }, 429)
    }
    throw error
  }
  const rawPayload = (await c.req.json()) as ResponsesRequestLike
  const payload = normalizeCodexResponsesRequest(
    rawPayload as unknown as Parameters<typeof normalizeCodexResponsesRequest>[0],
  ) as unknown as ResponsesRequestLike
  const config = c.get("config")
  const provider = getCopilotProviderContext(config)
  const search = new URL(c.req.url).search

  const capability = getModelCapability(payload.model)

  try {
    if (capability?.fallback === "chat-completions") {
      const chatPayload = responsesPayloadToChatPayload(payload, capability)
      const upstream = await fetchCopilot(provider, `/chat/completions${search}`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(chatPayload),
      })

      if (!upstream.ok) {
        const text = await upstream.text()
        return new Response(text, {
          status: upstream.status,
          headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
        })
      }

      const chatJson = (await upstream.json()) as Parameters<
        typeof chatResponseToResponsesJson
      >[1]

      if (payload.stream) {
        const stream = synthesizeResponsesSseFromChat(payload, chatJson)
        return new Response(stream, {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        })
      }

      const responsesJson = chatResponseToResponsesJson(payload, chatJson)
      return new Response(JSON.stringify(responsesJson), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }

    const upstream = await fetchCopilot(provider, `/responses${search}`, {
      method: "POST",
      headers: {
        accept: c.req.header("accept") ?? "application/json",
        "content-type": c.req.header("content-type") ?? "application/json",
      },
      body: JSON.stringify(payload),
    })

    const contentType = upstream.headers.get("content-type") ?? ""

    if (payload.stream && upstream.body && contentType.includes("text/event-stream")) {
      return new Response(normalizeResponsesSseStream(upstream.body), {
        status: upstream.status,
        headers: upstream.headers,
      })
    }

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
        501,
      )
    }

    throw error
  }
})