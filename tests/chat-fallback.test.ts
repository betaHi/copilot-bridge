import { describe, expect, test } from "bun:test"

import {
  chatResponseToResponsesJson,
  responsesPayloadToChatPayload,
  synthesizeResponsesSseFromChat,
} from "~/bridges/codex/chat-fallback"
import { getModelCapability } from "~/lib/model-capabilities"

const claudeOpus47 = getModelCapability("claude-opus-4.7")!
const claudeOpus46 = getModelCapability("claude-opus-4.6")!
const geminiFlash = getModelCapability("gemini-3-flash-preview")!

describe("chat-fallback: request translation", () => {
  test("string input becomes a single user message", () => {
    const out = responsesPayloadToChatPayload(
      { model: "claude-opus-4.6", input: "hello" },
      claudeOpus46,
    )
    expect(out.model).toBe("claude-opus-4.6")
    expect(out.stream).toBe(false)
    expect(out.messages).toEqual([{ role: "user", content: "hello" }])
  })

  test("instructions become a leading system message", () => {
    const out = responsesPayloadToChatPayload(
      {
        model: "claude-opus-4.6",
        instructions: "be terse",
        input: [{ role: "user", content: "hi" }],
      },
      claudeOpus46,
    )
    expect(out.messages[0]).toEqual({ role: "system", content: "be terse" })
    expect(out.messages[1]).toEqual({ role: "user", content: "hi" })
  })

  test("function_call / function_call_output translate to tool_calls + tool message", () => {
    const out = responsesPayloadToChatPayload(
      {
        model: "claude-opus-4.6",
        input: [
          { role: "user", content: "do it" },
          {
            type: "function_call",
            call_id: "call_1",
            name: "exec",
            arguments: '{"cmd":"ls"}',
          },
          { type: "function_call_output", call_id: "call_1", output: "file.txt" },
        ],
      },
      claudeOpus46,
    )
    expect(out.messages[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "exec", arguments: '{"cmd":"ls"}' },
        },
      ],
    })
    expect(out.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "file.txt",
    })
  })

  test("filters codex hosted tools (web_search) and tools without name", () => {
    const out = responsesPayloadToChatPayload(
      {
        model: "claude-opus-4.6",
        input: "x",
        tools: [
          {
            type: "function",
            name: "exec_command",
            description: "run",
            parameters: { type: "object", properties: {} },
          },
          // codex 0.125 hosted tool — no name
          { type: "web_search", external_web_access: false } as never,
          // function but missing name — also drop
          { type: "function" } as never,
        ],
        tool_choice: "auto",
      },
      claudeOpus46,
    )
    expect(out.tools).toHaveLength(1)
    expect(out.tools?.[0].function.name).toBe("exec_command")
    expect(out.tool_choice).toBe("auto")
  })

  test("when no usable tools remain, omit tools and tool_choice entirely", () => {
    const out = responsesPayloadToChatPayload(
      {
        model: "claude-opus-4.6",
        input: "x",
        tools: [{ type: "web_search", external_web_access: false } as never],
        tool_choice: "auto",
      },
      claudeOpus46,
    )
    expect(out.tools).toBeUndefined()
    expect(out.tool_choice).toBeUndefined()
  })

  test("claude-opus-4.7 places effort under output_config.effort, not reasoning_effort", () => {
    const out = responsesPayloadToChatPayload(
      {
        model: "claude-opus-4.7",
        input: "x",
        reasoning: { effort: "max" },
      },
      claudeOpus47,
    )
    expect(out.output_config).toEqual({ effort: "max" })
    expect(out.reasoning_effort).toBeUndefined()
  })

  test("default model places effort under reasoning_effort", () => {
    const out = responsesPayloadToChatPayload(
      {
        model: "claude-opus-4.6",
        input: "x",
        reasoning: { effort: "high" },
      },
      claudeOpus46,
    )
    expect(out.reasoning_effort).toBe("high")
    expect(out.output_config).toBeUndefined()
  })

  test("gemini (no reasoning support) does not emit reasoning fields", () => {
    const out = responsesPayloadToChatPayload(
      {
        model: "gemini-3-flash-preview",
        input: "x",
        reasoning: { effort: "high" },
      },
      geminiFlash,
    )
    expect(out.reasoning_effort).toBeUndefined()
    expect(out.output_config).toBeUndefined()
  })
})

describe("chat-fallback: non-stream response translation", () => {
  test("text choice maps to a single message output", () => {
    const out = chatResponseToResponsesJson(
      { model: "claude-opus-4.6", input: "x" },
      {
        id: "chatcmpl-1",
        created: 1700000000,
        model: "claude-opus-4.6-up",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "OK" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      },
    )
    expect(out.id).toBe("chatcmpl-1")
    expect(out.status).toBe("completed")
    expect(out.model).toBe("claude-opus-4.6-up")
    expect(out.output).toHaveLength(1)
    const item = out.output[0]
    expect(item.type).toBe("message")
    if (item.type === "message") {
      expect(item.content[0]).toEqual({
        type: "output_text",
        text: "OK",
        annotations: [],
      })
    }
    expect(out.usage).toEqual({
      input_tokens: 3,
      output_tokens: 1,
      total_tokens: 4,
    })
  })

  test("tool_calls translate to function_call output items", () => {
    const out = chatResponseToResponsesJson(
      { model: "claude-opus-4.6", input: "x" },
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_42",
                  type: "function",
                  function: { name: "exec", arguments: '{"cmd":"ls"}' },
                },
              ],
            },
          },
        ],
      },
    )
    expect(out.output).toHaveLength(1)
    const fc = out.output[0]
    expect(fc.type).toBe("function_call")
    if (fc.type === "function_call") {
      expect(fc.call_id).toBe("call_42")
      expect(fc.name).toBe("exec")
      expect(fc.arguments).toBe('{"cmd":"ls"}')
    }
  })
})

describe("chat-fallback: SSE synthesis", () => {
  const collect = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
    }
    return buf
  }

  test("emits the full event sequence for a text reply", async () => {
    const stream = synthesizeResponsesSseFromChat(
      { model: "claude-opus-4.6", input: "x", stream: true },
      {
        choices: [{ message: { role: "assistant", content: "Hi" } }],
      },
    )
    const text = await collect(stream)
    const events = text
      .split("\n")
      .filter((l) => l.startsWith("event:"))
      .map((l) => l.slice("event:".length).trim())
    expect(events).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ])
    expect(text).toContain('"delta":"Hi"')
  })

  test("emits function_call_arguments events for tool calls", async () => {
    const stream = synthesizeResponsesSseFromChat(
      { model: "claude-opus-4.6", input: "x", stream: true },
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "exec", arguments: '{"a":1}' },
                },
              ],
            },
          },
        ],
      },
    )
    const text = await collect(stream)
    expect(text).toContain("response.function_call_arguments.delta")
    expect(text).toContain("response.function_call_arguments.done")
    expect(text).toContain('"arguments":"{\\"a\\":1}"')
  })
})
