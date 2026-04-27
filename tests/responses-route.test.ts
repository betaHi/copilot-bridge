import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { BridgeConfig, BridgeEnv } from "~/lib/config"
import { responsesRoutes } from "~/routes/responses"

import { Hono } from "hono"

interface CapturedRequest {
  url: string
  method: string
  body: unknown
}

const buildApp = (captured: Array<CapturedRequest>, response: Response) => {
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
  app.route("/v1/responses", responsesRoutes)

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    let parsedBody: unknown
    if (typeof init?.body === "string") {
      try {
        parsedBody = JSON.parse(init.body)
      } catch {
        parsedBody = init.body
      }
    }
    captured.push({ url, method: init?.method ?? "GET", body: parsedBody })
    return response.clone()
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

describe("/v1/responses route — passthrough vs translation contract", () => {
  test("GPT-5 family is forwarded directly to upstream /responses (true passthrough)", async () => {
    const captured: Array<CapturedRequest> = []
    const upstream = new Response('{"id":"resp_1","object":"response"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    })
    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.3-codex",
        input: "ping",
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe("https://upstream.test/responses")
    expect((captured[0].body as { model: string }).model).toBe("gpt-5.3-codex")
  })

  test("alias-only model (gemini-3.1-pro) is rewritten and routed to chat/completions", async () => {
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-x",
        model: "gemini-3.1-pro-preview",
        choices: [{ message: { role: "assistant", content: "OK" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.1-pro",
        input: "ping",
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe("https://upstream.test/chat/completions")
    expect((captured[0].body as { model: string }).model).toBe(
      "gemini-3.1-pro-preview",
    )
    const json = (await res.json()) as { object: string; output: Array<unknown> }
    expect(json.object).toBe("response")
    expect(json.output).toHaveLength(1)
  })

  test("Claude fallback synthesizes SSE when stream=true", async () => {
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-y",
        model: "claude-opus-4.7",
        choices: [{ message: { role: "assistant", content: "Hi" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        input: "hi",
        stream: true,
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    // Upstream call must be non-stream chat/completions
    expect(captured[0].url).toBe("https://upstream.test/chat/completions")
    expect((captured[0].body as { stream: boolean }).stream).toBe(false)
    const sseText = await res.text()
    expect(sseText).toContain("event: response.created")
    expect(sseText).toContain("event: response.completed")
    expect(sseText).toContain('"delta":"Hi"')
  })

  test("upstream errors on translated path are propagated with original status", async () => {
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({ error: { message: "bad", code: "invalid_request_body" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    )
    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        input: "x",
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toBe("bad")
  })
})

beforeEach(() => {
  // no-op; placeholder to keep symmetry with afterEach
})
