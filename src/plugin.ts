import type { Plugin, PluginInput, PluginOptions } from '@opencode-ai/plugin'
import { resolvePluginConfig, getProviderId } from './utils.js'
import { discoverModels, injectModelsIntoConfig } from './discovery.js'
import { createMcpToolDefinitions } from './mcp-tools.js'
import { createSkillToolDefinitions, createSkillsInjector } from './skills.js'

/**
 * Main plugin entry point for the LiteLLM provider.
 *
 * Wires together config (model discovery), auth (/connect API key flow),
 * and chat.headers (per-request Bearer token injection).
 *
 * Auth: LITELLM_URL / LITELLM_KEY env vars take precedence,
 * with fallback to values in opencode.json plugin options.
 */
export const LiteLLMPlugin: Plugin = async (
  input: PluginInput,
  options?: PluginOptions,
) => {
  const pluginConfig = resolvePluginConfig(options)
  if (pluginConfig === null) {
    throw new Error(
      "Plugin config error: set 'url' and 'apiKey' in plugin options, " +
      "or set LITELLM_URL and LITELLM_KEY environment variables.",
    )
  }

  const providerId = getProviderId()

  // Discover MCP tools with graceful error handling
  let mcpTools: Record<string, any> = {}
  try {
    mcpTools = await createMcpToolDefinitions(pluginConfig, pluginConfig.apiKey)
  } catch (e) {
    console.warn(`[opencode-provider-litellm] MCP tool discovery failed: ${e}`)
  }

  return {
    /**
     * Config hook — discovers models from the LiteLLM proxy and injects
     * them into the OpenCode config under the provider.
     */
    config: async (config) => {
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
          return
        }

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

    /**
     * Auth hook — lets the user paste an API key via the /connect flow.
     * The key is stored in OpenCode's auth store and used as the Bearer token.
     */
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
          async authorize(inputs) {
            if (!inputs?.apiKey || inputs.apiKey.length === 0) {
              return { type: 'failed' as const }
            }
            return { type: 'success' as const, key: inputs.apiKey }
          },
        },
      ],
    },

    /**
     * Tool hook — merges dynamically-discovered MCP tools with static
     * Skills CRUD tools.
     */
    tool: {
      ...mcpTools,
      ...createSkillToolDefinitions(pluginConfig, pluginConfig.apiKey),
    },

    /**
     * Chat message hook — injects active Skills as context into chat messages.
     */
    "chat.message": createSkillsInjector(pluginConfig, pluginConfig.apiKey),
  }
}
