import { describe, expect, test } from "bun:test"

import {
  createAnthropicToolNameMapper,
  getClaudeToolNameMaxLength,
  getToolNameMapperOptionsForModel,
} from "~/bridges/claude/tool-names"

const OPENAI_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const EXTENDED_OPENAI_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const DOTTED_TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/

describe("Claude tool name mapping", () => {
  test("keeps valid names unchanged", () => {
    const mapper = createAnthropicToolNameMapper([
      { name: "lookup_weather", input_schema: { type: "object" } },
    ])

    expect(mapper.toOpenAI("lookup_weather")).toBe("lookup_weather")
    expect(mapper.toAnthropic("lookup_weather")).toBe("lookup_weather")
  })

  test("maps long or invalid Anthropic tool names to unique OpenAI-safe names", () => {
    const longName =
      "mcp__plugin_microsoft-docs_microsoft-learn__microsoft_code_sample_search"
    const dottedName = "mcp.server.tool"
    const collidingName = "mcp_server_tool"
    const mapper = createAnthropicToolNameMapper([
      { name: longName, input_schema: { type: "object" } },
      { name: dottedName, input_schema: { type: "object" } },
      { name: collidingName, input_schema: { type: "object" } },
    ])

    const mappedLongName = mapper.toOpenAI(longName)
    const mappedDottedName = mapper.toOpenAI(dottedName)
    const mappedCollidingName = mapper.toOpenAI(collidingName)

    expect(mappedLongName).not.toBe(longName)
    expect(mappedLongName).toMatch(OPENAI_TOOL_NAME_PATTERN)
    expect(mappedDottedName).toBe("mcp_server_tool")
    expect(mappedCollidingName).not.toBe(mappedDottedName)
    expect(mappedCollidingName).toMatch(OPENAI_TOOL_NAME_PATTERN)

    expect(mapper.toAnthropic(mappedLongName)).toBe(longName)
    expect(mapper.toAnthropic(mappedDottedName)).toBe(dottedName)
    expect(mapper.toAnthropic(mappedCollidingName)).toBe(collidingName)
  })

  test("uses the probed model-specific name profile", () => {
    expect(getClaudeToolNameMaxLength("claude-opus-4.7")).toBe(128)
    expect(getClaudeToolNameMaxLength("claude-opus-4.6-1m")).toBe(128)
    expect(getClaudeToolNameMaxLength("claude-sonnet-4")).toBe(128)
    expect(getClaudeToolNameMaxLength("claude-sonnet-4.6")).toBe(64)
    expect(getClaudeToolNameMaxLength("claude-haiku-4.5")).toBe(64)
    expect(getToolNameMapperOptionsForModel("gemini-3-flash-preview")).toEqual({
      allowDots: true,
      maxNameLength: 128,
    })
    expect(getToolNameMapperOptionsForModel("gpt-5.4")).toEqual({
      allowDots: false,
      maxNameLength: 128,
    })
    expect(getToolNameMapperOptionsForModel("gpt-5-mini")).toEqual({
      allowDots: false,
      maxNameLength: 128,
    })
    expect(getToolNameMapperOptionsForModel("gpt-4o")).toEqual({
      allowDots: true,
      maxNameLength: 128,
    })
  })

  test("keeps long valid tool names for Claude models with 128-char support", () => {
    const longName = "a".repeat(128)
    const mapper = createAnthropicToolNameMapper(
      [{ name: longName, input_schema: { type: "object" } }],
      { maxNameLength: 128 },
    )

    expect(mapper.toOpenAI(longName)).toBe(longName)
    expect(mapper.toOpenAI(longName)).toMatch(EXTENDED_OPENAI_TOOL_NAME_PATTERN)
  })

  test("preserves dotted names only for model profiles that allow dots", () => {
    const dottedName = "mcp.server.tool"
    const dottedMapper = createAnthropicToolNameMapper(
      [{ name: dottedName, input_schema: { type: "object" } }],
      getToolNameMapperOptionsForModel("gemini-2.5-pro"),
    )
    const strictMapper = createAnthropicToolNameMapper(
      [{ name: dottedName, input_schema: { type: "object" } }],
      getToolNameMapperOptionsForModel("gpt-5-mini"),
    )

    expect(dottedMapper.toOpenAI(dottedName)).toBe(dottedName)
    expect(dottedMapper.toOpenAI(dottedName)).toMatch(DOTTED_TOOL_NAME_PATTERN)
    expect(strictMapper.toOpenAI(dottedName)).toBe("mcp_server_tool")
  })
})
