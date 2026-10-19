import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Model, Provider } from '@opencode/plugin'
import type { PluginConfig, DiscoveredModel } from './types.js'
import { discoverModels, toProviderInfo, toModelInfos } from './discovery.js'

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

describe('toProviderInfo', () => {
  it('builds a V2 provider entry on the openai-compatible package', () => {
    const info = toProviderInfo('litellm', 'https://litellm.example.com', 'sk-test-key')

    expect(info.id).toBe(Provider.ID.make('litellm'))
    expect(info.name).toBe('litellm')
    expect(info.activation).toBe('enabled')
    expect(info.package).toBe('@opencode/ai/providers/openai-compatible')
    expect(info.settings).toEqual({
      baseURL: 'https://litellm.example.com/v1',
      apiKey: 'sk-test-key',
    })
  })

  it('appends /v1 for a proxy root (the driver appends /chat/completions)', () => {
    const info = toProviderInfo('litellm', 'http://10.5.30.197:4000/', 'k')
    expect(info.settings?.baseURL).toBe('http://10.5.30.197:4000/v1')
  })

  it('does not double-append /v1 when the URL already ends with it', () => {
    const info = toProviderInfo('litellm', 'https://litellm.example.com/v1', 'k')
    expect(info.settings?.baseURL).toBe('https://litellm.example.com/v1')
  })
})

describe('toModelInfos', () => {
  it('maps discovered models to Model.Info entries', () => {
    const models: Record<string, DiscoveredModel> = {
      'gpt-4': {
        name: 'gpt-4',
        tool_call: true,
        reasoning: false,
        limit: { context: 8192, output: 8192 },
        modalities: { input: ['text'], output: ['text'] },
      },
    }

    const infos = toModelInfos('litellm', models)

    expect(infos).toHaveLength(1)
    const [m] = infos
    expect(m.id).toBe(Model.ID.make('gpt-4'))
    expect(m.modelID).toBe(Model.ID.make('gpt-4'))
    expect(m.providerID).toBe(Provider.ID.make('litellm'))
    expect(m.name).toBe('gpt-4')
    expect(m.capabilities).toEqual({ tools: true, input: ['text'], output: ['text'] })
    expect(m.limit).toEqual({ context: 8192, output: 8192 })
    expect(m.enabled).toBe(true)
    expect(m.status).toBe('active')
    expect(m.cost).toEqual([])
  })

  it('maps per-1M costs to a single tier with cache read/write', () => {
    const models: Record<string, DiscoveredModel> = {
      'anthropic/claude-sonnet': {
        name: 'anthropic/claude-sonnet',
        limit: { context: 1_000_000, output: 64_000 },
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 3.75 },
      },
    }

    const [m] = toModelInfos('litellm', models)

    expect(m.cost).toEqual([
      { input: 5, output: 25, cache: { read: 0.5, write: 3.75 } },
    ])
  })

  it('defaults missing cache costs to 0', () => {
    const models: Record<string, DiscoveredModel> = {
      gpt: { name: 'gpt', limit: { context: 8, output: 8 }, cost: { input: 1, output: 2 } },
    }

    const [m] = toModelInfos('litellm', models)

    expect(m.cost).toEqual([
      { input: 1, output: 2, cache: { read: 0, write: 0 } },
    ])
  })

  it('applies defaults for missing capabilities and modalities', () => {
    const models: Record<string, DiscoveredModel> = {
      bare: { name: 'bare', limit: { context: 4096, output: 4096 } },
    }

    const [m] = toModelInfos('litellm', models)

    expect(m.capabilities).toEqual({ tools: true, input: ['text'], output: ['text'] })
  })
})
