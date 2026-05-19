import type { PluginConfig, OpencodeModelConfig } from './types.js'
import type { Config } from '@opencode-ai/plugin'
import { mapLiteLLMModel } from './utils.js'

/**
 * Fetches available models from the LiteLLM proxy's /v1/models endpoint
 * and maps them to OpenCode's model config format.
 */
export async function discoverModels(
  config: PluginConfig,
  getToken: () => Promise<string>,
): Promise<Record<string, OpencodeModelConfig>> {
  const token = await getToken()

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15_000)

  try {
    const response = await fetch(`${config.url}/v1/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    })

    if (response.status === 403) {
      throw new Error(
        'Access denied. Contact your admin to grant access to the LLM proxy.',
      )
    }

    if (!response.ok) {
      // 500 or other non-403 errors → return empty object
      return {}
    }

    const body = await response.json()
    if (!Array.isArray(body?.data)) return {}

    const models: Record<string, OpencodeModelConfig> = {}

    for (const model of body.data) {
      models[model.id] = mapLiteLLMModel(model)
    }

    return models
  } catch (error: unknown) {
    // Timeout (AbortError) or network error → return empty object
    if (error instanceof Error && error.name === 'AbortError') {
      return {}
    }
    // Re-throw the 403 descriptive error
    if (error instanceof Error && error.message.includes('Access denied')) {
      throw error
    }
    // Network errors → return empty object
    return {}
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Injects discovered models into an OpenCode config under the given provider name.
 * Merges with existing provider config without overwriting options.
 */
export function injectModelsIntoConfig(
  config: Config,
  providerName: string,
  baseUrl: string,
  models: Record<string, OpencodeModelConfig>,
): void {
  if (!config.provider) {
    config.provider = {}
  }

  const existing = config.provider[providerName]

  if (existing) {
    // Preserve existing options, merge models
    // Set defaults for incomplete provider entries
    if (!existing.npm) existing.npm = '@ai-sdk/openai-compatible'
    if (!existing.name) existing.name = providerName
    if (!existing.options) {
      existing.options = { baseURL: baseUrl, apiKey: 'iap-token' }
    }
    existing.models = { ...existing.models, ...models }
  } else {
    config.provider[providerName] = {
      npm: '@ai-sdk/openai-compatible',
      name: providerName,
      options: {
        baseURL: baseUrl,
        apiKey: 'iap-token',
      },
      models,
    }
  }
}
