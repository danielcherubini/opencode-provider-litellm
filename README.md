# opencode-provider-litellm

OpenCode plugin for any [LiteLLM](https://github.com/BerriAI/litellm) proxy — auto-discovers models, MCP tools, and auth. Zero config, zero hand-maintained model lists.

## Quick start

```bash
# 1. Set your LiteLLM proxy URL and API key
export LITELLM_URL="https://your-litellm-proxy.example.com"
export LITELLM_KEY="sk-..."

# 2. Install the plugin
opencode plugin opencode-provider-litellm

# 3. Restart OpenCode
```

All models and MCP tools from your LiteLLM proxy appear in OpenCode automatically.

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

## Features

### Model discovery

Queries LiteLLM on startup and injects all models with rich metadata into OpenCode:

- `/health` — model list with internal UUIDs
- `/model/info?litellm_model_id={uuid}` — costs, context limits, vision, tool calling, reasoning, etc.

Custom `model_info` updates via `/model/update` are respected — no hardcoded fallbacks.

### MCP tools

Discovers tools registered on LiteLLM's MCP servers at startup and exposes them as native OpenCode tools. Each tool keeps its original description and parameter schema.

### Skills

Skills registered in LiteLLM's [Skills Gateway](https://docs.litellm.ai/docs/skills_gateway) are made available to OpenCode via the [proxy-sidecar](../llm-server/proxy-sidecar/), which serves skills in OpenCode's native format. Add the sidecar URL to your config:

```jsonc
{
  "skills": {
    "urls": ["https://your-litellm-proxy.example.com/opencode/skills"]
  }
}
```

Skills appear in OpenCode's `/skills` menu and are loaded natively by the agent.

## How it works

The plugin uses three OpenCode hooks:

| Hook | Purpose |
|------|---------|
| `config` | Discovers models from LiteLLM and injects them into OpenCode |
| `auth` | Provides a `/connect` entry point for pasting an API key |
| `tool` | Exposes discovered MCP tools as native OpenCode tools |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Plugin config error" | Set `LITELLM_URL` and `LITELLM_KEY`, or add `url`/`apiKey` to plugin options |
| "Access denied" (403) | Verify the API key has access to the LiteLLM proxy |
| "No models discovered" | Check that the proxy is reachable and the `/health` endpoint responds |
| Skills not showing | Verify the proxy-sidecar is running and the skills URL is in `opencode.json` |

## Development

```bash
npm install
npm run typecheck
npm run test
npm run build
```
