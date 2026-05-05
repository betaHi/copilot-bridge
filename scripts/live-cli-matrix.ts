#!/usr/bin/env bun
/* eslint-disable no-console */
import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  getModelCapability,
  MODEL_CAPABILITIES,
  resolveModelId,
  type ReasoningEffort,
} from "~/lib/model-capabilities"

const ROOT = path.resolve(import.meta.dir, "..")
const EXTRA_PATH = process.env.LIVE_EXTRA_PATH ? `${process.env.LIVE_EXTRA_PATH}:` : ""
const PATH_ENV = `${EXTRA_PATH}${process.env.PATH ?? ""}`
const BACKEND = process.env.LIVE_WEB_SEARCH_BACKEND ?? "gpt-5.5"
const CASE_TIMEOUT_MS = Number(process.env.LIVE_CASE_TIMEOUT_MS ?? 90_000)
const PORT_BASE = Number(process.env.LIVE_PORT_BASE ?? 19420)
const RUN_SEARCH = process.env.LIVE_RUN_SEARCH !== "0"
const FILTER_MODES = new Set((process.env.LIVE_MODES ?? "no-backend,with-backend").split(",").filter(Boolean))
const FILTER_CLIENTS = new Set((process.env.LIVE_CLIENTS ?? "claude,codex").split(",").filter(Boolean))
const FILTER_MODELS = new Set((process.env.LIVE_MODELS ?? "").split(",").filter(Boolean))
const MAX_CASES = process.env.LIVE_MAX_CASES ? Number(process.env.LIVE_MAX_CASES) : undefined
const TRACE_DIR = process.env.LIVE_TRACE_DIR ? path.resolve(process.env.LIVE_TRACE_DIR) : path.join(ROOT, ".tmp-live")

type ClientName = "claude" | "codex"
type BackendMode = "no-backend" | "with-backend"

interface MatrixCase {
  model: string
  efforts: Array<ReasoningEffort | null>
}

interface Result {
  mode: BackendMode
  client: ClientName
  kind: "core" | "search"
  model: string
  effort: string
  ok: boolean
  ms: number
  preview: string
}

interface TraceEntry {
  attempt?: number
  body?: unknown
  method?: string
  path?: string
}

interface ModelsResponse {
  data?: Array<{ id?: string }>
}

const publicModelId = (id: string): string =>
  id === "claude-opus-4.7-1m-internal" ? "claude-opus-4.7-1m" : id

const matrixCases: Array<MatrixCase> = MODEL_CAPABILITIES.map((capability) => ({
  model: publicModelId(capability.id),
  efforts: capability.reasoning?.supported ? [...capability.reasoning.supported] : [null],
})).filter((item) => FILTER_MODELS.size === 0 || FILTER_MODELS.has(item.model))

const searchCases: Array<MatrixCase> = [
  { model: "claude-haiku-4.5", efforts: [null] },
  { model: "gemini-3-flash-preview", efforts: [null] },
  { model: "gpt-5-mini", efforts: ["low" as ReasoningEffort] },
].filter((item) => FILTER_MODELS.size === 0 || FILTER_MODELS.has(item.model))

const WEB_SEARCH_PROMPT = [
  "Use web search to find the official GitHub Copilot documentation URL.",
  "Do not answer from memory; only answer after using web search.",
  "Reply with that URL only.",
].join(" ")

const isCopilotDocsUrlOnly = (text: string): boolean =>
  /^\**https:\/\/docs\.github\.com\/[^\s*]*copilot[^\s*]*\**\.?$/i.test(text.trim())

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const runProcess = async (
  command: string,
  args: Array<string>,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; ms: number; timedOut: boolean }> => {
  const started = performance.now()
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, PATH: PATH_ENV, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  })

  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => (stdout += chunk.toString()))
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()))

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, options.timeoutMs ?? CASE_TIMEOUT_MS)

  const code = await new Promise<number | null>((resolve) => {
    child.on("close", resolve)
  })
  clearTimeout(timer)

  return {
    code,
    stdout,
    stderr,
    timedOut,
    ms: Math.round(performance.now() - started),
  }
}

