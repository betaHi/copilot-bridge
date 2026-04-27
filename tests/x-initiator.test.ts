import { afterEach, describe, expect, test } from "bun:test"

import { Hono } from "hono"

import type { BridgeConfig, BridgeEnv } from "~/lib/config"
import { messageRoutes } from "~/routes/messages"

interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
}

const buildApp = (
  captured: Array<CapturedRequest>,
  response: () => Response,
) => {
  const config: BridgeConfig = {
    host: "127.0.0.1",
    port: 0,
    accountType: "individual",
    copilotBaseUrl: "https://upstream.test",
    copilotToken: "test-token",
    vsCodeVersion: "1.0.0",
  }

  const app = new Hono<BridgeEnv>()
  app.use("*", async (c, next) => {
    c.set("config", config)
    await next()
  })
  app.route("/v1/messages", messageRoutes)

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    const headers: Record<string, string> = {}
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
    captured.push({ url, method: init?.method ?? "GET", headers })
    return response()
  }) as typeof fetch

  return {
    app,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

let restore: () => void = () => {}

afterEach(() => {
  restore()
  restore = () => {}
})

const upstreamOk = () =>
  new Response(
    JSON.stringify({
      id: "chatcmpl-x",
      created: 1700000000,
      model: "claude-opus-4.7",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )

describe("X-Initiator header", () => {
  test("user-only conversation sends x-initiator: user", async () => {
    const captured: Array<CapturedRequest> = []
    const { app, restore: r } = buildApp(captured, upstreamOk)
    restore = r

    await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(captured[0].headers["x-initiator"]).toBe("user")
  })

  test("conversation containing assistant turn sends x-initiator: agent", async () => {
    const captured: Array<CapturedRequest> = []
    const { app, restore: r } = buildApp(captured, upstreamOk)
    restore = r

    await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 32,
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "reply" },
          { role: "user", content: "follow-up" },
        ],
      }),
    })

    expect(captured[0].headers["x-initiator"]).toBe("agent")
  })

  test("image content triggers copilot-vision-request header", async () => {
    const captured: Array<CapturedRequest> = []
    const { app, restore: r } = buildApp(captured, upstreamOk)
    restore = r

    await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 32,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "iVBORw0KGgo=",
                },
              },
              { type: "text", text: "describe" },
            ],
          },
        ],
      }),
    })

    expect(captured[0].headers["copilot-vision-request"]).toBe("true")
  })
})
