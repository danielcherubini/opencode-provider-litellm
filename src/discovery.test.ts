import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PluginConfig, OpencodeModelConfig } from './types.js'
import {
  discoverModels,
  buildProviderInfo,
  buildModelInfo,
  buildProviderRecord,
} from './discovery.js'
import { Provider } from '@opencode/schema/provider'

describe('discoverModels', () => {
  const config: PluginConfig = {
    url: 'https://litellm.example.com',
    apiKey: 'test-api-key',
  }
  const getToken = vi.fn(() => Promise.resolve('test-token'))

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns mapped models from LiteLLM response', async () => {
    const mockFetch = vi.fn()
      // /v1/model/info (primary — single call returns all models)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              model_name: 'gpt-4',
              model_info: {
                max_input_tokens: 8192,
                max_output_tokens: 8192,
                supports_function_calling: true,
                supports_reasoning: false,
                supports_vision: false,
                input_cost_per_token: 0.0001,
                output_cost_per_token: 0.0003,
              },
            },
            {
              model_name: 'qwen3-32b',
              model_info: {
                max_input_tokens: 32768,
                max_output_tokens: 32768,
                supports_function_calling: true,
                supports_reasoning: true,
                supports_vision: false,
                input_cost_per_token: 0.00005,
                output_cost_per_token: 0.00015,
              },
            },
          ],
        }),
      })
    vi.stubGlobal('fetch', mockFetch)

    const result = await discoverModels(config, getToken)

    expect(result).toEqual({
      'gpt-4': {
        name: 'gpt-4',
        tool_call: true,
        reasoning: false,
        limit: { context: 8192, output: 8192 },
        cost: { input: 100, output: 300 },
        modalities: { input: ['text'], output: ['text'] },
      },
      'qwen3-32b': {
        name: 'qwen3-32b',
        tool_call: true,
        reasoning: true,
        limit: { context: 32768, output: 32768 },
        cost: { input: 50, output: 150 },
        modalities: { input: ['text'], output: ['text'] },
      },
    })
    expect(mockFetch).toHaveBeenCalledWith(
      'https://litellm.example.com/v1/model/info',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
        signal: expect.any(AbortSignal),
      })
    )
    expect(getToken).toHaveBeenCalled()
  })

  it('converts per-token cost to per-1M tokens with cache costs', async () => {
    const mockFetch = vi.fn()
      // /v1/model/info (primary — single call returns all models)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{
            model_name: 'anthropic/claude-sonnet',
            model_info: {
              max_input_tokens: 1_000_000,
              max_output_tokens: 64_000,
              supports_function_calling: true,
              supports_reasoning: true,
              supports_vision: true,
              supports_pdf_input: true,
              // Per-token costs (LiteLLM format)
              input_cost_per_token: 0.000005,
              output_cost_per_token: 0.000025,
              cache_read_input_token_cost: 0.0000005,
              cache_creation_input_token_cost: 0.00000375,
            },
          }],
        }),
      })
    vi.stubGlobal('fetch', mockFetch)

    const result = await discoverModels(config, getToken)

    expect(result['anthropic/claude-sonnet']?.cost).toEqual({
      input: 5,         // 0.000005 * 1M
      output: 25,       // 0.000025 * 1M
      cache_read: 0.5,  // 0.0000005 * 1M
      cache_write: 3.75, // 0.00000375 * 1M
    })
  })

  it('returns empty object on timeout', async () => {
    vi.useFakeTimers()

    // Simulate a fetch that rejects when the abort signal fires
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        }
      })
    })
    vi.stubGlobal('fetch', mockFetch)

    // Run discoverModels
    const promise = discoverModels(config, getToken)

    // Advance timer past 15s timeout
    await vi.advanceTimersByTimeAsync(15001)

    const result = await promise

    vi.useRealTimers()

    expect(result).toEqual({})
  })

  it('throws descriptive error on 403', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    })
    vi.stubGlobal('fetch', mockFetch)

    await expect(discoverModels(config, getToken)).rejects.toThrow(
      'Access denied. Contact your admin to grant access to the LLM proxy.'
    )
  })

  it('returns empty object on 500', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await discoverModels(config, getToken)
    expect(result).toEqual({})
  })

  it('returns empty object on network error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network error'))
    vi.stubGlobal('fetch', mockFetch)

    const result = await discoverModels(config, getToken)
    expect(result).toEqual({})
  })
})

