# copilot-bridge

Run GitHub Copilot as a local OpenAI Responses–compatible endpoint, so clients
like the [Codex CLI](https://github.com/openai/codex) (and soon Claude Code)
can talk to Copilot transparently.

## Quick start

Run directly with `npx`, no install needed:

```sh
# one-time GitHub device login (cached for later runs)
npx betahi-copilot-bridge@latest auth

# start the bridge on 127.0.0.1:4242
npx betahi-copilot-bridge@latest start
```

Or install globally:

```sh
npm i -g betahi-copilot-bridge
copilot-bridge start
```

## Using with Codex CLI

`start` writes a managed block into `~/.codex/config.toml` that points the
`bridge` provider at `http://127.0.0.1:4242/v1` with `wire_api = "responses"`,
so plain `codex exec` works without flags:

```sh
npm i -g @openai/codex
npx betahi-copilot-bridge@latest start &
codex exec 'Reply with exactly OK.'
```

The block is delimited with `# >>> copilot-bridge managed` markers; everything
outside the markers is preserved on rewrite. Pass `--no-codex-setup` to skip
auto-config.

## Configuration

User settings live in `~/.config/copilot-bridge/settings.json` (created on
first start):

```json
{
  "host": "127.0.0.1",
  "port": 4242,
  "codex": {
    "enabled": true,
    "providerId": "bridge",
    "providerName": "Copilot Bridge",
    "setAsDefault": true,
    "model": "gpt-5.3-codex"
  }
}
```

Edit this file to change the listen port, the codex provider id, or the
default model selected when `codex` is invoked without `-m`.

Environment overrides:

| Variable                 | Purpose                                                |
| ------------------------ | ------------------------------------------------------ |
| `COPILOT_TOKEN`          | Use a pre-issued Copilot bearer token (skip device login) |
| `COPILOT_ACCOUNT_TYPE`   | `individual` \| `business` \| `enterprise`              |
| `COPILOT_BASE_URL`       | Override the upstream Copilot base URL                  |
| `COPILOT_VSCODE_VERSION` | Override the VS Code version sent upstream              |

## Supported models

The bridge resolves and clamps requests against the table below. Aliases are
rewritten to the canonical id; reasoning efforts are clamped to what each
model accepts upstream.

### GPT-5 family — native Responses passthrough

| Model           | Reasoning efforts                  |
| --------------- | ---------------------------------- |
| `gpt-5.5`       | `none`, `low`, `medium`, `high`, `xhigh` |
| `gpt-5.4`       | `low`, `medium`, `high`, `xhigh`   |
| `gpt-5.4-mini`  | `none`, `low`, `medium`            |
| `gpt-5.3-codex` | `low`, `medium`, `high`, `xhigh`   |
| `gpt-5.2`       | `low`, `medium`, `high`, `xhigh`   |
| `gpt-5.2-codex` | `low`, `medium`, `high`, `xhigh`   |
| `gpt-5-mini`    | `low`, `medium`, `high`            |

### Claude family — translated to chat completions

| Model                | Reasoning efforts                | Notes                              |
| -------------------- | -------------------------------- | ---------------------------------- |
| `claude-opus-4.7`    | `low`, `medium`, `high`, `xhigh`, `max` | effort sent as `output_config.effort` |
| `claude-opus-4.6`    | `low`, `medium`, `high`          |                                    |
| `claude-opus-4.6-1m` | `low`, `medium`, `high`          | 1M-token context window            |
| `claude-sonnet-4.6`  | `low`, `medium`, `high`          |                                    |
| `claude-opus-4.5`    | —                                | reasoning not accepted upstream    |
| `claude-sonnet-4.5`  | —                                | reasoning not accepted upstream    |
| `claude-sonnet-4`    | —                                | reasoning not accepted upstream    |
| `claude-haiku-4.5`   | —                                | reasoning not accepted upstream    |

### Gemini family — translated to chat completions

| Model                     | Aliases             |
| ------------------------- | ------------------- |
| `gemini-3.1-pro-preview`  | `gemini-3.1-pro`    |
| `gemini-3-flash-preview`  | `gemini-3-flash`    |
| `gemini-2.5-pro`          | —                   |

### Legacy

`gpt-4.1`, `gpt-4o` — chat-only upstream, no reasoning parameter.