const readJsonFile = async (filePath: string): Promise<Record<string, unknown>> => {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>
  } catch {
    return {}
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readTraceEntries = async (filePath: string): Promise<Array<TraceEntry>> => {
  const text = await readFile(filePath, "utf8").catch(() => "")
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as TraceEntry]
      } catch {
        return []
      }
    })
}

const getTraceCursor = async (filePath: string): Promise<number> =>
  (await readTraceEntries(filePath)).length

const getTraceEntriesSince = async (
  filePath: string,
  cursor: number,
): Promise<Array<TraceEntry>> =>
  (await readTraceEntries(filePath)).slice(cursor)

const writeClaudeSettingsForBridge = async (
  port: number,
  backend: string | undefined,
  effort: ReasoningEffort | null = null,
) => {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json")
  const settings = await readJsonFile(settingsPath)
  const env = {
    ...(typeof settings.env === "object" && settings.env !== null ? settings.env as Record<string, unknown> : {}),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: "dummy",
  } as Record<string, unknown>

  if (backend === undefined) {
    delete env.COPILOT_WEB_SEARCH_BACKEND
  } else {
    env.COPILOT_WEB_SEARCH_BACKEND = backend
  }

  if (effort) {
    env.MODEL_REASONING_EFFORT = effort
  } else {
    delete env.MODEL_REASONING_EFFORT
  }

  const nextSettings: Record<string, unknown> = { ...settings, env }
  if (effort && effort !== "none") {
    nextSettings.effortLevel = effort
  } else {
    delete nextSettings.effortLevel
  }

  await writeFile(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`)
}

const writeProjectClaudeEffortForBridge = async (
  effort: ReasoningEffort | null,
) => {
  const settingsPath = path.join(ROOT, ".claude", "settings.local.json")
  const settings = await readJsonFile(settingsPath)
  const env = {
    ...(typeof settings.env === "object" && settings.env !== null ? settings.env as Record<string, unknown> : {}),
  } as Record<string, unknown>

  if (effort) {
    env.MODEL_REASONING_EFFORT = effort
  } else {
    delete env.MODEL_REASONING_EFFORT
  }

  await mkdir(path.dirname(settingsPath), { recursive: true })
  await writeFile(settingsPath, `${JSON.stringify({ ...settings, env }, null, 2)}\n`)
}

const writeCodexBackendConfig = async (
  dir: string,
  backend: string | undefined,
): Promise<string> => {
  const configPath = path.join(dir, "config.toml")
  await writeFile(
    configPath,
    backend === undefined ? "" : `COPILOT_WEB_SEARCH_BACKEND = ${JSON.stringify(backend)}\n`,
  )
  return configPath
}

const waitForBridge = async (port: number, child: ChildProcess) => {
  const deadline = Date.now() + 90_000
  let output = ""
  child.stdout?.on("data", (chunk) => (output += chunk.toString()))
  child.stderr?.on("data", (chunk) => (output += chunk.toString()))

  while (Date.now() < deadline) {
    if (output.includes(`copilot-bridge listening on http://127.0.0.1:${port}`)) {
      return
    }
    if (child.exitCode !== null) {
      throw new Error(`bridge exited early: ${output}`)
    }
    await sleep(250)
  }
  throw new Error(`bridge did not start within timeout: ${output.slice(-2000)}`)
}

const fetchAvailableModels = async (port: number): Promise<Set<string>> => {
  const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
    headers: { accept: "application/json" },
  })
  if (!response.ok) {
    throw new Error(`failed to fetch /v1/models: ${response.status}`)
  }
  const payload = await response.json() as ModelsResponse
  return new Set((payload.data ?? []).flatMap((model) => model.id ? [model.id] : []))
}

const isModelAvailable = (models: Set<string>, model: string): boolean =>
  models.has(model)
  || (model === "claude-opus-4.7-1m" && models.has("claude-opus-4.7-1m-internal"))

