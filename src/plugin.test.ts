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
  getProviderId: vi.fn(() => 'litellm'),
  mapLiteLLMModel: vi.fn(),
}))

// Mock the MCP tools module
vi.mock('./mcp-tools.js', () => ({
  createMcpToolDefinitions: vi.fn(),
}))

import { LiteLLMPlugin } from './plugin.js'
import { discoverModels, injectModelsIntoConfig } from './discovery.js'
import { resolvePluginConfig } from './utils.js'
import { createMcpToolDefinitions } from './mcp-tools.js'

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

describe('LiteLLMPlugin', () => {
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
      url: 'https://litellm.example.com',
      apiKey: 'test-api-key',
    })

    // Default MCP mock: returns one tool
    vi.mocked(createMcpToolDefinitions).mockResolvedValue({
      mcp_test_server_test_tool: 'mock-mcp-tool',
    })
  })

  it('throws on missing config', async () => {
    vi.mocked(resolvePluginConfig).mockReturnValue(null)

    await expect(
      LiteLLMPlugin(mockInput, {})
    ).rejects.toThrow(
      "Plugin config error: set 'url' and 'apiKey'",
    )
  })

  it('config hook calls discoverModels and injects models into config', async () => {
    const hooks = await LiteLLMPlugin(mockInput, {
      url: 'https://litellm.example.com',
      apiKey: 'test-api-key',
    })

    const testConfig = {} as never
    await hooks.config?.(testConfig)

    expect(discoverModels).toHaveBeenCalledWith(
      { url: 'https://litellm.example.com', apiKey: 'test-api-key' },
      expect.any(Function),
    )
    expect(injectModelsIntoConfig).toHaveBeenCalledWith(
      testConfig,
      'litellm',
      'https://litellm.example.com',
      'test-api-key',
      expect.any(Object),
    )
    expect(logFn).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          service: 'litellm',
          level: 'info',
          message: expect.stringContaining('Discovered'),
        }),
      }),
    )
  })

  it('config hook catches errors and does not throw', async () => {
    vi.mocked(discoverModels).mockRejectedValue(new Error('Network error'))

    const hooks = await LiteLLMPlugin(mockInput, {
      url: 'https://litellm.example.com',
      apiKey: 'test-api-key',
    })

    await expect(hooks.config?.({} as never)).resolves.not.toThrow()

    expect(logFn).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          service: 'litellm',
          level: 'warn',
          message: expect.stringContaining('Model discovery failed'),
        }),
      }),
    )
  })

  it('config hook logs warning and skips inject when no models discovered', async () => {
    vi.mocked(discoverModels).mockResolvedValue({})

    const hooks = await LiteLLMPlugin(mockInput, {
      url: 'https://litellm.example.com',
      apiKey: 'test-api-key',
    })

    await hooks.config?.({} as never)

    expect(injectModelsIntoConfig).not.toHaveBeenCalled()
    expect(logFn).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          service: 'litellm',
          level: 'warn',
          message: 'No models discovered',
        }),
      }),
    )
  })

  it('auth hook returns success when API key is provided', async () => {
    const hooks = await LiteLLMPlugin(mockInput, {
      url: 'https://litellm.example.com',
      apiKey: 'test-api-key',
    })

    const result = await hooks.auth?.methods[0].authorize?.({ apiKey: 'user-pasted-key' })

    expect(result).toEqual({ type: 'success', key: 'user-pasted-key' })
  })

  it('auth hook returns failed when API key is empty', async () => {
    const hooks = await LiteLLMPlugin(mockInput, {
      url: 'https://litellm.example.com',
      apiKey: 'test-api-key',
    })

    const result = await hooks.auth?.methods[0].authorize?.({ apiKey: '' })
    expect(result).toEqual({ type: 'failed' })
  })

  it('auth hook returns failed when no inputs provided', async () => {
    const hooks = await LiteLLMPlugin(mockInput, {
      url: 'https://litellm.example.com',
      apiKey: 'test-api-key',
    })

    const result = await hooks.auth?.methods[0].authorize?.()
    expect(result).toEqual({ type: 'failed' })
  })

  it('tool hook returns merged MCP + Skills tools', async () => {
    const hooks = await LiteLLMPlugin(mockInput, {
      url: 'https://litellm.example.com',
      apiKey: 'test-api-key',
    })

    expect(hooks.tool).toBeDefined()
    expect(hooks.tool).toHaveProperty('mcp_test_server_test_tool')
  })

  it('tool hook passes correct config and apiKey to createMcpToolDefinitions', async () => {
    await LiteLLMPlugin(mockInput, {
      url: 'https://litellm.example.com',
      apiKey: 'test-api-key',
    })

    expect(createMcpToolDefinitions).toHaveBeenCalledWith(
      { url: 'https://litellm.example.com', apiKey: 'test-api-key' },
      'test-api-key',
    )
  })

  it('MCP discovery failure does not break the plugin', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(createMcpToolDefinitions).mockRejectedValue(new Error('MCP server unavailable'))

    const hooks = await LiteLLMPlugin(mockInput, {
      url: 'https://litellm.example.com',
      apiKey: 'test-api-key',
    })

    expect(warnSpy).toHaveBeenCalledWith(
      '[opencode-provider-litellm] MCP tool discovery failed: Error: MCP server unavailable',
    )

    // Skills tools should still be present
    expect(hooks.tool).toBeDefined()
    // MCP tools should not be present (empty object merged)
    expect(hooks.tool).not.toHaveProperty('mcp_test_server_test_tool')

    warnSpy.mockRestore()
  })

  it('plugin works with env vars (no inline config)', async () => {
    process.env.LITELLM_URL = 'https://env.litellm.example.com'
    process.env.LITELLM_KEY = 'env-api-key'

    vi.mocked(resolvePluginConfig).mockReturnValue({
      url: 'https://env.litellm.example.com',
      apiKey: 'env-api-key',
    })

    const hooks = await LiteLLMPlugin(mockInput, undefined)

    expect(hooks.tool).toBeDefined()
    expect(createMcpToolDefinitions).toHaveBeenCalledWith(
      { url: 'https://env.litellm.example.com', apiKey: 'env-api-key' },
      'env-api-key',
    )

    delete process.env.LITELLM_URL
    delete process.env.LITELLM_KEY
  })
})
