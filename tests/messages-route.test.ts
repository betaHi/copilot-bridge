import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
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
        id: "claude-opus-4.7-1m-internal",
        name: "Claude Opus 4.7 1M",
        object: "model",
        vendor: "Anthropic",
        version: "1",
        preview: false,
        model_picker_enabled: true,
        capabilities: {
          family: "claude-opus-4.7-1m-internal",
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

const getFixtureModelId = (name: string): string => {
  const model = runtimeState.models?.data.find((candidate) => candidate.name === name)
  if (!model) {
    throw new Error(`Missing test model fixture: ${name}`)
  }
  return model.id
}

const buildApp = (
  captured: Array<CapturedRequest>,
  response: Response | ((request: CapturedRequest) => Response),
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
    const upstreamResponse =
      typeof response === "function" ? response(request) : response
    return upstreamResponse.clone()
  }) as typeof fetch

  return {
    app,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

const chatTextResponse = (content: string, model = "claude-haiku-4.5") =>
  new Response(
    JSON.stringify({
      id: "chatcmpl-text",
      created: 1700000000,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )

const chatWebSearchToolCallResponse = (
  query: string,
  name = "WebSearch",
  model = "claude-haiku-4.5",
) =>
  new Response(
    JSON.stringify({
      id: "chatcmpl-websearch-call",
      created: 1700000000,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_web_search",
                type: "function",
                function: { name, arguments: JSON.stringify({ query }) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )

const copilotWebSearchResponse = (
  query: string,
  text: string,
  model = "gpt-5.5",
) =>
  new Response(
    JSON.stringify({
      id: "resp-web-search",
      created_at: 1700000000,
      model,
      output: [
        {
          type: "web_search_call",
          action: { type: "search", query, queries: [query] },
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        },
      ],
      usage: { input_tokens: 20, output_tokens: 12, total_tokens: 32 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )

let restore: () => void = () => {}
let isolatedHome: string | undefined
const originalHome = process.env.HOME
const originalCwd = process.cwd()
const originalCopilotWebSearchBackend = process.env.COPILOT_WEB_SEARCH_BACKEND
const originalModelReasoningEffort = process.env.MODEL_REASONING_EFFORT
const originalCopilotReasoningEffort = process.env.COPILOT_REASONING_EFFORT

beforeEach(async () => {
  delete process.env.COPILOT_WEB_SEARCH_BACKEND
  delete process.env.MODEL_REASONING_EFFORT
  delete process.env.COPILOT_REASONING_EFFORT
  isolatedHome = await mkdtemp(path.join(os.tmpdir(), "claude-empty-home-"))
  await mkdir(path.join(isolatedHome, ".claude"), { recursive: true })
  await writeFile(path.join(isolatedHome, ".claude", "settings.json"), "{}\n")
  process.env.HOME = isolatedHome
  process.chdir(isolatedHome)
})

afterEach(async () => {
  restore()
  restore = () => {}
  delete runtimeState.modelOverride
  process.chdir(originalCwd)
  if (isolatedHome) {
    await rm(isolatedHome, { recursive: true, force: true })
    isolatedHome = undefined
  }
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalModelReasoningEffort === undefined) {
    delete process.env.MODEL_REASONING_EFFORT
  } else {
    process.env.MODEL_REASONING_EFFORT = originalModelReasoningEffort
  }
  if (originalCopilotReasoningEffort === undefined) {
    delete process.env.COPILOT_REASONING_EFFORT
  } else {
    process.env.COPILOT_REASONING_EFFORT = originalCopilotReasoningEffort
  }
  if (originalCopilotWebSearchBackend === undefined) {
    delete process.env.COPILOT_WEB_SEARCH_BACKEND
  } else {
    process.env.COPILOT_WEB_SEARCH_BACKEND = originalCopilotWebSearchBackend
  }
})

describe("/v1/messages route", () => {
  test("uses runtime model override without writing Claude settings", async () => {
    runtimeState.modelOverride = "claude-sonnet-4.6"
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-runtime-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect((captured[0].body as { model: string }).model).toBe(
      "claude-sonnet-4.6",
    )
  })

  test("shortens long MCP tool names upstream and restores them in tool_use", async () => {
    const originalToolName =
      "mcp__plugin_microsoft-docs_microsoft-learn__microsoft_code_sample_search"
    const captured: Array<CapturedRequest> = []
    const upstream = (request: CapturedRequest) => {
      const body = request.body as {
        tools?: Array<{ function: { name: string } }>
      }
      const upstreamToolName = body.tools?.[0]?.function.name ?? "missing"
      return new Response(
        JSON.stringify({
          id: "chatcmpl-tool",
          created: 1700000000,
          model: "claude-sonnet-4.6",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: upstreamToolName, arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        max_tokens: 1024,
        messages: [{ role: "user", content: "search docs" }],
        tools: [
          {
            name: originalToolName,
            description: "Search Microsoft Learn code samples",
            input_schema: { type: "object", properties: {} },
          },
        ],
        tool_choice: { type: "tool", name: originalToolName },
      }),
    })

    expect(res.status).toBe(200)
    const upstreamBody = captured[0].body as {
      tool_choice?: { function?: { name?: string } }
      tools?: Array<{ function: { name: string } }>
    }
    const upstreamToolName = upstreamBody.tools?.[0]?.function.name

    expect(typeof upstreamToolName).toBe("string")
    expect(upstreamToolName).not.toBe(originalToolName)
    expect(upstreamToolName?.length).toBeLessThanOrEqual(64)
    expect(upstreamBody.tool_choice?.function?.name).toBe(upstreamToolName)

    const json = (await res.json()) as {
      content: Array<{
        id?: string
        input?: Record<string, unknown>
        name?: string
        type: string
      }>
      stop_reason: string | null
    }
    expect(json.stop_reason).toBe("tool_use")
    expect(json.content).toContainEqual({
      type: "tool_use",
      id: "call_1",
      name: originalToolName,
      input: {},
    })
  })

  test("shortens Microsoft Learn MCP tool names for Claude opus 4.7 xhigh requests", async () => {
    const originalToolName =
      "mcp__plugin_microsoft-docs_microsoft-learn__microsoft_code_sample_search"
    const originalSecondToolName =
      "mcp__plugin_microsoft-docs_microsoft-learn__microsoft_docs_search"
    const fillerTools = Array.from({ length: 38 }, (_, index) => ({
      name: `tool_${index}`,
      description: `Filler tool ${index}`,
      input_schema: { type: "object", properties: {} },
    }))
    const captured: Array<CapturedRequest> = []
    const upstream = (request: CapturedRequest) => {
      const body = request.body as {
        tools?: Array<{ function: { name: string } }>
      }
      const upstreamToolName = body.tools?.[0]?.function.name ?? "missing"
      return new Response(
        JSON.stringify({
          id: "chatcmpl-tool-opus",
          created: 1700000000,
          model: "claude-opus-4.7",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: upstreamToolName, arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 32000,
        stream: true,
        reasoning_effort: "xhigh",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "Hi" },
          { role: "user", content: "use docs if needed" },
          { role: "user", content: "hello" },
        ],
        tools: [
          {
            name: originalToolName,
            description: "Search Microsoft Learn code samples",
            input_schema: { type: "object", properties: {} },
          },
          {
            name: originalSecondToolName,
            description: "Search Microsoft Learn docs",
            input_schema: { type: "object", properties: {} },
          },
          ...fillerTools,
        ],
      }),
    })

    expect(res.status).toBe(200)
    const upstreamBody = captured[0].body as {
      output_config?: { effort?: string }
      tools?: Array<{ function: { name: string } }>
    }
    const upstreamToolNames = upstreamBody.tools?.map((tool) => tool.function.name) ?? []
    expect(upstreamBody.output_config).toEqual({ effort: "xhigh" })
    expect(upstreamToolNames).toHaveLength(40)
    expect(upstreamToolNames[0]).not.toBe(originalToolName)
    expect(upstreamToolNames[1]).not.toBe(originalSecondToolName)
    for (const upstreamToolName of upstreamToolNames) {
      expect(upstreamToolName.length).toBeLessThanOrEqual(64)
      expect(upstreamToolName).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })

  test("shortens long MCP tool names for claude-opus-4.6 and restores them", async () => {
    const originalToolName =
      "mcp__plugin_microsoft-docs_microsoft-learn__microsoft_code_sample_search"
    const captured: Array<CapturedRequest> = []
    const upstream = (request: CapturedRequest) => {
      const body = request.body as {
        tools?: Array<{ function: { name: string } }>
      }
      const upstreamToolName = body.tools?.[0]?.function.name ?? "missing"
      return new Response(
        JSON.stringify({
          id: "chatcmpl-tool-opus-46",
          created: 1700000000,
          model: "claude-opus-4.6",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: upstreamToolName, arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        max_tokens: 1024,
        messages: [{ role: "user", content: "search docs" }],
        tools: [
          {
            name: originalToolName,
            description: "Search Microsoft Learn code samples",
            input_schema: { type: "object", properties: {} },
          },
        ],
        tool_choice: { type: "tool", name: originalToolName },
      }),
    })

    expect(res.status).toBe(200)
    const upstreamBody = captured[0].body as {
      tool_choice?: { function?: { name?: string } }
      tools?: Array<{ function: { name: string } }>
    }
    const upstreamToolName = upstreamBody.tools?.[0]?.function.name
    expect(upstreamToolName).not.toBe(originalToolName)
    expect(upstreamToolName?.length).toBeLessThanOrEqual(64)
    expect(upstreamBody.tool_choice?.function?.name).toBe(upstreamToolName)

    const json = (await res.json()) as {
      content: Array<{
        id?: string
        input?: Record<string, unknown>
        name?: string
        type: string
      }>
    }
    expect(json.content).toContainEqual({
      type: "tool_use",
      id: "call_1",
      name: originalToolName,
      input: {},
    })
  })

  test("preserves dotted tool names for models that accept them", async () => {
    const originalToolName = "mcp.server.tool"
    const captured: Array<CapturedRequest> = []
    const upstream = (request: CapturedRequest) => {
      const body = request.body as {
        tools?: Array<{ function: { name: string } }>
      }
      const upstreamToolName = body.tools?.[0]?.function.name ?? "missing"
      return new Response(
        JSON.stringify({
          id: "chatcmpl-dotted-gemini",
          created: 1700000000,
          model: "gemini-2.5-pro",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: upstreamToolName, arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-2.5-pro",
        max_tokens: 1024,
        messages: [{ role: "user", content: "use dotted tool" }],
        tools: [
          {
            name: originalToolName,
            description: "Dotted MCP-style tool",
            input_schema: { type: "object", properties: {} },
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    const upstreamBody = captured[0].body as {
      tools?: Array<{ function: { name: string } }>
    }
    expect(upstreamBody.tools?.[0]?.function.name).toBe(originalToolName)

    const json = (await res.json()) as {
      content: Array<{
        id?: string
        input?: Record<string, unknown>
        name?: string
        type: string
      }>
    }
    expect(json.content).toContainEqual({
      type: "tool_use",
      id: "call_1",
      name: originalToolName,
      input: {},
    })
  })

  test("maps dotted tool names for strict models and restores them", async () => {
    const originalToolName = "mcp.server.tool"
    const captured: Array<CapturedRequest> = []
    const upstream = (request: CapturedRequest) => {
      const body = request.body as {
        tools?: Array<{ function: { name: string } }>
      }
      const upstreamToolName = body.tools?.[0]?.function.name ?? "missing"
      return new Response(
        JSON.stringify({
          id: "chatcmpl-dotted-strict",
          created: 1700000000,
          model: "gpt-5.2",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: upstreamToolName, arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.2",
        max_tokens: 1024,
        messages: [{ role: "user", content: "use strict tool" }],
        tools: [
          {
            name: originalToolName,
            description: "Dotted MCP-style tool",
            input_schema: { type: "object", properties: {} },
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    const upstreamBody = captured[0].body as {
      tools?: Array<{ function: { name: string } }>
    }
    expect(upstreamBody.tools?.[0]?.function.name).toBe("mcp_server_tool")

    const json = (await res.json()) as {
      content: Array<{
        id?: string
        input?: Record<string, unknown>
        name?: string
        type: string
      }>
    }
    expect(json.content).toContainEqual({
      type: "tool_use",
      id: "call_1",
      name: originalToolName,
      input: {},
    })
  })

  test("keeps colliding sanitized tool names distinct and restores each original", async () => {
    const dottedToolName = "mcp.server.tool"
    const underscoredToolName = "mcp_server_tool"
    const captured: Array<CapturedRequest> = []
    const upstream = (request: CapturedRequest) => {
      const body = request.body as {
        tools?: Array<{ function: { name: string } }>
      }
      const toolCalls = body.tools?.map((tool, index) => ({
        id: `call_${index + 1}`,
        type: "function" as const,
        function: { name: tool.function.name, arguments: "{}" },
      })) ?? []

      return new Response(
        JSON.stringify({
          id: "chatcmpl-collision",
          created: 1700000000,
          model: "gpt-5.2",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: toolCalls,
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.2",
        max_tokens: 1024,
        messages: [{ role: "user", content: "use tools" }],
        tools: [
          {
            name: dottedToolName,
            description: "Dotted MCP-style tool",
            input_schema: { type: "object", properties: {} },
          },
          {
            name: underscoredToolName,
            description: "Underscored MCP-style tool",
            input_schema: { type: "object", properties: {} },
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    const upstreamBody = captured[0].body as {
      tools?: Array<{ function: { name: string } }>
    }
    const upstreamNames = upstreamBody.tools?.map((tool) => tool.function.name)
    expect(upstreamNames).toHaveLength(2)
    expect(new Set(upstreamNames).size).toBe(2)
    expect(upstreamNames).toContain("mcp_server_tool")
    expect(upstreamNames?.some((name) => name !== "mcp_server_tool")).toBe(true)

    const json = (await res.json()) as {
      content: Array<{
        id?: string
        input?: Record<string, unknown>
        name?: string
        type: string
      }>
    }
    expect(json.content).toContainEqual({
      type: "tool_use",
      id: "call_1",
      name: dottedToolName,
      input: {},
    })
    expect(json.content).toContainEqual({
      type: "tool_use",
      id: "call_2",
      name: underscoredToolName,
      input: {},
    })
  })

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

  test("keeps Claude opus 4.7 high-effort requests on the base model", async () => {
    const opus47OneMillionModel = getFixtureModelId("Claude Opus 4.7 1M")

    for (const [requestedModel, requestedEffort, expectedModel, expectedEffort] of [
      ["claude-opus-4.7", "low", "claude-opus-4.7", "low"],
      ["claude-opus-4.7", "high", "claude-opus-4.7", "high"],
      ["claude-opus-4.7", "xhigh", "claude-opus-4.7", "xhigh"],
      ["claude-opus-4.7", "max", "claude-opus-4.7", "xhigh"],
      ["claude-opus-4.7-1m", "max", opus47OneMillionModel, "xhigh"],
    ] as const) {
      const captured: Array<CapturedRequest> = []
      const upstream = new Response(
        JSON.stringify({
          id: `chatcmpl-${expectedModel}`,
          created: 1700000000,
          model: expectedModel,
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
          model: requestedModel,
          max_tokens: 1024,
          messages: [{ role: "user", content: "Reply with OK" }],
          reasoning_effort: requestedEffort,
        }),
      })

      expect(res.status).toBe(200)
      expect(captured).toHaveLength(1)
      expect(
        (captured[0].body as { model: string; output_config?: { effort?: string } }).model,
      ).toBe(expectedModel)
      expect(
        (captured[0].body as { output_config?: { effort?: string } })
          .output_config,
      ).toEqual({ effort: expectedEffort })
      expect(
        (captured[0].body as { reasoning_effort?: string }).reasoning_effort,
      ).toBeUndefined()
    }
  })

  test("keeps Claude settings opus 4.7 reasoning effort on the base model", async () => {
    for (const [configuredEffort, expectedModel, expectedEffort] of [
      ["low", "claude-opus-4.7", "low"],
      ["medium", "claude-opus-4.7", "medium"],
      ["high", "claude-opus-4.7", "high"],
      ["xhigh", "claude-opus-4.7", "xhigh"],
      ["max", "claude-opus-4.7", "xhigh"],
    ] as const) {
      const tempHome = await mkdtemp(path.join(os.tmpdir(), "claude-settings-opus47-"))
      process.env.HOME = tempHome
      await mkdir(path.join(tempHome, ".claude"), { recursive: true })
      await writeFile(
        path.join(tempHome, ".claude", "settings.json"),
        JSON.stringify(
          {
            env: {
              ANTHROPIC_MODEL: "claude-opus-4.7",
              MODEL_REASONING_EFFORT: configuredEffort,
            },
          },
          null,
          2,
        ),
      )

      try {
        const captured: Array<CapturedRequest> = []
        const upstream = new Response(
          JSON.stringify({
            id: `chatcmpl-settings-${configuredEffort}`,
            created: 1700000000,
            model: expectedModel,
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
        expect(
          (captured[0].body as { model: string; output_config?: { effort?: string } }).model,
        ).toBe(expectedModel)
        expect(
          (captured[0].body as { output_config?: { effort?: string } })
            .output_config,
        ).toEqual({ effort: expectedEffort })
      } finally {
        await rm(tempHome, { recursive: true, force: true })
      }
    }
  })

  test("routes Claude settings opus 4.7 1M reasoning effort to the 1M upstream model", async () => {
    const opus47OneMillionModel = getFixtureModelId("Claude Opus 4.7 1M")

    for (const [configuredEffort, expectedEffort] of [
      ["low", "low"],
      ["medium", "medium"],
      ["high", "high"],
      ["xhigh", "xhigh"],
      ["max", "xhigh"],
    ] as const) {
      const tempHome = await mkdtemp(path.join(os.tmpdir(), "claude-settings-opus47-1m-"))
      process.env.HOME = tempHome
      await mkdir(path.join(tempHome, ".claude"), { recursive: true })
      await writeFile(
        path.join(tempHome, ".claude", "settings.json"),
        JSON.stringify(
          {
            env: {
              ANTHROPIC_MODEL: "claude-opus-4.7-1m",
              MODEL_REASONING_EFFORT: configuredEffort,
            },
          },
          null,
          2,
        ),
      )

      try {
        const captured: Array<CapturedRequest> = []
        const upstream = new Response(
          JSON.stringify({
            id: `chatcmpl-settings-1m-${configuredEffort}`,
            created: 1700000000,
            model: opus47OneMillionModel,
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
        expect(
          (captured[0].body as { model: string; output_config?: { effort?: string } }).model,
        ).toBe(opus47OneMillionModel)
        expect(
          (captured[0].body as { output_config?: { effort?: string } })
            .output_config,
        ).toEqual({ effort: expectedEffort })
      } finally {
        await rm(tempHome, { recursive: true, force: true })
      }
    }
  })

  test("lets Claude settings override Claude CLI thinking-derived opus 4.7 effort", async () => {
    const opus47OneMillionModel = getFixtureModelId("Claude Opus 4.7 1M")
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "claude-settings-opus47-thinking-"))
    process.env.HOME = tempHome
    await mkdir(path.join(tempHome, ".claude"), { recursive: true })
    await writeFile(
      path.join(tempHome, ".claude", "settings.json"),
      JSON.stringify(
        {
          env: {
            ANTHROPIC_MODEL: "claude-opus-4.7-1m",
            MODEL_REASONING_EFFORT: "low",
          },
        },
        null,
        2,
      ),
    )

    try {
      const captured: Array<CapturedRequest> = []
      const upstream = new Response(
        JSON.stringify({
          id: "chatcmpl-settings-thinking",
          created: 1700000000,
          model: opus47OneMillionModel,
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
          model: "claude-opus-4.7-1m",
          max_tokens: 1024,
          messages: [{ role: "user", content: "Reply with OK" }],
          thinking: { type: "enabled", budget_tokens: 30_000 },
        }),
      })

      expect(res.status).toBe(200)
      expect(
        (captured[0].body as { model: string; output_config?: { effort?: string } }).model,
      ).toBe(opus47OneMillionModel)
      expect(
        (captured[0].body as { output_config?: { effort?: string } })
          .output_config,
      ).toEqual({ effort: "low" })
    } finally {
      await rm(tempHome, { recursive: true, force: true })
    }
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
    const opus47OneMillionModel = getFixtureModelId("Claude Opus 4.7 1M")
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-2c",
        created: 1700000000,
        model: opus47OneMillionModel,
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
      opus47OneMillionModel,
    )
  })

  test("preserves bracket-form Claude opus 1m version aliases", async () => {
    const opus47OneMillionModel = getFixtureModelId("Claude Opus 4.7 1M")
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-2c-bracket",
        created: 1700000000,
        model: opus47OneMillionModel,
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

    for (const model of [
      "claude-opus-4.7[1m]",
      "claude-opus-4.7-[1m]",
      "claude-opus-4.7-",
    ]) {
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          messages: [{ role: "user", content: "Reply with OK" }],
        }),
      })

      expect(res.status).toBe(200)
    }

    expect(captured.map((request) => (request.body as { model: string }).model)).toEqual([
      opus47OneMillionModel,
      opus47OneMillionModel,
      opus47OneMillionModel,
    ])
  })

  test("maps Claude Code 1m display aliases to the real 1m model", async () => {
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-2c-display",
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

    for (const model of ["claude-opus-4.6-[1m]", "claude-opus-4.6-"]) {
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          messages: [{ role: "user", content: "Reply with OK" }],
        }),
      })

      expect(res.status).toBe(200)
    }

    expect(captured.map((request) => (request.body as { model: string }).model)).toEqual([
      "claude-opus-4.6-1m",
      "claude-opus-4.6-1m",
    ])
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

  test("does not infer reasoning effort for a plain Claude Sonnet request", async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "claude-settings-plain-sonnet-"))
    process.env.HOME = tempHome
    delete process.env.MODEL_REASONING_EFFORT
    delete process.env.COPILOT_REASONING_EFFORT
    await mkdir(path.join(tempHome, ".claude"), { recursive: true })
    await writeFile(
      path.join(tempHome, ".claude", "settings.json"),
      JSON.stringify({ env: {} }, null, 2),
    )

    try {
      const captured: Array<CapturedRequest> = []
      const upstream = new Response(
        JSON.stringify({
          id: "chatcmpl-3b",
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
          model: "claude-sonnet-4.6",
          max_tokens: 1024,
          messages: [{ role: "user", content: "Reply with OK" }],
        }),
      })

      expect(res.status).toBe(200)
      const body = captured[0].body as {
        output_config?: { effort?: string }
        reasoning_effort?: string
      }
      expect(body.reasoning_effort).toBeUndefined()
      expect(body.output_config?.effort).toBeUndefined()
    } finally {
      await rm(tempHome, { recursive: true, force: true })
    }
  })

  test("uses only MODEL_REASONING_EFFORT for Claude-side reasoning config", async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "claude-settings-model-effort-"))
    process.env.HOME = tempHome
    delete process.env.COPILOT_REASONING_EFFORT
    process.env.MODEL_REASONING_EFFORT = "high"
    await mkdir(path.join(tempHome, ".claude"), { recursive: true })
    await writeFile(
      path.join(tempHome, ".claude", "settings.json"),
      JSON.stringify(
        {
          env: {
            COPILOT_REASONING_EFFORT: "low",
          },
        },
        null,
        2,
      ),
    )

    try {
      const captured: Array<CapturedRequest> = []
      const upstream = new Response(
        JSON.stringify({
          id: "chatcmpl-3c",
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
          model: "claude-sonnet-4.6",
          max_tokens: 1024,
          messages: [{ role: "user", content: "Reply with OK" }],
        }),
      })

      expect(res.status).toBe(200)
      expect((captured[0].body as { reasoning_effort?: string }).reasoning_effort).toBe(
        "high",
      )
    } finally {
      await rm(tempHome, { recursive: true, force: true })
    }
  })

  test("reads MODEL_REASONING_EFFORT from Claude settings", async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "claude-settings-model-env-"))
    process.env.HOME = tempHome
    delete process.env.MODEL_REASONING_EFFORT
    delete process.env.COPILOT_REASONING_EFFORT
    await mkdir(path.join(tempHome, ".claude"), { recursive: true })
    await writeFile(
      path.join(tempHome, ".claude", "settings.json"),
      JSON.stringify(
        {
          env: {
            MODEL_REASONING_EFFORT: "high",
          },
        },
        null,
        2,
      ),
    )

    try {
      const captured: Array<CapturedRequest> = []
      const upstream = new Response(
        JSON.stringify({
          id: "chatcmpl-3c-settings",
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
          model: "claude-sonnet-4.6",
          max_tokens: 1024,
          messages: [{ role: "user", content: "Reply with OK" }],
        }),
      })

      expect(res.status).toBe(200)
      expect((captured[0].body as { reasoning_effort?: string }).reasoning_effort).toBe(
        "high",
      )
    } finally {
      await rm(tempHome, { recursive: true, force: true })
    }
  })

  test("ignores legacy COPILOT_REASONING_EFFORT for plain Claude requests", async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "claude-settings-copilot-effort-"))
    process.env.HOME = tempHome
    delete process.env.MODEL_REASONING_EFFORT
    process.env.COPILOT_REASONING_EFFORT = "high"
    await mkdir(path.join(tempHome, ".claude"), { recursive: true })
    await writeFile(
      path.join(tempHome, ".claude", "settings.json"),
      JSON.stringify(
        {
          env: {
            COPILOT_REASONING_EFFORT: "low",
          },
        },
        null,
        2,
      ),
    )

    try {
      const captured: Array<CapturedRequest> = []
      const upstream = new Response(
        JSON.stringify({
          id: "chatcmpl-3d",
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
          model: "claude-sonnet-4.6",
          max_tokens: 1024,
          messages: [{ role: "user", content: "Reply with OK" }],
        }),
      })

      expect(res.status).toBe(200)
      const body = captured[0].body as {
        output_config?: { effort?: string }
        reasoning_effort?: string
      }
      expect(body.reasoning_effort).toBeUndefined()
      expect(body.output_config?.effort).toBeUndefined()
    } finally {
      await rm(tempHome, { recursive: true, force: true })
    }
  })

  test("omits empty tool fields for Claude requests", async () => {
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-3e",
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
        model: "claude-sonnet-4.6",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Reply with OK" }],
        tools: [],
        tool_choice: { type: "any" },
      }),
    })

    expect(res.status).toBe(200)
    const body = captured[0].body as { tool_choice?: unknown; tools?: unknown }
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
  })

  test("preserves non-empty Claude tools and tool choice", async () => {
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-3f",
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
        model: "claude-sonnet-4.6",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Reply with OK" }],
        tools: [
          {
            name: "lookup",
            description: "lookup data",
            input_schema: { type: "object", properties: {} },
          },
        ],
        tool_choice: { type: "any" },
      }),
    })

    expect(res.status).toBe(200)
    const body = captured[0].body as {
      tool_choice?: unknown
      tools?: Array<{ function: { name: string } }>
    }
    expect(body.tools?.[0]?.function.name).toBe("lookup")
    expect(body.tool_choice).toBe("required")
  })

  test("does not treat ordinary custom web_search tools as Claude server WebSearch", async () => {
    await writeFile(
      path.join(isolatedHome!, ".claude", "settings.json"),
      JSON.stringify({ env: { COPILOT_WEB_SEARCH_BACKEND: "gpt-5.5" } }),
    )
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-custom-web-search-tool",
        created: 1700000000,
        model: "claude-haiku-4.5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_custom_web_search",
                  type: "function",
                  function: {
                    name: "web_search",
                    arguments: JSON.stringify({ query: "local index" }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
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
        model: "claude-haiku-4.5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "use my local web_search tool" }],
        tools: [
          {
            name: "web_search",
            description: "Search a local project index",
            input_schema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe("https://upstream.test/chat/completions")

    const json = (await res.json()) as {
      content: Array<{
        id?: string
        input?: Record<string, unknown>
        name?: string
        type: string
      }>
      usage?: { server_tool_use?: { web_search_requests?: number } }
    }
    expect(json.content).toContainEqual({
      type: "tool_use",
      id: "call_custom_web_search",
      name: "web_search",
      input: { query: "local index" },
    })
    expect(json.usage?.server_tool_use?.web_search_requests).toBeUndefined()
  })

  test("routes Claude Code WebSearch function tools through the configured backend model", async () => {
    await writeFile(
      path.join(isolatedHome!, ".claude", "settings.json"),
      JSON.stringify({ env: { COPILOT_WEB_SEARCH_BACKEND: "gpt-5.5" } }),
    )
    const captured: Array<CapturedRequest> = []
    let chatCalls = 0
    const upstream = (request: CapturedRequest) => {
      if (request.url === "https://upstream.test/chat/completions") {
        chatCalls += 1
        return chatCalls === 1 ?
            chatWebSearchToolCallResponse("GitHub Copilot docs")
          : chatTextResponse("The Copilot docs are at https://docs.github.com/en/copilot.")
      }

      return copilotWebSearchResponse(
        "GitHub Copilot docs",
        "1. GitHub Copilot docs - https://docs.github.com/en/copilot",
      )
    }

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        max_tokens: 1024,
        messages: [{ role: "user", content: "search the web" }],
        tools: [
          {
            name: "WebSearch",
            description: "Search the web",
            input_schema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(3)
    expect(captured[0].url).toBe("https://upstream.test/chat/completions")
    const decisionBody = captured[0].body as {
      stream?: boolean
      tools?: Array<{ function: { name: string } }>
    }
    expect(decisionBody.stream).toBe(false)
    expect(decisionBody.tools?.[0]?.function.name).toBe("WebSearch")

    expect(captured[1].url).toBe("https://upstream.test/responses")
    const body = captured[1].body as { model: string; tools: Array<{ type: string }> }
    expect(body.model).toBe("gpt-5.5")
    expect(body.tools).toEqual([{ type: "web_search_preview" }])

    expect(captured[2].url).toBe("https://upstream.test/chat/completions")
    const finalBody = captured[2].body as {
      messages: Array<{ content?: string; role: string }>
      tool_choice?: unknown
      tools?: unknown
    }
    expect(finalBody.tools).toBeUndefined()
    expect(finalBody.tool_choice).toBeUndefined()
    expect(finalBody.messages.at(-1)?.role).toBe("system")
    expect(finalBody.messages.at(-1)?.content).toContain(
      "Trusted bridge retrieval context",
    )
    expect(finalBody.messages.at(-1)?.content).toContain(
      "Query: GitHub Copilot docs",
    )
    expect(finalBody.messages.some((message) => message.role === "assistant")).toBe(false)
    const json = (await res.json()) as {
      content: Array<{ type: string; content?: Array<{ url?: string }>; text?: string }>
      usage?: { server_tool_use?: { web_search_requests?: number } }
    }
    expect(json.content[0]?.type).toBe("server_tool_use")
    expect(json.content[1]?.type).toBe("web_search_tool_result")
    expect(json.content[2]?.text).toBe(
      "The Copilot docs are at https://docs.github.com/en/copilot.",
    )
    expect(json.usage?.server_tool_use?.web_search_requests).toBe(1)
  })

  test("does not run Claude Code WebSearch just because the tool is available", async () => {
    await writeFile(
      path.join(isolatedHome!, ".claude", "settings.json"),
      JSON.stringify({ env: { COPILOT_WEB_SEARCH_BACKEND: "gpt-5.5" } }),
    )
    const captured: Array<CapturedRequest> = []
    const upstream = chatTextResponse("Hello!")

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4.5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "WebSearch",
            description: "Search the web",
            input_schema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe("https://upstream.test/chat/completions")

    const json = (await res.json()) as {
      content: Array<{ text?: string; type: string }>
      usage?: { server_tool_use?: { web_search_requests?: number } }
    }
    expect(json.content).toEqual([{ type: "text", text: "Hello!" }])
    expect(json.usage?.server_tool_use?.web_search_requests).toBeUndefined()
  })

  test("streams normal Claude Code responses when WebSearch is available but not selected", async () => {
    await writeFile(
      path.join(isolatedHome!, ".claude", "settings.json"),
      JSON.stringify({ env: { COPILOT_WEB_SEARCH_BACKEND: "gpt-5.5" } }),
    )
    const captured: Array<CapturedRequest> = []
    const upstream = chatTextResponse("Hello from the model.")

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4.5",
        stream: true,
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "WebSearch",
            description: "Search the web",
            input_schema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe("https://upstream.test/chat/completions")

    const text = await res.text()
    expect(text).toContain("event: message_start")
    expect(text).toContain("Hello from the model.")
    expect(text).not.toContain("server_tool_use")
    expect(text).not.toContain("web_search_tool_result")
    expect(text).toContain("event: message_stop")
  })

  test("does not run Claude Code WebSearch for negated search requests", async () => {
    await writeFile(
      path.join(isolatedHome!, ".claude", "settings.json"),
      JSON.stringify({ env: { COPILOT_WEB_SEARCH_BACKEND: "gpt-5.5" } }),
    )
    const captured: Array<CapturedRequest> = []
    const upstream = chatTextResponse("No search run.")

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4.5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "i don't want you to search the web" }],
        tools: [
          {
            name: "WebSearch",
            description: "Search the web",
            input_schema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe("https://upstream.test/chat/completions")

    const json = (await res.json()) as { content: Array<{ text?: string; type: string }> }
    expect(json.content).toEqual([{ type: "text", text: "No search run." }])
  })

  test("does not run Claude Code WebSearch for local search requests", async () => {
    await writeFile(
      path.join(isolatedHome!, ".claude", "settings.json"),
      JSON.stringify({ env: { COPILOT_WEB_SEARCH_BACKEND: "gpt-5.5" } }),
    )
    const captured: Array<CapturedRequest> = []
    const upstream = chatTextResponse("I can search the local files.")

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4.5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "search files for TODO" }],
        tools: [
          {
            name: "WebSearch",
            description: "Search the web",
            input_schema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe("https://upstream.test/chat/completions")

    const json = (await res.json()) as { content: Array<{ text?: string; type: string }> }
    expect(json.content).toEqual([
      { type: "text", text: "I can search the local files." },
    ])
  })

  test("routes Anthropic native web search tools through the configured backend model", async () => {
    runtimeState.modelOverride = "gpt-5.2"
    await writeFile(
      path.join(isolatedHome!, ".claude", "settings.json"),
      JSON.stringify({ env: { COPILOT_WEB_SEARCH_BACKEND: "gpt-5.5" } }),
    )
    const captured: Array<CapturedRequest> = []
    let chatCalls = 0
    const upstream = (request: CapturedRequest) => {
      if (request.url === "https://upstream.test/chat/completions") {
        chatCalls += 1
        return chatCalls === 1 ?
            chatWebSearchToolCallResponse("test", "web_search", "gpt-5.2")
          : chatTextResponse("Speedtest and Fast.com are relevant options.", "gpt-5.2")
      }

      return copilotWebSearchResponse(
        "test",
        [
          "1. Speedtest by Ookla - https://www.speedtest.net",
          "2. Fast.com - https://fast.com",
        ].join("\n"),
        "gpt-5.5-2026-04-23",
      )
    }

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        max_tokens: 1024,
        messages: [{ role: "user", content: "search the web for test" }],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 5,
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(3)
    expect(captured[0].url).toBe("https://upstream.test/chat/completions")
    expect(captured[1].url).toBe("https://upstream.test/responses")
    expect(captured[2].url).toBe("https://upstream.test/chat/completions")
    const upstreamBody = captured[0].body as {
      model?: string
      tools?: Array<{ function?: { name?: string }; type: string }>
    }
    expect(upstreamBody.model).toBe("gpt-5.2")
    expect(upstreamBody.tools?.[0]?.function?.name).toBe("web_search")

    const searchBody = captured[1].body as {
      model?: string
      tools?: Array<{ type: string }>
    }
    expect(searchBody.model).toBe("gpt-5.5")
    expect(searchBody.tools).toEqual([{ type: "web_search_preview" }])

    const json = (await res.json()) as {
      content: Array<{
        content?: Array<{
          encrypted_content?: string
          page_age?: string | null
          title?: string
          type?: string
          url?: string
        }>
        id?: string
        input?: { query?: string }
        name?: string
        text?: string
        type: string
      }>
      usage?: { server_tool_use?: { web_search_requests?: number } }
    }
    expect(json.content[0]).toEqual({
      type: "server_tool_use",
      id: expect.stringMatching(/^srvtoolu_/),
      name: "web_search",
      input: { query: "test" },
    })
    expect(json.content[1]?.type).toBe("web_search_tool_result")
    expect(json.content[1]?.content).toEqual([
      {
        type: "web_search_result",
        title: "Speedtest by Ookla",
        url: "https://www.speedtest.net",
        encrypted_content: "",
        page_age: null,
      },
      {
        type: "web_search_result",
        title: "Fast.com",
        url: "https://fast.com",
        encrypted_content: "",
        page_age: null,
      },
    ])
    expect(json.content[2]?.text).toBe("Speedtest and Fast.com are relevant options.")
    expect(json.usage?.server_tool_use?.web_search_requests).toBe(1)
  })

  test("keeps WebSearch final answer requests free of prior tool-call protocol", async () => {
    await writeFile(
      path.join(isolatedHome!, ".claude", "settings.json"),
      JSON.stringify({ env: { COPILOT_WEB_SEARCH_BACKEND: "gpt-5.5" } }),
    )
    const captured: Array<CapturedRequest> = []
    let chatCalls = 0
    const upstream = (request: CapturedRequest) => {
      if (request.url === "https://upstream.test/chat/completions") {
        chatCalls += 1
        return chatCalls === 1 ?
            chatWebSearchToolCallResponse("GitHub Copilot documentation URL", "web_search")
          : chatTextResponse("The Copilot docs are available at https://docs.github.com/en/copilot.")
      }

      return copilotWebSearchResponse(
        "GitHub Copilot documentation URL",
        "GitHub Copilot docs - https://docs.github.com/en/copilot",
        "gpt-5.5-2026-04-23",
      )
    }

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        max_tokens: 1024,
        messages: [
          { role: "user", content: "Inspect local context first." },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_local_1",
                name: "LocalLookup",
                input: { key: "regression-policy" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_local_1",
                content: "Local context: preserve ordinary tool-use behavior.",
              },
              {
                type: "text",
                text: "Now use web_search to find the GitHub Copilot documentation URL.",
              },
            ],
          },
        ],
        tools: [
          {
            name: "LocalLookup",
            description: "Look up local bridge context",
            input_schema: {
              type: "object",
              properties: { key: { type: "string" } },
              required: ["key"],
            },
          },
          { type: "web_search_20250305", name: "web_search" },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(3)
    expect(captured[2].url).toBe("https://upstream.test/chat/completions")
    const finalBody = captured[2].body as {
      messages: Array<{ content?: string | null; role: string; tool_calls?: unknown }>
      tool_choice?: unknown
      tools?: unknown
    }
    expect(finalBody.tools).toBeUndefined()
    expect(finalBody.tool_choice).toBeUndefined()
    expect(finalBody.messages.some((message) => message.role === "tool")).toBe(false)
    expect(finalBody.messages.some((message) => message.tool_calls)).toBe(false)
    expect(finalBody.messages).toContainEqual({
      role: "developer",
      content: [
        "Prior local tool result from the conversation:",
        "Local context: preserve ordinary tool-use behavior.",
      ].join("\n"),
    })

    const json = (await res.json()) as { content: Array<{ text?: string; type: string }> }
    expect(json.content.map((block) => block.type)).toEqual([
      "server_tool_use",
      "web_search_tool_result",
      "text",
    ])
    expect(json.content[2]?.text).toBe(
      "The Copilot docs are available at https://docs.github.com/en/copilot.",
    )
  })

  test("retries empty WebSearch results with the user query and returns Claude final text", async () => {
    await writeFile(
      path.join(isolatedHome!, ".claude", "settings.json"),
      JSON.stringify({ env: { COPILOT_WEB_SEARCH_BACKEND: "gpt-5.5" } }),
    )
    const captured: Array<CapturedRequest> = []
    let chatCalls = 0
    let searchCalls = 0
    const upstream = (request: CapturedRequest) => {
      if (request.url === "https://upstream.test/chat/completions") {
        chatCalls += 1
        if (chatCalls === 1) {
          return chatWebSearchToolCallResponse("ambiguous local context", "web_search")
        }

        return chatCalls === 2 ?
            chatTextResponse("I don't have the ability to search the web or browse the internet.")
          : chatTextResponse("The GitHub Copilot docs are at https://docs.github.com/en/copilot.")
      }

      searchCalls += 1
      return searchCalls === 1 ?
          copilotWebSearchResponse(
            "ambiguous local context",
            "",
            "gpt-5.5-2026-04-23",
          )
        : copilotWebSearchResponse(
            "GitHub Copilot documentation URL",
            "GitHub Copilot docs - https://docs.github.com/en/copilot",
            "gpt-5.5-2026-04-23",
          )
    }

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: "Use web_search to find the GitHub Copilot documentation URL.",
          },
        ],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(4)
    expect(captured[1].url).toBe("https://upstream.test/responses")
    expect(captured[2].url).toBe("https://upstream.test/responses")
    expect(captured[3].url).toBe("https://upstream.test/chat/completions")
    expect((captured[1].body as { input?: string }).input).toContain(
      "Requested web search query: ambiguous local context",
    )
    expect((captured[2].body as { input?: string }).input).toContain(
      "Requested web search query: Use web_search to find the GitHub Copilot documentation URL.",
    )
    const finalBody = captured[3].body as {
      messages: Array<{ content?: string | null; role: string; tool_calls?: unknown }>
    }
    expect(finalBody.messages.some((message) => message.role === "tool")).toBe(false)
    expect(finalBody.messages.some((message) => message.tool_calls)).toBe(false)
    expect(finalBody.messages.some((message) =>
      message.role === "developer"
      && typeof message.content === "string"
      && message.content.includes("Prior local tool result"),
    )).toBe(false)
    const json = (await res.json()) as {
      content: Array<{ text?: string; type: string }>
    }
    expect(json.content.map((block) => block.type)).toEqual([
      "server_tool_use",
      "web_search_tool_result",
      "text",
    ])
    expect(json.content[2]?.text).toBe(
      "I don't have the ability to search the web or browse the internet.",
    )
  })

  test("passes through Claude WebSearch when backend is not configured", async () => {
    await writeFile(
      path.join(isolatedHome!, ".claude", "settings.json"),
      JSON.stringify({ model: "gpt-5.2" }),
    )
    const captured: Array<CapturedRequest> = []
    const upstream = chatWebSearchToolCallResponse("docs", "web_search", "gpt-5.2")
    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "definitely-not-a-real-model",
        max_tokens: 1024,
        messages: [{ role: "user", content: "search the web for docs" }],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe("https://upstream.test/chat/completions")

    const json = (await res.json()) as {
      content: Array<{ id?: string; input?: Record<string, unknown>; name?: string; type: string }>
      usage?: { server_tool_use?: { web_search_requests?: number } }
    }
    expect(json.content).toContainEqual({
      type: "tool_use",
      id: "call_web_search",
      name: "web_search",
      input: { query: "docs" },
    })
    expect(json.usage?.server_tool_use?.web_search_requests).toBeUndefined()
  })

  test("passes through Claude WebSearch when backend is empty", async () => {
    await writeFile(
      path.join(isolatedHome!, ".claude", "settings.json"),
      JSON.stringify({ env: { COPILOT_WEB_SEARCH_BACKEND: "   " } }),
    )
    const captured: Array<CapturedRequest> = []
    const upstream = chatWebSearchToolCallResponse("docs", "web_search")
    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        max_tokens: 1024,
        messages: [{ role: "user", content: "search the web for docs" }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe("https://upstream.test/chat/completions")
    const json = (await res.json()) as {
      content: Array<{ id?: string; input?: Record<string, unknown>; name?: string; type: string }>
      usage?: { server_tool_use?: { web_search_requests?: number } }
    }
    expect(json.content).toContainEqual({
      type: "tool_use",
      id: "call_web_search",
      name: "web_search",
      input: { query: "docs" },
    })
    expect(json.usage?.server_tool_use?.web_search_requests).toBeUndefined()
  })

  test("ignores project-local web search backend settings", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "claude-project-web-search-"))
    await mkdir(path.join(projectDir, ".claude"), { recursive: true })
    await writeFile(
      path.join(projectDir, ".claude", "settings.json"),
      JSON.stringify({ env: { COPILOT_WEB_SEARCH_BACKEND: "gpt-5.5" } }),
    )
    process.chdir(projectDir)

    try {
      const captured: Array<CapturedRequest> = []
      const upstream = chatWebSearchToolCallResponse("docs", "web_search")
      const { app, restore: r } = buildApp(captured, upstream)
      restore = r

      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4.6",
          max_tokens: 1024,
          messages: [{ role: "user", content: "search the web for docs" }],
          tools: [
            {
              type: "web_search_20250305",
              name: "web_search",
            },
          ],
        }),
      })

      expect(res.status).toBe(200)
      expect(captured).toHaveLength(1)
      expect(captured[0].url).toBe("https://upstream.test/chat/completions")
      const json = (await res.json()) as {
        content: Array<{ id?: string; input?: Record<string, unknown>; name?: string; type: string }>
        usage?: { server_tool_use?: { web_search_requests?: number } }
      }
      expect(json.content).toContainEqual({
        type: "tool_use",
        id: "call_web_search",
        name: "web_search",
        input: { query: "docs" },
      })
      expect(json.usage?.server_tool_use?.web_search_requests).toBeUndefined()
    } finally {
      process.chdir(isolatedHome!)
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  test("passes through Claude WebSearch when backend model is unsupported", async () => {
    await writeFile(
      path.join(isolatedHome!, ".claude", "settings.json"),
      JSON.stringify({ env: { COPILOT_WEB_SEARCH_BACKEND: "claude-opus-4.7" } }),
    )
    const captured: Array<CapturedRequest> = []
    const upstream = chatWebSearchToolCallResponse("test", "web_search", "claude-opus-4.7")

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.7",
        max_tokens: 1024,
        messages: [{ role: "user", content: "search the web for test" }],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe("https://upstream.test/chat/completions")

    const json = (await res.json()) as {
      content: Array<{
        id?: string
        input?: Record<string, unknown>
        text?: string
        name?: string
        type: string
      }>
      usage?: { server_tool_use?: { web_search_requests?: number } }
    }
    expect(json.content).toContainEqual({
      type: "tool_use",
      id: "call_web_search",
      name: "web_search",
      input: { query: "test" },
    })
    expect(json.usage?.server_tool_use?.web_search_requests).toBeUndefined()
  })

  test("can route Anthropic native web search tools through local SearXNG", async () => {
    await writeFile(
      path.join(isolatedHome!, ".claude", "settings.json"),
      JSON.stringify({
        env: {
          COPILOT_WEB_SEARCH_BACKEND: "searxng",
        },
      }),
    )
    const captured: Array<CapturedRequest> = []
    let chatCalls = 0
    const upstream = (request: CapturedRequest) => {
      if (request.url === "https://upstream.test/chat/completions") {
        chatCalls += 1
        return chatCalls === 1 ?
            chatWebSearchToolCallResponse("searxng", "web_search")
          : chatTextResponse("SearXNG is a privacy-respecting metasearch engine.")
      }

      return new Response(
        JSON.stringify({
          results: [
            {
              title: "SearXNG",
              url: "https://docs.searxng.org/",
              content: "A privacy-respecting metasearch engine.",
            },
            {
              title: "OpenClaw Search Skill",
              url: "https://github.com/betaHi/openclaw-searxng-search",
              content: "Search skill using local SearXNG.",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        max_tokens: 1024,
        messages: [{ role: "user", content: "search the web for searxng" }],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(4)
    expect(captured[0].url).toBe("https://upstream.test/chat/completions")
    expect(captured[1].url).toBe("http://localhost:8080")
    expect(captured[2].url).toBe(
      "http://localhost:8080/search?q=searxng&format=json",
    )
    expect(captured[3].url).toBe("https://upstream.test/chat/completions")
    const json = (await res.json()) as {
      content: Array<{
        content?: Array<{
          encrypted_content?: string
          page_age?: string | null
          title?: string
          type?: string
          url?: string
        }>
        input?: { query?: string }
        model?: string
        text?: string
        type: string
      }>
      model?: string
    }
    expect(json.content[0]?.input?.query).toBe("searxng")
    expect(json.content[1]?.type).toBe("web_search_tool_result")
    expect(json.content[1]?.content).toEqual([
      {
        type: "web_search_result",
        title: "SearXNG",
        url: "https://docs.searxng.org/",
        encrypted_content: "",
        page_age: null,
      },
      {
        type: "web_search_result",
        title: "OpenClaw Search Skill",
        url: "https://github.com/betaHi/openclaw-searxng-search",
        encrypted_content: "",
        page_age: null,
      },
    ])
    expect(json.content[2]?.text).toBe(
      "SearXNG is a privacy-respecting metasearch engine.",
    )
  })

  test("returns a helpful web search error when local SearXNG is unavailable", async () => {
    await writeFile(
      path.join(isolatedHome!, ".claude", "settings.json"),
      JSON.stringify({ env: { COPILOT_WEB_SEARCH_BACKEND: "searxng" } }),
    )
    const captured: Array<CapturedRequest> = []
    let chatCalls = 0
    const { app, restore: r } = buildApp(captured, (request) => {
      if (request.url === "https://upstream.test/chat/completions") {
        chatCalls += 1
        return chatCalls === 1 ?
            chatWebSearchToolCallResponse("searxng", "web_search")
          : chatTextResponse("Local SearXNG was unavailable during search.")
      }

      throw new TypeError("fetch failed")
    })
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        max_tokens: 1024,
        messages: [{ role: "user", content: "search the web for searxng" }],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(3)
    expect(captured[0].url).toBe("https://upstream.test/chat/completions")
    expect(captured[1].url).toBe("http://localhost:8080")
    expect(captured[2].url).toBe("https://upstream.test/chat/completions")
    const json = (await res.json()) as {
      content: Array<{
        content?: { error_code?: string; type?: string }
        text?: string
        type: string
      }>
    }
    expect(json.content[1]?.content).toEqual({
      type: "web_search_tool_result_error",
      error_code: "unavailable",
    })
    expect(json.content[2]?.text).toBe("Local SearXNG was unavailable during search.")
  })

  test("streams Anthropic native web search family responses", async () => {
    await writeFile(
      path.join(isolatedHome!, ".claude", "settings.json"),
      JSON.stringify({ env: { COPILOT_WEB_SEARCH_BACKEND: "gpt-5.5" } }),
    )
    const captured: Array<CapturedRequest> = []
    let chatCalls = 0
    const upstream = (request: CapturedRequest) => {
      if (request.url === "https://upstream.test/chat/completions") {
        chatCalls += 1
        return chatCalls === 1 ?
            chatWebSearchToolCallResponse("latest docs", "web_search")
          : chatTextResponse("The latest docs are at https://example.com/docs.")
      }

      return copilotWebSearchResponse(
        "latest docs",
        "[Docs](https://example.com/docs)",
        "gpt-5.5-2026-04-23",
      )
    }

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        stream: true,
        max_tokens: 1024,
        messages: [{ role: "user", content: "search the web for latest docs" }],
        tools: [
          {
            type: "web_search_20260209",
            name: "web_search",
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(captured).toHaveLength(3)
    expect(captured[0].url).toBe("https://upstream.test/chat/completions")
    expect(captured[1].url).toBe("https://upstream.test/responses")
    expect(captured[2].url).toBe("https://upstream.test/chat/completions")

    const text = await res.text()
    expect(text).toContain("event: message_start")
    expect(text).toContain('"type":"server_tool_use"')
    expect(text).toContain('"type":"web_search_tool_result"')
    expect(text).toContain('"url":"https://example.com/docs"')
    expect(text).toContain("The latest docs are at https://example.com/docs.")
    expect(text).toContain("event: message_stop")

    const events = text.split("\n\n").flatMap((chunk) => {
      const data = chunk.split("\n").find((line) => line.startsWith("data: "))
      if (!data) return []
      return [JSON.parse(data.slice("data: ".length)) as {
        content_block?: { input?: Record<string, unknown>; type?: string }
        delta?: { partial_json?: string; type?: string }
        type: string
      }]
    })
    const serverToolStart = events.find(
      (event) => event.content_block?.type === "server_tool_use",
    )
    const serverToolDelta = events.find(
      (event) => event.delta?.type === "input_json_delta",
    )
    expect(serverToolStart?.content_block?.input).toEqual({})
    expect(serverToolDelta?.delta?.partial_json).toBe(
      JSON.stringify({ query: "latest docs" }),
    )
  })

  test("handles Claude Code style tool history without legacy reasoning injection", async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "claude-settings-tool-history-"))
    process.env.HOME = tempHome
    delete process.env.MODEL_REASONING_EFFORT
    process.env.COPILOT_REASONING_EFFORT = "high"
    await mkdir(path.join(tempHome, ".claude"), { recursive: true })
    await writeFile(
      path.join(tempHome, ".claude", "settings.json"),
      JSON.stringify(
        {
          env: {
            COPILOT_REASONING_EFFORT: "xhigh",
          },
        },
        null,
        2,
      ),
    )

    try {
      const captured: Array<CapturedRequest> = []
      const upstream = new Response(
        JSON.stringify({
          id: "chatcmpl-3g",
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
          model: "claude-sonnet-4.6",
          max_tokens: 1024,
          messages: [
            { role: "user", content: "Use the tool" },
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "toolu_1",
                  name: "lookup",
                  input: { q: "status" },
                },
              ],
            },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
                { type: "text", text: "Continue" },
              ],
            },
          ],
        }),
      })

      expect(res.status).toBe(200)
      const body = captured[0].body as {
        messages?: Array<{ role?: string; tool_calls?: Array<{ id?: string }> }>
        output_config?: { effort?: string }
        reasoning_effort?: string
      }
      expect(body.reasoning_effort).toBeUndefined()
      expect(body.output_config?.effort).toBeUndefined()
      expect(body.messages?.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "user",
      ])
      expect(body.messages?.[1]?.tool_calls?.[0]?.id).toBe("toolu_1")
    } finally {
      await rm(tempHome, { recursive: true, force: true })
    }
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

  test("non-stream mode returns upstream reasoning as an Anthropic thinking block", async () => {
    const captured: Array<CapturedRequest> = []
    const upstream = new Response(
      JSON.stringify({
        id: "chatcmpl-thinking",
        created: 1700000000,
        model: "claude-opus-4.7-1m-internal",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              reasoning_text: "I should answer briefly.",
              content: "OK",
            },
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
        model: "claude-opus-4.7",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Reply with OK" }],
        reasoning_effort: "high",
      }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      content: Array<{ type: string; text?: string; thinking?: string }>
    }
    expect(json.content).toEqual([
      { type: "thinking", thinking: "I should answer briefly." },
      { type: "text", text: "OK" },
    ])
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

  test("stream mode returns upstream reasoning as Anthropic thinking events", async () => {
    const captured: Array<CapturedRequest> = []
    const sseBody = [
      'data: {"id":"cmpl-thinking","object":"chat.completion.chunk","created":1700000001,"model":"claude-opus-4.7-1m-internal","choices":[{"index":0,"delta":{"role":"assistant","reasoning_text":"I should answer briefly."},"finish_reason":null,"logprobs":null}],"usage":{"prompt_tokens":10,"completion_tokens":0,"total_tokens":10}}\n\n',
      'data: {"id":"cmpl-thinking","object":"chat.completion.chunk","created":1700000001,"model":"claude-opus-4.7-1m-internal","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null,"logprobs":null}],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}\n\n',
      'data: {"id":"cmpl-thinking","object":"chat.completion.chunk","created":1700000001,"model":"claude-opus-4.7-1m-internal","choices":[{"index":0,"delta":{},"finish_reason":"stop","logprobs":null}],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}\n\n',
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
        reasoning_effort: "high",
      }),
    })

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('"type":"thinking"')
    expect(text).toContain('"type":"thinking_delta"')
    expect(text).toContain('"thinking":"I should answer briefly."')
    expect(text).toContain('"type":"text_delta"')
    expect(text.indexOf('"type":"thinking_delta"')).toBeLessThan(
      text.indexOf('"type":"text_delta"'),
    )
  })

  test("stream mode restores shortened MCP tool names in Anthropic SSE events", async () => {
    const originalToolName =
      "mcp__plugin_microsoft-docs_microsoft-learn__microsoft_docs_search"
    const captured: Array<CapturedRequest> = []
    const upstream = (request: CapturedRequest) => {
      const body = request.body as {
        tools?: Array<{ function: { name: string } }>
      }
      const upstreamToolName = body.tools?.[0]?.function.name ?? "missing"
      const sseBody = [
        `data: {"id":"cmpl-tool","object":"chat.completion.chunk","created":1700000001,"model":"claude-haiku-4.5","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"${upstreamToolName}","arguments":""}}]},"finish_reason":null,"logprobs":null}],"usage":{"prompt_tokens":10,"completion_tokens":0,"total_tokens":10}}\n\n`,
        'data: {"id":"cmpl-tool","object":"chat.completion.chunk","created":1700000001,"model":"claude-haiku-4.5","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"finish_reason":null,"logprobs":null}],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}\n\n',
        'data: {"id":"cmpl-tool","object":"chat.completion.chunk","created":1700000001,"model":"claude-haiku-4.5","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls","logprobs":null}],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}\n\n',
        "data: [DONE]\n\n",
      ].join("")

      return new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      })
    }

    const { app, restore: r } = buildApp(captured, upstream)
    restore = r

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4.5",
        stream: true,
        max_tokens: 1024,
        messages: [{ role: "user", content: "search docs" }],
        tools: [
          {
            name: originalToolName,
            description: "Search Microsoft Learn docs",
            input_schema: { type: "object", properties: {} },
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    const upstreamBody = captured[0].body as {
      tools?: Array<{ function: { name: string } }>
    }
    const upstreamToolName = upstreamBody.tools?.[0]?.function.name
    expect(upstreamToolName).not.toBe(originalToolName)
    expect(upstreamToolName?.length).toBeLessThanOrEqual(64)

    const text = await res.text()
    expect(text).toContain('"type":"tool_use"')
    expect(text).toContain(`"name":"${originalToolName}"`)
    expect(text).not.toContain(`"name":"${upstreamToolName}"`)
    expect(text).toContain("event: message_stop")
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
