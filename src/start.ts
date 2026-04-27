import { defineCommand } from "citty"
import consola from "consola"

import { setupBridgeAuth } from "~/lib/auth"
import {
  applyClaudeConfig,
  parsePortFromBaseUrl,
  readClaudeBaseUrl,
} from "~/lib/claude-settings"
import {
  applyCodexConfig,
  readCodexUserConfigFromDisk,
} from "~/lib/codex-config"
import { readBridgeConfig } from "~/lib/config"
import {
  CLAUDE_CONFIG_PATH,
  CODEX_DEFAULTS,
  DEFAULT_HOST,
  DEFAULT_PORT,
} from "~/lib/defaults"
import {
  getModelCapability,
  MODEL_CAPABILITIES,
} from "~/lib/model-capabilities"
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
      description: `Host to bind (default: ${DEFAULT_HOST}).`,
    },
    port: {
      type: "string",
      description: `Port to listen on (default: ${DEFAULT_PORT}).`,
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
      description:
        "Force the model picker even when ~/.codex/config.toml already has a model.",
    },
    "no-prompt": {
      type: "boolean",
      default: false,
      description:
        "Never prompt; use the existing model from ~/.codex/config.toml as-is.",
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
    // Port resolution priority (high → low):
    //   1. --port CLI flag
    //   2. $PORT environment variable
    //   3. ANTHROPIC_BASE_URL port in ~/.claude/settings.json
    //   4. DEFAULT_PORT
    // Once resolved, the chosen port is written back to BOTH claude
    // settings and codex config so the three sources stay in lockstep.
    const claudeConfigPath = CLAUDE_CONFIG_PATH
    const claudePort = parsePortFromBaseUrl(
      await readClaudeBaseUrl(claudeConfigPath),
    )
    const envPortRaw = process.env.PORT
    const envPort =
      envPortRaw && Number.isFinite(Number(envPortRaw)) ?
        Number(envPortRaw)
      : undefined

    const host = args.host ? String(args.host) : DEFAULT_HOST
    const port =
      args.port ? Number(args.port)
      : envPort !== undefined ? envPort
      : claudePort !== undefined ? claudePort
      : DEFAULT_PORT

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
    const codexConfigPath = CODEX_DEFAULTS.configPath

    // Sync Claude Code's settings.json and Codex's config.toml *before* any
    // potentially blocking interactive prompt. This guarantees `claude` and
    // `codex` work the moment the server is listening — even if the user
    // never answers the model picker below.
    if (!args["no-claude-setup"]) {
      try {
        const claudeResult = await applyClaudeConfig({
          baseUrl,
          configPath: claudeConfigPath,
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
          `Could not update claude settings (${claudeConfigPath}):`,
          error,
        )
      }
    }

    // Read the user's current codex model so the picker can default to it,
    // and so we can stamp the managed block immediately even if the picker
    // is skipped or interrupted.
    const codexUserConfig = await readCodexUserConfigFromDisk(codexConfigPath)
    let chosenModel: string | undefined = codexUserConfig.model
    let chosenEffort: string | undefined =
      codexUserConfig.modelReasoningEffort

    if (!args["no-codex-setup"]) {
      try {
        const result = await applyCodexConfig({
          baseUrl: `${baseUrl}/v1`,
          configPath: codexConfigPath,
          settings: CODEX_DEFAULTS,
          model: chosenModel,
          modelReasoningEffort: chosenEffort,
        })
        if (result.changed) {
          consola.success(
            `codex config ${result.created ? "created" : "updated"}: ${result.configPath}`,
          )
          if (CODEX_DEFAULTS.setAsDefault) {
            consola.info(
              `codex now defaults to provider "${CODEX_DEFAULTS.providerId}". Run \`codex exec "..."\` directly.`,
            )
          } else {
            consola.info(
              `provider "${CODEX_DEFAULTS.providerId}" registered. Use \`codex -c model_provider="${CODEX_DEFAULTS.providerId}" ...\``,
            )
          }
        } else {
          consola.info(`codex config already up to date: ${result.configPath}`)
        }
      } catch (error) {
        consola.warn(
          `Could not update codex config (${codexConfigPath}):`,
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

    consola.box(
      [
        `🌐 Usage viewer`,
        ``,
        `  https://betahi.github.io/copilot-bridge?endpoint=${baseUrl}/usage`,
      ].join("\n"),
    )

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
        `Select a model for codex (writes to ${codexConfigPath})`,
        {
          type: "select",
          options: finalPickable,
          initial: defaultId,
        },
      )) as string
      if (selected && selected !== chosenModel) {
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
        // Re-stamp codex config with the user's freshly picked model.
        if (!args["no-codex-setup"]) {
          try {
            const result = await applyCodexConfig({
              baseUrl: `${baseUrl}/v1`,
              configPath: codexConfigPath,
              settings: CODEX_DEFAULTS,
              model: chosenModel,
              modelReasoningEffort: chosenEffort,
            })
            if (result.changed) {
              consola.success(`codex config updated: ${result.configPath}`)
            }
          } catch (error) {
            consola.warn(
              `Could not update codex config (${codexConfigPath}):`,
              error,
            )
          }
        }
      }
    }

    await new Promise<void>((resolve, reject) => {
      server.on("close", resolve)
      server.on("error", reject)
    })
  },
})
