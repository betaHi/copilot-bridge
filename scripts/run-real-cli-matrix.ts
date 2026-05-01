#!/usr/bin/env bun
/* eslint-disable no-console */
import { spawn } from "node:child_process"
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  MODEL_CAPABILITIES,
  type ModelCapability,
  type ReasoningEffort,
} from "~/lib/model-capabilities"

type ClientName = "codex" | "claude"

interface MatrixCase {
  client: ClientName
  family: "gpt" | "claude" | "gemini"
  model: string
  upstreamModel: string
  effort: ReasoningEffort | null
  reasoningField: ModelCapability["reasoningField"] | "reasoning.effort" | null
}

interface ProcessResult {
  code: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  ms: number
}

interface TraceRecord {
  seq: number
  method: string
  path: string
  status: number
  request: {
    model?: unknown
    reasoning_effort?: unknown
    reasoning?: { effort?: unknown }
    output_config?: { effort?: unknown }
    stream?: unknown
  }
  response: {
    model?: unknown
    reasoning_tokens?: unknown
    content_type?: string
  }
}

interface ClientTraceRecord {
  seq: number
  method: string
  path: string
  status: number
  request: {
    model?: unknown
    reasoning_effort?: unknown
    reasoning?: { effort?: unknown }
    output_config?: { effort?: unknown }
    thinking?: { type?: unknown; budget_tokens?: unknown }
    stream?: unknown
  }
}

interface CaseResult {
  case: MatrixCase
  ok: boolean
  code: number | null
  timedOut: boolean
  ms: number
  output: string
  clientTrace?: ClientTraceRecord
  trace?: TraceRecord
  checks: Record<string, boolean>
  error?: string
}

const PROMPT = "Reply exactly PONG and do not run tools."
const WORKSPACE = process.cwd()
const BRIDGE_PORT = Number(process.env.MATRIX_BRIDGE_PORT ?? "45242")
const PROXY_PORT = Number(process.env.MATRIX_PROXY_PORT ?? "45243")
const CLIENT_PROXY_PORT = Number(process.env.MATRIX_CLIENT_PROXY_PORT ?? "45244")
const BRIDGE_BASE_URL = `http://127.0.0.1:${BRIDGE_PORT}`
const PROXY_BASE_URL = `http://127.0.0.1:${PROXY_PORT}`
const CLIENT_BASE_URL = `http://127.0.0.1:${CLIENT_PROXY_PORT}`
const REAL_COPILOT_BASE_URL =
  process.env.MATRIX_REAL_COPILOT_BASE_URL ?? "https://api.githubcopilot.com"
const CLIENT_FILTER = process.env.MATRIX_CLIENT as ClientName | "both" | undefined
const ONLY_MODEL = process.env.MATRIX_ONLY_MODEL
const ONLY_EFFORT = process.env.MATRIX_ONLY_EFFORT
const TIMEOUT_MS = Number(process.env.MATRIX_TIMEOUT_MS ?? "180000")
const CODEX_COMMAND = process.env.MATRIX_CODEX_BIN ?? "codex"
const CODEX_REASONING_SUPPORT = process.env.MATRIX_CODEX_REASONING_SUPPORT !== "false"
const PROJECT_CLAUDE_DIR = path.join(WORKSPACE, ".claude")
const PROJECT_CLAUDE_SETTINGS = path.join(
  PROJECT_CLAUDE_DIR,
  "settings.local.json",
)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const publicModelId = (capability: ModelCapability): string =>
  capability.aliases?.includes("claude-opus-4.7-1m") ?
    "claude-opus-4.7-1m"
  : capability.id

const familyOf = (model: string): MatrixCase["family"] | undefined => {
  if (model.startsWith("gpt-")) return "gpt"
  if (model.startsWith("claude-")) return "claude"
  if (model.startsWith("gemini-")) return "gemini"
  return undefined
}

const shouldUseResponsesApiForModel = (model: string): boolean =>
  /^(?:gpt-5\.5|gpt-5\.4-mini|gpt-5\.3-codex|gpt-5\.2-codex)(?:-|$)/i.test(
    model,
  )

