#!/usr/bin/env bun
/* eslint-disable */
const BASE = process.env.BASE ?? "http://127.0.0.1:4242"

interface Case {
  model: string
  efforts: Array<string | null> // null = no effort sent
}

const CASES: Case[] = [
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
]

interface Result {
  model: string
  effort: string
  ok: boolean
  ms: number
  status: number
  preview: string
}

async function call(model: string, effort: string | null): Promise<Result> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: 64,
    messages: [{ role: "user", content: "Reply with the single word PONG." }],
  }
  if (effort) body.reasoning_effort = effort

  const t = performance.now()
  const res = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": "dummy",
    },
    body: JSON.stringify(body),
  })
  const ms = Math.round(performance.now() - t)
  const text = await res.text()

  let preview = ""
  let ok = res.ok
  if (res.ok) {
    try {
      const j = JSON.parse(text)
      const block = (j.content ?? []).find((b: any) => b.type === "text")
      preview = block?.text?.slice(0, 60) ?? ""
      ok = preview.length > 0
    } catch {
      ok = false
      preview = text.slice(0, 80)
    }
  } else {
    preview = text.slice(0, 120)
  }

  return { model, effort: effort ?? "—", ok, ms, status: res.status, preview }
}

const results: Result[] = []
for (const c of CASES) {
  for (const e of c.efforts) {
    const r = await call(c.model, e)
    results.push(r)
    const tag = r.ok ? "PASS" : "FAIL"
    console.log(
      `${tag.padEnd(4)}  ${r.model.padEnd(22)} effort=${String(r.effort).padEnd(7)} ${String(r.status).padEnd(4)} ${String(r.ms).padStart(5)}ms  ${r.preview.replace(/\s+/g, " ")}`,
    )
  }
}

const fail = results.filter((r) => !r.ok)
console.log("---")
console.log(`total=${results.length} pass=${results.length - fail.length} fail=${fail.length}`)
if (fail.length) process.exit(1)
