import type { LiteLLMModel, OpencodeModelConfig, PluginConfig } from './types.js'

/**
 * Maps a LiteLLM model to OpenCode model config format.
 */
export function mapLiteLLMModel(model: LiteLLMModel): OpencodeModelConfig {
  const maxLen = model.max_model_len ?? 32768
  const reasoning = /qwen3|deepseek-r1|o[134]/i.test(model.id)

  return {
    name: model.id,
    tool_call: true,
    reasoning,
    limit: {
      context: maxLen,
      output: maxLen,
    },
    modalities: {
      input: ['text'],
      output: ['text'],
    },
  }
}

/**
 * Resolves plugin configuration from environment variables or config options.
 *
 * Priority:
 * 1. LITELLM_URL / LITELLM_KEY environment variables
 * 2. Values from opencode.json plugin options
 *
 * Returns null if no source provides both url and apiKey.
 */
export function resolvePluginConfig(rawConfig: unknown): PluginConfig | null {
  const envUrl = typeof process !== 'undefined' ? process.env.LITELLM_URL : undefined
  const envKey = typeof process !== 'undefined' ? process.env.LITELLM_KEY : undefined
  const envGcloudAuth = typeof process !== 'undefined'
    ? process.env.LITELLM_GCLOUD_TOKEN_AUTH
    : undefined

  const hasEnvVars = envUrl !== undefined && envUrl.length > 0 &&
                      envKey !== undefined && envKey.length > 0

  if (hasEnvVars) {
    return { url: envUrl, apiKey: envKey }
  }

  // Allow missing LITELLM_KEY when gcloud token auth is enabled
  if (envUrl !== undefined && envUrl.length > 0 &&
      envGcloudAuth !== undefined && envGcloudAuth !== '' && envGcloudAuth !== '0') {
    return { url: envUrl, apiKey: envKey || '' }
  }

  // Fall back to config options from opencode.json
  if (rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)) {
    const obj = rawConfig as Record<string, unknown>
    const configUrl = typeof obj.url === 'string' ? obj.url : ''
    const configKey = typeof obj.apiKey === 'string' ? obj.apiKey : ''

    if (configUrl.length > 0 && configKey.length > 0) {
      return { url: configUrl, apiKey: configKey }
    }
  }

  return null
}

/**
 * Gets the provider ID from environment variable or defaults to "LiteLLM".
 */
export function getProviderId(): string {
  return (typeof process !== 'undefined' ? process.env.LITELLM_PROVIDER_ID : undefined) || 'LiteLLM'
}