const expectedReasoningField = (
  capability: ModelCapability,
  client: ClientName,
): MatrixCase["reasoningField"] => {
  if (!capability.reasoning) return null
  if (capability.reasoningField === "output_config.effort") {
    return "output_config.effort"
  }
  if (client === "codex" && !capability.fallback) {
    return "reasoning.effort"
  }
  if (
    client === "claude"
    && !capability.fallback
    && shouldUseResponsesApiForModel(capability.id)
  ) {
    return "reasoning.effort"
  }
  return "reasoning_effort"
}

const buildMatrix = (): Array<MatrixCase> => {
  const clients: Array<ClientName> =
    CLIENT_FILTER === "codex" ? ["codex"]
    : CLIENT_FILTER === "claude" ? ["claude"]
    : ["codex", "claude"]

  const cases: Array<MatrixCase> = []
  for (const capability of MODEL_CAPABILITIES) {
    const family = familyOf(capability.id)
    if (!family) continue

    const efforts = capability.reasoning?.supported ?? [null]
    for (const client of clients) {
      for (const effort of efforts) {
        if (ONLY_MODEL && publicModelId(capability) !== ONLY_MODEL) continue
        if (ONLY_EFFORT && String(effort ?? "none") !== ONLY_EFFORT) continue
        cases.push({
          client,
          family,
          model: publicModelId(capability),
          upstreamModel: capability.id,
          effort,
          reasoningField: expectedReasoningField(capability, client),
        })
      }
    }
  }

  return cases
}

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ?
    (value as Record<string, unknown>)
  : undefined

const pickResponseModelFromSse = (text: string): unknown => {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue
    const data = line.slice("data:".length).trim()
    if (!data || data === "[DONE]") continue
    const parsed = asRecord(parseJson(data))
    if (typeof parsed?.model === "string") return parsed.model
    const response = asRecord(parsed?.response)
    if (typeof response?.model === "string") return response.model
  }
  return undefined
}

const pickReasoningTokens = (responseJson: unknown): unknown => {
  const json = asRecord(responseJson)
  const usage = asRecord(json?.usage)
  const outputDetails = asRecord(usage?.output_tokens_details)
  return outputDetails?.reasoning_tokens
}

const createTraceProxy = async (tracePath: string) => {
  const records: Array<TraceRecord> = []
  let seq = 0

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: PROXY_PORT,
    async fetch(request) {
      const requestUrl = new URL(request.url)
      const target = `${REAL_COPILOT_BASE_URL}${requestUrl.pathname}${requestUrl.search}`
      const bodyText =
        request.method === "GET" || request.method === "HEAD" ?
          ""
        : await request.text()
      const requestJson = asRecord(parseJson(bodyText)) ?? {}
      const upstreamHeaders = new Headers(request.headers)
      upstreamHeaders.delete("host")
      const upstream = await fetch(target, {
        method: request.method,
        headers: upstreamHeaders,
        body: bodyText ? bodyText : undefined,
      })
      const responseText = await upstream.text()
      const responseJson = parseJson(responseText)
      const responseRecord = asRecord(responseJson)
      const contentType = upstream.headers.get("content-type") ?? undefined
      const record: TraceRecord = {
        seq: ++seq,
        method: request.method,
        path: requestUrl.pathname,
        status: upstream.status,
        request: {
          model: requestJson.model,
          reasoning_effort: requestJson.reasoning_effort,
          reasoning: asRecord(requestJson.reasoning) as { effort?: unknown } | undefined,
          output_config: asRecord(requestJson.output_config) as
            | { effort?: unknown }
            | undefined,
          stream: requestJson.stream,
        },
        response: {
          model:
            responseRecord?.model ?? pickResponseModelFromSse(responseText),
          reasoning_tokens: pickReasoningTokens(responseJson),
          content_type: contentType,
        },
      }
      records.push(record)
      await appendFile(tracePath, `${JSON.stringify(record)}\n`)

      const headers = new Headers(upstream.headers)
      headers.delete("content-encoding")
      headers.delete("content-length")
      headers.delete("transfer-encoding")
      return new Response(responseText, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      })
    },
  })

  return { server, records }
}

