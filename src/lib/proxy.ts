import consola from "consola"
import { Agent, Dispatcher, ProxyAgent, setGlobalDispatcher } from "undici"

const HTTP_PROXY_ENV_KEYS = ["HTTP_PROXY", "http_proxy"] as const
const HTTPS_PROXY_ENV_KEYS = ["HTTPS_PROXY", "https_proxy"] as const
const NO_PROXY_ENV_KEYS = ["NO_PROXY", "no_proxy"] as const

const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
] as const

const DEFAULT_PORTS: Record<string, number> = {
  "http:": 80,
  "https:": 443,
}

interface EnvValue {
  key: string
  value: string
}

interface NoProxyEntry {
  hostname: string
  port: number
}

interface ParsedNoProxy {
  entries: Array<NoProxyEntry>
  wildcard: boolean
}

const getEnvValue = (keys: readonly string[]): EnvValue | undefined => {
  const key = keys.find((candidate) => process.env[candidate]?.trim())
  if (!key) return undefined
  return { key, value: process.env[key]!.trim() }
}

export const getConfiguredProxyEnvKey = (): string | undefined =>
  getEnvValue(PROXY_ENV_KEYS)?.key

const getConfiguredNoProxyEnvKey = (): string | undefined =>
  getEnvValue(NO_PROXY_ENV_KEYS)?.key

const parseNoProxy = (value: string | undefined): ParsedNoProxy => {
  const entries: Array<NoProxyEntry> = []
  const rawEntries = value?.split(/[\s,]/).filter(Boolean) ?? []

  for (const entry of rawEntries) {
    if (entry === "*") {
      return { entries: [], wildcard: true }
    }

    const parsed = entry.match(/^(.+):(\d+)$/)
    const hostname = (parsed ? parsed[1] : entry)
      .replace(/^\*?\./, "")
      .toLowerCase()
    const port = parsed ? Number.parseInt(parsed[2], 10) : 0
    if (hostname) {
      entries.push({ hostname, port })
    }
  }

  return { entries, wildcard: false }
}

const getOriginPort = (origin: URL): number =>
  origin.port ? Number.parseInt(origin.port, 10)
  : DEFAULT_PORTS[origin.protocol] ?? 0

const shouldBypassProxy = (
  origin: URL,
  noProxy: ParsedNoProxy,
): boolean => {
  if (noProxy.wildcard) return true

  const hostname = origin.hostname.toLowerCase()
  const port = getOriginPort(origin)
  return noProxy.entries.some(
    (entry) =>
      (!entry.port || entry.port === port)
      && (hostname === entry.hostname
        || hostname.endsWith(`.${entry.hostname}`)),
  )
}

export class EnvProxyDispatcher extends Dispatcher {
  private readonly directAgent = new Agent()
  private readonly httpProxyAgent: ProxyAgent | undefined
  private readonly httpsProxyAgent: ProxyAgent | undefined
  private readonly noProxy: ParsedNoProxy

  constructor(input: {
    httpProxy: string | undefined
    httpsProxy: string | undefined
    noProxy: string | undefined
  }) {
    super()
    this.httpProxyAgent = input.httpProxy ? new ProxyAgent(input.httpProxy) : undefined
    this.httpsProxyAgent =
      input.httpsProxy ? new ProxyAgent(input.httpsProxy) : this.httpProxyAgent
    this.noProxy = parseNoProxy(input.noProxy)
  }

  dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandlers,
  ): boolean {
    const origin = options.origin ? new URL(options.origin) : undefined
    const dispatcher = origin ? this.getDispatcher(origin) : this.directAgent
    return dispatcher.dispatch(options, handler)
  }

  close(): Promise<void>
  close(callback: () => void): void
  close(callback?: () => void): Promise<void> | void {
    const promise = Promise.all(
      this.dispatchers.map((dispatcher) => dispatcher.close()),
    ).then(() => undefined)

    if (callback) {
      promise.then(callback)
      return
    }

    return promise
  }

  destroy(): Promise<void>
  destroy(error: Error | null): Promise<void>
  destroy(callback: () => void): void
  destroy(error: Error | null, callback: () => void): void
  destroy(
    errorOrCallback?: Error | null | (() => void),
    callback?: () => void,
  ): Promise<void> | void {
    const error =
      typeof errorOrCallback === "function" ? null : errorOrCallback ?? null
    const done = typeof errorOrCallback === "function" ? errorOrCallback : callback
    const promise = Promise.all(
      this.dispatchers.map((dispatcher) => dispatcher.destroy(error ?? null)),
    ).then(() => undefined)

    if (done) {
      promise.then(done)
      return
    }

    return promise
  }

  private get dispatchers(): Array<Dispatcher> {
    const dispatchers = new Set<Dispatcher>([this.directAgent])
    if (this.httpProxyAgent) dispatchers.add(this.httpProxyAgent)
    if (this.httpsProxyAgent) dispatchers.add(this.httpsProxyAgent)
    return [...dispatchers]
  }

  private getDispatcher(origin: URL): Dispatcher {
    if (shouldBypassProxy(origin, this.noProxy)) {
      return this.directAgent
    }

    if (origin.protocol === "https:") {
      return this.httpsProxyAgent ?? this.directAgent
    }

    if (origin.protocol === "http:") {
      return this.httpProxyAgent ?? this.directAgent
    }

    return this.directAgent
  }
}

export const configureProxyFromEnv = (): boolean => {
  const proxyEnvKey = getConfiguredProxyEnvKey()
  if (!proxyEnvKey) {
    return false
  }

  setGlobalDispatcher(
    new EnvProxyDispatcher({
      httpProxy: getEnvValue(HTTP_PROXY_ENV_KEYS)?.value,
      httpsProxy: getEnvValue(HTTPS_PROXY_ENV_KEYS)?.value,
      noProxy: getEnvValue(NO_PROXY_ENV_KEYS)?.value,
    }),
  )

  const noProxyEnvKey = getConfiguredNoProxyEnvKey()
  consola.info(
    `HTTP proxy enabled via $${proxyEnvKey}${noProxyEnvKey ? ` ($${noProxyEnvKey} respected)` : ""}`,
  )

  return true
}