const startBridge = async (
  mode: BackendMode,
  port: number,
  codexConfigPath: string,
): Promise<{ child: ChildProcess; traceFile: string }> => {
  await mkdir(TRACE_DIR, { recursive: true })
  const traceFile = path.join(TRACE_DIR, `${mode}-requests.jsonl`)
  await writeFile(traceFile, "")
  await writeClaudeSettingsForBridge(
    port,
    mode === "with-backend" ? BACKEND : undefined,
  )
  await writeProjectClaudeEffortForBridge(null)

  const child = spawn(
    "bun",
    [
      "run",
      "./src/main.ts",
      "start",
      "--port",
      String(port),
      "--no-codex-setup",
      "--no-claude-setup",
      "--no-prompt",
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: PATH_ENV,
        CODEX_CONFIG_PATH: codexConfigPath,
        COPILOT_BRIDGE_TRACE_REQUESTS_FILE: traceFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  await waitForBridge(port, child)
  return { child, traceFile }
}

const stopBridge = async (child: ChildProcess) => {
  if (child.exitCode !== null) return
  child.kill("SIGTERM")
  await Promise.race([
    new Promise((resolve) => child.on("close", resolve)),
    sleep(5_000).then(() => child.kill("SIGKILL")),
  ])
}

const claudeResultText = (stdout: string): string => {
  try {
    const parsed = JSON.parse(stdout) as { result?: unknown; message?: { content?: Array<{ text?: string }> } }
    return String(parsed.result ?? parsed.message?.content?.[0]?.text ?? "")
  } catch {
    return stdout
  }
}

const getTraceBodyModel = (entry: TraceEntry): string | undefined =>
  isRecord(entry.body) && typeof entry.body.model === "string" ? entry.body.model : undefined

const canonicalLiveModel = (model: string): string => resolveModelId(model)

const getEffortMarkers = (body: unknown): Array<string> => {
  if (!isRecord(body)) {
    return []
  }

  const markers: Array<string> = []
  const reasoning = body.reasoning
  if (isRecord(reasoning) && typeof reasoning.effort === "string") {
    markers.push(`reasoning.effort=${reasoning.effort}`)
  }

  if (typeof body.reasoning_effort === "string") {
    markers.push(`reasoning_effort=${body.reasoning_effort}`)
  }

  const outputConfig = body.output_config
  if (isRecord(outputConfig) && typeof outputConfig.effort === "string") {
    markers.push(`output_config.effort=${outputConfig.effort}`)
  }

  return markers
}

const validateEffortTrace = (
  entries: Array<TraceEntry>,
  model: string,
  effort: ReasoningEffort | null,
): { ok: boolean; preview: string } => {
  const canonicalModel = canonicalLiveModel(model)
  const relevantEntries = entries
    .filter((entry) => entry.attempt === undefined || entry.attempt === 1)
    .filter((entry) => getTraceBodyModel(entry) === canonicalModel)

  if (relevantEntries.length === 0) {
    return { ok: false, preview: "trace:no-upstream-request" }
  }

  const markers = relevantEntries.flatMap((entry) => getEffortMarkers(entry.body))
  const capability = getModelCapability(model)

  if (!capability?.reasoning) {
    return markers.length === 0 ?
        { ok: true, preview: "trace:effort-absent" }
      : { ok: false, preview: `trace:unexpected-${markers.join(",")}` }
  }

  if (!effort) {
    return { ok: false, preview: "trace:missing-expected-effort" }
  }

  const expectedSuffix = `=${effort}`
  const matched = markers.find((marker) => marker.endsWith(expectedSuffix))
  return matched ?
      { ok: true, preview: `trace:${matched}` }
    : {
      ok: false,
      preview: markers.length ?
        `trace:expected-${effort}-saw-${markers.join(",")}`
      : `trace:expected-${effort}-saw-absent`,
    }
}

const applyEffortTraceValidation = (
  result: Result,
  entries: Array<TraceEntry>,
): Result => {
  const effort = result.effort === "—" ? null : result.effort as ReasoningEffort
  const trace = validateEffortTrace(entries, result.model, effort)
  return {
    ...result,
    ok: result.ok && trace.ok,
    preview: `${result.preview} | ${trace.preview}`.slice(0, 220),
  }
}

const traceBodyIncludes = (body: unknown, needle: string): boolean => {
  try {
    return JSON.stringify(body).includes(needle)
  } catch {
    return false
  }
}

const validateWebSearchTrace = (
  entries: Array<TraceEntry>,
): { ok: boolean; preview: string } => {
  const searchEntry = entries
    .filter((entry) => entry.attempt === undefined || entry.attempt === 1)
    .find((entry) => traceBodyIncludes(entry.body, "web_search_preview"))

  return searchEntry ?
      { ok: true, preview: `trace:web_search_preview${searchEntry.path ? `@${searchEntry.path}` : ""}` }
    : { ok: false, preview: "trace:missing-web_search_preview" }
}

const applySearchTraceValidation = (
  result: Result,
  entries: Array<TraceEntry>,
): Result => {
  const effortResult = applyEffortTraceValidation(result, entries)
  const searchTrace = validateWebSearchTrace(entries)
  return {
    ...effortResult,
    ok: effortResult.ok && searchTrace.ok,
    preview: `${effortResult.preview} | ${searchTrace.preview}`.slice(0, 260),
  }
}

const runClaudeCore = async (
  mode: BackendMode,
  port: number,
  model: string,
  effort: ReasoningEffort | null,
): Promise<Result> => {
  await writeClaudeSettingsForBridge(
    port,
    mode === "with-backend" ? BACKEND : undefined,
    effort,
  )
  await writeProjectClaudeEffortForBridge(effort)
  const args = [
    "-p",
    "Reply with exactly PONG.",
    "--model",
    model,
    "--output-format",
    "json",
    "--no-session-persistence",
  ]
  if (effort && effort !== "none") args.push("--effort", effort)

  const result = await runProcess("claude", args, {
    env: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_AUTH_TOKEN: "dummy",
    },
  })
  const text = claudeResultText(result.stdout).replace(/\s+/g, " ").trim()
  return {
    mode,
    client: "claude",
    kind: "core",
    model,
    effort: effort ?? "—",
    ok: result.code === 0 && /\bPONG\b/i.test(text),
    ms: result.ms,
    preview: (text || result.stderr).replace(/\s+/g, " ").trim().slice(0, 160),
  }
}

const codexBaseArgs = (
  port: number,
  effort: ReasoningEffort | null,
  webSearch: "disabled" | "live",
): Array<string> => {
  const args = [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--ephemeral",
    "--color",
    "never",
    "-s",
    "read-only",
    "-c",
    "model_provider=\"bridge\"",
    "-c",
    "model_providers.bridge.name=\"Copilot Bridge\"",
    "-c",
    `model_providers.bridge.base_url=\"http://127.0.0.1:${port}/v1\"`,
    "-c",
    "model_providers.bridge.wire_api=\"responses\"",
    "-c",
    "model_providers.bridge.requires_openai_auth=false",
    "-c",
    "model_supports_reasoning_summaries=true",
    "-c",
    `web_search="${webSearch}"`,
  ]

  if (effort) {
    args.push("-c", `model_reasoning_effort=\"${effort}\"`)
  }

  return args
}

const runCodexCore = async (
  mode: BackendMode,
  port: number,
  model: string,
  effort: ReasoningEffort | null,
): Promise<Result> => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-live-out-"))
  const outFile = path.join(tempDir, "last.txt")
  const args = [
    ...codexBaseArgs(port, effort, mode === "with-backend" ? "live" : "disabled"),
    "-m",
    model,
    "-o",
    outFile,
    "Reply with exactly PONG. Do not run commands.",
  ]

  const result = await runProcess("codex", args)
  const text = await readFile(outFile, "utf8").catch(() => "")
  await rm(tempDir, { recursive: true, force: true })
  return {
    mode,
    client: "codex",
    kind: "core",
    model,
    effort: effort ?? "—",
    ok: result.code === 0 && /\bPONG\b/i.test(text),
    ms: result.ms,
    preview: (text || result.stderr || result.stdout).replace(/\s+/g, " ").trim().slice(0, 160),
  }
}

