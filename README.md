# opencode-provider-litellm

OpenCode **V2** plugin for any [LiteLLM](https://github.com/BerriAI/litellm) proxy — auto-discovers models, MCP tools, and auth. Zero config, zero hand-maintained model lists.

> Requires OpenCode ≥ 2.0.0 (V2 plugin API). V1 plugin code no longer loads under OpenCode V2 — this is a port from the `@opencode-ai/plugin` API to `@opencode/plugin`.

## Quick start

```bash
# 1. Set your LiteLLM proxy URL and API key
export LITELLM_URL="https://your-litellm-proxy.example.com"
export LITELLM_KEY="sk-..."

# 2. Restart OpenCode (the plugin is registered in your opencode.json(c) — see below)
```

Register the plugin in your `opencode.json` / `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-provider-litellm",
      "options": {
        "url": "https://your-litellm-proxy.example.com", // LITELLM_URL
        "apiKey": "sk-..." // LITELLM_KEY
      }
    }
  ]
}
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

`url` and `apiKey` can be set in the plugin's options block (see the quick start). **Env vars take precedence** — use options for defaults that can be overridden per environment.

Only `url` and `apiKey` are supported options; the provider name and gcloud token auth are controlled by the `LITELLM_PROVIDER_ID` and `LITELLM_GCLOUD_TOKEN_AUTH` environment variables.

### Google Vertex AI (gcloud token auth)

When your LiteLLM proxy is backed by Google Vertex AI, you can skip `LITELLM_KEY` and let the plugin automatically fetch a Google OAuth token:

```bash
# 1. Authenticate with gcloud (creates an ADC JSON file)
gcloud auth application-default login

# 2. Set env vars (LITELLM_KEY is optional)
export LITELLM_URL="https://your-litellm-proxy.example.com"
export LITELLM_GCLOUD_TOKEN_AUTH=1
```

The plugin reads your [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials) JSON file and exchanges the refresh token for an access token. Tokens are cached for 50 minutes, are used for model discovery at startup, and a fresh token is injected into every LLM request.

**ADC file locations searched (in order):**
1. `GOOGLE_APPLICATION_CREDENTIALS` env var (all platforms)
2. `~/.config/gcloud/application_default_credentials.json` (Linux/macOS)
3. `%APPDATA%/gcloud/application_default_credentials.json` (Windows)

> **Note:** Only `authorized_user` credentials (from `gcloud auth application-default login`) are supported. Service account keys are not yet supported.

### Auth

Authentication is static: the API key comes from `LITELLM_KEY` or the `apiKey` option (or a Google OAuth token with `LITELLM_GCLOUD_TOKEN_AUTH=1`). The V1 `/connect` flow is not available in the V2 port — OpenCode V2 plugins cannot register new auth integrations, only built-in ones.

## Features

### Model discovery

Queries LiteLLM on load and registers all models with rich metadata through the V2 provider API:

- `/v1/model/info` — all models in a single call with full metadata (costs per 1M tokens, context limits, vision, tool calling, reasoning)
- `/health` + `/model/info?litellm_model_id={id}` — fallback for older LiteLLM versions

Models are seeded from a local cache so they are available immediately, then refreshed with a live discovery pass. Custom `model_info` updates via `/model/update` are respected — no hardcoded fallbacks.

> The proxy's `supports_reasoning` flag is still discovered, but OpenCode V2 has no first-class per-model reasoning field, so it is not surfaced on the model.

### MCP tools

Discovers tools registered on LiteLLM's MCP servers at startup and exposes them as native OpenCode tools. Each tool keeps its original description and parameter schema (passed through as JSON Schema; tools without an object schema get a single `args` field).

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

The plugin registers the following in its `setup(ctx)`:

| V2 API | Purpose |
|--------|---------|
| `ctx.provider.transform` | Registers the LiteLLM provider (built-in openai-compatible package, `settings: { baseURL, apiKey }`) and the model inventory — seeded from the `ctx.storage` cache, refreshed live via `ctx.provider.reload()` |
| `ctx.tool.transform` | Exposes discovered MCP tools as native OpenCode tools |
| `ctx.session.hook("model.request")` | Injects `X-Litellm-Session-ID` on every model request and, with gcloud token auth, a fresh `Authorization: Bearer <token>` |
| `ctx.session.hook("context")` | Normalizes the `thinking` parameter for Vertex AI Claude |

Both session hooks are scoped to the provider this plugin registers (the V1 `chat.headers`/`chat.params` hooks applied to every request).

The model cache lives in OpenCode's plugin storage (`ctx.storage`, keyed by provider ID) instead of `~/.local/share/opencode/opencode-provider-litellm-cache.json`.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Plugin config error" | Set `LITELLM_URL` and `LITELLM_KEY` (or `LITELLM_GCLOUD_TOKEN_AUTH=1`) |
| "Access denied" (403) | Verify the API key has access to the LiteLLM proxy |
| "No models discovered" | Check the proxy is reachable and `/v1/model/info` (or `/health`) responds |
| No models with gcloud auth | Verify `gcloud auth application-default login` has been run and the ADC file exists |
| Skills not showing | Verify the proxy-sidecar is running and the skills URL is in `opencode.json` |

## Development

```bash
npm install
npm run typecheck
npm run test
npm run build
```
