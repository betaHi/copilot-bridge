import { defineCommand } from "citty"
import consola from "consola"

import { setupBridgeAuth } from "~/lib/auth"
import { readBridgeConfig } from "~/lib/config"

export const auth = defineCommand({
  meta: {
    name: "auth",
    description: "Run GitHub device auth and cache credentials for copilot-bridge.",
  },
  args: {
    host: {
      type: "string",
      default: "127.0.0.1",
      description: "Host used for config initialization.",
    },
    port: {
      type: "string",
      default: "4142",
      description: "Port used for config initialization.",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Print GitHub and Copilot tokens during auth.",
    },
  },
  async run({ args }) {
    const config = readBridgeConfig({
      host: String(args.host),
      port: Number(args.port),
    })

    config.copilotToken = undefined

    await setupBridgeAuth(config, {
      force: true,
      showToken: args["show-token"],
    })

    consola.success("copilot-bridge auth completed")
  },
})