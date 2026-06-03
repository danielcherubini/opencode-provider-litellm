import type { PluginConfig, OpencodeModelConfig } from './types.js'
import type { Config } from '@opencode-ai/plugin'

interface LiteLLMHealthModel {
  model: string
  model_id: string
}

interface LiteLLMModelInfo {
  model_name?: string
  max_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
  supports_function_calling?: boolean
  supports_reasoning?: boolean
  supports_vision?: boolean
  supports_audio_input?: boolean
  supports_pdf_input?: boolean
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_read_input_token_cost?: number
  cache_creation_input_token_cost?: number
}

/**
 * Fetches available models from the LiteLLM proxy's /health endpoint,
 * then fetches rich metadata from /model/info for each model.
 * Maps the metadata to OpenCode's model config format.
 */
export async function discoverModels(
  config: PluginConfig,
  getToken: () => Promise<string>,
): Promise<Record<string, OpencodeModelConfig>> {
  const token = await getToken()

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15_000)

  try {
    // Step 1: Get model list with internal UUIDs from /health
    const healthResponse = await fetch(`${config.url}/health`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    })

    if (healthResponse.status === 403) {
      throw new Error(
        'Access denied. Contact your admin to grant access to the LLM proxy.',
      )
    }

    if (!healthResponse.ok) {
      return {}
    }

    const healthBody = await healthResponse.json()
    const healthyEndpoints = healthBody.healthy_endpoints as LiteLLMHealthModel[] | undefined
    if (!Array.isArray(healthyEndpoints)) return {}

    // Step 2: Fetch rich metadata for each model in parallel
    const modelInfos = await Promise.all(
      healthyEndpoints.map(async (endpoint) => {
        try {
          const infoResponse = await fetch(
            `${config.url}/model/info?litellm_model_id=${encodeURIComponent(endpoint.model_id)}`,
            {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${token}`,
              },
              signal: controller.signal,
            },
          )

          if (!infoResponse.ok) return null

          const infoBody = await infoResponse.json()
          const data = infoBody.data as Array<{ model_name?: string; model_info?: LiteLLMModelInfo }> | undefined
          if (!Array.isArray(data) || !data[0]) return null

          return { model_name: data[0].model_name, ...data[0].model_info }
        } catch {
          return null
        }
      }),
    )

    // Step 3: Map to OpenCode model config
    const models: Record<string, OpencodeModelConfig> = {}

    for (let i = 0; i < healthyEndpoints.length; i++) {
      const info = modelInfos[i]
      if (!info?.model_name) continue

      const modelName = info.model_name

      const inputModalities: Array<'text' | 'audio' | 'image' | 'video' | 'pdf'> = ['text']
      if (info.supports_vision) inputModalities.push('image')
      if (info.supports_audio_input) inputModalities.push('audio')
      if (info.supports_pdf_input) inputModalities.push('pdf')

      const modelConfig: OpencodeModelConfig = {
        name: modelName,
        tool_call: info.supports_function_calling ?? true,
        reasoning: info.supports_reasoning ?? false,
        limit: {
          context: info.max_input_tokens ?? 32768,
          output: info.max_output_tokens ?? info.max_tokens ?? 32768,
        },
        modalities: {
          input: inputModalities,
          output: ['text'],
        },
      }

      // Add cost info if available
      // LiteLLM returns cost per single token; opencode expects cost per 1M tokens
      if (info.input_cost_per_token != null && info.output_cost_per_token != null) {
        modelConfig.cost = {
          input: info.input_cost_per_token * 1_000_000,
          output: info.output_cost_per_token * 1_000_000,
        }
        if (info.cache_read_input_token_cost != null) {
          modelConfig.cost.cache_read = info.cache_read_input_token_cost * 1_000_000
        }
        if (info.cache_creation_input_token_cost != null) {
          modelConfig.cost.cache_write = info.cache_creation_input_token_cost * 1_000_000
        }
      }

      models[modelName] = modelConfig
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
  apiKey: string,
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
      existing.options = { baseURL: baseUrl, apiKey }
    }
    existing.models = { ...existing.models, ...models }
  } else {
    config.provider[providerName] = {
      npm: '@ai-sdk/openai-compatible',
      name: providerName,
      options: {
        baseURL: baseUrl,
        apiKey,
      },
      models,
    }
  }
}
