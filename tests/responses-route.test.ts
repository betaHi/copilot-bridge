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
  response: Response | ((request: CapturedRequest) => Response),
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
    const request = { url, method: init?.method ?? "GET", body: parsedBody }
    captured.push(request)
    const nextResponse = typeof response === "function" ? response(request) : response
    return nextResponse.clone()
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

const chatTextResponse = (
  content: string,
  options: { reasoningText?: string } = {},
) => new Response(
  JSON.stringify({
    id: "chatcmpl-final",
    created: 1700000000,
    model: "claude-opus-4.6",
    choices: [
      {
        message: {
          role: "assistant",
          content,
          reasoning_text: options.reasoningText,
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
  }),
  { status: 200, headers: { "content-type": "application/json" } },
)

const chatWebSearchToolCallResponse = (argumentsText: string) => new Response(
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
              function: { name: "web_search", arguments: argumentsText },
            },
          ],
        },
      },
    ],
  }),
  { status: 200, headers: { "content-type": "application/json" } },
)

const copilotSearchResponse = (text: string) => new Response(
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
        content: [{ type: "output_text", text }],
      },
    ],
    usage: { input_tokens: 12, output_tokens: 8 },
  }),
  { status: 200, headers: { "content-type": "application/json" } },
)

const responsesFunctionCallResponse = (argumentsText: string) => new Response(
  JSON.stringify({
    id: "resp-web-search-decision",
    object: "response",
    status: "completed",
    created_at: 1700000000,
    model: "gpt-5-mini",
    output: [
      {
        id: "fc_search",
        type: "function_call",
        status: "completed",
        call_id: "call_search",
        name: "web_search",
        arguments: argumentsText,
      },
    ],
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  }),
  { status: 200, headers: { "content-type": "application/json" } },
)

