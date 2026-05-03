export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<ChatChunkChoice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

interface ChatChunkChoice {
  index: number
  delta: ChatChunkDelta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

interface ChatChunkDelta {
  content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  reasoning_content?: string | null
  reasoning_opaque?: string | null
  reasoning_text?: string | null
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

export interface ChatCompletionResponse {
  id: string
  object?: "chat.completion"
  created: number
  model: string
  choices: Array<ChatNonStreamingChoice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

interface ChatNonStreamingChoice {
  index: number
  message: ChatResponseMessage
  logprobs?: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
}

interface ChatResponseMessage {
  role: "assistant"
  content: string | null
  reasoning_content?: string | null
  reasoning_opaque?: string | null
  reasoning_text?: string | null
  tool_calls?: Array<ToolCall>
}

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  thinking?: {
    type: "enabled" | "adaptive"
    budget_tokens?: number
  } | null
  output_config?: {
    effort?: "low" | "medium" | "high" | "xhigh" | "max"
  } | null
  reasoning_effort?: "none" | "low" | "medium" | "high" | "max" | "xhigh" | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null
  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null
  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}