const runClaudeSearch = async (
  port: number,
  model: string,
  effort: ReasoningEffort | null,
): Promise<Result> => {
  await writeClaudeSettingsForBridge(port, BACKEND, effort)
  await writeProjectClaudeEffortForBridge(effort)
  const args = [
    "-p",
    WEB_SEARCH_PROMPT,
    "--model",
    model,
    "--output-format",
    "json",
    "--no-session-persistence",
  ]
  if (effort && effort !== "none") args.push("--effort", effort)
  const result = await runProcess("claude", args, {
    env: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_AUTH_TOKEN: "dummy",
    },
    timeoutMs: 120_000,
  })
  const text = claudeResultText(result.stdout).replace(/\s+/g, " ").trim()
  return {
    mode: "with-backend",
    client: "claude",
    kind: "search",
    model,
    effort: effort ?? "—",
    ok: result.code === 0 && isCopilotDocsUrlOnly(text),
    ms: result.ms,
    preview: (text || result.stderr).replace(/\s+/g, " ").trim().slice(0, 180),
  }
}

const runCodexSearch = async (
  port: number,
  model: string,
  effort: ReasoningEffort | null,
): Promise<Result> => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-live-search-"))
  const outFile = path.join(tempDir, "last.txt")
  const args = [
    ...codexBaseArgs(port, effort, "live"),
    "-m",
    model,
    "-o",
    outFile,
    WEB_SEARCH_PROMPT,
  ]
  const result = await runProcess("codex", args, { timeoutMs: 120_000 })
  const text = await readFile(outFile, "utf8").catch(() => "")
  await rm(tempDir, { recursive: true, force: true })
  return {
    mode: "with-backend",
    client: "codex",
    kind: "search",
    model,
    effort: effort ?? "—",
    ok: result.code === 0 && isCopilotDocsUrlOnly(text),
    ms: result.ms,
    preview: (text || result.stderr || result.stdout).replace(/\s+/g, " ").trim().slice(0, 180),
  }
}

