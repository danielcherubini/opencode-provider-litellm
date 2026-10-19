import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Plugin } from '@opencode/plugin'
import type { DiscoveredModel } from './types.js'
import { setup } from './plugin.js'
import { discoverModels, toProviderInfo, toModelInfos } from './discovery.js'
import { resolvePluginConfig, getProviderId } from './utils.js'
import { createMcpToolDefinitions } from './mcp-tools.js'
import { getGcloudToken } from './gcloud-token.js'
import { loadModelCache, saveModelCache } from './model-cache.js'

// Mock the discovery module
vi.mock('./discovery.js', () => ({
  discoverModels: vi.fn(),
  toProviderInfo: vi.fn(),
  toModelInfos: vi.fn(),
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
  loadModelCache: vi.fn().mockResolvedValue(null),
  saveModelCache: vi.fn().mockResolvedValue(undefined),
}))

const liveModels: Record<string, DiscoveredModel> = {
  'gpt-4': {
    name: 'gpt-4',
    tool_call: true,
    reasoning: false,
    limit: { context: 8192, output: 8192 },
    modalities: { input: ['text'], output: ['text'] },
  },
}

interface EditorMock {
  add: (entry: unknown) => void
}

/**
 * Builds a mock V2 plugin context (Plugin.Context) and exposes the
 * registration callbacks for assertions.
 */
function createMockCtx(options: Record<string, unknown> = {}) {
  const providerTransform = vi.fn().mockResolvedValue({ dispose: vi.fn() })
  const providerReload = vi.fn().mockResolvedValue(undefined)
  const toolTransform = vi.fn().mockResolvedValue({ dispose: vi.fn() })
  const sessionHook = vi.fn().mockResolvedValue({ dispose: vi.fn() })
  const storageGet = vi.fn().mockResolvedValue(undefined)
  const storageSet = vi.fn().mockResolvedValue(undefined)

  const ctx = {
    app: { name: 'opencode', version: '2.0.27', channel: 'test' },
    location: {
      directory: '/test',
      project: { id: 'project-test', directory: '/test', canonical: '/test' },
    },
    options,
    provider: { transform: providerTransform, reload: providerReload },
    tool: { transform: toolTransform },
    session: { hook: sessionHook },
    storage: { get: storageGet, set: storageSet },
  } as unknown as Plugin.Context

  return {
    ctx,
    providerTransform,
    providerReload,
    toolTransform,
    sessionHook,
    storageGet,
    storageSet,
  }
}

type MockCtx = ReturnType<typeof createMockCtx>

