import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  fetchAutoSession,
  enableAutoMode,
} from "~/lib/auto-session"
import type { BridgeConfig } from "~/lib/config"
import { runtimeState } from "~/lib/state"
import {
  fetchCopilot,
  getCopilotProviderContext,
  type CopilotProviderContext,
} from "~/providers/copilot/client"

const makeConfig = (): BridgeConfig => ({
  host: "127.0.0.1",
  port: 0,
  accountType: "individual",
  copilotBaseUrl: "https://upstream.test",
  copilotToken: "test-token",
  vsCodeVersion: "1.0.0",
})

const originalFetch = globalThis.fetch

beforeEach(() => {
  delete runtimeState.autoMode
  delete runtimeState.autoSessionToken
  delete runtimeState.autoExpiresAt
  delete runtimeState.autoAvailableModels
})

afterEach(() => {
  globalThis.fetch = originalFetch
  delete runtimeState.autoMode
  delete runtimeState.autoSessionToken
  delete runtimeState.autoExpiresAt
  delete runtimeState.autoAvailableModels
})

const provider: CopilotProviderContext = {
  baseUrl: "https://upstream.test",
  token: "test-token",
  vsCodeVersion: "1.0.0",
}

describe("start --auto model selection", () => {
  test("auto mode resolves models from session.available_models not from /models endpoint", async () => {
    const availableModels = ["gpt-5.3-codex", "gpt-5-mini", "gpt-5.4-mini", "gpt-4o", "gpt-4.1"]

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          session_token: "tok",
          available_models: availableModels,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    ) as typeof fetch

    const result = await enableAutoMode(makeConfig())

    expect(result.available_models).toEqual(availableModels)
    expect(runtimeState.autoAvailableModels).toEqual(availableModels)

    const models = result.available_models ?? []
    expect(models).toHaveLength(5)
    expect(models).toContain("gpt-5-mini")
    expect(models).toContain("gpt-4o")
    expect(models).toContain("gpt-4.1")
    expect(models).toContain("gpt-5.3-codex")
    expect(models).toContain("gpt-5.4-mini")
  })

  test("non-auto mode fetches models from GET /models (contrast with auto)", async () => {
    const upstreamModels = [
      { id: "gpt-5-mini" },
      { id: "gpt-5.2" },
      { id: "gpt-5.2-codex" },
      { id: "gpt-5.3-codex" },
      { id: "gpt-5.4" },
      { id: "gpt-5.4-mini" },
      { id: "gpt-5.5" },
      { id: "gpt-4o" },
      { id: "gpt-4.1" },
      { id: "claude-opus-4.7" },
      { id: "gemini-2.5-pro" },
      { id: "gemini-3-flash-preview" },
      { id: "gemini-3.1-pro-preview" },
    ]

    let capturedUrl = ""
    let capturedMethod = ""
    const capturedHeaders: Record<string, string> = {}

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString()
      capturedMethod = init?.method ?? "GET"
      new Headers(init?.headers).forEach((v, k) => { capturedHeaders[k] = v })
      return new Response(
        JSON.stringify({ data: upstreamModels, object: "list" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch

    const config = makeConfig()
    const ctxProvider = getCopilotProviderContext(config)
    const response = await fetchCopilot(ctxProvider, "/models", {
      method: "GET",
      headers: { accept: "application/json" },
    })
    const payload = (await response.json()) as { data?: Array<{ id: string }> }
    const models = (payload.data ?? []).map((m) => m.id).filter(Boolean)

    // Non-auto /models request uses GET (not POST like auto /models/session)
    expect(capturedUrl).toBe("https://upstream.test/models")
    expect(capturedMethod).toBe("GET")

    // Non-auto request does NOT carry copilot-session-token
    expect(capturedHeaders["copilot-session-token"]).toBeUndefined()

    // Non-auto response contains ALL upstream models (not just auto-mode subset)
    expect(models).toContain("claude-opus-4.7")
    expect(models).toContain("gemini-3.1-pro-preview")
    expect(models).toContain("gpt-5.2")
    expect(models).toContain("gpt-5.2-codex")
    expect(models).toContain("gpt-5.5")
    expect(models).toContain("gemini-2.5-pro")
    expect(models).toContain("gemini-3-flash-preview")
    expect(models.length).toBeGreaterThan(5)
  })
})


describe("fetchCopilot with auto session token", () => {
  test("adds copilot-session-token header for /chat/completions requests", async () => {
    runtimeState.autoSessionToken = "sess-chat-test"

    let capturedHeaders: Record<string, string> = {}
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      headers.forEach((value, key) => {
        capturedHeaders[key] = value
      })
      return new Response("{}", { status: 200 })
    }) as typeof fetch

    await fetchCopilot(provider, "/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }] }),
    })

    expect(capturedHeaders["copilot-session-token"]).toBe("sess-chat-test")
    expect(capturedHeaders["x-github-api-version"]).toBe("2025-10-01")
  })

  test("adds copilot-session-token header for /responses requests", async () => {
    runtimeState.autoSessionToken = "sess-responses-test"

    let capturedHeaders: Record<string, string> = {}
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      headers.forEach((value, key) => {
        capturedHeaders[key] = value
      })
      return new Response("{}", { status: 200 })
    }) as typeof fetch

    await fetchCopilot(provider, "/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", input: "hello" }),
    })

    expect(capturedHeaders["copilot-session-token"]).toBe("sess-responses-test")
    expect(capturedHeaders["x-github-api-version"]).toBe("2025-10-01")
  })

  test("does NOT add copilot-session-token header for /models requests", async () => {
    runtimeState.autoSessionToken = "sess-models-test"

    let capturedHeaders: Record<string, string> = {}
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      headers.forEach((value, key) => {
        capturedHeaders[key] = value
      })
      return new Response("{}", { status: 200 })
    }) as typeof fetch

    await fetchCopilot(provider, "/models", {
      method: "GET",
    })

    expect(capturedHeaders["copilot-session-token"]).toBeUndefined()
    // Non-auto-mode API version should be used
    expect(capturedHeaders["x-github-api-version"]).toBe("2025-04-01")
  })

  test("does NOT add copilot-session-token header when autoSessionToken is not set", async () => {
    delete runtimeState.autoSessionToken

    let capturedHeaders: Record<string, string> = {}
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      headers.forEach((value, key) => {
        capturedHeaders[key] = value
      })
      return new Response("{}", { status: 200 })
    }) as typeof fetch

    await fetchCopilot(provider, "/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }] }),
    })

    expect(capturedHeaders["copilot-session-token"]).toBeUndefined()
    expect(capturedHeaders["x-github-api-version"]).toBe("2025-04-01")
  })

  test("does NOT add copilot-session-token for /embeddings path", async () => {
    runtimeState.autoSessionToken = "sess-embed-test"

    let capturedHeaders: Record<string, string> = {}
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      headers.forEach((value, key) => {
        capturedHeaders[key] = value
      })
      return new Response("{}", { status: 200 })
    }) as typeof fetch

    await fetchCopilot(provider, "/embeddings", {
      method: "POST",
      body: JSON.stringify({ input: "hello" }),
    })

    expect(capturedHeaders["copilot-session-token"]).toBeUndefined()
  })
})