const responsesTextResponse = (
  text: string,
  reasoningText?: string,
) => new Response(
  JSON.stringify({
    id: "resp-final",
    object: "response",
    status: "completed",
    created_at: 1700000000,
    model: "gpt-5-mini",
    output: [
      ...(reasoningText ? [
        {
          id: "rs_final",
          type: "reasoning",
          status: "completed",
          summary: [{ type: "summary_text", text: reasoningText }],
        },
      ] : []),
      {
        id: "msg_final",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 30, output_tokens: 8, total_tokens: 38 },
  }),
  { status: 200, headers: { "content-type": "application/json" } },
)

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
    const models = ["gpt-5.5", "gpt-5.3-codex"]

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

  test("Claude opus 4.7 Codex fallback keeps base model for supported efforts", async () => {
    for (const [effort, expectedModel, expectedEffort] of [
      ["low", "claude-opus-4.7", "low"],
      ["medium", "claude-opus-4.7", "medium"],
      ["high", "claude-opus-4.7", "high"],
      ["xhigh", "claude-opus-4.7", "xhigh"],
      ["max", "claude-opus-4.7", "max"],
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

  test("Claude opus 4.8 Codex fallback routes through chat completions", async () => {
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-opus48",
        model: "claude-opus-4.8",
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
        model: "claude-opus-4.8",
        input: "hi",
        reasoning: { effort: "max", summary: "auto" },
      }),
    })

    expect(res.status).toBe(200)
    expect(captured[0].url).toBe("https://upstream.test/chat/completions")
    expect((captured[0].body as { model: string }).model).toBe(
      "claude-opus-4.8",
    )
    expect(
      (captured[0].body as { reasoning_effort?: string }).reasoning_effort,
    ).toBe("max")
    expect(
      (captured[0].body as { output_config?: { effort?: string } }).output_config,
    ).toBeUndefined()
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
    let chatCalls = 0
    const upstream = (request: CapturedRequest) => {
      if (request.url === "https://upstream.test/chat/completions") {
        chatCalls += 1
        return chatCalls === 1 ?
            chatWebSearchToolCallResponse(
              JSON.stringify({ query: "GitHub Copilot docs" }),
            )
          : chatTextResponse(
            "The GitHub Copilot docs are at https://docs.github.com/en/copilot.",
            { reasoningText: "Use the retrieved docs result." },
          )
      }

      return copilotSearchResponse(
        "1. GitHub Copilot docs - https://docs.github.com/en/copilot",
      )
    }
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
    expect(captured).toHaveLength(3)
    expect(captured[0].url).toBe("https://upstream.test/chat/completions")
    expect(captured[1].url).toBe("https://upstream.test/responses")
    expect(captured[2].url).toBe("https://upstream.test/chat/completions")
    const searchBody = captured[1].body as { input: string; model: string }
    expect(searchBody.model).toBe("gpt-5.5")
    expect(searchBody.input).toContain("GitHub Copilot docs")
    const finalBody = captured[2].body as {
      messages: Array<{ content?: string; role: string; tool_calls?: unknown }>
      tool_choice?: unknown
      tools?: unknown
    }
    expect(finalBody.tools).toBeUndefined()
    expect(finalBody.tool_choice).toBeUndefined()
    const contextMessage = finalBody.messages.find(
      (message) =>
        message.role === "system"
        && String(message.content ?? "").includes("Trusted bridge retrieval context"),
    )
    expect(contextMessage?.content).toContain(
      "Trusted bridge retrieval context",
    )
    expect(finalBody.messages.at(-1)?.content).toContain(
      "Answer the user's last request now",
    )
    expect(finalBody.messages.some((message) => message.tool_calls)).toBe(false)
    const json = (await res.json()) as {
      output: Array<{ type: string; content?: Array<{ text?: string }> }>
    }
    expect(json.output[0]?.type).toBe("web_search_call")
    expect(json.output[1]?.type).toBe("reasoning")
    expect(json.output[2]?.content?.[0]?.text).toBe(
      "The GitHub Copilot docs are at https://docs.github.com/en/copilot.",
    )
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
    let chatCalls = 0
    const upstream = (request: CapturedRequest) => {
      if (request.url === "https://upstream.test/chat/completions") {
        chatCalls += 1
        return chatCalls === 1 ?
            chatWebSearchToolCallResponse("GitHub Copilot docs")
          : chatTextResponse("I found the GitHub Copilot docs.")
      }

      return copilotSearchResponse(
        "I'll search now.\n1. GitHub Copilot docs - https://docs.github.com/en/copilot",
      )
    }
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
    expect(captured).toHaveLength(3)
    const searchBody = captured[1].body as { input: string; model: string }
    expect(searchBody.model).toBe("gpt-5.5")
    expect(searchBody.input).toContain("GitHub Copilot docs")
  })

  test("Codex fallback passes through web_search when backend is missing", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codex-web-search-home-"))
    process.env.HOME = home
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-missing-web-search-backend",
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
        tool_choice: { type: "web_search" },
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe("https://upstream.test/chat/completions")
    const upstreamBody = captured[0].body as {
      tool_choice?: { function?: { name?: string }; type?: string }
    }
    expect(upstreamBody.tool_choice).toEqual({
      type: "function",
      function: { name: "web_search" },
    })
    const json = (await res.json()) as {
      output: Array<{ name?: string; type: string }>
    }
    expect(json.output[0]?.type).toBe("function_call")
    expect(json.output[0]?.name).toBe("web_search")
  })

  test("Codex fallback passes through web_search when backend is empty", async () => {
    await writeCodexConfig('COPILOT_WEB_SEARCH_BACKEND = "   "\n')
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-empty-web-search-backend",
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
        tool_choice: { type: "web_search" },
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe("https://upstream.test/chat/completions")
    const json = (await res.json()) as {
      output: Array<{ name?: string; type: string }>
    }
    expect(json.output[0]?.type).toBe("function_call")
    expect(json.output[0]?.name).toBe("web_search")
  })

  test("Codex fallback web_search uses configured HTTP search model", async () => {
    await writeCodexConfig('COPILOT_WEB_SEARCH_BACKEND = "gpt-5.5"\n')
    const captured: Array<CapturedRequest> = []
    const upstream = (request: CapturedRequest) => {
      if (request.url === "https://upstream.test/chat/completions") {
        return chatTextResponse(
          "The GitHub Copilot docs are at https://docs.github.com/en/copilot.",
          { reasoningText: "Answer from the trusted search context." },
        )
      }

      return copilotSearchResponse(
        "1. GitHub Copilot docs - https://docs.github.com/en/copilot",
      )
    }
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
    expect(captured).toHaveLength(2)
    expect(captured[0].url).toBe("https://upstream.test/responses")
    expect(captured[1].url).toBe("https://upstream.test/chat/completions")
    const upstreamBody = captured[0].body as {
      input: string
      model: string
      tools: Array<{ type: string }>
    }
    expect(upstreamBody.model).toBe("gpt-5.5")
    expect(upstreamBody.tools).toEqual([{ type: "web_search_preview" }])
    expect(upstreamBody.input).toContain("Codex CLI")
    const finalBody = captured[1].body as {
      messages: Array<{ content?: string; role: string }>
      tool_choice?: unknown
      tools?: unknown
    }
    expect(finalBody.tools).toBeUndefined()
    expect(finalBody.tool_choice).toBeUndefined()
    const contextMessage = finalBody.messages.find(
      (message) =>
        message.role === "system"
        && String(message.content ?? "").includes("Trusted bridge retrieval context"),
    )
    expect(contextMessage?.content).toContain(
      "Trusted bridge retrieval context",
    )
    expect(contextMessage?.content).toContain(
      "https://docs.github.com/en/copilot",
    )
    expect(contextMessage?.content).not.toContain("I'll search now")
    expect(finalBody.messages.at(-1)?.content).toContain(
      "Answer the user's last request now",
    )

    const json = (await res.json()) as {
      model: string
      output: Array<{
        summary?: Array<{ text?: string }>
        type: string
        content?: Array<{ text?: string }>
      }>
    }
    expect(json.model).toBe("claude-opus-4.6")
    expect(json.output[0]?.type).toBe("web_search_call")
    expect(json.output[1]?.type).toBe("reasoning")
    expect(json.output[1]?.summary?.[0]?.text).toBe(
      "Answer from the trusted search context.",
    )
    expect(json.output[2]?.content?.[0]?.text).toContain(
      "https://docs.github.com/en/copilot",
    )
  })

  test("Codex native web_search uses configured backend after model selects it", async () => {
    await writeCodexConfig('COPILOT_WEB_SEARCH_BACKEND = "gpt-5.5"\n')
    const captured: Array<CapturedRequest> = []
    let responseCalls = 0
    const upstream = (request: CapturedRequest) => {
      if (request.url !== "https://upstream.test/responses") {
        throw new Error(`Unexpected upstream URL: ${request.url}`)
      }

      const body = request.body as { model?: string }
      if (body.model === "gpt-5.5") {
        return copilotSearchResponse(
          "I'll search now.\n1. GitHub Copilot docs - https://docs.github.com/en/copilot",
        )
      }

      responseCalls += 1
      return responseCalls === 1 ?
          responsesFunctionCallResponse(
            JSON.stringify({ query: "GitHub Copilot docs" }),
          )
        : responsesTextResponse(
          "https://docs.github.com/en/copilot",
          "Use native bridge retrieval.",
        )
    }
    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5-mini",
        input: "Use web search to find the GitHub Copilot docs URL. Reply with the URL only.",
        tools: [{ type: "web_search_preview" }],
        reasoning: { effort: "low" },
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(3)
    expect(captured[0].url).toBe("https://upstream.test/responses")
    const decisionBody = captured[0].body as {
      reasoning?: { effort?: string }
      tools?: Array<{ name?: string; type: string }>
    }
    expect(decisionBody.reasoning?.effort).toBe("low")
    expect(decisionBody.tools?.[0]).toMatchObject({
      type: "function",
      name: "web_search",
    })

    const searchBody = captured[1].body as {
      input: string
      model: string
      tools: Array<{ type: string }>
    }
    expect(searchBody.model).toBe("gpt-5.5")
    expect(searchBody.tools).toEqual([{ type: "web_search_preview" }])
    expect(searchBody.input).toContain("GitHub Copilot docs")

    const finalBody = captured[2].body as {
      input: Array<{ content?: Array<{ text?: string }>; role?: string }>
      reasoning?: { effort?: string }
      tool_choice?: unknown
      tools?: unknown
    }
    expect(finalBody.tools).toBeUndefined()
    expect(finalBody.tool_choice).toBeUndefined()
    expect(finalBody.reasoning?.effort).toBe("low")
    const contextItem = finalBody.input.find(
      (item) =>
        item.role === "system"
        && item.content?.some((part) =>
          part.text?.includes("Trusted bridge retrieval context"),
        ),
    )
    const contextText = contextItem?.content?.[0]?.text ?? ""
    expect(contextText).toContain("https://docs.github.com/en/copilot")
    expect(contextText).not.toContain("I'll search now")
    expect(finalBody.input.at(-1)?.role).toBe("user")
    expect(finalBody.input.at(-1)?.content?.[0]?.text).toContain(
      "Answer the user's last request now",
    )

    const json = (await res.json()) as {
      output: Array<{
        summary?: Array<{ text?: string }>
        type: string
        content?: Array<{ text?: string }>
      }>
    }
    expect(json.output.map((item) => item.type)).toEqual([
      "web_search_call",
      "reasoning",
      "message",
    ])
    expect(json.output[1]?.summary?.[0]?.text).toBe(
      "Use native bridge retrieval.",
    )
    expect(json.output[2]?.content?.[0]?.text).toBe(
      "https://docs.github.com/en/copilot",
    )
  })

  test("Codex fallback preserves final reasoning and message when web_search has no results", async () => {
    await writeCodexConfig('COPILOT_WEB_SEARCH_BACKEND = "gpt-5.5"\n')
    const captured: Array<CapturedRequest> = []
    const upstream = (request: CapturedRequest) => {
      if (request.url === "https://upstream.test/chat/completions") {
        return chatTextResponse(
          "I could not find useful web results for that query.",
          { reasoningText: "The retrieval context says no results were available." },
        )
      }

      return copilotSearchResponse("")
    }
    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        input: "search the web for unlikely bridge test query",
        tools: [{ type: "web_search", external_web_access: false }],
        tool_choice: { type: "web_search" },
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(2)
    const finalBody = captured[1].body as {
      messages: Array<{ content?: string; role: string }>
    }
    const contextMessage = finalBody.messages.find(
      (message) =>
        message.role === "system"
        && String(message.content ?? "").includes("Trusted bridge retrieval context"),
    )
    expect(contextMessage?.content).toContain(
      "Copilot HTTP web search did not return search results.",
    )
    const json = (await res.json()) as {
      output: Array<{
        summary?: Array<{ text?: string }>
        type: string
        content?: Array<{ text?: string }>
      }>
    }
    expect(json.output.map((item) => item.type)).toEqual([
      "web_search_call",
      "reasoning",
      "message",
    ])
    expect(json.output[1]?.summary?.[0]?.text).toBe(
      "The retrieval context says no results were available.",
    )
    expect(json.output[2]?.content?.[0]?.text).toBe(
      "I could not find useful web results for that query.",
    )
  })

  test("Codex fallback streams configured web_search final reasoning and message", async () => {
    await writeCodexConfig('COPILOT_WEB_SEARCH_BACKEND = "gpt-5.5"\n')
    const captured: Array<CapturedRequest> = []
    const upstream = (request: CapturedRequest) => {
      if (request.url === "https://upstream.test/chat/completions") {
        return chatTextResponse(
          "The streamed Copilot docs answer is ready.",
          { reasoningText: "Use the streamed final answer context." },
        )
      }

      return copilotSearchResponse(
        "1. GitHub Copilot docs - https://docs.github.com/en/copilot",
      )
    }
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
        stream: true,
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(2)
    const text = await res.text()
    expect(text).toContain("event: response.output_item.added")
    expect(text).toContain('"type":"web_search_call"')
    expect(text).toContain("response.reasoning_summary_text.delta")
    expect(text).toContain("Use the streamed final answer context.")
    expect(text).toContain("response.output_text.delta")
    expect(text).toContain("The streamed Copilot docs answer is ready.")
    expect(text).toContain("event: response.completed")
  })

  test("Codex fallback passes through web_search when backend model is unsupported", async () => {
    await writeCodexConfig('COPILOT_WEB_SEARCH_BACKEND = "gpt-4o"\n')
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-unsupported-web-search-backend",
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
        tool_choice: { type: "web_search" },
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe("https://upstream.test/chat/completions")
    const json = (await res.json()) as {
      output: Array<{ name?: string; type: string }>
    }
    expect(json.output[0]?.type).toBe("function_call")
    expect(json.output[0]?.name).toBe("web_search")
  })
})

beforeEach(async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "codex-route-empty-cfg-"))
  process.env.CODEX_CONFIG_PATH = path.join(configDir, "config.toml")
})