describe('buildProviderInfo', () => {
  it('creates provider info with enabled activation and openai-compatible package', () => {
    const info = buildProviderInfo('litellm', 'https://litellm.example.com', 'test-key')

    expect(info.id).toBe('litellm')
    expect(info.name).toBe('LiteLLM')
    expect(info.activation).toBe('enabled')
    expect(info.package).toBe('@opencode/ai/providers/openai-compatible')
    expect(info.settings).toEqual({
      baseURL: 'https://litellm.example.com',
      apiKey: 'test-key',
    })
  })

  it('omits apiKey from settings when not provided', () => {
    const info = buildProviderInfo('litellm', 'https://litellm.example.com')

    expect(info.settings).toEqual({
      baseURL: 'https://litellm.example.com',
    })
  })

  it('uses custom displayName when provided', () => {
    const info = buildProviderInfo('protector', 'https://llm.example.com', undefined, 'Protector AI')

    expect(info.id).toBe('protector')
    expect(info.name).toBe('Protector AI')
  })

  it('falls back to non-litellm providerId as name when displayName is omitted', () => {
    const info = buildProviderInfo('protector', 'https://llm.example.com')

    expect(info.id).toBe('protector')
    expect(info.name).toBe('protector')
  })
})

describe('buildModelInfo', () => {
  const providerID = Provider.ID.make('litellm')

  it('builds Model.Info with defaults and overrides', () => {
    const config: OpencodeModelConfig = {
      name: 'GPT-4 Turbo',
      tool_call: true,
      limit: { context: 128000.8, output: 4096.2 },
      modalities: { input: ['text', 'image'], output: ['text'] },
      cost: { input: 10, output: 30, cache_read: 2.5, cache_write: 5 },
    }

    const model = buildModelInfo(providerID, 'gpt-4-turbo', config)

    expect(model.id).toBe('gpt-4-turbo')
    expect(model.modelID).toBe('gpt-4-turbo')
    expect(model.providerID).toBe('litellm')
    expect(model.name).toBe('GPT-4 Turbo')
    expect(model.limit).toEqual({
      context: 128000,
      output: 4096,
    })
    expect(model.capabilities).toEqual({
      tools: true,
      input: ['text', 'image'],
      output: ['text'],
    })
    expect(model.cost).toEqual([
      {
        input: 10,
        output: 30,
        cache: { read: 2.5, write: 5 },
      },
    ])
  })

  it('falls back model name to id when config.name is empty', () => {
    const model = buildModelInfo(providerID, 'custom-model', {
      name: '',
    })

    expect(model.name).toBe('custom-model')
  })

  it('floors integer limits and uses defaults when limits are omitted', () => {
    const model = buildModelInfo(providerID, 'default-limits', {
      name: 'default-limits',
    })

    expect(model.limit.context).toBe(32768)
    expect(model.limit.output).toBe(4096)
  })

  it('sets tool capability to false when config.tool_call is false', () => {
    const model = buildModelInfo(providerID, 'no-tools', {
      name: 'no-tools',
      tool_call: false,
    })

    expect(model.capabilities.tools).toBe(false)
  })

  it('handles empty cost as empty array and fills default zero cache costs', () => {
    const modelWithoutCost = buildModelInfo(providerID, 'no-cost', {
      name: 'no-cost',
    })
    expect(modelWithoutCost.cost).toEqual([])

    const modelWithCostNoCache = buildModelInfo(providerID, 'cost-no-cache', {
      name: 'cost-no-cache',
      cost: { input: 1, output: 2 },
    })
    expect(modelWithCostNoCache.cost).toEqual([
      {
        input: 1,
        output: 2,
        cache: { read: 0, write: 0 },
      },
    ])
  })

  it('includes context_over_200k tier if defined', () => {
    const model = buildModelInfo(providerID, 'tiered-cost', {
      name: 'tiered-cost',
      cost: {
        input: 5,
        output: 15,
        context_over_200k: { input: 2.5, output: 7.5 },
      },
    })

    expect(model.cost).toEqual([
      {
        input: 5,
        output: 15,
        cache: { read: 0, write: 0 },
      },
      {
        tier: { type: 'context', size: 200000 },
        input: 2.5,
        output: 7.5,
        cache: { read: 0, write: 0 },
      },
    ])
  })
})

describe('buildProviderRecord', () => {
  it('builds provider info and array of model infos', () => {
    const models: Record<string, OpencodeModelConfig> = {
      'gpt-4': {
        name: 'GPT-4',
        tool_call: true,
        limit: { context: 8192, output: 4096 },
      },
      'claude-3': {
        name: 'Claude 3',
        tool_call: true,
        limit: { context: 200000, output: 4096 },
      },
    }

    const record = buildProviderRecord(
      'litellm',
      'https://litellm.example.com',
      'key-123',
      models,
    )

    expect(record.info.id).toBe('litellm')
    expect(record.info.settings?.baseURL).toBe('https://litellm.example.com')
    expect(record.models).toHaveLength(2)
    expect(record.models.map((m) => m.id)).toEqual(['gpt-4', 'claude-3'])
    expect(record.models[0].limit.context).toBe(8192)
    expect(record.models[1].limit.context).toBe(200000)
  })

  it('passes displayName to provider info', () => {
    const record = buildProviderRecord(
      'protector',
      'https://litellm.example.com',
      'key-123',
      {},
      'Protector Gateway',
    )
    expect(record.info.id).toBe('protector')
    expect(record.info.name).toBe('Protector Gateway')
  })
})
