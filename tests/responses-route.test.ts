import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { BridgeConfig, BridgeEnv } from "~/lib/config"
import { runtimeState } from "~/lib/state"
import { chatCompletionRoutes } from "~/routes/chat-completions"
import { responsesRoutes } from "~/routes/responses"

import { Hono } from "hono"

interface CapturedRequest {
  url: string
  method: string
  body: unknown
}

const buildApp = (
  captured: Array<CapturedRequest>,
  response: Response,
  route: "chat-completions" | "responses" = "responses",
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
  if (route === "chat-completions") {
    app.route("/v1/chat/completions", chatCompletionRoutes)
  } else {
    app.route("/v1/responses", responsesRoutes)
  }

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
const originalCodexConfigPath = process.env.CODEX_CONFIG_PATH
const originalHome = process.env.HOME

afterEach(() => {
  restore()
  restore = () => {}
  delete runtimeState.modelOverride
  if (originalCodexConfigPath === undefined) {
    delete process.env.CODEX_CONFIG_PATH
  } else {
    process.env.CODEX_CONFIG_PATH = originalCodexConfigPath
  }
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
})

const writeCodexConfig = async (content: string): Promise<void> => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "codex-web-search-cfg-"))
  process.env.CODEX_CONFIG_PATH = path.join(configDir, "config.toml")
  await writeFile(process.env.CODEX_CONFIG_PATH, content)
}

