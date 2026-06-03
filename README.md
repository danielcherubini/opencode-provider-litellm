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

Environment variables take precedence over all other configuration. Use them to keep secrets out of checked-in files.

| Variable | Required | Description |
|----------|----------|-------------|
| `LITELLM_URL` | Yes | Your LiteLLM proxy base URL |
| `LITELLM_KEY` | Yes* | API key for the proxy |
| `LITELLM_PROVIDER_ID` | No | Provider name in OpenCode (default: `LiteLLM`) |
| `LITELLM_GCLOUD_TOKEN_AUTH` | No | Set to `1` to use Google ADC for auth — makes `LITELLM_KEY` optional |
| `GOOGLE_APPLICATION_CREDENTIALS` | No | Path to a Google ADC JSON file (used when `LITELLM_GCLOUD_TOKEN_AUTH=1`) |

*`LITELLM_KEY` is optional when `LITELLM_GCLOUD_TOKEN_AUTH=1`.

### Plugin options

All env vars have an equivalent in the plugin options block in `opencode.json`. **Env vars take precedence** — use options for defaults that can be overridden per environment.

```jsonc
{
  "plugin": [
    ["opencode-provider-litellm", {
      "url": "https://your-litellm-proxy.example.com",  // LITELLM_URL
      "apiKey": "sk-...",                                // LITELLM_KEY
      "providerName": "MyLiteLLM",                       // LITELLM_PROVIDER_ID
      "gcloudTokenAuth": true                            // LITELLM_GCLOUD_TOKEN_AUTH=1
      // apiKey can be omitted when gcloudTokenAuth is true
    }]
  ]
}
```

### Google Vertex AI (gcloud token auth)

When your LiteLLM proxy is backed by Google Vertex AI, you can skip `LITELLM_KEY` and let the plugin automatically fetch a Google OAuth token:

```bash
# 1. Authenticate with gcloud (creates an ADC JSON file)
gcloud auth application-default login

# 2. Set env vars (LITELLM_KEY is optional)
export LITELLM_URL="https://your-litellm-proxy.example.com"
export LITELLM_GCLOUD_TOKEN_AUTH=1

# 3. Install and restart OpenCode
opencode plugin opencode-provider-litellm
```

The plugin reads your [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials) JSON file and exchanges the refresh token for an access token. Tokens are cached for 50 minutes and used for both model discovery at startup and every LLM request.

**ADC file locations searched (in order):**
1. `GOOGLE_APPLICATION_CREDENTIALS` env var (all platforms)
2. `~/.config/gcloud/application_default_credentials.json` (Linux/macOS)
3. `%APPDATA%/gcloud/application_default_credentials.json` (Windows)

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

The plugin uses these OpenCode hooks:

| Hook | Purpose |
|------|---------|
| `config` | Discovers models from LiteLLM and injects them into OpenCode |
| `auth` | Provides a `/connect` entry point for pasting an API key |
| `tool` | Exposes discovered MCP tools as native OpenCode tools |
| `chat.headers` | Injects `Authorization: Bearer <token>` when gcloud token auth is enabled |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Plugin config error" | Set `LITELLM_URL` and `LITELLM_KEY` (or `LITELLM_GCLOUD_TOKEN_AUTH=1`) |
| "Access denied" (403) | Verify the API key has access to the LiteLLM proxy |
| "No models discovered" | Check the proxy is reachable and `/health` responds |
| No models with gcloud auth | Verify `gcloud auth application-default login` has been run and the ADC file exists |
| Skills not showing | Verify the proxy-sidecar is running and the skills URL is in `opencode.json` |

## Development

```bash
npm install
npm run typecheck
npm run test
npm run build
```
