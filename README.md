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
| `LITELLM_GCLOUD_TOKEN_AUTH` | Set to `1` to use Google ADC for auth (makes `LITELLM_KEY` optional) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to a Google ADC JSON file (used when `LITELLM_GCLOUD_TOKEN_AUTH=1`) |

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

> **Tip:** Environment variables take precedence over inline config. Use env vars to keep secrets out of checked-in files.

### Google Vertex AI (gcloud token auth)

When your LiteLLM proxy is backed by Google Vertex AI, you can skip `LITELLM_KEY` and let the plugin automatically fetch a gcloud OAuth token:

```bash
# 1. Authenticate with gcloud (creates an ADC JSON file)
gcloud auth application-default login

# 2. Set env vars (LITELLM_KEY is optional)
export LITELLM_URL="https://your-litellm-proxy.example.com"
export LITELLM_GCLOUD_TOKEN_AUTH=1

# 3. Install and restart OpenCode
opencode plugin opencode-provider-litellm
```

The plugin reads your [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials) JSON file and exchanges the refresh token for an access token before every LLM request. Tokens are cached for 50 minutes.

To use a custom credentials file, set `GOOGLE_APPLICATION_CREDENTIALS` to its path.

> **Note:** Only `authorized_user` credentials (from `gcloud auth application-default login`) are supported. Service account keys are not yet supported.

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
| `chat.headers` | Injects `Authorization: Bearer <token>` when `LITELLM_GCLOUD_TOKEN_AUTH=1` |

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
