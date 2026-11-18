import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { OpencodeModelConfig } from './types.js'

// Mock the discovery module
vi.mock('./discovery.js', () => ({
  discoverModels: vi.fn(),
  buildProviderInfo: vi.fn((id, url, apiKey, displayName) => ({
    id,
    name: displayName ?? 'LiteLLM',
    activation: 'enabled',
    package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL: url, ...(apiKey ? { apiKey } : {}) },
  })),
  buildModelInfo: vi.fn((providerID, id, m) => ({
    id,
    providerID,
    name: m.name ?? id,
  })),
}))

// Mock the utils module
vi.mock('./utils.js', () => ({
  resolvePluginConfig: vi.fn(),
  getProviderId: vi.fn(() => 'litellm'),
  getProviderDisplayName: vi.fn(() => 'LiteLLM'),
}))

// Mock the MCP tools module
vi.mock('./mcp-tools.js', () => ({
  buildMcpToolDefinitions: vi.fn(),
}))

// Mock the gcloud token module
vi.mock('./gcloud-token.js', () => ({
  getGcloudToken: vi.fn(),
  resetTokenCache: vi.fn(),
}))

// Mock the model cache module
vi.mock('./model-cache.js', () => ({
  loadModelCache: vi.fn().mockReturnValue(null),
  saveModelCache: vi.fn(),
}))

import { LiteLLMPlugin } from './plugin.js'
import { discoverModels, buildProviderInfo, buildModelInfo } from './discovery.js'
import { resolvePluginConfig } from './utils.js'
import { buildMcpToolDefinitions } from './mcp-tools.js'
import { loadModelCache, saveModelCache } from './model-cache.js'
import { getGcloudToken } from './gcloud-token.js'

function createMockContext(options?: Record<string, unknown>) {
  const providerEditor = {
    add: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    models: {
      set: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    },
  }
  const toolEditor = {
    add: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    namespace: vi.fn(),
  }
  const hooks = new Map<string, { callback: Function; options?: unknown }>()

  const ctx = {
    options: options ?? {},
    provider: {
      transform: vi.fn(async (cb: (editor: typeof providerEditor) => void) => {
        cb(providerEditor)
        return { dispose: vi.fn() }
      }),
      reload: vi.fn().mockResolvedValue(undefined),
    },
    tool: {
      transform: vi.fn(async (cb: (editor: typeof toolEditor) => void) => {
        cb(toolEditor)
        return { dispose: vi.fn() }
      }),
    },
    session: {
      hook: vi.fn(async (name: string, callback: Function, hookOptions?: unknown) => {
        hooks.set(name, { callback, options: hookOptions })
        return { dispose: vi.fn() }
      }),
    },
    _providerEditor: providerEditor,
    _toolEditor: toolEditor,
    _hooks: hooks,
  }

  return ctx
}

