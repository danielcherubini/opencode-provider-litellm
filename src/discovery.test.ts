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
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'gpt-4', max_model_len: 8192 },
          { id: 'qwen3-32b', max_model_len: 32768 },
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
        modalities: { input: ['text'], output: ['text'] },
      },
      'qwen3-32b': {
        name: 'qwen3-32b',
        tool_call: true,
        reasoning: true,
        limit: { context: 32768, output: 32768 },
        modalities: { input: ['text'], output: ['text'] },
      },
    })
    expect(mockFetch).toHaveBeenCalledWith(
      'https://litellm.example.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
        signal: expect.any(AbortSignal),
      })
    )
    expect(getToken).toHaveBeenCalled()
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

    injectModelsIntoConfig(config, 'protector', 'https://litellm.example.com', models)

    expect(config.provider).toEqual({
      protector: {
        npm: '@ai-sdk/openai-compatible',
        name: 'protector',
        options: { baseURL: 'https://litellm.example.com', apiKey: 'iap-token' },
        models,
      },
    })
  })

  it('merges with existing provider config without overwriting options', async () => {
    const config: TestConfig = {
      provider: {
        protector: {
          npm: '@ai-sdk/openai-compatible',
          name: 'protector',
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

    injectModelsIntoConfig(config, 'protector', 'https://litellm.example.com', newModels)

    // Existing options should be preserved
    expect(config.provider!.protector.options).toEqual({
      baseURL: 'https://old.example.com',
      apiKey: 'old-key',
      extra: 'value',
    })

    // Models should be merged
    expect(config.provider!.protector.models).toEqual({
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
        protector: {
          npm: '@ai-sdk/openai-compatible',
          name: 'protector',
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

    injectModelsIntoConfig(config, 'protector', 'https://litellm.example.com', newModels)

    // All existing options should be preserved
    const provider = config.provider!.protector
    expect(provider.options!.baseURL).toBe('https://preserved.example.com')
    expect(provider.options!.apiKey).toBe('preserved-key')
    expect(provider.options!.customHeader).toBe('custom-value')

    // New models should be added
    expect(Object.keys(provider.models!)).toContain('gpt-4')
  })
})
