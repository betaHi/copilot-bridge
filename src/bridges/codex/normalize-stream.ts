interface ResponseMetadata {
  created_at?: number
  id?: string
  model?: string
}

interface ResponsesStreamEvent {
  response?: ResponseMetadata
  type?: string
  [key: string]: unknown
}

interface StableResponseMetadata {
  created_at: number
  id: string
  initialized: boolean
  model: string
}

const normalizeEventPayload = (
  rawData: string,
  stableResponse: StableResponseMetadata,
): string => {
  let event: ResponsesStreamEvent
  try {
    event = JSON.parse(rawData) as ResponsesStreamEvent
  } catch {
    return rawData
  }

  if (event.response && typeof event.response === "object") {
    const incoming = event.response
    if (!stableResponse.initialized) {
      if (incoming.id) stableResponse.id = incoming.id
      if (typeof incoming.created_at === "number")
        stableResponse.created_at = incoming.created_at
      if (incoming.model) stableResponse.model = incoming.model
      stableResponse.initialized = true
    }

    event.response = {
      ...incoming,
      ...(stableResponse.id ? { id: stableResponse.id } : {}),
      ...(stableResponse.created_at
        ? { created_at: stableResponse.created_at }
        : {}),
      ...(stableResponse.model ? { model: stableResponse.model } : {}),
    }
  }

  return JSON.stringify(event)
}

const transformSseChunk = (
  chunk: string,
  stableResponse: StableResponseMetadata,
): string => {
  const lines = chunk.split("\n")

  return lines
    .map((line) => {
      if (!line.startsWith("data: ")) {
        return line
      }

      const rawData = line.slice(6)
      if (!rawData || rawData === "[DONE]") {
        return line
      }

      return `data: ${normalizeEventPayload(rawData, stableResponse)}`
    })
    .join("\n")
}

export const normalizeResponsesSseStream = (
  upstreamBody: ReadableStream<Uint8Array>,
) => {
  const stableResponse: StableResponseMetadata = {
    created_at: 0,
    id: "",
    initialized: false,
    model: "",
  }

  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstreamBody.getReader()

      try {
        while (true) {
          const { done, value } = await reader.read()

          if (done) {
            break
          }

          buffer += decoder.decode(value, { stream: true })

          let separatorIndex = buffer.indexOf("\n\n")

          while (separatorIndex !== -1) {
            const rawEvent = buffer.slice(0, separatorIndex)
            buffer = buffer.slice(separatorIndex + 2)

            const transformed = transformSseChunk(rawEvent, stableResponse)
            controller.enqueue(encoder.encode(`${transformed}\n\n`))

            separatorIndex = buffer.indexOf("\n\n")
          }
        }

        if (buffer.length > 0) {
          const transformed = transformSseChunk(buffer, stableResponse)
          controller.enqueue(encoder.encode(transformed))
        }
      } finally {
        reader.releaseLock()
      }

      controller.close()
    },
  })
}
