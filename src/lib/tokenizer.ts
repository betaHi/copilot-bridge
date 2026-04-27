import type {
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
  ToolCall,
} from "~/providers/copilot/chat-types"
import type { Model } from "~/providers/copilot/get-models"

const ENCODING_MAP = {
  o200k_base: () => import("gpt-tokenizer/encoding/o200k_base"),
  cl100k_base: () => import("gpt-tokenizer/encoding/cl100k_base"),
  p50k_base: () => import("gpt-tokenizer/encoding/p50k_base"),
  p50k_edit: () => import("gpt-tokenizer/encoding/p50k_edit"),
  r50k_base: () => import("gpt-tokenizer/encoding/r50k_base"),
} as const

type SupportedEncoding = keyof typeof ENCODING_MAP

interface Encoder {
  encode: (text: string) => Array<number>
}

const encodingCache = new Map<string, Encoder>()

const calculateToolCallsTokens = (
  toolCalls: Array<ToolCall>,
  encoder: Encoder,
  constants: ReturnType<typeof getModelConstants>,
): number => {
  let tokens = 0
  for (const toolCall of toolCalls) {
    tokens += constants.funcInit
    tokens += encoder.encode(JSON.stringify(toolCall)).length
  }
  tokens += constants.funcEnd
  return tokens
}

const calculateContentPartsTokens = (
  contentParts: Array<ContentPart>,
  encoder: Encoder,
): number => {
  let tokens = 0
  for (const part of contentParts) {
    if (part.type === "image_url") {
      tokens += encoder.encode(part.image_url.url).length + 85
    } else if (part.text) {
      tokens += encoder.encode(part.text).length
    }
  }
  return tokens
}

const calculateMessageTokens = (
  message: Message,
  encoder: Encoder,
  constants: ReturnType<typeof getModelConstants>,
): number => {
  const tokensPerMessage = 3
  const tokensPerName = 1
  let tokens = tokensPerMessage
  for (const [key, value] of Object.entries(message)) {
    if (typeof value === "string") {
      tokens += encoder.encode(value).length
    }
    if (key === "name") tokens += tokensPerName
    if (key === "tool_calls") {
      tokens += calculateToolCallsTokens(
        value as Array<ToolCall>,
        encoder,
        constants,
      )
    }
    if (key === "content" && Array.isArray(value)) {
      tokens += calculateContentPartsTokens(
        value as Array<ContentPart>,
        encoder,
      )
    }
  }
  return tokens
}

const calculateTokens = (
  messages: Array<Message>,
  encoder: Encoder,
  constants: ReturnType<typeof getModelConstants>,
): number => {
  if (messages.length === 0) return 0
  let numTokens = 0
  for (const message of messages) {
    numTokens += calculateMessageTokens(message, encoder, constants)
  }
  numTokens += 3
  return numTokens
}

const getEncodeChatFunction = async (encoding: string): Promise<Encoder> => {
  if (encodingCache.has(encoding)) {
    const cached = encodingCache.get(encoding)
    if (cached) return cached
  }

  const supported = encoding as SupportedEncoding
  if (!(supported in ENCODING_MAP)) {
    const fallback = (await ENCODING_MAP.o200k_base()) as Encoder
    encodingCache.set(encoding, fallback)
    return fallback
  }

  const mod = (await ENCODING_MAP[supported]()) as Encoder
  encodingCache.set(encoding, mod)
  return mod
}

export const getTokenizerFromModel = (model: Model): string =>
  model.capabilities.tokenizer || "o200k_base"

const getModelConstants = (model: Model) =>
  model.id === "gpt-3.5-turbo" || model.id === "gpt-4"
    ? {
        funcInit: 10,
        propInit: 3,
        propKey: 3,
        enumInit: -3,
        enumItem: 3,
        funcEnd: 12,
      }
    : {
        funcInit: 7,
        propInit: 3,
        propKey: 3,
        enumInit: -3,
        enumItem: 3,
        funcEnd: 12,
      }

