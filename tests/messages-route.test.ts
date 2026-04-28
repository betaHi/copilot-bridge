import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeAll, describe, expect, test } from "bun:test"

import { Hono } from "hono"

import type { BridgeConfig, BridgeEnv } from "~/lib/config"
import { runtimeState } from "~/lib/state"
import { messageRoutes } from "~/routes/messages"

beforeAll(() => {
  runtimeState.models = {
    object: "list",
    data: [
      {
        id: "claude-opus-4.6-1m",
        name: "Claude Opus 4.6 1M",
        object: "model",
        vendor: "Anthropic",
        version: "1",
        preview: false,
        model_picker_enabled: true,
        capabilities: {
          family: "claude-opus-4.6-1m",
          object: "model_capabilities",
          tokenizer: "o200k_base",
          type: "chat",
          limits: {},
          supports: { tool_calls: true },
        },
      },
      {
        id: "claude-opus-4.7",
        name: "Claude Opus 4.7",
        object: "model",
        vendor: "Anthropic",
        version: "1",
        preview: false,
        model_picker_enabled: true,
        capabilities: {
          family: "claude-opus-4.7",
          object: "model_capabilities",
          tokenizer: "o200k_base",
          type: "chat",
          limits: {},
          supports: { tool_calls: true },
        },
      },
      {
        id: "claude-sonnet-4.6",
        name: "Claude Sonnet 4.6",
        object: "model",
        vendor: "Anthropic",
        version: "1",
        preview: false,
        model_picker_enabled: true,
        capabilities: {
          family: "claude-sonnet-4.6",
          object: "model_capabilities",
          tokenizer: "o200k_base",
          type: "chat",
          limits: {},
          supports: { tool_calls: true },
        },
      },
      {
        id: "claude-haiku-4.5",
        name: "Claude Haiku 4.5",
        object: "model",
        vendor: "Anthropic",
        version: "1",
        preview: false,
        model_picker_enabled: true,
        capabilities: {
          family: "claude-haiku-4.5",
          object: "model_capabilities",
          tokenizer: "o200k_base",
          type: "chat",
          limits: {},
          supports: { tool_calls: true },
        },
      },
    ],
  }
})

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
  app.route("/v1/messages", messageRoutes)

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
const originalHome = process.env.HOME

afterEach(() => {
  restore()
  restore = () => {}
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
})

