import { afterEach, describe, expect, test } from "bun:test"

import {
  fetchCopilot,
  type CopilotProviderContext,
} from "~/providers/copilot/client"

const provider: CopilotProviderContext = {
  baseUrl: "https://upstream.test",
  token: "test-token",
  vsCodeVersion: "1.0.0",
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("fetchCopilot retry", () => {
  test("retries one transient upstream 5xx", async () => {
    const requestIds: Array<string> = []
    let calls = 0
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls++
      requestIds.push(new Headers(init?.headers).get("x-request-id") ?? "")
      return new Response(calls === 1 ? "Internal Server Error\n" : "{}", {
        status: calls === 1 ? 500 : 200,
      })
    }) as unknown as typeof fetch

    const response = await fetchCopilot(provider, "/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5" }),
    })

    expect(response.status).toBe(200)
    expect(calls).toBe(2)
    expect(requestIds[0]).toBeTruthy()
    expect(requestIds[1]).toBeTruthy()
    expect(requestIds[0]).not.toBe(requestIds[1])
  })

  test("does not retry upstream 4xx", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response("Bad Request\n", { status: 400 })
    }) as unknown as typeof fetch

    const response = await fetchCopilot(provider, "/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5" }),
    })

    expect(response.status).toBe(400)
    expect(calls).toBe(1)
  })

  test("retries one network failure", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) {
        throw new Error("socket closed")
      }
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    const response = await fetchCopilot(provider, "/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5" }),
    })

    expect(response.status).toBe(200)
    expect(calls).toBe(2)
  })
})
