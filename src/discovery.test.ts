import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PluginConfig, OpencodeModelConfig } from './types.js'
import { discoverModels, injectModelsIntoConfig } from './discovery.js'

interface TestConfig {
  provider?: Record<string, {
    npm?: string
    name?: string
    options?: Record<string, unknown>
    models?: Record<string, OpencodeModelConfig>
  }>
}

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

describe('injectModelsIntoConfig', () => {
  it('creates provider entry with correct structure', async () => {
    const config: TestConfig = {}
    const models: Record<string, OpencodeModelConfig> = {
      'gpt-4': {
        name: 'gpt-4',
        tool_call: true,
        reasoning: false,
        limit: { context: 8192, output: 8192 },
        modalities: { input: ['text' as const], output: ['text' as const] },
      },
    }

    injectModelsIntoConfig(config, 'litellm', 'https://litellm.example.com', 'sk-test-key', models)

    expect(config.provider).toEqual({
      litellm: {
        npm: '@ai-sdk/openai-compatible',
        name: 'litellm',
        options: { baseURL: 'https://litellm.example.com', apiKey: 'sk-test-key' },
        models,
      },
    })
  })

  it('merges with existing provider config without overwriting options', async () => {
    const config: TestConfig = {
      provider: {
        litellm: {
          npm: '@ai-sdk/openai-compatible',
          name: 'litellm',
          options: { baseURL: 'https://old.example.com', apiKey: 'old-key', extra: 'value' },
          models: {
            'existing-model': {
              name: 'existing-model',
              tool_call: true,
              reasoning: false,
              limit: { context: 4096, output: 4096 },
              modalities: { input: ['text' as const], output: ['text' as const] },
            },
          },
        },
      },
    }

    const newModels: Record<string, OpencodeModelConfig> = {
      'new-model': {
        name: 'new-model',
        tool_call: true,
        reasoning: false,
        limit: { context: 8192, output: 8192 },
        modalities: { input: ['text' as const], output: ['text' as const] },
      },
    }

    injectModelsIntoConfig(config, 'litellm', 'https://litellm.example.com', 'sk-test-key', newModels)

    // Existing options should be preserved
    expect(config.provider!.litellm.options).toEqual({
      baseURL: 'https://old.example.com',
      apiKey: 'old-key',
      extra: 'value',
    })

    // Models should be merged
    expect(config.provider!.litellm.models).toEqual({
      'existing-model': {
        name: 'existing-model',
        tool_call: true,
        reasoning: false,
        limit: { context: 4096, output: 4096 },
        modalities: { input: ['text' as const], output: ['text' as const] },
      },
      'new-model': {
        name: 'new-model',
        tool_call: true,
        reasoning: false,
        limit: { context: 8192, output: 8192 },
        modalities: { input: ['text' as const], output: ['text' as const] },
      },
    })
  })

  it('preserves existing provider options when merging', async () => {
    const config: TestConfig = {
      provider: {
        litellm: {
          npm: '@ai-sdk/openai-compatible',
          name: 'litellm',
          options: {
            baseURL: 'https://preserved.example.com',
            apiKey: 'preserved-key',
            customHeader: 'custom-value',
          },
          models: {},
        },
      },
    }

    const newModels: Record<string, OpencodeModelConfig> = {
      'gpt-4': {
        name: 'gpt-4',
        tool_call: true,
        reasoning: false,
        limit: { context: 8192, output: 8192 },
        modalities: { input: ['text' as const], output: ['text' as const] },
      },
    }

    injectModelsIntoConfig(config, 'litellm', 'https://litellm.example.com', 'sk-test-key', newModels)

    // All existing options should be preserved
    const provider = config.provider!.litellm
    expect(provider.options!.baseURL).toBe('https://preserved.example.com')
    expect(provider.options!.apiKey).toBe('preserved-key')
    expect(provider.options!.customHeader).toBe('custom-value')

    // New models should be added
    expect(Object.keys(provider.models!)).toContain('gpt-4')
  })
})
