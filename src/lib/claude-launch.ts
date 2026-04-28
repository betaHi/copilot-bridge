const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

export interface ClaudeLaunchDefaults {
  model: string
}

export interface ClaudeLaunchCommandInput extends ClaudeLaunchDefaults {
  baseUrl: string
}

export const pickClaudeLaunchDefaults = (
  availableModels: Array<string>,
  preferredModel?: string,
): ClaudeLaunchDefaults => {
  const model =
    preferredModel && availableModels.includes(preferredModel) ? preferredModel
    : availableModels.includes("gpt-5.3-codex") ? "gpt-5.3-codex"
    : availableModels[0] ?? "gpt-5.3-codex"

  return { model }
}

export const buildClaudeLaunchCommand = (
  input: ClaudeLaunchCommandInput,
): string => {
  const env = {
    ANTHROPIC_BASE_URL: input.baseUrl,
    ANTHROPIC_AUTH_TOKEN: "dummy",
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  }

  return `${Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ")} && claude --model ${shellQuote(input.model)}`
}