describe("/v1/messages route", () => {
  test("non-stream translation returns Anthropic format", async () => {
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-1",
        created: 1700000000,
        model: "claude-opus-4.7",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "OK" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Reply with OK" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe("https://upstream.test/chat/completions")
    expect((captured[0].body as { model: string }).model).toBe("claude-opus-4.7")

    const json = (await res.json()) as {
      type: string
      role: string
      stop_reason: string | null
      content: Array<{ type: string; text?: string }>
    }
    expect(json.type).toBe("message")
    expect(json.role).toBe("assistant")
    expect(json.stop_reason).toBe("end_turn")
    expect(json.content[0]).toEqual({ type: "text", text: "OK" })
  })

  test("normalizes Claude snapshot model ids before forwarding upstream", async () => {
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-2",
        created: 1700000000,
        model: "claude-sonnet-4.6",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "OK" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6-20260401",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Reply with OK" }],
      }),
    })

    expect(res.status).toBe(200)
    expect((captured[0].body as { model: string }).model).toBe(
      "claude-sonnet-4.6",
    )
  })

  test("maps Claude client opus alias to the default upstream opus model", async () => {
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-2b",
        created: 1700000000,
        model: "claude-opus-4.7",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "OK" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "opus",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Reply with OK" }],
      }),
    })

    expect(res.status).toBe(200)
    expect((captured[0].body as { model: string }).model).toBe("claude-opus-4.7")
  })

  test("maps Claude client opus[1m] alias to the 1m upstream opus model", async () => {
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-2c",
        created: 1700000000,
        model: "claude-opus-4.6-1m",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "OK" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "opus[1m]",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Reply with OK" }],
      }),
    })

    expect(res.status).toBe(200)
    expect((captured[0].body as { model: string }).model).toBe(
      "claude-opus-4.6-1m",
    )
  })

  test("maps Claude client sonnet and haiku aliases to upstream models", async () => {
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-2d",
        created: 1700000000,
        model: "claude-sonnet-4.6",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "OK" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const sonnetRes = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "sonnet",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Reply with OK" }],
      }),
    })

    expect(sonnetRes.status).toBe(200)
    expect((captured[0].body as { model: string }).model).toBe(
      "claude-sonnet-4.6",
    )

    const haikuUpstream = new Response(
      JSON.stringify({
        id: "chatcmpl-2e",
        created: 1700000000,
        model: "claude-haiku-4.5",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "OK" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )

    restore()
    const next = buildApp(captured, haikuUpstream)
    restore = next.restore

    const haikuRes = await next.app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "haiku",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Reply with OK" }],
      }),
    })

    expect(haikuRes.status).toBe(200)
    expect((captured[1].body as { model: string }).model).toBe(
      "claude-haiku-4.5",
    )
  })

  test("uses settings.json model defaults when Claude sends a placeholder model", async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "claude-settings-model-"))
    process.env.HOME = tempHome
    await mkdir(path.join(tempHome, ".claude"), { recursive: true })
    await writeFile(
      path.join(tempHome, ".claude", "settings.json"),
      JSON.stringify(
        {
          env: {
            ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4.6-1m",
          },
          model: "opus[1m]",
        },
        null,
        2,
      ),
    )

    try {
      const captured: Array<CapturedRequest> = []
      const upstream = new Response(
        JSON.stringify({
          id: "chatcmpl-2f",
          created: 1700000000,
          model: "claude-opus-4.6-1m",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "OK" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )

      const { app, restore: r } = buildApp(captured, upstream)
      restore = r

      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "definitely-not-a-real-model",
          max_tokens: 1024,
          messages: [{ role: "user", content: "Reply with OK" }],
        }),
      })

      expect(res.status).toBe(200)
      expect((captured[0].body as { model: string }).model).toBe(
        "claude-opus-4.6-1m",
      )
    } finally {
      await rm(tempHome, { recursive: true, force: true })
    }
  })

  test("uses ANTHROPIC_SMALL_FAST_MODEL when settings.json selects haiku", async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "claude-settings-haiku-"))
    process.env.HOME = tempHome
    await mkdir(path.join(tempHome, ".claude"), { recursive: true })
    await writeFile(
      path.join(tempHome, ".claude", "settings.json"),
      JSON.stringify(
        {
          env: {
            ANTHROPIC_SMALL_FAST_MODEL: "claude-sonnet-4.6",
          },
          model: "haiku",
        },
        null,
        2,
      ),
    )

    try {
      const captured: Array<CapturedRequest> = []
      const upstream = new Response(
        JSON.stringify({
          id: "chatcmpl-2g",
          created: 1700000000,
          model: "claude-haiku-4.5",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "OK" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )

      const { app, restore: r } = buildApp(captured, upstream)
      restore = r

      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "definitely-not-a-real-model",
          max_tokens: 1024,
          messages: [{ role: "user", content: "Reply with OK" }],
        }),
      })

      expect(res.status).toBe(200)
      expect((captured[0].body as { model: string }).model).toBe(
        "claude-sonnet-4.6",
      )
    } finally {
      await rm(tempHome, { recursive: true, force: true })
    }
  })

  test("preserves requested reasoning effort for Claude 4.6 models", async () => {
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-3",
        created: 1700000000,
        model: "claude-opus-4.6",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "OK" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        max_tokens: 1024,
        reasoning_effort: "high",
        messages: [{ role: "user", content: "Reply with OK" }],
      }),
    })

    expect(res.status).toBe(200)
    expect((captured[0].body as { reasoning_effort?: string }).reasoning_effort).toBe(
      "high",
    )
  })

  test("does not attach reasoning effort to Claude models without reasoning support", async () => {
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-4",
        created: 1700000000,
        model: "claude-opus-4.5",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "OK" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Reply with OK" }],
      }),
    })

    expect(res.status).toBe(200)
    expect((captured[0].body as { reasoning_effort?: string }).reasoning_effort).toBeUndefined()
  })

  test("stream mode translates OpenAI chunks to Anthropic SSE events", async () => {
    const captured: Array<CapturedRequest> = []
    const sseBody = [
      'data: {"id":"cmpl-1","object":"chat.completion.chunk","created":1700000001,"model":"claude-opus-4.7","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null,"logprobs":null}],"usage":{"prompt_tokens":10,"completion_tokens":0,"total_tokens":10}}\n\n',
      'data: {"id":"cmpl-1","object":"chat.completion.chunk","created":1700000001,"model":"claude-opus-4.7","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null,"logprobs":null}],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}\n\n',
      'data: {"id":"cmpl-1","object":"chat.completion.chunk","created":1700000001,"model":"claude-opus-4.7","choices":[{"index":0,"delta":{},"finish_reason":"stop","logprobs":null}],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}\n\n',
      "data: [DONE]\n\n",
    ].join("")

    const upstream = new Response(sseBody, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    })

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        stream: true,
        max_tokens: 1024,
        messages: [{ role: "user", content: "Reply with OK" }],
      }),
    })

    expect(res.status).toBe(200)
    expect((captured[0].body as { stream: boolean }).stream).toBe(true)

    const text = await res.text()
    expect(text).toContain("event: message_start")
    expect(text).toContain("event: content_block_start")
    expect(text).toContain("event: content_block_delta")
    expect(text).toContain("event: message_stop")
    expect(text).toContain('"text":"OK"')
  })

  test("count_tokens returns positive token estimate", async () => {
    const captured: Array<CapturedRequest> = []
    const upstream = new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    })

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Count tokens for this message" }],
        tools: [
          {
            name: "get_weather",
            input_schema: {
              type: "object",
              properties: {
                city: { type: "string" },
              },
            },
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as { input_tokens: number }
    expect(json.input_tokens).toBeGreaterThan(1)
    expect(captured).toHaveLength(0)
  })
})
