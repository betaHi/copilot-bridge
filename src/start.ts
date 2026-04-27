import { defineCommand } from "citty"
import consola from "consola"

import { setupBridgeAuth } from "~/lib/auth"
import { applyClaudeConfig } from "~/lib/claude-settings"
import {
  applyCodexConfig,
  readCodexUserConfigFromDisk,
} from "~/lib/codex-config"
import { readBridgeConfig } from "~/lib/config"
import {
  getModelCapability,
  MODEL_CAPABILITIES,
} from "~/lib/model-capabilities"
import { ensureSettingsFile } from "~/lib/settings"
import { runtimeState } from "~/lib/state"
import {
  fetchCopilot,
  getCopilotProviderContext,
} from "~/providers/copilot/client"
import { startServer } from "~/server"

interface CopilotModel {
  id: string
}

interface CopilotModelsResponse {
  data?: Array<CopilotModel>
}

const fetchAvailableModels = async (
  config: ReturnType<typeof readBridgeConfig>,
): Promise<Array<string>> => {
  try {
    const provider = getCopilotProviderContext(config)
    const response = await fetchCopilot(provider, "/models", {
      method: "GET",
      headers: { accept: "application/json" },
    })
    if (!response.ok) return []
    const payload = (await response.json()) as CopilotModelsResponse
    return (payload.data ?? []).map((m) => m.id).filter(Boolean)
  } catch {
    return []
  }
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the copilot-bridge HTTP server.",
  },
  args: {
    host: {
      type: "string",
      description: "Host to bind (overrides settings.json).",
    },
    port: {
      type: "string",
      description: "Port to listen on (overrides settings.json).",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Print GitHub and Copilot tokens during startup.",
    },
    "no-codex-setup": {
      type: "boolean",
      default: false,
      description: "Skip writing the bridge provider into ~/.codex/config.toml.",
    },
    "no-claude-setup": {
      type: "boolean",
      default: false,
      description:
        "Skip writing ANTHROPIC_BASE_URL into ~/.claude/settings.json.",
    },
    "select-model": {
      type: "boolean",
      default: false,
      description: "Force the model picker even when codex.model is set.",
    },
    "no-prompt": {
      type: "boolean",
      default: false,
      description: "Never prompt; use codex.model from settings.json as-is.",
    },
    "rate-limit": {
      type: "string",
      description:
        "Minimum seconds between upstream requests (anti-abuse throttle).",
    },
    wait: {
      type: "boolean",
      default: false,
      description:
        "When --rate-limit is set, wait instead of returning HTTP 429.",
    },
  },
  async run({ args }) {
    const settings = await ensureSettingsFile()

    const host = args.host ? String(args.host) : settings.host
    const port = args.port ? Number(args.port) : settings.port

    const config = readBridgeConfig({ host, port })

    const rateLimitRaw = args["rate-limit"]
    if (rateLimitRaw !== undefined) {
      const parsed = Number.parseInt(String(rateLimitRaw), 10)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        consola.error(`Invalid --rate-limit value: ${rateLimitRaw}`)
        process.exit(1)
      }
      runtimeState.rateLimitSeconds = parsed
      runtimeState.rateLimitWait = Boolean(args.wait)
      consola.info(
        `Rate limit: ${parsed}s between requests (${runtimeState.rateLimitWait ? "wait" : "reject"} on overflow)`,
      )
    }

    await setupBridgeAuth(config, {
      showToken: args["show-token"],
    })

    const server = startServer(config)

    consola.success(
      `copilot-bridge listening on http://${config.host}:${config.port}`,
    )
    consola.info(`copilot base url: ${config.copilotBaseUrl}`)

    const baseUrl = `http://${config.host}:${config.port}`

    // Sync Claude Code's settings.json *first*, before any potentially
    // blocking interactive prompt. This guarantees `claude` works the moment
    // the server is listening — even if the user never answers the model
    // picker below.
    if (settings.claude.enabled && !args["no-claude-setup"]) {
      try {
        const claudeResult = await applyClaudeConfig({
          baseUrl,
          configPath: settings.claude.configPath,
        })
        if (claudeResult.changed) {
          consola.success(
            `claude settings ${claudeResult.created ? "created" : "updated"}: ${claudeResult.configPath}`,
          )
          if (
            claudeResult.previousBaseUrl
            && claudeResult.previousBaseUrl !== baseUrl
          ) {
            consola.info(
              `ANTHROPIC_BASE_URL: ${claudeResult.previousBaseUrl} → ${baseUrl}`,
            )
          }
        } else {
          consola.info(
            `claude settings already up to date: ${claudeResult.configPath}`,
          )
        }
      } catch (error) {
        consola.warn(
          `Could not update claude settings (${settings.claude.configPath}):`,
          error,
        )
      }
    }

    const models = await fetchAvailableModels(config)
    const supportedIds = new Set(MODEL_CAPABILITIES.map((m) => m.id))
    const pickable =
      models.length > 0 ?
        models.filter((id) => supportedIds.has(id))
      : MODEL_CAPABILITIES.map((m) => m.id)
    const finalPickable =
      pickable.length > 0 ? pickable : MODEL_CAPABILITIES.map((m) => m.id)
    if (models.length > 0) {
      consola.info(
        `Available models:\n${models
          .map((id) => `- ${id}${supportedIds.has(id) ? " (bridge-supported)" : ""}`)
          .join("\n")}`,
      )
    } else {
      consola.warn("Could not fetch model list from upstream Copilot API")
    }

    const codexUserConfig = await readCodexUserConfigFromDisk(
      settings.codex.configPath,
    )
    let chosenModel: string | undefined = codexUserConfig.model
    let chosenEffort: string | undefined =
      codexUserConfig.modelReasoningEffort

    const shouldPrompt =
      !args["no-prompt"]
      && finalPickable.length > 0
      && (args["select-model"] || !chosenModel)

    if (shouldPrompt) {
      const defaultId =
        chosenModel && finalPickable.includes(chosenModel) ? chosenModel
        : finalPickable.includes("gpt-5.3-codex") ? "gpt-5.3-codex"
        : finalPickable[0]
      const selected = (await consola.prompt(
        `Select a model for codex (writes to ${settings.codex.configPath})`,
        {
          type: "select",
          options: finalPickable,
          initial: defaultId,
        },
      )) as string
      if (selected) {
        chosenModel = selected
        // If the previously stored effort is no longer supported by the
        // newly chosen model, drop it so codex falls back to its default.
        const cap = getModelCapability(selected)
        const supported = cap?.reasoning?.supported
        if (
          chosenEffort
          && supported
          && !supported.includes(chosenEffort as never)
        ) {
          chosenEffort = undefined
        }
      }
    }

    consola.box(
      [
        `🌐 Usage viewer`,
        ``,
        `  https://betahi.github.io/copilot-bridge?endpoint=${baseUrl}/usage`,
      ].join("\n"),
    )

    if (settings.codex.enabled && !args["no-codex-setup"]) {
      const codexBaseUrl = `${baseUrl}/v1`
      const result = await applyCodexConfig({
        baseUrl: codexBaseUrl,
        configPath: settings.codex.configPath,
        settings: settings.codex,
        model: chosenModel,
        modelReasoningEffort: chosenEffort,
      })
      if (result.changed) {
        consola.success(
          `codex config ${result.created ? "created" : "updated"}: ${result.configPath}`,
        )
        if (settings.codex.setAsDefault) {
          consola.info(
            `codex now defaults to provider "${settings.codex.providerId}". Run \`codex exec "..."\` directly.`,
          )
        } else {
          consola.info(
            `provider "${settings.codex.providerId}" registered. Use \`codex -c model_provider="${settings.codex.providerId}" ...\``,
          )
        }
      } else {
        consola.info(`codex config already up to date: ${result.configPath}`)
      }
    }

    await new Promise<void>((resolve, reject) => {
      server.on("close", resolve)
      server.on("error", reject)
    })
  },
})
