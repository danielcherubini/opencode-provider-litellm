import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tool } from '@opencode-ai/plugin'
import type { PluginConfig, McpTool } from './types.js'
import { discoverMcpTools, executeMcpTool, createMcpToolDefinitions } from './mcp-tools.js'

describe('discoverMcpTools', () => {
  const config: PluginConfig = {
    url: 'https://litellm.example.com',
    apiKey: 'test-api-key',
  }
  const token = 'test-token'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns tools from a mock response', async () => {
    const mockTools: McpTool[] = [
      {
        name: 'search',
        server_name: 'brave',
        description: 'Search the web',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      },
      {
        name: 'fetch',
        server_name: 'fetch',
        description: 'Fetch a URL',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
          },
          required: ['url'],
        },
      },
    ]

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockTools,
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await discoverMcpTools(config, token)

    expect(result).toEqual(mockTools)
    expect(mockFetch).toHaveBeenCalledWith(
      'https://litellm.example.com/mcp-rest/tools/list',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        }),
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it('returns [] on network error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network error'))
    vi.stubGlobal('fetch', mockFetch)

    const result = await discoverMcpTools(config, token)
    expect(result).toEqual([])
  })

  it('returns [] on 4xx response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await discoverMcpTools(config, token)
    expect(result).toEqual([])
  })

  it('returns [] on 5xx response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await discoverMcpTools(config, token)
    expect(result).toEqual([])
  })

  it('returns [] when response is not an array', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tools: [] }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await discoverMcpTools(config, token)
    expect(result).toEqual([])
  })

  it('returns [] when response is empty array', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await discoverMcpTools(config, token)
    expect(result).toEqual([])
  })

  it('respects timeout (AbortError after 10s)', async () => {
    const controller = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)

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

    const promise = discoverMcpTools(config, token)

    await Promise.resolve()
    controller.abort()

    const result = await promise

    expect(timeoutSpy).toHaveBeenCalledWith(10_000)
    expect(result).toEqual([])
  })
})

describe('executeMcpTool', () => {
  const config: PluginConfig = {
    url: 'https://litellm.example.com',
    apiKey: 'test-api-key',
  }
  const token = 'test-token'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns formatted result on success', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        result: { content: [{ type: 'text', text: 'Search results found' }] },
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await executeMcpTool(
      config,
      token,
      'brave',
      'search',
      { query: 'test' },
    )

    expect(result).toBe(JSON.stringify({ content: [{ type: 'text', text: 'Search results found' }] }, null, 2))
    expect(mockFetch).toHaveBeenCalledWith(
      'https://litellm.example.com/mcp-rest/tools/call',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ server: 'brave', tool: 'search', args: { query: 'test' } }),
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it('stringifies entire response when no result field', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        output: [{ type: 'text', text: 'plain text' }],
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await executeMcpTool(
      config,
      token,
      'brave',
      'search',
      { query: 'test' },
    )

    expect(result).toBe(JSON.stringify({ output: [{ type: 'text', text: 'plain text' }] }, null, 2))
  })

  it('returns error string on failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('connection refused'))
    vi.stubGlobal('fetch', mockFetch)

    const result = await executeMcpTool(
      config,
      token,
      'brave',
      'search',
      { query: 'test' },
    )

    expect(result).toBe('Error calling search on brave: connection refused')
  })

  it('returns error string on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await executeMcpTool(
      config,
      token,
      'myserver',
      'mytool',
      { arg1: 'val1' },
    )

    expect(result).toContain('Error calling mytool on myserver')
  })

  it('respects timeout (AbortError after 30s)', async () => {
    const controller = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)

    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise<string>((_resolve, reject) => {
        const signal = init?.signal
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        }
      })
    })
    vi.stubGlobal('fetch', mockFetch)

    const promise = executeMcpTool(
      config,
      token,
      'brave',
      'search',
      { query: 'test' },
    )

    await Promise.resolve()
    controller.abort()

    const result = await promise

    expect(timeoutSpy).toHaveBeenCalledWith(30_000)
    expect(result).toContain('Error calling search on brave')
  })
})

describe('createMcpToolDefinitions', () => {
  const config: PluginConfig = {
    url: 'https://litellm.example.com',
    apiKey: 'test-api-key',
  }
  const token = 'test-token'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('produces correct tool names (namespaced, sanitized)', async () => {
    const mockTools: McpTool[] = [
      {
        name: 'web-search',
        server_name: 'Brave-API',
        description: 'Search the web',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      },
    ]

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockTools,
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await createMcpToolDefinitions(config, token)

    expect(Object.keys(result)).toEqual(['mcp_brave_api_web_search'])
    const toolDef = result['mcp_brave_api_web_search']
    expect(toolDef.description).toBe('Search the web (via Brave-API MCP server)')
  })

  it('returns {} when no tools discovered', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await createMcpToolDefinitions(config, token)
    expect(result).toEqual({})
  })

  it('uses a single record arg for tool arguments', async () => {
    const mockTools: McpTool[] = [
      {
        name: 'test_tool',
        server_name: 'test_server',
        description: 'Test tool',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            count: { type: 'number' },
            is_active: { type: 'boolean' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['name'],
        },
      },
    ]

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockTools,
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await createMcpToolDefinitions(config, token)

    const toolDef = result['mcp_test_server_test_tool']
    expect(toolDef).toBeDefined()
    expect(toolDef.args.args).toBeInstanceOf(tool.schema.ZodRecord)
  })

  it('execute function calls executeMcpTool correctly', async () => {
    let callCount = 0
    const mockFetch = vi.fn().mockImplementation((_url: string, _init: RequestInit) => {
      callCount++
      if (callCount === 1) {
        // First call: discover
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [{
            name: 'search',
            server_name: 'brave',
            description: 'Search the web',
            input_schema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          }],
        })
      }
      // Second call: execute
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ result: { content: [{ type: 'text', text: 'found' }] } }),
      })
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await createMcpToolDefinitions(config, token)

    const toolDef = result['mcp_brave_search']
    expect(toolDef).toBeDefined()

    // Call execute
    const executeResult = await toolDef.execute({ args: { query: 'test' } }, {} as any)
    expect(executeResult).toBe(JSON.stringify({ content: [{ type: 'text', text: 'found' }] }, null, 2))
    expect(callCount).toBe(2)
    expect(JSON.parse(mockFetch.mock.calls[1][1].body as string).args).toEqual({ query: 'test' })
  })
})