const calculateParameterTokens = (
  key: string,
  prop: unknown,
  context: {
    encoder: Encoder
    constants: ReturnType<typeof getModelConstants>
  },
): number => {
  const { encoder, constants } = context
  let tokens = constants.propKey

  if (typeof prop !== "object" || prop === null) return tokens

  const param = prop as {
    type?: string
    description?: string
    enum?: Array<unknown>
    [key: string]: unknown
  }

  const paramName = key
  const paramType = param.type || "string"
  let paramDesc = param.description || ""

  if (param.enum && Array.isArray(param.enum)) {
    tokens += constants.enumInit
    for (const item of param.enum) {
      tokens += constants.enumItem
      tokens += encoder.encode(String(item)).length
    }
  }

  if (paramDesc.endsWith(".")) paramDesc = paramDesc.slice(0, -1)

  const line = `${paramName}:${paramType}:${paramDesc}`
  tokens += encoder.encode(line).length

  const excludedKeys = new Set(["type", "description", "enum"])
  for (const propertyName of Object.keys(param)) {
    if (excludedKeys.has(propertyName)) continue
    const propertyValue = param[propertyName]
    const propertyText =
      typeof propertyValue === "string"
        ? propertyValue
        : JSON.stringify(propertyValue)
    tokens += encoder.encode(`${propertyName}:${propertyText}`).length
  }

  return tokens
}

const calculateParametersTokens = (
  parameters: unknown,
  encoder: Encoder,
  constants: ReturnType<typeof getModelConstants>,
): number => {
  if (!parameters || typeof parameters !== "object") return 0

  const params = parameters as Record<string, unknown>
  let tokens = 0

  for (const [key, value] of Object.entries(params)) {
    if (key === "properties") {
      const properties = value as Record<string, unknown>
      if (Object.keys(properties).length > 0) {
        tokens += constants.propInit
        for (const propKey of Object.keys(properties)) {
          tokens += calculateParameterTokens(propKey, properties[propKey], {
            encoder,
            constants,
          })
        }
      }
    } else {
      const paramText =
        typeof value === "string" ? value : JSON.stringify(value)
      tokens += encoder.encode(`${key}:${paramText}`).length
    }
  }

  return tokens
}

const calculateToolTokens = (
  tool: Tool,
  encoder: Encoder,
  constants: ReturnType<typeof getModelConstants>,
): number => {
  let tokens = constants.funcInit
  const func = tool.function
  const fName = func.name
  let fDesc = func.description || ""
  if (fDesc.endsWith(".")) fDesc = fDesc.slice(0, -1)
  tokens += encoder.encode(`${fName}:${fDesc}`).length
  if (typeof func.parameters === "object" && func.parameters !== null) {
    tokens += calculateParametersTokens(func.parameters, encoder, constants)
  }
  return tokens
}

export const numTokensForTools = (
  tools: Array<Tool>,
  encoder: Encoder,
  constants: ReturnType<typeof getModelConstants>,
): number => {
  let funcTokenCount = 0
  for (const tool of tools) {
    funcTokenCount += calculateToolTokens(tool, encoder, constants)
  }
  funcTokenCount += constants.funcEnd
  return funcTokenCount
}

export const getTokenCount = async (
  payload: ChatCompletionsPayload,
  model: Model,
): Promise<{ input: number; output: number }> => {
  const tokenizer = getTokenizerFromModel(model)
  const encoder = await getEncodeChatFunction(tokenizer)

  const inputMessages = payload.messages.filter((msg) => msg.role !== "assistant")
  const outputMessages = payload.messages.filter((msg) => msg.role === "assistant")

  const constants = getModelConstants(model)
  let inputTokens = calculateTokens(inputMessages, encoder, constants)
  if (payload.tools && payload.tools.length > 0) {
    inputTokens += numTokensForTools(payload.tools, encoder, constants)
  }
  const outputTokens = calculateTokens(outputMessages, encoder, constants)

  return { input: inputTokens, output: outputTokens }
}
