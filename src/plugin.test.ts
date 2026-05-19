import { vi, describe, it, expect, beforeEach } from 'vitest'
import type { PluginInput } from '@opencode-ai/plugin'
import type { OpencodeModelConfig } from './types.js'

// Mock the discovery module
vi.mock('./discovery.js', () => ({
  discoverModels: vi.fn(),
  injectModelsIntoConfig: vi.fn(),
}))

// Mock the utils module
vi.mock('./utils.js', () => ({
  resolvePluginConfig: vi.fn(),
  mapLiteLLMModel: vi.fn(),
}))

import { ProtectorLlmPlugin } from './plugin.js'
import { discoverModels, injectModelsIntoConfig } from './discovery.js'
import { resolvePluginConfig } from './utils.js'

function createMockInput(): PluginInput {
  const logFn = vi.fn().mockResolvedValue(true)
  return {
    client: {
      app: { log: logFn },
    } as never,
    $: vi.fn() as never,
    project: {} as never,
    directory: '/test',
    worktree: '/test',
    serverUrl: new URL('http://localhost'),
    experimental_workspace: {
      register: vi.fn(),
    },
  }
}

describe('ProtectorLlmPlugin', () => {
  let mockInput: PluginInput
  let logFn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetAllMocks()

    mockInput = createMockInput()
    logFn = mockInput.client.app.log as ReturnType<typeof vi.fn>

    const models: Record<string, OpencodeModelConfig> = {
      'gpt-4': {
        name: 'gpt-4',
        tool_call: true,
        reasoning: false,
        limit: { context: 8192, output: 8192 },
        modalities: { input: ['text'], output: ['text'] },
      },
    }
    vi.mocked(discoverModels).mockResolvedValue(models)
    vi.mocked(injectModelsIntoConfig).mockImplementation(() => {})
    vi.mocked(resolvePluginConfig).mockReturnValue({
      url: 'https://protector.example.com',
      apiKey: 'test-api-key',
    })
  })

  it('throws on missing config', async () => {
    vi.mocked(resolvePluginConfig).mockReturnValue(null)

    await expect(
      ProtectorLlmPlugin(mockInput, {})
    ).rejects.toThrow(
      "Plugin config error: set 'url' and 'apiKey'",
    )
  })

  it('config hook calls discoverModels and injects models into config', async () => {
    const hooks = await ProtectorLlmPlugin(mockInput, {
      url: 'https://protector.example.com',
      apiKey: 'test-api-key',
    })

    const testConfig = {} as never
    await hooks.config?.(testConfig)

    expect(discoverModels).toHaveBeenCalledWith(
      { url: 'https://protector.example.com', apiKey: 'test-api-key' },
      expect.any(Function),
    )
    expect(injectModelsIntoConfig).toHaveBeenCalledWith(
      testConfig,
      'protector',
      'https://protector.example.com',
      expect.any(Object),
    )
    expect(logFn).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          service: 'protector',
          level: 'info',
          message: expect.stringContaining('Discovered'),
        }),
      }),
    )
  })

  it('config hook catches errors and does not throw', async () => {
    vi.mocked(discoverModels).mockRejectedValue(new Error('Network error'))

    const hooks = await ProtectorLlmPlugin(mockInput, {
      url: 'https://protector.example.com',
      apiKey: 'test-api-key',
    })

    await expect(hooks.config?.({} as never)).resolves.not.toThrow()

    expect(logFn).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          service: 'protector',
          level: 'warn',
          message: expect.stringContaining('Model discovery failed'),
        }),
      }),
    )
  })

  it('config hook logs warning and skips inject when no models discovered', async () => {
    vi.mocked(discoverModels).mockResolvedValue({})

    const hooks = await ProtectorLlmPlugin(mockInput, {
      url: 'https://protector.example.com',
      apiKey: 'test-api-key',
    })

    await hooks.config?.({} as never)

    expect(injectModelsIntoConfig).not.toHaveBeenCalled()
    expect(logFn).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          service: 'protector',
          level: 'warn',
          message: 'No models discovered',
        }),
      }),
    )
  })

  it('auth hook returns success when API key is provided', async () => {
    const hooks = await ProtectorLlmPlugin(mockInput, {
      url: 'https://protector.example.com',
      apiKey: 'test-api-key',
    })

    const result = await hooks.auth?.methods[0].authorize?.({ apiKey: 'user-pasted-key' })

    expect(result).toEqual({ type: 'success', key: 'user-pasted-key' })
  })

  it('auth hook returns failed when API key is empty', async () => {
    const hooks = await ProtectorLlmPlugin(mockInput, {
      url: 'https://protector.example.com',
      apiKey: 'test-api-key',
    })

    const result = await hooks.auth?.methods[0].authorize?.({ apiKey: '' })
    expect(result).toEqual({ type: 'failed' })
  })

  it('auth hook returns failed when no inputs provided', async () => {
    const hooks = await ProtectorLlmPlugin(mockInput, {
      url: 'https://protector.example.com',
      apiKey: 'test-api-key',
    })

    const result = await hooks.auth?.methods[0].authorize?.()
    expect(result).toEqual({ type: 'failed' })
  })

  it('chat.headers hook adds Authorization header for protector-llm provider', async () => {
    const hooks = await ProtectorLlmPlugin(mockInput, {
      url: 'https://protector.example.com',
      apiKey: 'test-api-key',
    })

    const input = {
      provider: {
        info: { id: 'protector' },
      } as never,
    } as never
    const output = { headers: {} as Record<string, string> }

    await hooks['chat.headers']?.(input, output)

    expect(output.headers['Authorization']).toBe('Bearer test-api-key')
  })

  it('chat.headers hook skips non-protector-llm providers', async () => {
    const hooks = await ProtectorLlmPlugin(mockInput, {
      url: 'https://protector.example.com',
      apiKey: 'test-api-key',
    })

    const input = {
      provider: {
        info: { id: 'openai' },
      } as never,
    } as never
    const output = { headers: {} as Record<string, string> }

    await hooks['chat.headers']?.(input, output)

    expect(output.headers['Authorization']).toBeUndefined()
  })
})
