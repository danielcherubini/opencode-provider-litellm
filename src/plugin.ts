import type { Plugin, PluginInput, PluginOptions } from '@opencode-ai/plugin'
import { resolvePluginConfig, getProviderId } from './utils.js'
import { discoverModels, injectModelsIntoConfig } from './discovery.js'
import { createMcpToolDefinitions } from './mcp-tools.js'
import { getGcloudToken } from './gcloud-token.js'
import { loadModelCache, saveModelCache } from './model-cache.js'

export const LiteLLMPlugin: Plugin = async (
  input: PluginInput,
  options?: PluginOptions,
) => {
  const pluginConfig = resolvePluginConfig(options)
  if (pluginConfig === null) {
    const isGcloudAuth = process.env.LITELLM_GCLOUD_TOKEN_AUTH &&
      process.env.LITELLM_GCLOUD_TOKEN_AUTH !== '' &&
      process.env.LITELLM_GCLOUD_TOKEN_AUTH !== '0'

    throw new Error(
      isGcloudAuth
        ? "Plugin config error: set LITELLM_URL (LITELLM_KEY is optional when LITELLM_GCLOUD_TOKEN_AUTH=1)."
        : "Plugin config error: set 'url' and 'apiKey' in plugin options, " +
          "or set LITELLM_URL and LITELLM_KEY environment variables.",
    )
  }

  const providerId = getProviderId()

  const isGcloudAuth = !!(process.env.LITELLM_GCLOUD_TOKEN_AUTH &&
    process.env.LITELLM_GCLOUD_TOKEN_AUTH !== '' &&
    process.env.LITELLM_GCLOUD_TOKEN_AUTH !== '0')

  // When gcloud token auth is enabled, fetch a live token instead of using the static apiKey
  const getToken = async (): Promise<string> => {
    if (isGcloudAuth) {
      return (await getGcloudToken()) ?? ''
    }
    return pluginConfig.apiKey
  }

  let mcpTools: Record<string, any> = {}
  try {
    mcpTools = await createMcpToolDefinitions(pluginConfig, await getToken())
  } catch (e) {
    console.warn(`[opencode-provider-litellm] MCP tool discovery failed: ${e}`)
  }

  const result: Record<string, unknown> = {
    config: async (config: Record<string, any>) => {
      // Inject cached models immediately so opencode has something to work
      // with while live discovery runs.
      const cachedModels = loadModelCache(providerId)
      if (cachedModels) {
        const token = await getToken()
        injectModelsIntoConfig(
          config as Parameters<typeof injectModelsIntoConfig>[0],
          providerId,
          pluginConfig.url,
          token,
          cachedModels,
        )
      }

      // Discover live models, update cache, and re-inject with fresh data.
      try {
        const models = await discoverModels(pluginConfig, getToken)

        if (Object.keys(models).length === 0) {
          await input.client.app.log({
            body: {
              service: providerId,
              level: 'warn',
              message: 'No models discovered',
            },
          })
        } else {
          saveModelCache(providerId, models)
          const token = await getToken()
          injectModelsIntoConfig(
            config as Parameters<typeof injectModelsIntoConfig>[0],
            providerId,
            pluginConfig.url,
            token,
            models,
          )
          await input.client.app.log({
            body: {
              service: providerId,
              level: 'info',
              message: `Discovered ${Object.keys(models).length} models`,
            },
          })
        }
      } catch (error) {
        await input.client.app.log({
          body: {
            service: providerId,
            level: 'warn',
            message: `Model discovery failed: ${error}`,
          },
        })
      }
    },

    auth: {
      provider: providerId,
      methods: [
        {
          type: 'api' as const,
          label: 'LiteLLM API Key',
          prompts: [
            {
              type: 'text' as const,
              key: 'apiKey',
              message: 'API key',
              placeholder: 'sk-...',
            },
          ],
          async authorize(inputs: Record<string, unknown> | undefined) {
            const apiKey = inputs?.apiKey
            if (!apiKey || typeof apiKey !== 'string' || apiKey.length === 0) {
              return { type: 'failed' as const }
            }
            return { type: 'success' as const, key: apiKey }
          },
        },
      ],
    },

    tool: {
      ...mcpTools,
    },
  }

  // Inject session ID into LiteLLM requests so all messages in the same
  // opencode session are grouped under one conversation in LiteLLM logs.
  // Mirrors pi-provider-litellm's setSessionId(ctx.sessionManager.getSessionId()).
  result['chat.headers'] = async (
    input: { sessionID: string },
    output: { headers: Record<string, string> },
  ) => {
    // gcloud auth: inject fresh OAuth token
    if (isGcloudAuth) {
      const token = await getGcloudToken()
      if (token) {
        output.headers['Authorization'] = `Bearer ${token}`
      }
    }

    // Session ID: group requests by conversation in LiteLLM logs
    if (input.sessionID) {
      output.headers['X-Litellm-Session-ID'] = input.sessionID
    }
  }

  // Normalize `thinking` param to Vertex AI Claude format.
  // Vertex AI Claude only accepts type in {"adaptive", "disabled", "enabled"}.
  // Opencode may send string levels like "medium"/"low"/"high" or dict with
  // non-standard type values — map them to "adaptive" (Claude decides budget)
  // or "disabled" (no thinking).
  // Also ensures thinking is always a dict (LiteLLM's is_thinking_enabled
  // assumes dict shape — see BerriAI/litellm#28576, PR #28861).
  result['chat.params'] = async (
    _input: Record<string, unknown>,
    output: { options: Record<string, unknown> },
  ) => {
    const thinking = output.options.thinking
    if (typeof thinking === 'string') {
      const type = (thinking === 'off' || thinking === 'disabled')
        ? 'disabled'
        : 'adaptive'
      output.options.thinking = { type }
    } else if (typeof thinking === 'object' && thinking !== null && !Array.isArray(thinking)) {
      const thinkingObj = thinking as Record<string, unknown>
      const type = thinkingObj.type as string | undefined
      if (typeof type === 'string' && !['adaptive', 'disabled', 'enabled'].includes(type)) {
        thinkingObj.type = 'adaptive'
      }
    }
  }

  return result
}
