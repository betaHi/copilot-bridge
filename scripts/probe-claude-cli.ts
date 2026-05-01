#!/usr/bin/env bun
/* eslint-disable */
import { spawn } from "node:child_process"

interface Case {
  model: string
  efforts: Array<string | null> // null = no --effort flag
}

// CLI's --effort only accepts low/medium/high/xhigh/max (no "none").
// We exercise the broadest subset each model accepts.
const CASES: Case[] = [
  // GPT-5
  { model: "gpt-5.5", efforts: ["low", "medium", "high", "xhigh"] },
  { model: "gpt-5.4", efforts: ["low", "medium", "high", "xhigh"] },
  { model: "gpt-5.4-mini", efforts: ["low", "medium"] },
  { model: "gpt-5.3-codex", efforts: ["low", "medium", "high", "xhigh"] },
  { model: "gpt-5.2", efforts: ["low", "medium", "high", "xhigh"] },
  { model: "gpt-5.2-codex", efforts: ["low", "medium", "high", "xhigh"] },
  { model: "gpt-5-mini", efforts: ["low", "medium", "high"] },
  // Claude
  { model: "claude-opus-4.7", efforts: ["medium"] },
  { model: "claude-opus-4.7-1m", efforts: ["low", "medium", "high", "xhigh"] },
  { model: "claude-opus-4.7-high", efforts: ["high"] },
  { model: "claude-opus-4.7-xhigh", efforts: ["xhigh"] },
  { model: "claude-opus-4.6", efforts: ["low", "medium", "high"] },
  { model: "claude-opus-4.6-1m", efforts: ["low", "medium", "high"] },
  { model: "claude-sonnet-4.6", efforts: ["low", "medium", "high"] },
  { model: "claude-opus-4.5", efforts: [null] },
  { model: "claude-sonnet-4.5", efforts: [null] },
  { model: "claude-sonnet-4", efforts: [null] },
  { model: "claude-haiku-4.5", efforts: [null] },
  // Gemini
  { model: "gemini-3.1-pro-preview", efforts: [null] },
  { model: "gemini-3-flash-preview", efforts: [null] },
  { model: "gemini-2.5-pro", efforts: [null] },
  // Legacy
  { model: "gpt-4.1", efforts: [null] },
  { model: "gpt-4o", efforts: [null] },
]

interface Result {
  model: string
  effort: string
  ok: boolean
  ms: number
  preview: string
}

function runClaude(model: string, effort: string | null): Promise<Result> {
  return new Promise((resolve) => {
    const args = [
      "-p",
      "Reply with the single word PONG and nothing else.",
      "--model",
      model,
      "--output-format",
      "json",
      "--no-session-persistence",
    ]
    if (effort) args.push("--effort", effort)

    const t = performance.now()
    const child = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })

    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d.toString()))
    child.stderr.on("data", (d) => (stderr += d.toString()))

    const timer = setTimeout(() => {
      child.kill("SIGKILL")
    }, 60_000)

    child.on("close", (code) => {
      clearTimeout(timer)
      const ms = Math.round(performance.now() - t)
      let preview = ""
      let ok = false
      try {
        const j = JSON.parse(stdout)
        const text = j.result ?? j.message?.content?.[0]?.text ?? ""
        preview = String(text).replace(/\s+/g, " ").trim().slice(0, 80)
        ok = code === 0 && /pong/i.test(preview)
      } catch {
        preview = (stderr || stdout).replace(/\s+/g, " ").trim().slice(0, 120)
      }
      resolve({ model, effort: effort ?? "—", ok, ms, preview })
    })
  })
}

const results: Result[] = []
for (const c of CASES) {
  for (const e of c.efforts) {
    const r = await runClaude(c.model, e)
    results.push(r)
    const tag = r.ok ? "PASS" : "FAIL"
    console.log(
      `${tag.padEnd(4)}  ${r.model.padEnd(24)} effort=${String(r.effort).padEnd(7)} ${String(r.ms).padStart(6)}ms  ${r.preview}`,
    )
  }
}

const fail = results.filter((r) => !r.ok)
console.log("---")
console.log(`total=${results.length} pass=${results.length - fail.length} fail=${fail.length}`)
if (fail.length) process.exit(1)