describe('LiteLLMPlugin (OpenCode v2)', () => {
  let mockCtx: ReturnType<typeof createMockContext>

  beforeEach(() => {
    vi.resetAllMocks()
    delete process.env.LITELLM_GCLOUD_TOKEN_AUTH

    mockCtx = createMockContext({
      url: 'https://litellm.example.com',
      apiKey: 'test-api-key',
    })

    const models: Record<string, OpencodeModelConfig> = {
      'gpt-4': {
        name: 'gpt-4',
        tool_call: true,
        reasoning: false,
        limit: { context: 8192, output: 8192 },
        modalities: { input: ['text'], output: ['text'] },
      },
    }
    vi.mocked(discoverModels).mockReturnValue(new Promise(() => {}))
    vi.mocked(resolvePluginConfig).mockReturnValue({
      url: 'https://litellm.example.com',
      apiKey: 'test-api-key',
    })
    vi.mocked(loadModelCache).mockReturnValue(null)
    vi.mocked(buildMcpToolDefinitions).mockResolvedValue([
      {
        name: 'mcp_brave_search',
        description: 'Search',
        input: { type: 'object', properties: {} },
        execute: vi.fn().mockResolvedValue({ content: 'result' }),
      },
    ])
    delete process.env.LITELLM_GCLOUD_TOKEN_AUTH
    delete process.env.LITELLM_PROVIDER_PROTECTOR_USE_GCLOUD_AUTH
  })

  afterEach(() => {
    delete process.env.LITELLM_GCLOUD_TOKEN_AUTH
    delete process.env.LITELLM_PROVIDER_PROTECTOR_USE_GCLOUD_AUTH
  })

  it('defines plugin with id "litellm"', () => {
    expect(LiteLLMPlugin.id).toBe('litellm')
    expect(typeof LiteLLMPlugin.setup).toBe('function')
  })

  describe('configuration errors', () => {
    it('throws when config is null', async () => {
      vi.mocked(resolvePluginConfig).mockReturnValue(null)

      await expect(
        LiteLLMPlugin.setup(mockCtx as any),
      ).rejects.toThrow("Plugin config error: set 'url' and 'apiKey'")
    })

    it('throws gcloud-specific error when LITELLM_GCLOUD_TOKEN_AUTH is set and config is null', async () => {
      vi.mocked(resolvePluginConfig).mockReturnValue(null)
      process.env.LITELLM_GCLOUD_TOKEN_AUTH = '1'

      await expect(
        LiteLLMPlugin.setup(mockCtx as any),
      ).rejects.toThrow('LITELLM_KEY is optional when LITELLM_GCLOUD_TOKEN_AUTH=1')
    })
  })

  describe('setup lifecycle', () => {
    it('registers provider synchronously via ctx.provider.transform', async () => {
      await LiteLLMPlugin.setup(mockCtx as any)

      expect(ctxTransformCalled(mockCtx.provider.transform)).toBe(true)
      expect(mockCtx._providerEditor.add).toHaveBeenCalledTimes(1)
      const added = mockCtx._providerEditor.add.mock.calls[0][0]
      expect(added.info).toEqual(expect.objectContaining({ id: 'litellm' }))
      expect(added.models).toEqual([])
    })

    it('preloads cached models into source.models', async () => {
      const cached: Record<string, OpencodeModelConfig> = {
        'cached-model': {
          name: 'cached-model',
          tool_call: true,
          reasoning: false,
          limit: { context: 4096, output: 4096 },
        },
      }
      vi.mocked(loadModelCache).mockReturnValue(cached)

      await LiteLLMPlugin.setup(mockCtx as any)

      expect(loadModelCache).toHaveBeenCalledWith('litellm')
      expect(buildModelInfo).toHaveBeenCalledWith('litellm', 'cached-model', cached['cached-model'])
      const added = mockCtx._providerEditor.add.mock.calls[0][0]
      expect(added.models).toHaveLength(1)
      expect(added.models[0].id).toBe('cached-model')
    })

    it('triggers live model discovery and reloads provider on success', async () => {
      let resolveDiscovery: (models: Record<string, OpencodeModelConfig>) => void
      const discoveryPromise = new Promise<Record<string, OpencodeModelConfig>>((resolve) => {
        resolveDiscovery = resolve
      })
      vi.mocked(discoverModels).mockReturnValue(discoveryPromise)

      await LiteLLMPlugin.setup(mockCtx as any)

      expect(mockCtx.provider.reload).not.toHaveBeenCalled()

      const discovered: Record<string, OpencodeModelConfig> = {
        'discovered-1': {
          name: 'discovered-1',
          tool_call: true,
          reasoning: false,
          limit: { context: 16384, output: 4096 },
        },
      }
      resolveDiscovery!(discovered)
      await flushPromises()

      expect(saveModelCache).toHaveBeenCalledWith('litellm', discovered)
      expect(mockCtx.provider.reload).toHaveBeenCalledTimes(1)
      const added = mockCtx._providerEditor.add.mock.calls[0][0]
      expect(added.models).toHaveLength(1)
      expect(added.models[0].id).toBe('discovered-1')
    })

    it('catches discovery error without throwing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.mocked(discoverModels).mockRejectedValue(new Error('Network failure'))

      await LiteLLMPlugin.setup(mockCtx as any)
      await flushPromises()

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[opencode-provider-litellm] Model discovery failed: Error: Network failure'),
      )
      warnSpy.mockRestore()
    })

    it('registers MCP tools via ctx.tool.transform', async () => {
      const mockTools = [
        {
          name: 'mcp_test_search',
          description: 'Search (via test MCP server)',
          input: { type: 'object', properties: {} },
          execute: vi.fn(),
        },
      ]
      vi.mocked(buildMcpToolDefinitions).mockResolvedValue(mockTools)

      await LiteLLMPlugin.setup(mockCtx as any)

      expect(buildMcpToolDefinitions).toHaveBeenCalledWith(
        { url: 'https://litellm.example.com', apiKey: 'test-api-key' },
        expect.any(Function),
      )
      expect(mockCtx.tool.transform).toHaveBeenCalledTimes(1)
      expect(mockCtx._toolEditor.add).toHaveBeenCalledWith(mockTools[0])
    })

    it('handles MCP discovery failure gracefully', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.mocked(buildMcpToolDefinitions).mockRejectedValue(new Error('MCP server down'))

      await expect(LiteLLMPlugin.setup(mockCtx as any)).resolves.not.toThrow()

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[opencode-provider-litellm] MCP tool discovery failed: Error: MCP server down'),
      )
      warnSpy.mockRestore()
    })
  })

  describe('session hooks', () => {
    it('registers model.request hook with providerID scoping', async () => {
      await LiteLLMPlugin.setup(mockCtx as any)

      expect(mockCtx.session.hook).toHaveBeenCalledWith(
        'model.request',
        expect.any(Function),
        { providerID: 'litellm' },
      )
    })

    it('registers thinking normalization hooks with providerID scoping', async () => {
      await LiteLLMPlugin.setup(mockCtx as any)

      for (const hookName of ['context', 'compaction', 'generate', 'title']) {
        expect(mockCtx.session.hook).toHaveBeenCalledWith(
          hookName,
          expect.any(Function),
          { providerID: 'litellm' },
        )
      }
    })

    describe('model.request hook headers', () => {
      it('sets static apiKey Authorization header when not gcloud auth', async () => {
        await LiteLLMPlugin.setup(mockCtx as any)

        const hook = mockCtx._hooks.get('model.request')!
        const event = { headers: {} as Record<string, string> }
        await hook.callback(event)

        expect(event.headers['Authorization']).toBe('Bearer test-api-key')
      })

      it('sets gcloud bearer token when LITELLM_GCLOUD_TOKEN_AUTH is set', async () => {
        process.env.LITELLM_GCLOUD_TOKEN_AUTH = '1'
        vi.mocked(getGcloudToken).mockResolvedValue('gcloud-oauth-token')

        await LiteLLMPlugin.setup(mockCtx as any)

        const hook = mockCtx._hooks.get('model.request')!
        const event = { headers: {} as Record<string, string> }
        await hook.callback(event)

        expect(event.headers['Authorization']).toBe('Bearer gcloud-oauth-token')
      })

      it('sets X-Litellm-Session-ID header when sessionID is provided', async () => {
        await LiteLLMPlugin.setup(mockCtx as any)

        const hook = mockCtx._hooks.get('model.request')!
        const event = { headers: {} as Record<string, string>, sessionID: 'sess-123' }
        await hook.callback(event)

        expect(event.headers['X-Litellm-Session-ID']).toBe('sess-123')
      })

      it('does not set X-Litellm-Session-ID when sessionID is empty or undefined', async () => {
        await LiteLLMPlugin.setup(mockCtx as any)

        const hook = mockCtx._hooks.get('model.request')!
        const event = { headers: {} as Record<string, string> }
        await hook.callback(event)

        expect(event.headers['X-Litellm-Session-ID']).toBeUndefined()
      })
    })

    describe('thinking param normalization', () => {
      it('normalizes thinking string "enabled" to adaptive', async () => {
        await LiteLLMPlugin.setup(mockCtx as any)

        const hook = mockCtx._hooks.get('context')!
        const event = { options: { thinking: 'enabled' } as Record<string, unknown> }
        await hook.callback(event)

        expect(event.options.thinking).toEqual({ type: 'adaptive' })
      })

      it('normalizes thinking string "disabled" to disabled', async () => {
        await LiteLLMPlugin.setup(mockCtx as any)

        const hook = mockCtx._hooks.get('context')!
        const event = { options: { thinking: 'disabled' } as Record<string, unknown> }
        await hook.callback(event)

        expect(event.options.thinking).toEqual({ type: 'disabled' })
      })

      it('normalizes thinking string "off" to disabled', async () => {
        await LiteLLMPlugin.setup(mockCtx as any)

        const hook = mockCtx._hooks.get('context')!
        const event = { options: { thinking: 'off' } as Record<string, unknown> }
        await hook.callback(event)

        expect(event.options.thinking).toEqual({ type: 'disabled' })
      })

      it('normalizes thinking string "medium" to adaptive', async () => {
        await LiteLLMPlugin.setup(mockCtx as any)

        const hook = mockCtx._hooks.get('compaction')!
        const event = { options: { thinking: 'medium' } as Record<string, unknown> }
        await hook.callback(event)

        expect(event.options.thinking).toEqual({ type: 'adaptive' })
      })

      it('normalizes thinking dict with non-standard type to adaptive', async () => {
        await LiteLLMPlugin.setup(mockCtx as any)

        const hook = mockCtx._hooks.get('generate')!
        const event = {
          options: { thinking: { type: 'medium', budget_tokens: 1000 } } as Record<string, unknown>,
        }
        await hook.callback(event)

        expect(event.options.thinking).toEqual({ type: 'adaptive', budget_tokens: 1000 })
      })

      it('leaves thinking dict with valid type untouched', async () => {
        await LiteLLMPlugin.setup(mockCtx as any)

        const hook = mockCtx._hooks.get('title')!
        const event = {
          options: { thinking: { type: 'enabled', budget_tokens: 1000 } } as Record<string, unknown>,
        }
        await hook.callback(event)

        expect(event.options.thinking).toEqual({ type: 'enabled', budget_tokens: 1000 })
      })

      it('leaves missing thinking untouched', async () => {
        await LiteLLMPlugin.setup(mockCtx as any)

        const hook = mockCtx._hooks.get('context')!
        const event = { options: {} as Record<string, unknown> }
        await hook.callback(event)

        expect(event.options.thinking).toBeUndefined()
      })

      it('leaves null thinking untouched', async () => {
        await LiteLLMPlugin.setup(mockCtx as any)

        const hook = mockCtx._hooks.get('context')!
        const event = { options: { thinking: null } as Record<string, unknown> }
        await hook.callback(event)

        expect(event.options.thinking).toBeNull()
      })
    })
  })
})

function ctxTransformCalled(mockFn: any): boolean {
  return mockFn.mock.calls.length > 0
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
