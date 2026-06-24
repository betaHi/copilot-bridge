import { afterEach, describe, expect, test } from "bun:test"

import {
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici"

import {
  configureProxyFromEnv,
  EnvProxyDispatcher,
  getConfiguredProxyEnvKey,
} from "~/lib/proxy"

const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
] as const

const originalDispatcher = getGlobalDispatcher()
const originalEnv = Object.fromEntries(
  PROXY_ENV_KEYS.map((key) => [key, process.env[key]]),
)

const restoreProxyEnv = () => {
  for (const key of PROXY_ENV_KEYS) {
    const originalValue = originalEnv[key]
    if (originalValue === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalValue
    }
  }
}

const clearProxyEnv = () => {
  for (const key of PROXY_ENV_KEYS) {
    delete process.env[key]
  }
}

afterEach(() => {
  restoreProxyEnv()
  setGlobalDispatcher(originalDispatcher)
})

describe("proxy environment support", () => {
  test("does not change dispatcher without proxy env", () => {
    clearProxyEnv()

    expect(configureProxyFromEnv()).toBe(false)
    expect(getGlobalDispatcher()).toBe(originalDispatcher)
  })

  test("enables proxy dispatcher when HTTP proxy env is set", () => {
    clearProxyEnv()
    process.env.HTTP_PROXY = "http://127.0.0.1:7890"

    expect(getConfiguredProxyEnvKey()).toBe("HTTP_PROXY")
    expect(configureProxyFromEnv()).toBe(true)
    expect(getGlobalDispatcher()).toBeInstanceOf(EnvProxyDispatcher)
  })

  test("prefers HTTPS_PROXY over HTTP_PROXY", () => {
    clearProxyEnv()
    process.env.HTTP_PROXY = "http://127.0.0.1:7890"
    process.env.HTTPS_PROXY = "http://127.0.0.1:7891"

    expect(getConfiguredProxyEnvKey()).toBe("HTTPS_PROXY")
  })
})
