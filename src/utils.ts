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
 * 1. PROTECTOR_LLM_URL / PROTECTOR_LLM_KEY environment variables
 * 2. Values from opencode.json plugin options
 * 3. Falls back to env vars if config values are empty
 *
 * Returns null if neither source provides both url and apiKey.
 */
export function resolvePluginConfig(rawConfig: unknown): PluginConfig | null {
  const envUrl = typeof process !== 'undefined' ? process.env.PROTECTOR_LLM_URL : undefined
  const envKey = typeof process !== 'undefined' ? process.env.PROTECTOR_LLM_KEY : undefined

  const hasEnvVars = envUrl !== undefined && envUrl.length > 0 &&
                     envKey !== undefined && envKey.length > 0

  if (hasEnvVars) {
    return { url: envUrl, apiKey: envKey }
  }

  // Fall back to config options from opencode.json
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    return null
  }

  const obj = rawConfig as Record<string, unknown>
  const configUrl = typeof obj.url === 'string' ? obj.url : ''
  const configKey = typeof obj.apiKey === 'string' ? obj.apiKey : ''

  if (configUrl.length === 0 || configKey.length === 0) {
    return null
  }

  return { url: configUrl, apiKey: configKey }
}
