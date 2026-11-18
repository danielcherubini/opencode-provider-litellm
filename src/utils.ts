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
 * Checks whether Google Cloud token authentication is enabled via environment variables or options.
 */
export function isGcloudAuthEnabled(options?: unknown): boolean {
  if (typeof process !== 'undefined') {
    const gcloud = process.env.LITELLM_GCLOUD_TOKEN_AUTH
    if (gcloud !== undefined && gcloud !== '' && gcloud !== '0' && gcloud !== 'false') {
      return true
    }
    const protectorAuth = process.env.LITELLM_PROVIDER_PROTECTOR_USE_GCLOUD_AUTH
    if (protectorAuth !== undefined && protectorAuth !== '' && protectorAuth !== '0' && protectorAuth !== 'false') {
      return true
    }
  }
  if (options && typeof options === 'object' && !Array.isArray(options)) {
    const obj = options as Record<string, unknown>
    if (obj.gcloudAuth === true) return true
  }
  return false
}

/**
 * Resolves plugin configuration from environment variables or config options.
 *
 * Priority:
 * 1. LITELLM_URL / LITELLM_KEY environment variables
 * 2. Values from opencode.json plugin options
 * 3. Fallback to Protector environment variables (LITELLM_PROVIDER_PROTECTOR_*)
 *
 * Returns null if no source provides both url and apiKey (or url with gcloud auth).
 */
export function resolvePluginConfig(rawConfig: unknown): PluginConfig | null {
  // 1. Explicit LITELLM_URL / LITELLM_KEY
  const envUrl = typeof process !== 'undefined' ? process.env.LITELLM_URL : undefined
  const envKey = typeof process !== 'undefined' ? process.env.LITELLM_KEY : undefined
  const gcloudAuth = isGcloudAuthEnabled(rawConfig)

  if (envUrl && envUrl.length > 0) {
    if (envKey && envKey.length > 0) {
      return { url: envUrl, apiKey: envKey }
    }
    if (gcloudAuth) {
      return { url: envUrl, apiKey: envKey || '' }
    }
  }

  // 2. Explicit plugin options from opencode.json
  if (rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)) {
    const obj = rawConfig as Record<string, unknown>
    const configUrl = typeof obj.url === 'string' ? obj.url : ''
    const configKey = typeof obj.apiKey === 'string' ? obj.apiKey : ''

    if (configUrl.length > 0) {
      if (configKey.length > 0 || gcloudAuth) {
        return { url: configUrl, apiKey: configKey }
      }
    }
  }

  // 3. Fallback to Protector environment variables (LITELLM_PROVIDER_PROTECTOR_*)
  if (typeof process !== 'undefined') {
    const protectorUrl = process.env.LITELLM_PROVIDER_PROTECTOR_BASE_URL
    const protectorKey = process.env.LITELLM_PROVIDER_PROTECTOR_API_KEY
    if (protectorUrl && protectorUrl.length > 0) {
      if (protectorKey && protectorKey.length > 0) {
        return { url: protectorUrl, apiKey: protectorKey }
      }
      if (gcloudAuth) {
        return { url: protectorUrl, apiKey: protectorKey || '' }
      }
    }
  }

  return null
}

/**
 * Gets the provider ID from environment variable or defaults to "LiteLLM".
 */
export function getProviderId(): string {
  return (
    (typeof process !== 'undefined'
      ? process.env.LITELLM_PROVIDER_ID || process.env.LITELLM_PROVIDER_PROTECTOR_NAME
      : undefined) || 'LiteLLM'
  )
}
