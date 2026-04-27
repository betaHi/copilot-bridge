import consola from "consola"

import { runtimeState } from "./state"

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Enforces the configured rate limit window between mutating upstream calls.
 *
 * - Resolves silently if no rate limit is configured or enough time has passed.
 * - Throws a Response (HTTP 429) when the window has not elapsed and `wait` is
 *   disabled, so route handlers can `c.json` it directly.
 * - When `wait` is enabled, sleeps until the window elapses, then resolves.
 */
export const checkRateLimit = async (): Promise<void> => {
  const { rateLimitSeconds, rateLimitWait } = runtimeState
  if (rateLimitSeconds === undefined) return

  const now = Date.now()
  if (!runtimeState.lastRequestTimestamp) {
    runtimeState.lastRequestTimestamp = now
    return
  }

  const elapsed = (now - runtimeState.lastRequestTimestamp) / 1000
  if (elapsed > rateLimitSeconds) {
    runtimeState.lastRequestTimestamp = now
    return
  }

  const waitSeconds = Math.ceil(rateLimitSeconds - elapsed)

  if (!rateLimitWait) {
    consola.warn(
      `Rate limit exceeded. Need to wait ${waitSeconds} more seconds.`,
    )
    throw new RateLimitError(waitSeconds)
  }

  consola.warn(
    `Rate limit reached. Waiting ${waitSeconds}s before proceeding...`,
  )
  await sleep(waitSeconds * 1000)
  runtimeState.lastRequestTimestamp = Date.now()
}

export class RateLimitError extends Error {
  readonly waitSeconds: number

  constructor(waitSeconds: number) {
    super(`Rate limit exceeded. Try again in ${waitSeconds}s.`)
    this.name = "RateLimitError"
    this.waitSeconds = waitSeconds
  }
}
