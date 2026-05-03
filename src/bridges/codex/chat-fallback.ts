// Translation layer: Codex /v1/responses ⇄ Copilot /v1/chat/completions.
// Used for models that do not implement the Responses API upstream
// (claude-*, gemini-*).
//
// Strategy:
// - Translate the Responses request to a Chat Completions request.
// - Force upstream to non-stream (stream: false) so we get a single JSON.
// - Translate that JSON to a Responses API JSON.
// - If the original request asked for stream:true, synthesize a tiny
//   sequence of SSE events (response.created → output_item.added →
//   content_part.added → output_text.delta → ... → response.completed)
//   so codex's bookkeeping still works.

import { randomUUID } from "node:crypto"

import type { ModelCapability, ReasoningEffort } from "~/lib/model-capabilities"

// ---------- Responses (input) types — only what we read ----------

interface ResponsesInputMessage {
  type?: "message"
  role: "user" | "assistant" | "system" | "developer"
  content: string | Array<ResponsesInputContentPart>
}

interface ResponsesInputContentPart {
  type:
    | "input_text"
    | "output_text"
    | "input_image"
    | "text"
  text?: string
  image_url?: string | { url: string }
  detail?: "low" | "high" | "auto"
}

interface ResponsesFunctionCallInput {
  type: "function_call"
  call_id: string
  name: string
  arguments: string
}

interface ResponsesFunctionCallOutputInput {
  type: "function_call_output"
  call_id: string
  output: string
}

type ResponsesInputItem =
  | ResponsesInputMessage
  | ResponsesFunctionCallInput
  | ResponsesFunctionCallOutputInput

interface ResponsesTool {
  type: "function"
  name?: string
  description?: string
  parameters?: Record<string, unknown>
  function?: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export interface ResponsesRequestLike {
  model: string
  input?: string | Array<ResponsesInputItem>
  instructions?: string
  stream?: boolean
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  user?: string
  tools?: Array<ResponsesTool>
  tool_choice?:
    | "auto"
    | "none"
    | "required"
    | { type: "function"; name: string }
  reasoning?: { effort?: ReasoningEffort; [k: string]: unknown }
  [key: string]: unknown
}

// ---------- Chat completion types — only what we send/read ----------

type ChatRole = "system" | "user" | "assistant" | "tool"

interface ChatContentPart {
  type: "text" | "image_url"
  text?: string
  image_url?: { url: string; detail?: "low" | "high" | "auto" }
}

interface ChatToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

interface ChatMessage {
  role: ChatRole
  content?: string | Array<ChatContentPart> | null
  name?: string
  reasoning_content?: string | null
  reasoning_text?: string | null
  tool_call_id?: string
  tool_calls?: Array<ChatToolCall>
}

interface ChatTool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

interface ChatRequestPayload {
  model: string
  messages: Array<ChatMessage>
  stream: boolean
  max_tokens?: number
  temperature?: number
  top_p?: number
  user?: string
  tools?: Array<ChatTool>
  tool_choice?: unknown
  reasoning_effort?: ReasoningEffort
  output_config?: { effort?: ReasoningEffort }
}

interface ChatCompletionResponse {
  id?: string
  created?: number
  model?: string
  choices: Array<{
    index?: number
    message: ChatMessage & { role: "assistant" }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

// ---------- Helpers ----------

const collectText = (
  content: string | Array<ResponsesInputContentPart> | undefined,
): { text: string; parts: Array<ChatContentPart> } => {
  if (typeof content === "string") {
    return { text: content, parts: [{ type: "text", text: content }] }
  }
  const parts: Array<ChatContentPart> = []
  let textBuf = ""
  for (const p of content ?? []) {
    if (p.type === "input_text" || p.type === "output_text" || p.type === "text") {
      const t = p.text ?? ""
      textBuf += t
      parts.push({ type: "text", text: t })
    } else if (p.type === "input_image") {
      const url =
        typeof p.image_url === "string" ?
          p.image_url
        : (p.image_url?.url ?? "")
      if (url) parts.push({ type: "image_url", image_url: { url, detail: p.detail } })
    }
  }
  return { text: textBuf, parts }
}

const placeReasoning = (
  payload: ChatRequestPayload,
  capability: ModelCapability,
  effort: ReasoningEffort | undefined,
) => {
  if (!effort || !capability.reasoning) return
  if (capability.reasoningField === "output_config.effort") {
    payload.output_config = { ...(payload.output_config ?? {}), effort }
  } else {
    payload.reasoning_effort = effort
  }
}

// ---------- Public: translate request ----------

export const responsesPayloadToChatPayload = (
  request: ResponsesRequestLike,
  capability: ModelCapability,
): ChatRequestPayload => {
  const messages: Array<ChatMessage> = []

  if (request.instructions) {
    messages.push({ role: "system", content: request.instructions })
  }

  const inputItems: Array<ResponsesInputItem> =
    typeof request.input === "string" ?
      [{ role: "user", content: request.input } as ResponsesInputMessage]
    : (request.input ?? [])

  for (const item of inputItems) {
    if ("role" in item && (item.type === undefined || item.type === "message")) {
      const { text, parts } = collectText(item.content)
      const role: ChatRole =
        item.role === "developer" ? "system"
        : item.role === "system" ? "system"
        : item.role === "assistant" ? "assistant"
        : "user"
      // Use string content when single text part for simplicity.
      const useStringContent =
        parts.length <= 1 && parts.every((p) => p.type === "text")
      messages.push({
        role,
        content: useStringContent ? text : parts,
      })
    } else if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id,
            type: "function",
            function: { name: item.name, arguments: item.arguments },
          },
        ],
      })
    } else if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: item.output,
      })
    }
  }

  const tools: Array<ChatTool> | undefined = request.tools
    ?.filter((t) => {
      const name = t.function?.name ?? t.name
      return t.type === "function" && typeof name === "string" && name.length > 0
    })
    .map((t) => ({
      type: "function",
      function: {
        name: t.function?.name ?? t.name ?? "",
        description: t.function?.description ?? t.description,
        parameters: t.function?.parameters ?? t.parameters,
      },
    }))

  const payload: ChatRequestPayload = {
    model: capability.id,
    messages,
    stream: false, // always non-stream upstream; we synthesize SSE later
    max_tokens: request.max_output_tokens,
    temperature: request.temperature,
    top_p: request.top_p,
    user: request.user,
    tools: tools && tools.length > 0 ? tools : undefined,
    tool_choice:
      tools && tools.length > 0 ? request.tool_choice : undefined,
  }

  placeReasoning(payload, capability, request.reasoning?.effort)

  return payload
}

