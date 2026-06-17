import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
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
}))

// Mock the MCP tools module
vi.mock('./mcp-tools.js', () => ({
  createMcpToolDefinitions: vi.fn(),
}))

// Mock the gcloud token module
vi.mock('./gcloud-token.js', () => ({
  getGcloudToken: vi.fn(),
  resetTokenCache: vi.fn(),
}))

// Mock the model cache module — no cache by default
vi.mock('./model-cache.js', () => ({
  loadModelCache: vi.fn().mockReturnValue(null),
  saveModelCache: vi.fn(),
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
    delete process.env.LITELLM_GCLOUD_TOKEN_AUTH

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

  afterEach(() => {
    delete process.env.LITELLM_GCLOUD_TOKEN_AUTH
  })

  it('throws on missing config', async () => {
    vi.mocked(resolvePluginConfig).mockReturnValue(null)

    await expect(
      LiteLLMPlugin(mockInput, {})
    ).rejects.toThrow(
      "Plugin config error: set 'url' and 'apiKey'",
    )
  })

  it('throws gcloud-specific error when LITELLM_GCLOUD_TOKEN_AUTH is set but config is missing', async () => {
    vi.mocked(resolvePluginConfig).mockReturnValue(null)
    process.env.LITELLM_GCLOUD_TOKEN_AUTH = '1'

    await expect(
      LiteLLMPlugin(mockInput, {})
    ).rejects.toThrow(
      'LITELLM_KEY is optional when LITELLM_GCLOUD_TOKEN_AUTH=1',
    )
  })

  it('throws generic error when LITELLM_GCLOUD_TOKEN_AUTH is not set and config is missing', async () => {
    vi.mocked(resolvePluginConfig).mockReturnValue(null)
    delete process.env.LITELLM_GCLOUD_TOKEN_AUTH

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

  describe('chat.headers', () => {
    it('always registers chat.headers hook', async () => {
      delete process.env.LITELLM_GCLOUD_TOKEN_AUTH

      const hooks = await LiteLLMPlugin(mockInput, {
        url: 'https://litellm.example.com',
        apiKey: 'test-api-key',
      })

      expect(hooks['chat.headers']).toBeDefined()
      expect(typeof hooks['chat.headers']).toBe('function')
    })

    it('injects session ID header', async () => {
      const hooks = await LiteLLMPlugin(mockInput, {
        url: 'https://litellm.example.com',
        apiKey: 'test-api-key',
      })

      const output = { headers: {} as Record<string, string> }
      await (hooks['chat.headers'] as Function)(
        { sessionID: 'test-session-123' },
        output,
      )
      expect(output.headers['X-Litellm-Session-ID']).toBe('test-session-123')
    })

    it('skips session ID header when sessionID is empty', async () => {
      const hooks = await LiteLLMPlugin(mockInput, {
        url: 'https://litellm.example.com',
        apiKey: 'test-api-key',
      })

      const output = { headers: {} as Record<string, string> }
      await (hooks['chat.headers'] as Function)(
        { sessionID: '' },
        output,
      )
      expect(output.headers['X-Litellm-Session-ID']).toBeUndefined()
    })

    it('injects gcloud token when LITELLM_GCLOUD_TOKEN_AUTH is set', async () => {
      process.env.LITELLM_GCLOUD_TOKEN_AUTH = '1'

      const { getGcloudToken } = await import('./gcloud-token.js')
      vi.mocked(getGcloudToken).mockResolvedValue('mock-gcloud-token')

      const hooks = await LiteLLMPlugin(mockInput, {
        url: 'https://litellm.example.com',
        apiKey: 'test-api-key',
      })

      const output = { headers: {} as Record<string, string> }
      await (hooks['chat.headers'] as Function)(
        { sessionID: 'test-session-123' },
        output,
      )
      expect(output.headers['Authorization']).toBe('Bearer mock-gcloud-token')
      expect(output.headers['X-Litellm-Session-ID']).toBe('test-session-123')
    })

    it('does not inject gcloud token when LITELLM_GCLOUD_TOKEN_AUTH is unset', async () => {
      delete process.env.LITELLM_GCLOUD_TOKEN_AUTH

      const hooks = await LiteLLMPlugin(mockInput, {
        url: 'https://litellm.example.com',
        apiKey: 'test-api-key',
      })

      const output = { headers: {} as Record<string, string> }
      await (hooks['chat.headers'] as Function)(
        { sessionID: 'test-session-123' },
        output,
      )
      expect(output.headers['Authorization']).toBeUndefined()
      expect(output.headers['X-Litellm-Session-ID']).toBe('test-session-123')
    })
  })

  describe('chat.params thinking normalization', () => {
    it('normalizes thinking string "enabled" to adaptive', async () => {
      const hooks = await LiteLLMPlugin(mockInput, {
        url: 'https://litellm.example.com',
        apiKey: 'test-api-key',
      })

      const output = { options: { thinking: 'enabled' } as Record<string, unknown> }
      await (hooks['chat.params'] as Function)({}, output)
      expect(output.options.thinking).toEqual({ type: 'adaptive' })
    })

    it('normalizes thinking string "disabled" to disabled', async () => {
      const hooks = await LiteLLMPlugin(mockInput, {
        url: 'https://litellm.example.com',
        apiKey: 'test-api-key',
      })

      const output = { options: { thinking: 'disabled' } as Record<string, unknown> }
      await (hooks['chat.params'] as Function)({}, output)
      expect(output.options.thinking).toEqual({ type: 'disabled' })
    })

    it('normalizes thinking string "off" to disabled', async () => {
      const hooks = await LiteLLMPlugin(mockInput, {
        url: 'https://litellm.example.com',
        apiKey: 'test-api-key',
      })

      const output = { options: { thinking: 'off' } as Record<string, unknown> }
      await (hooks['chat.params'] as Function)({}, output)
      expect(output.options.thinking).toEqual({ type: 'disabled' })
    })

    it('normalizes thinking string "medium" to adaptive', async () => {
      const hooks = await LiteLLMPlugin(mockInput, {
        url: 'https://litellm.example.com',
        apiKey: 'test-api-key',
      })

      const output = { options: { thinking: 'medium' } as Record<string, unknown> }
      await (hooks['chat.params'] as Function)({}, output)
      expect(output.options.thinking).toEqual({ type: 'adaptive' })
    })

    it('normalizes thinking dict with non-standard type to adaptive', async () => {
      const hooks = await LiteLLMPlugin(mockInput, {
        url: 'https://litellm.example.com',
        apiKey: 'test-api-key',
      })

      const output = { options: { thinking: { type: 'medium', budget_tokens: 1000 } } as Record<string, unknown> }
      await (hooks['chat.params'] as Function)({}, output)
      expect(output.options.thinking).toEqual({ type: 'adaptive', budget_tokens: 1000 })
    })

    it('leaves thinking dict with valid type untouched', async () => {
      const hooks = await LiteLLMPlugin(mockInput, {
        url: 'https://litellm.example.com',
        apiKey: 'test-api-key',
      })

      const output = { options: { thinking: { type: 'enabled', budget_tokens: 1000 } } as Record<string, unknown> }
      await (hooks['chat.params'] as Function)({}, output)
      expect(output.options.thinking).toEqual({ type: 'enabled', budget_tokens: 1000 })
    })

    it('leaves missing thinking untouched', async () => {
      const hooks = await LiteLLMPlugin(mockInput, {
        url: 'https://litellm.example.com',
        apiKey: 'test-api-key',
      })

      const output = { options: {} as Record<string, unknown> }
      await (hooks['chat.params'] as Function)({}, output)
      expect(output.options.thinking).toBeUndefined()
    })

    it('leaves thinking null untouched', async () => {
      const hooks = await LiteLLMPlugin(mockInput, {
        url: 'https://litellm.example.com',
        apiKey: 'test-api-key',
      })

      const output = { options: { thinking: null } as Record<string, unknown> }
      await (hooks['chat.params'] as Function)({}, output)
      expect(output.options.thinking).toBeNull()
    })
  })
})