const printResult = (result: Result) => {
  const tag = result.ok ? "PASS" : "FAIL"
  console.log(
    [
      tag.padEnd(4),
      result.mode.padEnd(12),
      result.client.padEnd(6),
      result.kind.padEnd(6),
      result.model.padEnd(28),
      `effort=${String(result.effort).padEnd(6)}`,
      `${String(result.ms).padStart(6)}ms`,
      result.preview,
    ].join("  "),
  )
}

const originalClaudeSettings = await readFile(
  path.join(os.homedir(), ".claude", "settings.json"),
  "utf8",
).catch(() => undefined)
const projectClaudeSettingsPath = path.join(ROOT, ".claude", "settings.local.json")
const originalProjectClaudeSettings = await readFile(
  projectClaudeSettingsPath,
  "utf8",
).catch(() => undefined)

const results: Array<Result> = []
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "copilot-bridge-live-"))
let activeBridge: ChildProcess | undefined
let restoredClaudeSettings = false

const restoreClaudeSettings = async () => {
  if (restoredClaudeSettings) return
  restoredClaudeSettings = true
  if (originalClaudeSettings === undefined) {
    await rm(path.join(os.homedir(), ".claude", "settings.json"), { force: true })
  } else {
    await writeFile(path.join(os.homedir(), ".claude", "settings.json"), originalClaudeSettings)
  }

  if (originalProjectClaudeSettings === undefined) {
    await rm(projectClaudeSettingsPath, { force: true })
  } else {
    await writeFile(projectClaudeSettingsPath, originalProjectClaudeSettings)
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    activeBridge?.kill("SIGTERM")
    void restoreClaudeSettings().finally(() => process.exit(130))
  })
}

