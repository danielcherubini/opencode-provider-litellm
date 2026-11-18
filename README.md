# opencode-provider-litellm

OpenCode v2 plugin for any [LiteLLM](https://github.com/BerriAI/litellm) proxy — auto-discovers models, MCP tools, and auth. Zero config, zero hand-maintained model lists.

Compatible with **OpenCode >= 2.0.0**.

## Quick start

```bash
# 1. Set your LiteLLM proxy URL and API key
export LITELLM_URL="https://your-litellm-proxy.example.com"
export LITELLM_KEY="sk-..."

# 2. Add the plugin to OpenCode
opencode plugin add opencode-provider-litellm

# 3. Check available models
opencode models
```

All models and MCP tools from your LiteLLM proxy appear in OpenCode automatically.

## Configuration

### Environment variables

Environment variables take precedence over all other configuration. Use them to keep secrets out of checked-in files.

| Variable | Required | Description |
|----------|----------|-------------|
| `LITELLM_URL` | Yes | Your LiteLLM proxy base URL (or `LITELLM_PROVIDER_<NAME>_BASE_URL`) |
| `LITELLM_KEY` | Yes* | API key for the proxy (or `LITELLM_PROVIDER_<NAME>_API_KEY`) |
| `LITELLM_PROVIDER_ID` | No | Provider ID namespace in OpenCode (e.g. `protector`, default: `LiteLLM`). Also checks `LITELLM_PROVIDER_NAME` or `LITELLM_PROVIDER_<NAME>_NAME`. |
| `LITELLM_DISPLAY_NAME` | No | Provider display name shown in OpenCode UI (e.g. `Protector`, default: provider ID). Also checks `LITELLM_PROVIDER_<NAME>_DISPLAY_NAME`. |
| `LITELLM_GCLOUD_TOKEN_AUTH` | No | Set to `1` or `true` to use Google ADC for auth — makes `LITELLM_KEY` optional (also supports `LITELLM_PROVIDER_<NAME>_USE_GCLOUD_AUTH`) |
| `GOOGLE_APPLICATION_CREDENTIALS` | No | Path to a Google ADC JSON file (used when `LITELLM_GCLOUD_TOKEN_AUTH=1`) |

*`LITELLM_KEY` is optional when `LITELLM_GCLOUD_TOKEN_AUTH=1`.

### OpenCode v2 Plugin Configuration (`opencode.json` / `opencode.jsonc`)

All environment variables have an equivalent in the plugin options block in `opencode.json`. **Environment variables take precedence** over options.

In OpenCode v2, plugins are specified under the `plugins` array:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-provider-litellm",
      "options": {
        "url": "https://your-litellm-proxy.example.com",  // LITELLM_URL
        "apiKey": "sk-...",                               // LITELLM_KEY (optional if gcloud ADC is used)
        "id": "protector",                                // Custom provider ID namespace (e.g. protector/<model>)
        "displayName": "Protector"                        // Custom provider UI label
      }
    }
  ]
}
```

For local development or testing from a local clone, set `"package"` to the directory path:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/path/to/opencode-provider-litellm",
      "options": {
        "url": "http://127.0.0.1:4000",
        "apiKey": "sk-..."
      }
    }
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

# 3. Add plugin and verify models
opencode models
```

The plugin reads your [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials) JSON file and exchanges the refresh token for an access token. Tokens are cached for 50 minutes and refreshed automatically for model discovery and LLM requests.

**ADC file locations searched (in order):**
1. `GOOGLE_APPLICATION_CREDENTIALS` env var (all platforms)
2. `~/.config/gcloud/application_default_credentials.json` (Linux/macOS)
3. `%APPDATA%/gcloud/application_default_credentials.json` (Windows)

> **Note:** Only `authorized_user` credentials (from `gcloud auth application-default login`) are supported. Service account keys are not yet supported.

## Features

### Model discovery

Queries LiteLLM on startup and registers all models with complete capabilities and limits into OpenCode's catalog:

- `/v1/model/info` (or `/health` + `/model/info`) — model metadata, costs, context limits, vision, tool calling, reasoning, etc.
- Local model cache is stored on disk so available models load instantly across restarts while background discovery updates the registry.

Custom `model_info` updates via `/model/update` are respected — no hardcoded fallbacks.

### MCP tools

Discovers tools registered on LiteLLM's MCP servers at startup and registers them into OpenCode with native JSON Schema parameter definitions. Each tool keeps its original description and server namespace.

### Skills

Skills registered in LiteLLM's [Skills Gateway](https://docs.litellm.ai/docs/skills_gateway) can be added to your OpenCode configuration:

```jsonc
{
  "skills": [
    "https://your-litellm-proxy.example.com/opencode/skills"
  ]
}
```

Skills appear in OpenCode's `/skills` menu and are loaded natively by the agent.

## OpenCode v2 Architecture

This plugin is built natively for OpenCode v2 using `@opencode/plugin` and `@opencode/schema`:

| Domain | Mechanism | Purpose |
|--------|-----------|---------|
| **Provider & Models** | `ctx.provider.transform` / `ctx.catalog.transform` | Registers the `LiteLLM` provider using `@opencode/ai/providers/openai-compatible` and adds discovered models with context limits, tool call capabilities, and pricing. |
| **MCP Tools** | `ctx.tool.transform` | Exposes discovered MCP tools using native JSON Schema input definitions. |
| **Auth & Session Tracking** | `ctx.session.hook("model.request", ..., { providerID })` | Injects dynamic Google ADC OAuth bearer tokens and `X-Litellm-Session-ID` conversation tracking per request, strictly scoped to the LiteLLM provider. |
| **Thinking Normalization** | `ctx.session.hook("context", ..., { providerID })` | Normalizes Claude / Vertex AI `thinking` parameters (`adaptive` / `disabled`) across agent sessions. |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Plugin config error" | Set `LITELLM_URL` and `LITELLM_KEY` (or `LITELLM_GCLOUD_TOKEN_AUTH=1`) |
| "Access denied" (403) | Verify the API key has access to the LiteLLM proxy |
| "No models discovered" | Check the proxy is reachable and `/v1/model/info` or `/health` responds |
| No models with gcloud auth | Verify `gcloud auth application-default login` has been run and the ADC file exists |
| Skills not showing | Verify the proxy-sidecar is running and the skills URL is in `opencode.json` |

## Development

```bash
npm install
npm run typecheck
npm run test:run
npm run build
npx tsx scripts/verify-v2.ts
```
