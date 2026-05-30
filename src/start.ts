import { defineCommand } from "citty"
import consola from "consola"

import { setupBridgeAuth } from "~/lib/auth"
import { disableAutoMode, enableAutoMode } from "~/lib/auto-session"
import {
  applyClaudeConfig,
  getClaudeSettings,
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
  resolveModelId,
} from "~/lib/model-capabilities"
import { runtimeState } from "~/lib/state"
import { BRIDGE_VERSION } from "~/lib/version"
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

const getPublicModelId = (id: string): string =>
  id === "claude-opus-4.7-1m-internal" ? "claude-opus-4.7-1m" : id

const unique = (ids: Array<string>): Array<string> => [...new Set(ids)]

const AUTO_MODEL_PRIORITY = [
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "gpt-5-mini",
  "gpt-4.1",
  "gpt-4o",
  "claude-haiku-4.5",
]

const modelComparableId = (id: string): string =>
  getPublicModelId(resolveModelId(id))

const isModelInList = (model: string, models: Array<string>): boolean =>
  models.includes(modelComparableId(model))

const pickPreferredModel = (models: Array<string>): string | undefined =>
  AUTO_MODEL_PRIORITY.find((id) => models.includes(id)) ?? models[0]

const clearUnsupportedReasoningEffort = (
  model: string | undefined,
  effort: string | undefined,
): string | undefined => {
  if (!model || !effort) return effort
  const supported = getModelCapability(model)?.reasoning?.supported
  return supported && !supported.includes(effort as never) ? undefined : effort
}

const CLAUDE_MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
] as const

const normalizeConfiguredModelId = (model: string): string =>
  model.trim().toLowerCase().replace(/[._]/g, "-")

const getRetiredModelWarning = (
  model: string | undefined,
  client: "claude" | "codex",
): string | undefined => {
  if (!model) return undefined

  switch (normalizeConfiguredModelId(model)) {
    case "claude-sonnet-4": {
      return 'use "claude-sonnet-4.6" instead'
    }
    case "opus-4-7-high":
    case "claude-opus-4-7-high": {
      return client === "claude" ?
          'use "claude-opus-4.7" with MODEL_REASONING_EFFORT=high'
        : 'use "claude-opus-4.7" with model_reasoning_effort = "high"'
    }
    case "opus-4-7-xhigh":
    case "claude-opus-4-7-xhigh": {
      return client === "claude" ?
          'use "claude-opus-4.7" with MODEL_REASONING_EFFORT=xhigh'
        : 'use "claude-opus-4.7" with model_reasoning_effort = "xhigh"'
    }
    default: {
      return undefined
    }
  }
}

const warnRetiredModelConfig = (
  label: string,
  model: string | undefined,
  client: "claude" | "codex",
) => {
  const warning = getRetiredModelWarning(model, client)
  if (!warning || !model) return
  consola.warn(
    `${label} model "${model}" is retired and may fail upstream; ${warning}.`,
  )
}

const warnRetiredClaudeSettings = async () => {
  const settings = await getClaudeSettings()
  warnRetiredModelConfig("Claude settings model", settings.model, "claude")
  for (const key of CLAUDE_MODEL_ENV_KEYS) {
    warnRetiredModelConfig(
      `Claude settings env.${key}`,
      settings.env[key],
      "claude",
    )
  }
}

