import type { PluginConfig, OpencodeModelConfig } from './types.js'
import type { Config } from '@opencode-ai/plugin'

interface LiteLLMHealthModel {
  model: string
  model_id: string
}

interface LiteLLMModelInfo {
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

function toModelConfig(modelName: string, info: LiteLLMModelInfo = {}): OpencodeModelConfig {
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

  return modelConfig
}

/**
 * Fetches available models from the LiteLLM proxy's /v1/model/info endpoint.
 * Falls back to /health + /model/info per model for older LiteLLM versions.
 * Maps the metadata to OpenCode's model config format.
 */
export async function discoverModels(
  config: PluginConfig,
  getToken: () => Promise<string>,
): Promise<Record<string, OpencodeModelConfig>> {
  const token = await getToken()
  const signal = AbortSignal.timeout(15_000)

  try {
    // Primary: use /v1/model/info — single call, returns all models with full metadata
    const modelInfoResponse = await fetch(`${config.url}/v1/model/info`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
        signal,
    })

    if (modelInfoResponse.ok) {
      const modelInfoBody = await modelInfoResponse.json()
      const modelData = modelInfoBody.data as Array<{ model_name?: string; model_info?: LiteLLMModelInfo }> | undefined

      if (Array.isArray(modelData) && modelData.length > 0) {
        const models: Record<string, OpencodeModelConfig> = {}

        for (const entry of modelData) {
          if (!entry?.model_name) continue

          const modelName = entry.model_name
          models[modelName] = toModelConfig(modelName, entry.model_info)
        }

        return models
      }
    }

    // Fallback: use /health + /model/info per model (legacy approach)
    const healthResponse = await fetch(`${config.url}/health`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal,
    })

    if (healthResponse.status === 403) {
      throw new Error(
        'Access denied. Contact your admin to grant access to the LLM proxy.',
      )
    }

    if (!healthResponse.ok) return {}

    const healthBody = await healthResponse.json()
    const healthyEndpoints = healthBody.healthy_endpoints as LiteLLMHealthModel[] | undefined
    if (!Array.isArray(healthyEndpoints) || healthyEndpoints.length === 0) return {}

    // Fetch model info for each healthy endpoint
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
              signal,
            },
          )

          if (!infoResponse.ok) return null

          const infoBody = await infoResponse.json()
          const data = infoBody.data as Array<{ model_name?: string; model_info?: LiteLLMModelInfo }> | undefined
          if (!Array.isArray(data) || !data[0]) return null

          const entry = data[0]
          if (!entry.model_name) return null
          return { modelName: entry.model_name, info: entry.model_info }
        } catch {
          return null
        }
      }),
    )

    // Map to OpenCode model config
    const models: Record<string, OpencodeModelConfig> = {}

    for (const modelInfo of modelInfos) {
      if (!modelInfo) continue
      models[modelInfo.modelName] = toModelConfig(modelInfo.modelName, modelInfo.info)
    }

    return models
  } catch (error: unknown) {
    // Timeout/abort or network error → return empty object
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      return {}
    }
    // Re-throw the 403 descriptive error
    if (error instanceof Error && error.message.includes('Access denied')) {
      throw error
    }
    // Network errors → return empty object
    return {}
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
