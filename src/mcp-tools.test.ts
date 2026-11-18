import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PluginConfig, McpTool } from './types.js'
import { discoverMcpTools, executeMcpTool, buildMcpToolDefinitions } from './mcp-tools.js'

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
    vi.useFakeTimers()

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

    await vi.advanceTimersByTimeAsync(10001)

    const result = await promise

    vi.useRealTimers()

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
    vi.useFakeTimers()

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

    await vi.advanceTimersByTimeAsync(30001)

    const result = await promise

    vi.useRealTimers()

    expect(result).toContain('Error calling search on brave')
  })
})

describe('buildMcpToolDefinitions', () => {
  const config: PluginConfig = {
    url: 'https://litellm.example.com',
    apiKey: 'test-api-key',
  }

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('produces correct tool definitions with exact naming and description suffix', async () => {
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

    const getToken = vi.fn().mockResolvedValue('token-1')

    const tools = await buildMcpToolDefinitions(config, getToken)

    expect(getToken).toHaveBeenCalledTimes(1)
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('mcp_brave_api_web_search')
    expect(tools[0].description).toBe('Search the web (via Brave-API MCP server)')
    expect(tools[0].input).toEqual(mockTools[0].input_schema)
  })

  it('uses tool.name in description when tool.description is empty or missing', async () => {
    const mockTools: McpTool[] = [
      {
        name: 'echo',
        server_name: 'util_server',
        description: '',
        input_schema: { type: 'object', properties: {} },
      },
    ]

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockTools,
    })
    vi.stubGlobal('fetch', mockFetch)

    const getToken = vi.fn().mockResolvedValue('token-1')

    const tools = await buildMcpToolDefinitions(config, getToken)

    expect(tools).toHaveLength(1)
    expect(tools[0].description).toBe('echo (via util_server MCP server)')
  })

  it('uses fallback empty object schema when input_schema is missing or not an object', async () => {
    const mockTools = [
      {
        name: 'no_schema',
        server_name: 'test',
        description: 'No schema tool',
        input_schema: null as any,
      },
      {
        name: 'primitive_schema',
        server_name: 'test',
        description: 'Primitive schema tool',
        input_schema: 'invalid' as any,
      },
    ]

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockTools,
    })
    vi.stubGlobal('fetch', mockFetch)

    const getToken = vi.fn().mockResolvedValue('token-1')

    const tools = await buildMcpToolDefinitions(config, getToken)

    expect(tools).toHaveLength(2)
    expect(tools[0].input).toEqual({ type: 'object', properties: {} })
    expect(tools[1].input).toEqual({ type: 'object', properties: {} })
  })

  it('invokes fresh token per execute call and returns { content: string }', async () => {
    const mockTools: McpTool[] = [
      {
        name: 'search',
        server_name: 'brave',
        description: 'Search',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
    ]

    let fetchCount = 0
    const mockFetch = vi.fn().mockImplementation((_url: string, _init: RequestInit) => {
      fetchCount++
      if (fetchCount === 1) {
        // Discovery
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => mockTools,
        })
      }
      // Execute
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ result: `result for call ${fetchCount}` }),
      })
    })
    vi.stubGlobal('fetch', mockFetch)

    let tokenIndex = 0
    const getToken = vi.fn().mockImplementation(async () => {
      tokenIndex++
      return `token-${tokenIndex}`
    })

    const tools = await buildMcpToolDefinitions(config, getToken)
    expect(tools).toHaveLength(1)
    expect(getToken).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/mcp-rest/tools/list'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
        }),
      }),
    )

    // First execution
    const res1 = await tools[0].execute({ query: 'hello' })
    expect(getToken).toHaveBeenCalledTimes(2)
    expect(res1).toEqual({ content: JSON.stringify('result for call 2', null, 2) })
    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.stringContaining('/mcp-rest/tools/call'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token-2',
        }),
        body: JSON.stringify({
          server: 'brave',
          tool: 'search',
          args: { query: 'hello' },
        }),
      }),
    )

    // Second execution
    const res2 = await tools[0].execute({ query: 'world' })
    expect(getToken).toHaveBeenCalledTimes(3)
    expect(res2).toEqual({ content: JSON.stringify('result for call 3', null, 2) })
    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.stringContaining('/mcp-rest/tools/call'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token-3',
        }),
        body: JSON.stringify({
          server: 'brave',
          tool: 'search',
          args: { query: 'world' },
        }),
      }),
    )
  })

  it('handles non-object args in execute by passing empty object', async () => {
    const mockTools: McpTool[] = [
      {
        name: 'test',
        server_name: 'test_srv',
        description: 'Test',
        input_schema: { type: 'object', properties: {} },
      },
    ]

    let fetchCount = 0
    const mockFetch = vi.fn().mockImplementation(() => {
      fetchCount++
      if (fetchCount === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => mockTools,
        })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ result: 'ok' }),
      })
    })
    vi.stubGlobal('fetch', mockFetch)

    const getToken = vi.fn().mockResolvedValue('token')
    const tools = await buildMcpToolDefinitions(config, getToken)

    const res = await tools[0].execute(null)
    expect(res).toEqual({ content: JSON.stringify('ok', null, 2) })
    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.stringContaining('/mcp-rest/tools/call'),
      expect.objectContaining({
        body: JSON.stringify({
          server: 'test_srv',
          tool: 'test',
          args: {},
        }),
      }),
    )
  })

  it('returns empty array when no tools are discovered', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    })
    vi.stubGlobal('fetch', mockFetch)

    const getToken = vi.fn().mockResolvedValue('token')
    const tools = await buildMcpToolDefinitions(config, getToken)
    expect(tools).toEqual([])
  })
})
