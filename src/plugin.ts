import type { Plugin, PluginInput, PluginOptions } from '@opencode-ai/plugin'
import { resolvePluginConfig } from './utils.js'
import { discoverModels, injectModelsIntoConfig } from './discovery.js'

/**
 * Main plugin entry point for the Protector LLM provider.
 *
 * Wires together config (model discovery), auth (/connect API key flow),
 * and chat.headers (per-request Bearer token injection).
 *
 * Auth: PROTECTOR_LLM_URL / PROTECTOR_LLM_KEY env vars take precedence,
 * with fallback to values in opencode.json plugin options.
 */
export const ProtectorLlmPlugin: Plugin = async (
  input: PluginInput,
  options?: PluginOptions,
) => {
  const pluginConfig = resolvePluginConfig(options)
  if (pluginConfig === null) {
    throw new Error(
      "Plugin config error: set 'url' and 'apiKey' in plugin options, " +
      "or set PROTECTOR_LLM_URL and PROTECTOR_LLM_KEY environment variables.",
    )
  }

  return {
    /**
     * Config hook — discovers models from the LiteLLM proxy and injects
     * them into the OpenCode config under the 'protector' provider.
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
              service: 'protector',
              level: 'warn',
              message: 'No models discovered',
            },
          })
          return
        }

        injectModelsIntoConfig(
          config as Parameters<typeof injectModelsIntoConfig>[0],
          'protector',
          pluginConfig.url,
          models,
        )
        await input.client.app.log({
          body: {
            service: 'protector',
            level: 'info',
            message: `Discovered ${Object.keys(models).length} models`,
          },
        })
      } catch (error) {
        await input.client.app.log({
          body: {
            service: 'protector',
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
      provider: 'protector',
      methods: [
        {
          type: 'api' as const,
          label: 'Protector LLM API Key',
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
     * Chat.headers hook — injects the API key as an Authorization header
     * for requests to the protector-llm provider.
     */
    'chat.headers': async (input, output) => {
      if (input.provider.info.id !== 'protector') return
      output.headers['Authorization'] = `Bearer ${pluginConfig.apiKey}`
    },
  }
}