const createClientProxy = async (tracePath: string) => {
  const records: Array<ClientTraceRecord> = []
  let seq = 0

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: CLIENT_PROXY_PORT,
    async fetch(request) {
      const requestUrl = new URL(request.url)
      const target = `${BRIDGE_BASE_URL}${requestUrl.pathname}${requestUrl.search}`
      const bodyText =
        request.method === "GET" || request.method === "HEAD" ?
          ""
        : await request.text()
      const requestJson = asRecord(parseJson(bodyText)) ?? {}
      const headers = new Headers(request.headers)
      headers.delete("host")
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        body: bodyText ? bodyText : undefined,
      })
      const responseText = await upstream.text()
      const record: ClientTraceRecord = {
        seq: ++seq,
        method: request.method,
        path: requestUrl.pathname,
        status: upstream.status,
        request: {
          model: requestJson.model,
          reasoning_effort: requestJson.reasoning_effort,
          reasoning: asRecord(requestJson.reasoning) as { effort?: unknown } | undefined,
          output_config: asRecord(requestJson.output_config) as
            | { effort?: unknown }
            | undefined,
          thinking: asRecord(requestJson.thinking) as
            | { type?: unknown; budget_tokens?: unknown }
            | undefined,
          stream: requestJson.stream,
        },
      }
      records.push(record)
      await appendFile(tracePath, `${JSON.stringify(record)}\n`)

      const responseHeaders = new Headers(upstream.headers)
      responseHeaders.delete("content-encoding")
      responseHeaders.delete("content-length")
      responseHeaders.delete("transfer-encoding")
      return new Response(responseText, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      })
    },
  })

  return { server, records }
}

const runProcess = (
  command: string,
  args: Array<string>,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ProcessResult> =>
  new Promise((resolve) => {
    const started = performance.now()
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, options.timeoutMs ?? TIMEOUT_MS)

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({
        code,
        timedOut,
        stdout,
        stderr,
        ms: Math.round(performance.now() - started),
      })
    })
  })