describe("--model override with unsupported model", () => {
  test("auto mode + non-auto-available model → upstream returns 400", async () => {
    runtimeState.autoSessionToken = "sess-auto-400"
    runtimeState.autoAvailableModels = ["gpt-5-mini", "gpt-4o"]

    const requestedModel = "gemini-3.1-pro-preview" // not in auto-available
  
    let capturedModel = ""
    const capturedHeaders: Record<string, string> = {}

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      headers.forEach((v, k) => { capturedHeaders[k] = v })
      const body = JSON.parse((init?.body as string) ?? "{}") as { model?: string }
      capturedModel = body.model ?? ""

      // Upstream rejects non-auto models when copilot-session-token is present
      return new Response(
        JSON.stringify({
          error: { message: "Requested model not available for session" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch

    const response = await fetchCopilot(provider, "/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: requestedModel,
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(response.status).toBe(400)
    expect(capturedModel).toBe(requestedModel)
    // Still carries auto session token — the 400 is the upstream rejecting the model
    expect(capturedHeaders["copilot-session-token"]).toBe("sess-auto-400")
  })

  test("non-auto mode + same model → no auto restriction (200)", async () => {
    delete runtimeState.autoSessionToken

    const requestedModel = "gemini-3.1-pro-preview"
    const capturedHeaders: Record<string, string> = {}

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      headers.forEach((v, k) => { capturedHeaders[k] = v })
      return new Response("{}", { status: 200 })
    }) as typeof fetch

    const response = await fetchCopilot(provider, "/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: requestedModel,
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(response.status).toBe(200)
    expect(capturedHeaders["copilot-session-token"]).toBeUndefined()
  })

  test("non-auto mode + custom/unknown model → upstream rejects with 400", async () => {
    delete runtimeState.autoSessionToken

    const requestedModel = "my-custom-unknown-model"
    const capturedHeaders: Record<string, string> = {}

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      headers.forEach((v, k) => { capturedHeaders[k] = v })
      return new Response(
        JSON.stringify({
          error: { message: "The model `my-custom-unknown-model` does not exist" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch

    const response = await fetchCopilot(provider, "/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: requestedModel,
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(response.status).toBe(400)
    expect(capturedHeaders["copilot-session-token"]).toBeUndefined()
  })
})