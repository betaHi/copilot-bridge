const OPENAI_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const TOOL_SCHEMA_SUSPECT_KEYS = new Set([
  "$defs",
  "allOf",
  "definitions",
  "dependentRequired",
  "dependentSchemas",
  "else",
  "if",
  "not",
  "oneOf",
  "patternProperties",
  "then",
])
const MAX_DIAGNOSTIC_ITEMS = 8

export type ToolDiagnostics = {
  count: number
  invalidNames?: Array<string>
  suspiciousSchemas?: Array<{
    keys: Array<string>
    name: string
  }>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const getToolName = (tool: unknown): string => {
  if (!isRecord(tool)) {
    return ""
  }

  const functionValue = tool.function
  if (isRecord(functionValue) && typeof functionValue.name === "string") {
    return functionValue.name
  }

  return typeof tool.name === "string" ? tool.name : ""
}

const getToolParameters = (tool: unknown): unknown => {
  if (!isRecord(tool)) {
    return undefined
  }

  const functionValue = tool.function
  if (isRecord(functionValue) && "parameters" in functionValue) {
    return functionValue.parameters
  }

  return tool.parameters
}

const collectSuspiciousSchemaKeys = (
  value: unknown,
  path = "$",
  keys: Array<string> = [],
): Array<string> => {
  if (keys.length >= MAX_DIAGNOSTIC_ITEMS) {
    return keys
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectSuspiciousSchemaKeys(item, `${path}[${index}]`, keys)
      if (keys.length >= MAX_DIAGNOSTIC_ITEMS) {
        break
      }
    }
    return keys
  }

  if (!isRecord(value)) {
    return keys
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const nextPath = `${path}.${key}`
    if (TOOL_SCHEMA_SUSPECT_KEYS.has(key)) {
      if (!keys.includes(nextPath)) {
        keys.push(nextPath)
      }
      if (keys.length >= MAX_DIAGNOSTIC_ITEMS) {
        break
      }
    }
    collectSuspiciousSchemaKeys(nestedValue, nextPath, keys)
    if (keys.length >= MAX_DIAGNOSTIC_ITEMS) {
      break
    }
  }

  return keys
}

export const summarizeToolsForDiagnostics = (
  tools: unknown,
): ToolDiagnostics | undefined => {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined
  }

  const invalidNames = tools
    .map((tool) => getToolName(tool))
    .filter((name) => !OPENAI_TOOL_NAME_PATTERN.test(name))
    .slice(0, MAX_DIAGNOSTIC_ITEMS)

  const suspiciousSchemas = tools.flatMap((tool) => {
    const name = getToolName(tool) || "<missing>"
    const keys = collectSuspiciousSchemaKeys(getToolParameters(tool))
    return keys.length > 0 ?
        [
          {
            keys,
            name,
          },
        ]
      : []
  }).slice(0, MAX_DIAGNOSTIC_ITEMS)

  return {
    count: tools.length,
    ...(invalidNames.length > 0 ? { invalidNames } : {}),
    ...(suspiciousSchemas.length > 0 ? { suspiciousSchemas } : {}),
  }
}
