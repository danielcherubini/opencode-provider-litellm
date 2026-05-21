# opencode-provider-litellm

OpenCode plugin that auto-discovers models from any [LiteLLM](https://github.com/BerriAI/litellm) proxy — complete with costs, context limits, capabilities, and auth. Zero config, zero hand-maintained model lists.

## Quick start

```bash
# 1. Set your LiteLLM proxy URL and API key
export LITELLM_URL="https://your-litellm-proxy.example.com"
export LITELLM_KEY="sk-..."

# 2. Install the plugin
opencode plugin opencode-provider-litellm

# 3. Restart OpenCode
```

All models from your LiteLLM proxy appear in OpenCode's model picker automatically.

## Configuration

### Environment variables

| Variable | Description |
|----------|-------------|
| `LITELLM_URL` | Your LiteLLM proxy base URL |
| `LITELLM_KEY` | API key for the proxy |
| `LITELLM_PROVIDER_ID` | Provider ID in OpenCode (defaults to `LiteLLM`) |

### Inline config

Alternatively, provide `url` and `apiKey` directly in your `opencode.json`:

```jsonc
{
  "plugin": [
    ["opencode-provider-litellm", {
      "url": "https://your-litellm-proxy.example.com",
      "apiKey": "sk-..."
    }]
  ]
}
```

:::tip
Environment variables take precedence over inline config. Use env vars to keep secrets out of checked-in files.
:::

### /connect flow

You can also authenticate interactively via the OpenCode TUI:

1. Run `/connect`
2. Select **LiteLLM**
3. Paste your API key

The key is stored in OpenCode's auth store.

## How it works

The plugin uses two OpenCode hooks:

| Hook | Purpose |
|------|---------|
| `config` | Queries `/health` + `/model/info` on startup, discovers models with rich metadata (costs, limits, capabilities), and injects them into OpenCode |
| `auth` | Provides a `/connect` entry point for pasting an API key |

Model metadata is fetched from LiteLLM's admin API:

- `/health` — model list with internal UUIDs
- `/model/info?litellm_model_id={uuid}` — rich metadata per model (costs, context limits, vision, tool calling, reasoning, etc.)

Custom model_info updates via `/model/update` are respected — no hardcoded fallbacks.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Plugin config error" | Set `LITELLM_URL` and `LITELLM_KEY`, or add `url`/`apiKey` to plugin options |
| "Access denied" (403) | Verify the API key has access to the LiteLLM proxy |
| "No models discovered" | Check that the proxy is reachable and the `/health` endpoint responds |

## Development

```bash
npm install
npm run typecheck
npm run test
npm run build
```