describe('setup', () => {
  let mk: MockCtx

  beforeEach(() => {
    vi.resetAllMocks()
    delete process.env.LITELLM_GCLOUD_TOKEN_AUTH

    mk = createMockCtx({
      url: 'https://litellm.example.com',
      apiKey: 'test-api-key',
    })

    vi.mocked(resolvePluginConfig).mockReturnValue({
      url: 'https://litellm.example.com',
      apiKey: 'test-api-key',
    })
    vi.mocked(getProviderId).mockReturnValue('litellm')
    vi.mocked(discoverModels).mockResolvedValue(liveModels)
    vi.mocked(toProviderInfo).mockReturnValue({} as never)
    vi.mocked(toModelInfos).mockReturnValue([] as never)
    vi.mocked(createMcpToolDefinitions).mockResolvedValue([] as never)
    vi.mocked(loadModelCache).mockResolvedValue(null)
    vi.mocked(saveModelCache).mockResolvedValue(undefined)
    vi.mocked(getGcloudToken).mockResolvedValue(null)
  })

  afterEach(() => {
    delete process.env.LITELLM_GCLOUD_TOKEN_AUTH
    vi.restoreAllMocks()
  })

  it('throws a descriptive error when no config is available', async () => {
    vi.mocked(resolvePluginConfig).mockReturnValue(null)

    await expect(setup(mk.ctx)).rejects.toThrow(
      "Plugin config error: set 'url' and 'apiKey' in plugin options, or set LITELLM_URL and LITELLM_KEY environment variables.",
    )

    expect(mk.providerTransform).not.toHaveBeenCalled()
    expect(mk.toolTransform).not.toHaveBeenCalled()
    expect(mk.sessionHook).not.toHaveBeenCalled()
  })

  it('uses the gcloud-specific error when LITELLM_GCLOUD_TOKEN_AUTH is set', async () => {
    vi.mocked(resolvePluginConfig).mockReturnValue(null)
    process.env.LITELLM_GCLOUD_TOKEN_AUTH = '1'

    await expect(setup(mk.ctx)).rejects.toThrow(
      'LITELLM_KEY is optional when LITELLM_GCLOUD_TOKEN_AUTH=1',
    )
  })

  it('registers the provider from the cache, then refreshes with live discovery', async () => {
    const cachedModels: Record<string, DiscoveredModel> = {
      'cached-model': { name: 'cached-model', limit: { context: 1024, output: 1024 } },
    }
    vi.mocked(loadModelCache).mockResolvedValue(cachedModels)

    const providerEditor: EditorMock = { add: vi.fn() }
    let capturedTransform: ((editor: EditorMock) => void) | undefined
    mk.providerTransform.mockImplementation((cb: (editor: EditorMock) => void) => {
      capturedTransform = cb
      cb(providerEditor) // initial registry build
      return { dispose: vi.fn() }
    })

    await setup(mk.ctx)

    expect(mk.providerTransform).toHaveBeenCalledTimes(1)
    expect(providerEditor.add).toHaveBeenCalledTimes(1)
    expect(toProviderInfo).toHaveBeenCalledWith(
      'litellm',
      'https://litellm.example.com',
      'test-api-key',
    )
    expect(toModelInfos).toHaveBeenNthCalledWith(1, 'litellm', cachedModels)
    expect(discoverModels).toHaveBeenCalledWith(
      { url: 'https://litellm.example.com', apiKey: 'test-api-key' },
      expect.any(Function),
    )

    // The live discovery result is cached and the registry is rebuilt
    expect(saveModelCache).toHaveBeenCalledWith(mk.ctx, 'litellm', liveModels)
    expect(mk.providerReload).toHaveBeenCalledTimes(1)

    // Replaying the transform callback (what the registry does on reload)
    // picks up the live models
    capturedTransform!(providerEditor)
    expect(toModelInfos).toHaveBeenLastCalledWith('litellm', liveModels)
  })

  it('warns and keeps the cache when no models are discovered', async () => {
    const cachedModels: Record<string, DiscoveredModel> = {
      cached: { name: 'cached', limit: { context: 1, output: 1 } },
    }
    vi.mocked(loadModelCache).mockResolvedValue(cachedModels)
    vi.mocked(discoverModels).mockResolvedValue({})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await setup(mk.ctx)

    expect(warn).toHaveBeenCalledWith('[opencode-provider-litellm] No models discovered')
    expect(saveModelCache).not.toHaveBeenCalled()
    expect(mk.providerReload).not.toHaveBeenCalled()
    expect(mk.providerTransform).toHaveBeenCalledTimes(1)
  })

  it('survives a discovery failure with a warning', async () => {
    vi.mocked(discoverModels).mockRejectedValue(new Error('Network error'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(setup(mk.ctx)).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledWith(
      '[opencode-provider-litellm] Model discovery failed: Error: Network error',
    )
    expect(saveModelCache).not.toHaveBeenCalled()
    expect(mk.providerReload).not.toHaveBeenCalled()
    expect(mk.providerTransform).toHaveBeenCalledTimes(1)
  })

  it('registers discovered MCP tools via ctx.tool.transform', async () => {
    const definitions = [
      {
        name: 'mcp_test_server_test_tool',
        description: 'Test tool (via test_server MCP server)',
        input: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
        execute: vi.fn(async () => ({ content: 'ok' })),
      },
    ]
    vi.mocked(createMcpToolDefinitions).mockResolvedValue(definitions as never)

    const toolEditor: EditorMock = { add: vi.fn() }
    mk.toolTransform.mockImplementation((cb: (editor: EditorMock) => void) => {
      cb(toolEditor)
      return { dispose: vi.fn() }
    })

    await setup(mk.ctx)

    expect(createMcpToolDefinitions).toHaveBeenCalledWith(
      { url: 'https://litellm.example.com', apiKey: 'test-api-key' },
      'test-api-key',
    )
    expect(toolEditor.add).toHaveBeenCalledWith({
      name: 'mcp_test_server_test_tool',
      description: 'Test tool (via test_server MCP server)',
      input: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      execute: expect.any(Function),
    })
  })

  it('survives MCP discovery failure without registering tools', async () => {
    vi.mocked(createMcpToolDefinitions).mockRejectedValue(new Error('MCP unavailable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const toolEditor: EditorMock = { add: vi.fn() }
    mk.toolTransform.mockImplementation((cb: (editor: EditorMock) => void) => {
      cb(toolEditor)
      return { dispose: vi.fn() }
    })

    await expect(setup(mk.ctx)).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledWith(
      '[opencode-provider-litellm] MCP tool discovery failed: Error: MCP unavailable',
    )
    expect(toolEditor.add).not.toHaveBeenCalled()
  })

  it('registers model.request and context hooks scoped to the provider', async () => {
    await setup(mk.ctx)

    expect(mk.sessionHook).toHaveBeenCalledTimes(2)
    expect(mk.sessionHook.mock.calls.map((c) => c[0])).toEqual(['model.request', 'context'])
    for (const call of mk.sessionHook.mock.calls) {
      expect(call[2]).toEqual({ providerID: 'litellm' })
    }
  })

  it('injects X-Litellm-Session-ID into model requests', async () => {
    await setup(mk.ctx)

    const headerHook = mk.sessionHook.mock.calls.find((c) => c[0] === 'model.request')![1] as (
      e: any,
    ) => Promise<void>

    const event: { headers: Record<string, string>; sessionID: string } = {
      headers: {},
      sessionID: 'test-session-123',
    }
    await headerHook(event)

    expect(event.headers['X-Litellm-Session-ID']).toBe('test-session-123')
    expect(event.headers['Authorization']).toBeUndefined()
  })

  it('injects a fresh gcloud token into model requests when enabled', async () => {
    process.env.LITELLM_GCLOUD_TOKEN_AUTH = '1'
    vi.mocked(getGcloudToken).mockResolvedValue('mock-gcloud-token')

    const mk2 = createMockCtx({ url: 'https://litellm.example.com', apiKey: '' })
    await setup(mk2.ctx)

    const headerHook = mk2.sessionHook.mock.calls.find((c) => c[0] === 'model.request')![1] as (
      e: any,
    ) => Promise<void>

    const event: { headers: Record<string, string>; sessionID: string } = {
      headers: {},
      sessionID: 'test-session-123',
    }
    await headerHook(event)

    expect(event.headers['Authorization']).toBe('Bearer mock-gcloud-token')
    expect(event.headers['X-Litellm-Session-ID']).toBe('test-session-123')
  })

  describe('thinking normalization (context hook)', () => {
    async function normalize(options: Record<string, unknown>): Promise<Record<string, unknown>> {
      await setup(mk.ctx)

      const contextHook = mk.sessionHook.mock.calls.find((c) => c[0] === 'context')![1] as (
        e: any,
      ) => void

      const event = { options: { ...options } }
      contextHook(event)
      return event.options
    }

    it('maps the string "enabled" to { type: "adaptive" }', async () => {
      expect(await normalize({ thinking: 'enabled' })).toEqual({ thinking: { type: 'adaptive' } })
    })

    it('maps the string "disabled" to { type: "disabled" }', async () => {
      expect(await normalize({ thinking: 'disabled' })).toEqual({ thinking: { type: 'disabled' } })
    })

    it('maps the string "off" to { type: "disabled" }', async () => {
      expect(await normalize({ thinking: 'off' })).toEqual({ thinking: { type: 'disabled' } })
    })

    it('maps non-standard string levels to { type: "adaptive" }', async () => {
      expect(await normalize({ thinking: 'medium' })).toEqual({ thinking: { type: 'adaptive' } })
    })

    it('maps non-standard dict types to "adaptive" and keeps other fields', async () => {
      expect(
        await normalize({ thinking: { type: 'medium', budget_tokens: 1000 } }),
      ).toEqual({
        thinking: { type: 'adaptive', budget_tokens: 1000 },
      })
    })

    it('leaves valid dict types untouched', async () => {
      expect(
        await normalize({ thinking: { type: 'enabled', budget_tokens: 1000 } }),
      ).toEqual({
        thinking: { type: 'enabled', budget_tokens: 1000 },
      })
    })

    it('leaves an empty thinking object untouched', async () => {
      expect(await normalize({ thinking: {} })).toEqual({ thinking: {} })
    })

    it('leaves a null thinking untouched', async () => {
      expect(await normalize({ thinking: null })).toEqual({ thinking: null })
    })
  })
})
