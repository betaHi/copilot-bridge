import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { Hono } from "hono"

import type { BridgeConfig, BridgeEnv } from "~/lib/config"
import {
  MODEL_CAPABILITIES,
  type ReasoningEffort,
} from "~/lib/model-capabilities"
import { runtimeState } from "~/lib/state"
import { chatCompletionRoutes } from "~/routes/chat-completions"
import { messageRoutes } from "~/routes/messages"

interface CapturedRequest {
  body: unknown
  method: string
  url: string
}

const config: BridgeConfig = {
  host: "127.0.0.1",
  port: 0,
  accountType: "individual",
  copilotBaseUrl: "https://upstream.test",
  copilotToken: "test-token",
  vsCodeVersion: "1.0.0",
}

const upstreamChatResponse = (model: string) =>
  new Response(
    JSON.stringify({
      id: "chatcmpl-matrix",
      created: 1700000000,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )

const upstreamResponsesResponse = (model: string) =>
  new Response(
    JSON.stringify({
      id: "resp-matrix",
      created_at: 1700000000,
      model,
      output: [
        {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "OK", annotations: [] }],
        },
      ],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )

const buildApp = (
  route: "messages" | "chat-completions",
  captured: Array<CapturedRequest>,
) => {
  const app = new Hono<BridgeEnv>()
  app.use("*", async (c, next) => {
    c.set("config", config)
    await next()
  })

  if (route === "messages") {
    app.route("/v1/messages", messageRoutes)
  } else {
    app.route("/v1/chat/completions", chatCompletionRoutes)
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

    return url.includes("/responses") ?
        upstreamResponsesResponse((parsedBody as { model?: string })?.model ?? "unknown")
      : upstreamChatResponse((parsedBody as { model?: string })?.model ?? "unknown")
  }) as typeof fetch

  return {
    app,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

const expectedChatReasoningFields = (
  reasoningField: "reasoning_effort" | "output_config.effort" | undefined,
  effort: ReasoningEffort | undefined,
) =>
  reasoningField === "output_config.effort" ?
    {
      outputEffort: effort,
      reasoningEffort: undefined,
    }
  : {
      outputEffort: undefined,
      reasoningEffort: effort,
    }

const expectedResponsesReasoningEffort = (
  effort: ReasoningEffort | undefined,
): ReasoningEffort | undefined => effort

const originalHome = process.env.HOME
const originalCwd = process.cwd()
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-bridge-matrix-"))

beforeAll(() => {
  fs.mkdirSync(path.join(tempHome, ".claude"), { recursive: true })
  fs.writeFileSync(path.join(tempHome, ".claude", "settings.json"), "{}\n")
  process.env.HOME = tempHome
  process.chdir(tempHome)
  delete process.env.MODEL_REASONING_EFFORT

  runtimeState.models = {
    object: "list",
    data: MODEL_CAPABILITIES.map((capability) => ({
      id: capability.id,
      name: capability.id,
      object: "model",
      vendor: "test",
      version: "1",
      preview: false,
      model_picker_enabled: true,
      capabilities: {
        family: capability.id,
        object: "model_capabilities",
        tokenizer: "o200k_base",
        type: "chat",
        limits: {},
        supports: { tool_calls: true },
      },
    })),
  }
})

afterAll(() => {
  process.chdir(originalCwd)
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  fs.rmSync(tempHome, { recursive: true, force: true })
})

let restore: () => void = () => {}

afterEach(() => {
  restore()
  restore = () => {}
})

describe("reasoning matrix: /v1/chat/completions", () => {
  test("does not infer reasoning effort when omitted", async () => {
    for (const capability of MODEL_CAPABILITIES) {
      const captured: Array<CapturedRequest> = []
      const { app, restore: r } = buildApp("chat-completions", captured)
      restore = r

      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: capability.id,
          max_tokens: 32,
          messages: [{ role: "user", content: "Reply with OK" }],
        }),
      })

      expect(res.status).toBe(200)
      const request = captured[0]
      const body = request?.body as {
        reasoning?: { effort?: ReasoningEffort }
        output_config?: { effort?: ReasoningEffort }
        reasoning_effort?: ReasoningEffort
      }

      expect(body.reasoning?.effort).toBeUndefined()
      expect(body.output_config?.effort).toBeUndefined()
      expect(body.reasoning_effort).toBeUndefined()
    }
  })

  test("forwards every model's supported reasoning efforts to the correct field", async () => {
    for (const capability of MODEL_CAPABILITIES) {
      const efforts = capability.reasoning?.supported ?? ["high" as const]

      for (const effort of efforts) {
        const captured: Array<CapturedRequest> = []
        const { app, restore: r } = buildApp("chat-completions", captured)
        restore = r

        const payload: Record<string, unknown> = {
          model: capability.id,
          max_tokens: 32,
          messages: [{ role: "user", content: "Reply with OK" }],
        }
        payload.reasoning_effort = effort

        const res = await app.request("/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        })

        expect(res.status).toBe(200)
        const request = captured[0]
        const body = request?.body as {
          reasoning?: { effort?: ReasoningEffort }
          output_config?: { effort?: ReasoningEffort }
          reasoning_effort?: ReasoningEffort
        }

        if (request.url.endsWith("/responses")) {
          expect(body.reasoning?.effort).toBe(
            expectedResponsesReasoningEffort(
              capability.reasoning ? (effort ?? undefined) : undefined,
            ),
          )
          expect(body.reasoning_effort).toBeUndefined()
          expect(body.output_config?.effort).toBeUndefined()
        } else {
          const expected = expectedChatReasoningFields(
            capability.reasoningField,
            capability.reasoning ? (effort ?? undefined) : undefined,
          )
          expect(body.output_config?.effort).toBe(expected.outputEffort)
          expect(body.reasoning_effort).toBe(expected.reasoningEffort)
        }
      }
    }
  })
})

describe("reasoning matrix: /v1/messages", () => {
  test("does not infer reasoning for plain Claude-client requests", async () => {
    for (const capability of MODEL_CAPABILITIES) {
      const captured: Array<CapturedRequest> = []
      const { app, restore: r } = buildApp("messages", captured)
      restore = r

      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: capability.id,
          max_tokens: 32,
          messages: [{ role: "user", content: "Reply with OK" }],
        }),
      })

      expect(res.status).toBe(200)
      const request = captured[0]
      const body = request?.body as {
        reasoning?: { effort?: ReasoningEffort }
        output_config?: { effort?: ReasoningEffort }
        reasoning_effort?: ReasoningEffort
      }

      if (request.url.endsWith("/responses")) {
        expect(body.reasoning?.effort).toBeUndefined()
        expect(body.reasoning_effort).toBeUndefined()
        expect(body.output_config?.effort).toBeUndefined()
      } else {
        const expected = expectedChatReasoningFields(
          capability.reasoningField,
          undefined,
        )
        expect(body.output_config?.effort).toBe(expected.outputEffort)
        expect(body.reasoning_effort).toBe(expected.reasoningEffort)
      }
    }
  })
})