# opencode-provider-protector

OpenCode plugin that gives every Protector employee access to company LLMs. Add one line to your config — models, auth, and capabilities are handled automatically.

## Quick start

Set your environment variables:

```bash
export PROTECTOR_LLM_URL="https://your-litellm-proxy.example.com"
export PROTECTOR_LLM_KEY="sk-..."
```

Add the plugin to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["git+https://github.com/protectorinsurance/opencode-provider-protector.git"]
}
```

Restart OpenCode.

## Setup

### 1. Set environment variables

```bash
export PROTECTOR_LLM_URL="https://your-litellm-proxy.example.com"
export PROTECTOR_LLM_KEY="sk-..."
```

Add these to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.) so they persist.

:::tip
Environment variables take precedence over inline config values. Use env vars to keep secrets out of checked-in files.
:::

### 2. Add the plugin

Add the plugin to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["git+https://github.com/protectorinsurance/opencode-provider-protector.git"]
}
```

OpenCode installs the plugin automatically on startup.

### 3. Select a model

Run `/models` in the TUI and pick a model from the `protector` provider.

---

### Alternative: inline config

If you prefer not to use environment variables, provide `url` and `apiKey` directly in the plugin options:

```json
{
  "plugin": [
    ["git+https://github.com/protectorinsurance/opencode-provider-protector.git", {
      "url": "https://your-litellm-proxy.example.com",
      "apiKey": "sk-..."
    }]
  ]
}
```

### Alternative: /connect flow

You can also authenticate interactively via the OpenCode TUI:

1. Run `/connect`
2. Select **Protector LLM**
3. Paste your API key

The key is stored in `~/.local/share/opencode/auth.json`.

## How it works

The plugin uses three OpenCode hooks:

| Hook | Purpose |
|---|---|
| `config` | Fetches available models from the LiteLLM proxy at startup and injects them into OpenCode under the `protector` provider |
| `auth` | Provides a `/connect` entry point for pasting an API key |
| `chat.headers` | Injects `Authorization: Bearer <key>` on every request to the `protector` provider |

Model capabilities (tool calling, reasoning, context limits) are auto-detected from the proxy response.

## Troubleshooting

| Problem | Solution |
|---|---|
| "Plugin config error" | Set `PROTECTOR_LLM_URL` and `PROTECTOR_LLM_KEY`, or add `url`/`apiKey` to plugin options |
| "Access denied" (403) | Contact your admin to grant access to the LLM proxy |
| "No models discovered" | Verify the proxy URL is reachable and the API key is valid |

## Development

```bash
npm install
npm run typecheck
npm run test
```