try {
  let executedCases = 0
  for (const [modeIndex, mode] of (["no-backend", "with-backend"] as const).entries()) {
    if (!FILTER_MODES.has(mode)) continue
    const port = PORT_BASE + modeIndex
    const codexConfigPath = await writeCodexBackendConfig(
      tempRoot,
      mode === "with-backend" ? BACKEND : undefined,
    )
    const bridge = await startBridge(mode, port, codexConfigPath)
    activeBridge = bridge.child
    try {
      const availableModels = await fetchAvailableModels(port)
      const activeCases = matrixCases.filter((item) =>
        isModelAvailable(availableModels, item.model),
      )
      const unavailable = matrixCases
        .filter((item) => !isModelAvailable(availableModels, item.model))
        .map((item) => item.model)
      if (unavailable.length) {
        console.log(`UNAVAILABLE ${mode}: ${unavailable.join(", ")}`)
      }

      for (const item of activeCases) {
        for (const effort of item.efforts) {
          if (MAX_CASES !== undefined && executedCases >= MAX_CASES) break

          if (FILTER_CLIENTS.has("claude")) {
            const traceCursor = await getTraceCursor(bridge.traceFile)
            const claude = applyEffortTraceValidation(
              await runClaudeCore(mode, port, item.model, effort),
              await getTraceEntriesSince(bridge.traceFile, traceCursor),
            )
            results.push(claude)
            printResult(claude)
            executedCases += 1
          }

          if (MAX_CASES !== undefined && executedCases >= MAX_CASES) break

          if (FILTER_CLIENTS.has("codex")) {
            const traceCursor = await getTraceCursor(bridge.traceFile)
            const codex = applyEffortTraceValidation(
              await runCodexCore(mode, port, item.model, effort),
              await getTraceEntriesSince(bridge.traceFile, traceCursor),
            )
            results.push(codex)
            printResult(codex)
            executedCases += 1
          }
        }
        if (MAX_CASES !== undefined && executedCases >= MAX_CASES) break
      }

      if (mode === "with-backend" && RUN_SEARCH) {
        for (const item of searchCases.filter((searchCase) =>
          isModelAvailable(availableModels, searchCase.model),
        )) {
          for (const effort of item.efforts) {
            if (MAX_CASES !== undefined && executedCases >= MAX_CASES) break

            if (FILTER_CLIENTS.has("claude")) {
              const traceCursor = await getTraceCursor(bridge.traceFile)
              const claude = applySearchTraceValidation(
                await runClaudeSearch(port, item.model, effort),
                await getTraceEntriesSince(bridge.traceFile, traceCursor),
              )
              results.push(claude)
              printResult(claude)
              executedCases += 1
            }

            if (MAX_CASES !== undefined && executedCases >= MAX_CASES) break

            if (FILTER_CLIENTS.has("codex")) {
              const traceCursor = await getTraceCursor(bridge.traceFile)
              const codex = applySearchTraceValidation(
                await runCodexSearch(port, item.model, effort),
                await getTraceEntriesSince(bridge.traceFile, traceCursor),
              )
              results.push(codex)
              printResult(codex)
              executedCases += 1
            }
          }
          if (MAX_CASES !== undefined && executedCases >= MAX_CASES) break
        }
      }
    } finally {
      await stopBridge(bridge.child)
      activeBridge = undefined
    }
  }
} finally {
  await restoreClaudeSettings()
  await rm(tempRoot, { recursive: true, force: true })
}

const failures = results.filter((result) => !result.ok)
console.log("---")
console.log(`total=${results.length} pass=${results.length - failures.length} fail=${failures.length}`)

if (failures.length) {
  for (const failure of failures) {
    console.log(
      `FAIL_DETAIL ${failure.mode} ${failure.client} ${failure.kind} ${failure.model} effort=${failure.effort}: ${failure.preview}`,
    )
  }
  process.exit(1)
}