export const resolveAutoCodexModel = (input: {
  currentModel: string | undefined
  currentEffort: string | undefined
  requestedModel: string | undefined
  pickableModels: Array<string>
  prompt: boolean
}): { model: string | undefined; effort: string | undefined; changed: boolean } => {
  const { currentModel, currentEffort, pickableModels, prompt, requestedModel } = input

  if (requestedModel) {
    return { model: currentModel, effort: currentEffort, changed: false }
  }

  if (currentModel && isModelInList(currentModel, pickableModels)) {
    return { model: currentModel, effort: currentEffort, changed: false }
  }

  if (!currentModel && prompt) {
    return { model: currentModel, effort: currentEffort, changed: false }
  }

  const replacement = pickPreferredModel(pickableModels)
  if (!replacement) {
    return { model: currentModel, effort: currentEffort, changed: false }
  }

  return {
    model: replacement,
    effort: clearUnsupportedReasoningEffort(replacement, currentEffort),
    changed: replacement !== currentModel,
  }
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

const getCodexModelContextWindow = (
  model: string | undefined,
): number | undefined => {
  if (!model) return undefined

  const resolvedModel = resolveModelId(model)
  const match = runtimeState.models?.data.find(
    (candidate) =>
      candidate.id === resolvedModel
      || candidate.id === model
      || getPublicModelId(candidate.id) === model
      || getPublicModelId(candidate.id) === resolvedModel,
  )
  const contextWindow =
    match?.capabilities?.limits?.max_context_window_tokens

  return typeof contextWindow === "number" && contextWindow > 0 ?
      Math.trunc(contextWindow)
    : undefined
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
    debug: {
      type: "boolean",
      default: false,
      description: "Enable upstream request diagnostics in console logs.",
    },
    "codex-setup": {
      type: "boolean",
      default: true,
      description: "Skip writing the bridge provider into ~/.codex/config.toml.",
    },
    "claude-setup": {
      type: "boolean",
      default: true,
      description:
        "Skip writing ANTHROPIC_BASE_URL into ~/.claude/settings.json.",
    },
    model: {
      type: "string",
      description:
        "Override the request model for this bridge process only.",
    },
    prompt: {
      type: "boolean",
      default: true,
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
    auto: {
      type: "boolean",
      default: false,
      description:
        "Acquire a Copilot auto-mode session token and attach it to every upstream request (bypasses the router intent step; only auto-mode models are reachable).",
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
    runtimeState.debug = Boolean(args.debug)
    if (!args.auto) {
      disableAutoMode()
    }

    if (runtimeState.debug) {
      consola.info("Debug mode enabled; upstream errors include request summaries")
    }

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

    const authSession = await setupBridgeAuth(config, {
      showToken: args["show-token"],
    })

    const server = startServer(config)

    consola.info(`copilot-bridge version: ${BRIDGE_VERSION}`)
    if (authSession.githubLogin) {
      consola.info(`GitHub user: ${authSession.githubLogin}`)
    } else if (authSession.source === "copilot-token") {
      consola.info("GitHub user: unavailable (using COPILOT_TOKEN)")
    } else {
      consola.warn("GitHub user: unavailable")
    }

    consola.success(
      `copilot-bridge listening on http://${config.host}:${config.port}`,
    )
    consola.info(`copilot base url: ${config.copilotBaseUrl}`)

    const baseUrl = `http://${config.host}:${config.port}`
    const codexConfigPath = CODEX_DEFAULTS.configPath
    const requestedModel =
      args.model !== undefined ? String(args.model) : undefined
    if (requestedModel) {
      runtimeState.modelOverride = requestedModel
      consola.info(`Runtime model override: ${requestedModel}`)
    } else {
      delete runtimeState.modelOverride
    }

    // Sync Claude Code's settings.json before any potentially blocking prompt.
    // Codex config is stamped after model discovery below, so --auto can avoid
    // preserving a model that is unavailable to the auto-mode session.
    if (args["claude-setup"]) {
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
    warnRetiredModelConfig("Codex config", chosenModel, "codex")
    await warnRetiredClaudeSettings()

    if (chosenModel && !chosenEffort) {
      const capability = getModelCapability(chosenModel)
      if (capability && !capability.reasoning) {
        consola.info(
          `codex model_reasoning_effort not set; ${chosenModel} does not accept reasoning effort`,
        )
      } else if (capability?.reasoning) {
        consola.info(
          `codex model_reasoning_effort not set; leaving reasoning effort unset for ${chosenModel}`,
        )
      } else {
        consola.info(
          `codex model_reasoning_effort not set; leaving reasoning effort unset for ${chosenModel}`,
        )
      }
    }

    const writeCodexConfig = async (mode: "initial" | "updated") => {
      if (!args["codex-setup"]) return
      try {
        const result = await applyCodexConfig({
          baseUrl: `${baseUrl}/v1`,
          configPath: codexConfigPath,
          settings: CODEX_DEFAULTS,
          model: chosenModel,
          modelReasoningEffort: chosenEffort,
          modelContextWindow: getCodexModelContextWindow(chosenModel),
        })
        if (result.changed) {
          const action =
            mode === "updated" ? "updated"
            : result.created ? "created"
            : "updated"
          consola.success(`codex config ${action}: ${result.configPath}`)
          if (mode === "initial") {
            if (CODEX_DEFAULTS.setAsDefault) {
              consola.info(
                `codex now defaults to provider "${CODEX_DEFAULTS.providerId}". Run \`codex exec "..."\` directly.`,
              )
            } else {
              consola.info(
                `provider "${CODEX_DEFAULTS.providerId}" registered. Use \`codex -c model_provider="${CODEX_DEFAULTS.providerId}" ...\``,
              )
            }
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

    const isAutoMode = Boolean(args.auto)
    let models: Array<string>
    if (args.auto) {
      const session = await enableAutoMode(config)
      models = session.available_models ?? []
      consola.info(
        "Auto mode enabled; session token is attached only to /chat/completions and /responses upstream requests.",
      )
    } else {
      models = await fetchAvailableModels(config)
    }
    const supportedIds = new Set(
      MODEL_CAPABILITIES.flatMap((m) => [m.id, ...(m.aliases ?? [])]),
    )
    const fallbackModelIds = unique(
      MODEL_CAPABILITIES.map((m) => getPublicModelId(m.id)),
    )
    const pickable =
      models.length > 0 ?
        unique(
          models
            .filter((id) => supportedIds.has(id))
            .map((id) => getPublicModelId(id)),
        )
      : isAutoMode ? []
      : fallbackModelIds
    const finalPickable =
      pickable.length > 0 ? pickable
      : isAutoMode ? []
      : fallbackModelIds
    if (models.length > 0) {
      consola.info(
        `${isAutoMode ? "Auto available models" : "Available models"}:\n${models
          .map((id) => {
            const publicId = getPublicModelId(id)
            return `- ${publicId}${supportedIds.has(id) ? " (bridge-supported)" : ""}`
          })
          .join("\n")}`,
      )
    } else {
      consola.warn(
        isAutoMode ?
          "Auto mode did not return an available model list"
        : "Could not fetch model list from upstream Copilot API",
      )
    }

    if (isAutoMode && finalPickable.length === 0 && !requestedModel) {
      consola.error(
        "Auto mode did not return any bridge-supported models. Retry later or pass --model with an auto-available model.",
      )
      process.exit(1)
    }

    if (isAutoMode) {
      if (requestedModel && finalPickable.length > 0 && !isModelInList(requestedModel, finalPickable)) {
        consola.warn(
          `Runtime model override "${requestedModel}" is not in the auto-mode available model list; upstream may reject it.`,
        )
      }

      const autoSelection = resolveAutoCodexModel({
        currentEffort: chosenEffort,
        currentModel: chosenModel,
        pickableModels: finalPickable,
        prompt: Boolean(args.prompt),
        requestedModel,
      })
      if (autoSelection.changed) {
        consola.warn(
          chosenModel ?
            `Auto mode: codex model "${chosenModel}" is not available to Auto; using "${autoSelection.model}".`
          : `Auto mode: using "${autoSelection.model}" as the Codex default model.`,
        )
        chosenModel = autoSelection.model
        chosenEffort = autoSelection.effort
      }
    }

    await writeCodexConfig("initial")

    consola.box(
      [
        `🌐 Usage viewer`,
        ``,
        `  https://betahi.github.io/copilot-bridge?endpoint=${baseUrl}/usage`,
      ].join("\n"),
    )

    const shouldPrompt =
      args.prompt
      && finalPickable.length > 0
      && !chosenModel
      && !requestedModel

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
        if (args["codex-setup"]) {
          try {
            await writeCodexConfig("updated")
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
