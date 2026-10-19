import { Model, Provider } from '@opencode/plugin'
import { Money } from '@opencode/schema'
import type { PluginConfig, DiscoveredModel } from './types.js'

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
 * Fetches available models from the LiteLLM proxy's /v1/model/info endpoint.
 * Falls back to /health + /model/info per model for older LiteLLM versions.
 * Maps the metadata to the plugin's DiscoveredModel format.
 */
export async function discoverModels(
  config: PluginConfig,
  getToken: () => Promise<string>,
): Promise<Record<string, DiscoveredModel>> {
  const token = await getToken()

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15_000)

  try {
    // Primary: use /v1/model/info — single call, returns all models with full metadata
    const modelInfoResponse = await fetch(`${config.url}/v1/model/info`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    })

    if (modelInfoResponse.ok) {
      const modelInfoBody = await modelInfoResponse.json()
      const modelData = modelInfoBody.data as Array<{ model_name?: string; model_info?: LiteLLMModelInfo }> | undefined

      if (Array.isArray(modelData) && modelData.length > 0) {
        const models: Record<string, DiscoveredModel> = {}

        for (const entry of modelData) {
          if (!entry?.model_name) continue

          const info = entry.model_info || {}
          const modelName = entry.model_name

          const inputModalities: Array<'text' | 'audio' | 'image' | 'video' | 'pdf'> = ['text']
          if (info.supports_vision) inputModalities.push('image')
          if (info.supports_audio_input) inputModalities.push('audio')
          if (info.supports_pdf_input) inputModalities.push('pdf')

          const modelConfig: DiscoveredModel = {
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

          models[modelName] = modelConfig
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
      signal: controller.signal,
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

    // Map to the plugin's DiscoveredModel format
    const models: Record<string, DiscoveredModel> = {}

    for (let i = 0; i < healthyEndpoints.length; i++) {
      const info = modelInfos[i]
      if (!info?.model_name) continue

      const modelName = info.model_name
      const inputModalities: Array<'text' | 'audio' | 'image' | 'video' | 'pdf'> = ['text']
      if (info.supports_vision) inputModalities.push('image')
      if (info.supports_audio_input) inputModalities.push('audio')
      if (info.supports_pdf_input) inputModalities.push('pdf')

      const modelConfig: DiscoveredModel = {
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
 * Builds the OpenCode V2 provider entry for the LiteLLM proxy.
 *
 * Uses the built-in openai-compatible provider package; the plugin
 * contributes the connection settings (baseURL + current API key). The
 * openai-compatible driver appends /chat/completions to the baseURL, so
 * point it at the proxy's /v1 prefix (LITELLM_URL stays the proxy root —
 * discovery calls <root>/v1/model/info).
 */
export function toProviderInfo(
  providerId: string,
  url: string,
  apiKey: string,
): Provider.Info {
  const id = Provider.ID.make(providerId)
  const root = url.replace(/\/+$/, '')
  return {
    ...Provider.Info.empty(id),
    name: providerId,
    activation: 'enabled',
    package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL: /\/v1$/.test(root) ? root : `${root}/v1`, apiKey },
  }
}

/**
 * Maps discovered models to OpenCode V2 Model.Info entries.
 */
export function toModelInfos(
  providerId: string,
  models: Record<string, DiscoveredModel>,
): Model.Info[] {
  const pid = Provider.ID.make(providerId)

  return Object.entries(models).map(([modelId, m]) => ({
    ...Model.Info.default(pid, Model.ID.make(modelId)),
    name: m.name,
    capabilities: {
      tools: m.tool_call ?? true,
      input: m.modalities?.input ?? ['text'],
      output: m.modalities?.output ?? ['text'],
    },
    limit: {
      context: m.limit.context,
      output: m.limit.output,
    },
    cost: toCostTiers(m.cost),
  }))
}

/**
 * Maps the flat per-1M cost fields to V2 cost tiers.
 * Absent cache costs default to 0 (the tier requires both).
 */
function toCostTiers(cost: DiscoveredModel['cost']): Model.Info['cost'] {
  if (!cost) return []

  const usd = (n: number) => Money.USDPerMillionTokens.make(n)
  return [
    Model.Cost.make({
      input: usd(cost.input),
      output: usd(cost.output),
      cache: {
        read: usd(cost.cache_read ?? 0),
        write: usd(cost.cache_write ?? 0),
      },
    }),
  ]
}