// ---------- Public: translate non-stream response ----------

interface ResponsesApiResult {
  id: string
  object: "response"
  status: "completed" | "incomplete"
  created_at: number
  model: string
  output: Array<
    | {
        id: string
        type: "reasoning"
        status: "completed"
        summary: Array<{ type: "summary_text"; text: string }>
      }
    | {
        id: string
        type: "message"
        role: "assistant"
        status: "completed"
        content: Array<{ type: "output_text"; text: string; annotations: [] }>
      }
    | {
        id: string
        type: "function_call"
        status: "completed"
        call_id: string
        name: string
        arguments: string
      }
  >
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
  }
}

const buildResponsesResult = (
  request: ResponsesRequestLike,
  chat: ChatCompletionResponse,
): ResponsesApiResult => {
  const choice = chat.choices[0]
  const message = choice?.message
  const text =
    typeof message?.content === "string" ?
      message.content
    : Array.isArray(message?.content) ?
      message.content
        .filter((p): p is ChatContentPart => p.type === "text")
        .map((p) => p.text ?? "")
        .join("")
    : ""

  const output: ResponsesApiResult["output"] = []
  const reasoningText = message?.reasoning_text ?? message?.reasoning_content
  if (reasoningText) {
    output.push({
      id: `rs_${randomUUID()}`,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: reasoningText }],
    })
  }
  if (text.length > 0) {
    output.push({
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    })
  }
  for (const tc of message?.tool_calls ?? []) {
    output.push({
      id: `fc_${randomUUID()}`,
      type: "function_call",
      status: "completed",
      call_id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    })
  }

  return {
    id: chat.id ?? `resp_${randomUUID()}`,
    object: "response",
    status: "completed",
    created_at: chat.created ?? Math.floor(Date.now() / 1000),
    model: chat.model ?? request.model,
    output,
    usage:
      chat.usage ?
        {
          input_tokens: chat.usage.prompt_tokens ?? 0,
          output_tokens: chat.usage.completion_tokens ?? 0,
          total_tokens: chat.usage.total_tokens ?? 0,
        }
      : undefined,
  }
}

export const chatResponseToResponsesJson = buildResponsesResult

// ---------- Public: synthesize SSE stream ----------

const sse = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

export const synthesizeResponsesSseFromChat = (
  request: ResponsesRequestLike,
  chat: ChatCompletionResponse,
): ReadableStream<Uint8Array> => {
  const result = buildResponsesResult(request, chat)
  const encoder = new TextEncoder()
  const baseResponse = {
    id: result.id,
    object: "response",
    created_at: result.created_at,
    model: result.model,
    status: "in_progress",
    output: [] as unknown[],
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(sse(event, data)))

      push("response.created", { type: "response.created", response: baseResponse })
      push("response.in_progress", {
        type: "response.in_progress",
        response: baseResponse,
      })

      result.output.forEach((item, index) => {
        push("response.output_item.added", {
          type: "response.output_item.added",
          output_index: index,
          item,
        })

        if (item.type === "reasoning") {
          const text = item.summary.map((summary) => summary.text).join("")
          if (text) {
            push("response.reasoning_summary_text.delta", {
              type: "response.reasoning_summary_text.delta",
              item_id: item.id,
              output_index: index,
              summary_index: 0,
              delta: text,
            })
          }
        } else if (item.type === "message") {
          const text = item.content[0]?.text ?? ""
          const part = { type: "output_text", text: "", annotations: [] }
          push("response.content_part.added", {
            type: "response.content_part.added",
            item_id: item.id,
            output_index: index,
            content_index: 0,
            part,
          })
          if (text) {
            push("response.output_text.delta", {
              type: "response.output_text.delta",
              item_id: item.id,
              output_index: index,
              content_index: 0,
              delta: text,
            })
          }
          push("response.output_text.done", {
            type: "response.output_text.done",
            item_id: item.id,
            output_index: index,
            content_index: 0,
            text,
          })
          push("response.content_part.done", {
            type: "response.content_part.done",
            item_id: item.id,
            output_index: index,
            content_index: 0,
            part: { ...part, text },
          })
        } else if (item.type === "function_call") {
          if (item.arguments) {
            push("response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta",
              item_id: item.id,
              output_index: index,
              delta: item.arguments,
            })
          }
          push("response.function_call_arguments.done", {
            type: "response.function_call_arguments.done",
            item_id: item.id,
            output_index: index,
            arguments: item.arguments,
          })
        }

        push("response.output_item.done", {
          type: "response.output_item.done",
          output_index: index,
          item,
        })
      })

      push("response.completed", {
        type: "response.completed",
        response: { ...result, status: "completed" },
      })
      controller.close()
    },
  })
}
