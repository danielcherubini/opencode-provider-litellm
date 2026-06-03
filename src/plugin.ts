import type { Plugin, PluginInput, PluginOptions } from '@opencode-ai/plugin'
import { resolvePluginConfig, getProviderId } from './utils.js'
import { discoverModels, injectModelsIntoConfig } from './discovery.js'
import { createMcpToolDefinitions } from './mcp-tools.js'
import { getGcloudToken } from './gcloud-token.js'

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

  let mcpTools: Record<string, any> = {}
  try {
    mcpTools = await createMcpToolDefinitions(pluginConfig, pluginConfig.apiKey)
  } catch (e) {
    console.warn(`[opencode-provider-litellm] MCP tool discovery failed: ${e}`)
  }

  const result: Record<string, unknown> = {
    config: async (config: Record<string, any>) => {
      try {
        const models = await discoverModels(
          pluginConfig,
          () => Promise.resolve(pluginConfig.apiKey),
        )

        if (Object.keys(models).length === 0) {
          await input.client.app.log({
            body: {
              service: providerId,
              level: 'warn',
              message: 'No models discovered',
            },
          })
        } else {
          injectModelsIntoConfig(
            config as Parameters<typeof injectModelsIntoConfig>[0],
            providerId,
            pluginConfig.url,
            pluginConfig.apiKey,
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

  if (process.env.LITELLM_GCLOUD_TOKEN_AUTH &&
      process.env.LITELLM_GCLOUD_TOKEN_AUTH !== '' &&
      process.env.LITELLM_GCLOUD_TOKEN_AUTH !== '0') {
    result['chat.headers'] = async (_input: Record<string, unknown>, output: { headers: Record<string, string> }) => {
      const token = await getGcloudToken()
      if (token) {
        output.headers['Authorization'] = `Bearer ${token}`
      }
    }
  }

  return result
}
