import { z } from "zod"

const bridgeModeSchema = z.enum(["codex", "multi-client"])
const accountTypeSchema = z.enum(["individual", "business", "enterprise"])

const inputSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
})

export interface BridgeConfig {
  host: string
  port: number
  bridgeMode: "codex" | "multi-client"
  accountType: "individual" | "business" | "enterprise"
  copilotBaseUrl: string
  copilotToken: string | undefined
  vsCodeVersion: string
}

export interface BridgeEnv {
  Variables: {
    config: BridgeConfig
  }
}

export const readBridgeConfig = (input: {
  host: string
  port: number
}): BridgeConfig => {
  const parsedInput = inputSchema.parse(input)
  const accountType = accountTypeSchema.parse(
    process.env.COPILOT_ACCOUNT_TYPE ?? "individual",
  )
  const copilotBaseUrl =
    process.env.COPILOT_BASE_URL
    ?? (
      accountType === "individual" ?
        "https://api.githubcopilot.com"
      : `https://api.${accountType}.githubcopilot.com`
    )

  return {
    host: parsedInput.host,
    port: parsedInput.port,
    bridgeMode: bridgeModeSchema.parse(
      process.env.COPILOT_BRIDGE_MODE ?? "multi-client",
    ),
    accountType,
    copilotBaseUrl,
    copilotToken: process.env.COPILOT_TOKEN,
    vsCodeVersion: process.env.COPILOT_VSCODE_VERSION ?? "1.99.3",
  }
}