describe("/v1/responses route — passthrough vs translation contract", () => {
  test("uses runtime model override without changing client config", async () => {
    runtimeState.modelOverride = "gpt-5.3-codex"
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
        model: "gpt-5.4",
        input: "ping",
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect((captured[0].body as { model: string }).model).toBe("gpt-5.3-codex")
  })

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

  test("injects Codex config reasoning effort when Codex omits reasoning", async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), "codex-route-cfg-"))
    process.env.CODEX_CONFIG_PATH = path.join(configDir, "config.toml")
    await writeFile(
      process.env.CODEX_CONFIG_PATH,
      `model = "gpt-5-mini"
model_reasoning_effort = "high"
`,
    )

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
        model: "gpt-5-mini",
        input: "ping",
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(
      (captured[0].body as { reasoning?: { effort?: string } }).reasoning?.effort,
    ).toBe("high")
  })

  test("chat-completions routes responses-only GPT models directly to /responses", async () => {
    const models = ["gpt-5.5", "gpt-5.2-codex"]

    for (const model of models) {
      const captured: Array<CapturedRequest> = []
      const upstream = new Response(
        JSON.stringify({
          id: "resp-direct",
          created_at: 1700000000,
          model,
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "OK" }],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
      const { app, restore: r } = buildApp(captured, upstream, "chat-completions")
      restore = r

      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 16,
          reasoning_effort: "high",
          stream: false,
        }),
      })

      expect(res.status).toBe(200)
      expect(captured).toHaveLength(1)
      expect(captured[0].url).toBe("https://upstream.test/responses")
      expect((captured[0].body as { model: string }).model).toBe(model)
      expect(
        (captured[0].body as { reasoning?: { effort?: string } }).reasoning
          ?.effort,
      ).toBe("high")
      restore()
      restore = () => {}
    }
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

  test("Claude opus 4.7 Codex fallback routes reasoning efforts to variants", async () => {
    for (const [effort, expectedModel, expectedEffort] of [
      ["medium", "claude-opus-4.7", "medium"],
      ["high", "claude-opus-4.7-high", "high"],
      ["xhigh", "claude-opus-4.7-xhigh", "xhigh"],
      ["max", "claude-opus-4.7-xhigh", "xhigh"],
    ] as const) {
      const captured: Array<CapturedRequest> = []
      const upstream = new Response(
        JSON.stringify({
          id: `chatcmpl-opus47-${effort}`,
          model: expectedModel,
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
          reasoning: { effort },
        }),
      })

      expect(res.status).toBe(200)
      expect((captured[0].body as { model: string }).model).toBe(expectedModel)
      expect(
        (captured[0].body as { output_config?: { effort?: string } })
          .output_config,
      ).toEqual({ effort: expectedEffort })
      restore()
    }
  })

  test("Claude opus 4.7 Codex fallback accepts public 1M alias", async () => {
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-opus47-1m",
        model: "claude-opus-4.7-1m-internal",
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
        model: "claude-opus-4.7-1m",
        input: "hi",
        reasoning: { effort: "high" },
      }),
    })

    expect(res.status).toBe(200)
    expect((captured[0].body as { model: string }).model).toBe(
      "claude-opus-4.7-1m-internal",
    )
    expect(
      (captured[0].body as { output_config?: { effort?: string } })
        .output_config,
    ).toEqual({ effort: "high" })
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

  test("Codex fallback ignores default web_search availability when not selected", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codex-web-search-home-"))
    process.env.HOME = home
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-web-search-ignored",
        model: "claude-opus-4.6",
        choices: [{ message: { role: "assistant", content: "PONG" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        input: "reply PONG only",
        tools: [{ type: "web_search", external_web_access: false }],
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe("https://upstream.test/chat/completions")
    const upstreamBody = captured[0].body as { tools?: Array<unknown> }
    expect(upstreamBody.tools).toEqual([
      {
        type: "function",
        function: expect.objectContaining({ name: "web_search" }),
      },
    ])
    const json = (await res.json()) as {
      output: Array<{ content?: Array<{ text?: string }> }>
    }
    expect(json.output[0]?.content?.[0]?.text).toBe("PONG")
  })

  test("Codex fallback executes configured web_search only after model calls it", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codex-web-search-home-"))
    process.env.HOME = home
    await writeCodexConfig('COPILOT_WEB_SEARCH_BACKEND = "gpt-5.5"\n')
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-web-search-call",
        model: "claude-opus-4.6",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_search",
                  type: "function",
                  function: {
                    name: "web_search",
                    arguments: JSON.stringify({ query: "GitHub Copilot docs" }),
                  },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        input: "search the web for GitHub Copilot docs",
        tools: [{ type: "web_search", external_web_access: false }],
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(2)
    expect(captured[0].url).toBe("https://upstream.test/chat/completions")
    expect(captured[1].url).toBe("https://upstream.test/responses")
    const searchBody = captured[1].body as { input: string; model: string }
    expect(searchBody.model).toBe("gpt-5.5")
    expect(searchBody.input).toContain("GitHub Copilot docs")
    const json = (await res.json()) as {
      output: Array<{ type: string; content?: Array<{ text?: string }> }>
    }
    expect(json.output[0]?.type).toBe("web_search_call")
  })

  test("Codex fallback does not execute web_search for empty tool arguments", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codex-web-search-home-"))
    process.env.HOME = home
    await writeCodexConfig('COPILOT_WEB_SEARCH_BACKEND = "gpt-5.5"\n')
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-empty-web-search-call",
        model: "claude-opus-4.6",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_search",
                  type: "function",
                  function: { name: "web_search", arguments: "" },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        input: "search the web",
        tools: [{ type: "web_search", external_web_access: false }],
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    const json = (await res.json()) as { output: Array<{ type: string }> }
    expect(json.output[0]?.type).toBe("function_call")
  })

  test("Codex fallback uses malformed web_search arguments as the raw query", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codex-web-search-home-"))
    process.env.HOME = home
    await writeCodexConfig('COPILOT_WEB_SEARCH_BACKEND = "gpt-5.5"\n')
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-raw-web-search-call",
        model: "claude-opus-4.6",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_search",
                  type: "function",
                  function: { name: "web_search", arguments: "GitHub Copilot docs" },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        input: "search the web",
        tools: [{ type: "web_search", external_web_access: false }],
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(2)
    const searchBody = captured[1].body as { input: string; model: string }
    expect(searchBody.model).toBe("gpt-5.5")
    expect(searchBody.input).toContain("GitHub Copilot docs")
  })

  test("Codex fallback web_search returns configuration guidance when backend is missing", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codex-web-search-home-"))
    process.env.HOME = home
    const captured: Array<CapturedRequest> = []
    const upstream = new Response("should not be called", { status: 500 })
    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        input: "search the web for GitHub Copilot docs",
        tools: [{ type: "web_search", external_web_access: false }],
        tool_choice: { type: "web_search" },
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(0)
    const json = (await res.json()) as {
      output: Array<{ type: string; content?: Array<{ text?: string }> }>
    }
    expect(json.output[0]?.type).toBe("web_search_call")
    const text = json.output[1]?.content?.[0]?.text ?? ""
    expect(text).toContain("Codex web search is not configured")
    expect(text).toContain("~/.codex/config.toml")
    expect(text).not.toContain("~/.claude/settings.json")
    expect(text).toContain("model id")
    expect(text).toContain("searxng")
    expect(text).toContain("copilot-cli")
  })

  test("Codex fallback web_search uses configured HTTP search model", async () => {
    await writeCodexConfig('COPILOT_WEB_SEARCH_BACKEND = "gpt-5.5"\n')
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "resp-search",
        created_at: 1700000000,
        model: "gpt-5.5",
        output: [
          {
            type: "web_search_call",
            action: { query: "GitHub Copilot docs" },
          },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "1. GitHub Copilot docs - https://docs.github.com/en/copilot",
              },
            ],
          },
        ],
        usage: { input_tokens: 12, output_tokens: 8 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        input: "search the web for GitHub Copilot docs",
        tools: [{ type: "web_search", external_web_access: false }],
        tool_choice: { type: "web_search" },
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe("https://upstream.test/responses")
    const upstreamBody = captured[0].body as {
      input: string
      model: string
      tools: Array<{ type: string }>
    }
    expect(upstreamBody.model).toBe("gpt-5.5")
    expect(upstreamBody.tools).toEqual([{ type: "web_search_preview" }])
    expect(upstreamBody.input).toContain("Codex CLI")

    const json = (await res.json()) as {
      model: string
      output: Array<{ type: string; content?: Array<{ text?: string }> }>
    }
    expect(json.model).toBe("claude-opus-4.6")
    expect(json.output[0]?.type).toBe("web_search_call")
    expect(json.output[1]?.content?.[0]?.text).toContain(
      "https://docs.github.com/en/copilot",
    )
  })

  test("Codex fallback web_search reports unsupported HTTP search models", async () => {
    await writeCodexConfig('COPILOT_WEB_SEARCH_BACKEND = "gpt-4o"\n')
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({ error: { message: "web search unsupported" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    )
    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        input: "search the web for GitHub Copilot docs",
        tools: [{ type: "web_search", external_web_access: false }],
        tool_choice: { type: "web_search" },
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe("https://upstream.test/responses")
    const json = (await res.json()) as {
      output: Array<{ type: string; content?: Array<{ text?: string }> }>
    }
    const text = json.output[1]?.content?.[0]?.text ?? ""
    expect(text).toContain("Copilot HTTP web search is not available for model gpt-4o")
    expect(text).toContain("~/.codex/config.toml")
    expect(text).toContain("model id")
    expect(text).toContain("searxng")
    expect(text).toContain("copilot-cli")
  })
})

beforeEach(async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "codex-route-empty-cfg-"))
  process.env.CODEX_CONFIG_PATH = path.join(configDir, "config.toml")
})
