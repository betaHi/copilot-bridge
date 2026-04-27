# copilot-bridge

Run GitHub Copilot as a local OpenAI Responses– and Anthropic-compatible
endpoint, so [Codex CLI](https://github.com/openai/codex) and
[Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) can
talk to Copilot transparently.

**Supports:** **Codex CLI** and **Claude Code** out of the box.

> [!WARNING]
> This is a reverse-engineered bridge for the GitHub Copilot API. It is not
> supported by GitHub, and may break unexpectedly. Use at your own risk.

> [!WARNING]
> **GitHub Security Notice:**
> Excessive automated or scripted use of Copilot (including rapid or bulk
> requests, such as via automated tools) may trigger GitHub's abuse-detection
> systems. You may receive a warning from GitHub Security, and further
> anomalous activity could result in temporary suspension of your Copilot
> access.
>
> GitHub prohibits use of their servers for excessive automated bulk activity
> or any activity that places undue burden on their infrastructure.
>
> Please review:
>
> - [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github)
> - [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)
>
> Use this bridge responsibly to avoid account restrictions. The
> `--rate-limit <seconds>` flag is provided to help throttle upstream traffic.

## Demo

### Codex CLI

![Codex demo](assets/screenshots/codex_demo.png)

### Claude Code

![Claude demo](assets/screenshots/claude_demo.png)

## Install & run

```sh
# one-time GitHub device login
npx betahi-copilot-bridge@latest auth

# start the bridge on 127.0.0.1:4142
npx betahi-copilot-bridge@latest start
```

`start` flags: `--host`, `--port`, `--show-token`, `--no-codex-setup`,
`--select-model`, `--no-prompt`, `--rate-limit <seconds>`, `--wait`.

After startup the banner prints a **Usage Viewer** link of the form
`https://betahi.github.io/copilot-bridge?endpoint=http://127.0.0.1:4142/usage`,
which renders the Copilot quota snapshot (chat / completions / premium
interactions) read from `GET /usage`.

The bridge exposes both adapter-style endpoints (`/v1/responses`,
`/v1/messages`) and the raw OpenAI-compatible surface
(`/v1/chat/completions`, `/v1/embeddings`, `/v1/models`) so tools like
LiteLLM, Continue, Cline and Aider work out of the box. CORS is enabled
globally for browser-based clients.

`--rate-limit N` enforces a minimum of N seconds between upstream
requests (anti–abuse-detection throttle). Add `--wait` to block instead
of returning HTTP 429 when the window has not elapsed.

## Configure Codex CLI

`start` writes a managed block into **`~/.codex/config.toml`**. You don't edit
this block; the bridge regenerates it on every start.

```toml
# >>> copilot-bridge managed block — auto-generated, do not edit between markers >>>
model_provider = "bridge"

[model_providers.bridge]
name = "Copilot Bridge"
base_url = "http://127.0.0.1:4142/v1"
wire_api = "responses"
prefer_websockets = false
requires_openai_auth = false
# <<< copilot-bridge managed block — edits outside this block are preserved <<<
```

To pin the **default model** for `codex` (without passing `-m` every time),
edit the **top of the same file** — outside the markers. The bridge preserves
these keys across rewrites:

```toml
model = "gpt-5.3-codex"
model_reasoning_effort = "high"
```

That's it — `codex exec '...'` will now route through the bridge to Copilot.

Use `--no-codex-setup` to skip the managed-block writer entirely (e.g. if you
manage `~/.codex/config.toml` yourself).

### Codex warning: "Model metadata ... not found"

This is a Codex client-side metadata warning, not a bridge routing failure.
Requests can still complete through the bridge.

For `claude-opus-4.6-1m`, upstream still enforces a 1,000,000-token prompt
limit (about 900k succeeds; around 1,000,046 is rejected as too long).

## Configure Claude Code

Bridge endpoints: `POST /v1/messages`, `POST /v1/messages/count_tokens`.

Point Claude Code at the bridge through **`~/.claude/settings.json`**:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4142",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "claude-opus-4.7",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4.6",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4.5",
    "COPILOT_REASONING_EFFORT": "medium"
  },
  "model": "claude-opus-4.7"
}
```

`COPILOT_REASONING_EFFORT` is also read from the project-local
`.claude/settings.json` and `.claude/settings.local.json` and applied to the
upstream call when the model supports reasoning.

## Environment overrides

| Variable                   | Purpose                                              |
| -------------------------- | ---------------------------------------------------- |
| `COPILOT_TOKEN`            | Pre-issued Copilot bearer token (skip device login). |
| `COPILOT_ACCOUNT_TYPE`     | `individual` \| `business` \| `enterprise`.          |
| `COPILOT_BASE_URL`         | Override the upstream Copilot base URL.              |
| `COPILOT_VSCODE_VERSION`   | Override the VS Code version sent upstream.          |
| `COPILOT_REASONING_EFFORT` | Default reasoning effort when the model supports it. |

## Supported models

The bridge resolves aliases and clamps reasoning effort to what each model
accepts upstream.

### GPT-5 family — native Responses passthrough

| Model           | Reasoning efforts                        |
| --------------- | ---------------------------------------- |
| `gpt-5.5`       | `none`, `low`, `medium`, `high`, `xhigh` |
| `gpt-5.4`       | `low`, `medium`, `high`, `xhigh`         |
| `gpt-5.4-mini`  | `none`, `low`, `medium`                  |
| `gpt-5.3-codex` | `low`, `medium`, `high`, `xhigh`         |
| `gpt-5.2`       | `low`, `medium`, `high`, `xhigh`         |
| `gpt-5.2-codex` | `low`, `medium`, `high`, `xhigh`         |
| `gpt-5-mini`    | `low`, `medium`, `high`                  |

### Claude family — translated to chat completions

| Model                | Reasoning efforts                       | Notes                                  |
| -------------------- | --------------------------------------- | -------------------------------------- |
| `claude-opus-4.7`    | `low`, `medium`, `high`, `xhigh`, `max` | Effort sent as `output_config.effort`. |
| `claude-opus-4.6`    | `low`, `medium`, `high`                 |                                        |
| `claude-opus-4.6-1m` | `low`, `medium`, `high`                 | 1M-token context window.               |
| `claude-sonnet-4.6`  | `low`, `medium`, `high`                 |                                        |
| `claude-opus-4.5`    | —                                       | Reasoning not accepted upstream.       |
| `claude-sonnet-4.5`  | —                                       | Reasoning not accepted upstream.       |
| `claude-sonnet-4`    | —                                       | Reasoning not accepted upstream.       |
| `claude-haiku-4.5`   | —                                       | Reasoning not accepted upstream.       |

### Gemini family — translated to chat completions

| Model                    | Aliases          |
| ------------------------ | ---------------- |
| `gemini-3.1-pro-preview` | `gemini-3.1-pro` |
| `gemini-3-flash-preview` | `gemini-3-flash` |
| `gemini-2.5-pro`         | —                |

### Legacy

`gpt-4.1`, `gpt-4o` — chat-only upstream, no reasoning parameter.

### Reasoning effort

If an unsupported value is sent for a reasoning-capable model, the bridge
falls back to the model's default (`medium` for the GPT-5 / Claude Opus 4.7
families) instead of forwarding an invalid request upstream. Set the default
globally via `COPILOT_REASONING_EFFORT` (env, or `env` in
`~/.claude/settings.json`); per-request `reasoning_effort` (or Anthropic
`thinking.budget_tokens`) takes precedence.

## Development

Requires [Bun](https://bun.sh) ≥ 1.2.

```sh
bun install
bun run dev          # watch mode against src/main.ts
bun test             # run all tests (bun test runner)
bun run typecheck    # tsc --noEmit
bun run build        # produce dist/main.js with tsdown

# run directly from source (no build, no npx); --port specifies the port
bun run ./src/main.ts start --host 127.0.0.1 --port 4141 --no-prompt
```

Adding another CLI: drop a new translator under `src/bridges/<client>/`,
reuse `src/services/copilot/` for upstream calls, register routes in
`src/server.ts`, and add tests under `tests/`.
