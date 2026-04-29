import { describe, expect, test } from "bun:test"

import { summarizeToolsForDiagnostics } from "~/lib/upstream-diagnostics"

describe("upstream debug diagnostics", () => {
  test("includes local tool names and schema key paths", () => {
    const summary = summarizeToolsForDiagnostics([
      {
        type: "function",
        name: "internal bad tool",
        parameters: {
          properties: {
            privateCustomerId: {
              oneOf: [{ type: "string" }, { type: "number" }],
            },
          },
        },
      },
    ])

    const text = JSON.stringify(summary)

    expect(summary?.count).toBe(1)
    expect(summary?.invalidNames).toEqual(["internal bad tool"])
    expect(summary?.suspiciousSchemas).toEqual([
      {
        keys: ["$.properties.privateCustomerId.oneOf"],
        name: "internal bad tool",
      },
    ])
    expect(text).toContain("internal bad tool")
    expect(text).toContain("privateCustomerId")
    expect(text).toContain("$.properties.privateCustomerId.oneOf")
  })
})