const waitForBridge = async () => {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BRIDGE_BASE_URL}/healthz`)
      if (response.ok) return
    } catch {
      // keep waiting
    }
    await sleep(500)
  }
  throw new Error("bridge did not become healthy")
}

const writeProjectClaudeSettings = async (
  effort: ReasoningEffort | null,
): Promise<void> => {
  await mkdir(PROJECT_CLAUDE_DIR, { recursive: true })

  if (effort === "none") {
    await writeFile(
      PROJECT_CLAUDE_SETTINGS,
      `${JSON.stringify({ env: { MODEL_REASONING_EFFORT: "none" } }, null, 2)}\n`,
    )
    return
  }

  if (effort) {
    await writeFile(
      PROJECT_CLAUDE_SETTINGS,
      `${JSON.stringify({ env: { MODEL_REASONING_EFFORT: effort } }, null, 2)}\n`,
    )
    return
  }

  await writeFile(
    PROJECT_CLAUDE_SETTINGS,
    `${JSON.stringify({ env: {} }, null, 2)}\n`,
  )
}

const readCodexOutput = async (outputPath: string, result: ProcessResult) => {
  try {
    return (await readFile(outputPath, "utf8")).trim()
  } catch {
    return (result.stdout || result.stderr).trim()
  }
}

const readClaudeOutput = (result: ProcessResult): string => {
  const parsed = asRecord(parseJson(result.stdout))
  const resultText = parsed?.result
  if (typeof resultText === "string") return resultText.trim()
  return (result.stdout || result.stderr).trim()
}

const runCodexCase = async (
  testCase: MatrixCase,
  rootDir: string,
): Promise<ProcessResult & { output: string }> => {
  const codexHome = path.join(rootDir, "codex-home")
  const workdir = path.join(
    rootDir,
    `codex-work-${testCase.model}-${testCase.effort ?? "none"}`,
  )
  await mkdir(codexHome, { recursive: true })
  await mkdir(workdir, { recursive: true })

  const effortLine =
    testCase.effort ? `model_reasoning_effort = "${testCase.effort}"\n` : ""
  const reasoningSupportLine =
    testCase.effort && CODEX_REASONING_SUPPORT ?
      "model_supports_reasoning_summaries = true\n"
    : ""
  await writeFile(
    path.join(codexHome, "config.toml"),
    `model = "${testCase.model}"\n${effortLine}${reasoningSupportLine}model_provider = "copilot-bridge"\n\n[model_providers.copilot-bridge]\nname = "copilot-bridge"\nbase_url = "${BRIDGE_BASE_URL}/v1"\nwire_api = "responses"\nprefer_websockets = false\nrequires_openai_auth = false\n`,
  )

  const outputPath = path.join(workdir, "out.txt")
  const result = await runProcess(
    CODEX_COMMAND,
    [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--cd",
      workdir,
      "--output-last-message",
      outputPath,
      PROMPT,
    ],
    {
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        OPENAI_API_KEY: "dummy",
      },
    },
  )

  return { ...result, output: await readCodexOutput(outputPath, result) }
}

const runClaudeCase = async (
  testCase: MatrixCase,
  rootDir: string,
): Promise<ProcessResult & { output: string }> => {
  await writeProjectClaudeSettings(testCase.effort)

  const claudeHome = path.join(
    rootDir,
    `claude-home-${testCase.model}-${testCase.effort ?? "none"}`,
  )
  const workdir = path.join(
    rootDir,
    `claude-work-${testCase.model}-${testCase.effort ?? "none"}`,
  )
  await mkdir(claudeHome, { recursive: true })
  await mkdir(workdir, { recursive: true })
  const settingsPath = path.join(claudeHome, "settings.json")
  await writeFile(
    settingsPath,
    `${JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: CLIENT_BASE_URL,
          ANTHROPIC_AUTH_TOKEN: "dummy",
        },
      },
      null,
      2,
    )}\n`,
  )

  const args = [
    "--bare",
    "-p",
    PROMPT,
    "--model",
    testCase.model,
    "--output-format",
    "json",
    "--no-session-persistence",
    "--tools",
    "",
    "--settings",
    settingsPath,
  ]

  const result = await runProcess("claude", args, {
    cwd: workdir,
    env: {
      ...process.env,
      HOME: claudeHome,
      ANTHROPIC_BASE_URL: CLIENT_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: "dummy",
      ANTHROPIC_API_KEY: "dummy",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_SIMPLE: "1",
    },
  })

  return { ...result, output: readClaudeOutput(result) }
}

const noEffortAttached = (trace: TraceRecord): boolean =>
  trace.request.reasoning_effort === undefined
  && trace.request.reasoning?.effort === undefined
  && trace.request.output_config?.effort === undefined

const effortMatches = (testCase: MatrixCase, trace: TraceRecord): boolean => {
  if (!testCase.effort) return noEffortAttached(trace)

  switch (testCase.reasoningField) {
    case "output_config.effort": {
      return trace.request.output_config?.effort === testCase.effort
    }
    case "reasoning.effort": {
      return trace.request.reasoning?.effort === testCase.effort
    }
    case "reasoning_effort": {
      return trace.request.reasoning_effort === testCase.effort
    }
    case null: {
      return noEffortAttached(trace)
    }
  }

  return false
}

const findTrace = (
  records: Array<TraceRecord>,
  fromIndex: number,
): TraceRecord | undefined =>
  records
    .slice(fromIndex)
    .filter((record) =>
      record.path === "/chat/completions" || record.path === "/responses",
    )
    .at(-1)

const findClientTrace = (
  records: Array<ClientTraceRecord>,
  fromIndex: number,
): ClientTraceRecord | undefined =>
  records
    .slice(fromIndex)
    .filter((record) =>
      record.path === "/v1/messages" || record.path === "/v1/responses",
    )
    .at(-1)

const evaluateCase = (
  testCase: MatrixCase,
  processResult: ProcessResult & { output: string },
  clientTrace: ClientTraceRecord | undefined,
  trace: TraceRecord | undefined,
): CaseResult => {
  const checks = {
    cli_exit: processResult.code === 0 && !processResult.timedOut,
    cli_output: /^PONG\.?$/i.test(processResult.output.trim()),
    upstream_called: trace !== undefined,
    upstream_status: trace ? trace.status >= 200 && trace.status <= 299 : false,
    upstream_model: trace?.request.model === testCase.upstreamModel,
    upstream_response_model: trace?.response.model === testCase.upstreamModel,
    upstream_effort: trace ? effortMatches(testCase, trace) : false,
  }
  const ok = Object.values(checks).every(Boolean)
  const error =
    ok ? undefined
    : (processResult.stderr || processResult.stdout).replace(/\s+/g, " ").trim().slice(0, 500)

  return {
    case: testCase,
    ok,
    code: processResult.code,
    timedOut: processResult.timedOut,
    ms: processResult.ms,
    output: processResult.output,
    clientTrace,
    trace,
    checks,
    error,
  }
}

const printResult = (result: CaseResult): void => {
  const { case: testCase, clientTrace, trace } = result
  const expectedEffort = testCase.effort ?? "none"
  const actualEffort =
    trace?.request.output_config?.effort
    ?? trace?.request.reasoning?.effort
    ?? trace?.request.reasoning_effort
    ?? "none"
  const status = result.ok ? "PASS" : "FAIL"
  console.log(
    `${status} ${testCase.client.padEnd(6)} ${testCase.model.padEnd(28)} effort=${String(expectedEffort).padEnd(6)} inbound=${String(clientTrace?.path ?? "-").padEnd(13)} upstream=${String(trace?.path ?? "-").padEnd(17)} req_model=${String(trace?.request.model ?? "-").padEnd(32)} req_effort=${String(actualEffort).padEnd(6)} in_effort=${String(clientTrace?.request.reasoning_effort ?? clientTrace?.request.thinking?.budget_tokens ?? clientTrace?.request.reasoning?.effort ?? "none").padEnd(7)} resp_model=${String(trace?.response.model ?? "-").padEnd(28)} ${String(result.ms).padStart(6)}ms`,
  )
  if (!result.ok) {
    console.log(`     checks=${JSON.stringify(result.checks)} error=${result.error ?? ""}`)
  }
}

const main = async () => {
  const matrix = buildMatrix()
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "copilot-bridge-matrix-"))
  const tracePath = path.join(rootDir, "upstream-trace.jsonl")
  const clientTracePath = path.join(rootDir, "client-trace.jsonl")
  const resultPath = path.join(rootDir, "results.json")
  const hadProjectClaudeSettings = existsSync(PROJECT_CLAUDE_SETTINGS)
  const previousProjectClaudeSettings =
    hadProjectClaudeSettings ? await readFile(PROJECT_CLAUDE_SETTINGS, "utf8") : undefined

  await mkdir(rootDir, { recursive: true })
  await writeFile(tracePath, "")
  await writeFile(clientTracePath, "")

  const { server: proxy, records } = await createTraceProxy(tracePath)
  const { server: clientProxy, records: clientRecords } =
    await createClientProxy(clientTracePath)
  const bridge = spawn(
    "bun",
    [
      "./src/main.ts",
      "start",
      "--host",
      "127.0.0.1",
      "--port",
      String(BRIDGE_PORT),
      "--no-claude-setup",
      "--no-codex-setup",
      "--no-prompt",
      "--debug",
    ],
    {
      cwd: WORKSPACE,
      env: {
        ...process.env,
        COPILOT_BASE_URL: PROXY_BASE_URL,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  bridge.stdout.on("data", (chunk) => process.stdout.write(chunk))
  bridge.stderr.on("data", (chunk) => process.stderr.write(chunk))

  const results: Array<CaseResult> = []
  try {
    await waitForBridge()
    console.log(
      `matrix_start clients=${CLIENT_FILTER ?? "both"} cases=${matrix.length} trace=${tracePath} client_trace=${clientTracePath}`,
    )

    for (const testCase of matrix) {
      const traceStart = records.length
      const clientTraceStart = clientRecords.length
      const processResult =
        testCase.client === "codex" ?
          await runCodexCase(testCase, rootDir)
        : await runClaudeCase(testCase, rootDir)
      const clientTrace = findClientTrace(clientRecords, clientTraceStart)
      const trace = findTrace(records, traceStart)
      const result = evaluateCase(testCase, processResult, clientTrace, trace)
      results.push(result)
      printResult(result)
    }

    await writeFile(resultPath, `${JSON.stringify(results, null, 2)}\n`)
    const failed = results.filter((result) => !result.ok)
    console.log("---")
    console.log(
      `matrix_done total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`,
    )
    console.log(`results=${resultPath}`)
    console.log(`client_trace=${clientTracePath}`)
    console.log(`trace=${tracePath}`)
    if (failed.length > 0) process.exitCode = 1
  } finally {
    bridge.kill("SIGTERM")
    clientProxy.stop(true)
    proxy.stop(true)
    if (previousProjectClaudeSettings !== undefined) {
      await mkdir(PROJECT_CLAUDE_DIR, { recursive: true })
      await writeFile(PROJECT_CLAUDE_SETTINGS, previousProjectClaudeSettings)
    } else if (!hadProjectClaudeSettings) {
      await rm(PROJECT_CLAUDE_SETTINGS, { force: true })
    }
  }
}

await main()