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

  it('maps JSON Schema types correctly', async () => {
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
            optional_val: { type: 'string' },
          },
          required: ['name', 'count', 'is_active', 'tags'],
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

    // Check that args were built correctly
    const args = toolDef.args
    expect(args).toBeDefined()

    const z = tool.schema

    // Required string field
    expect(args.name).toBeInstanceOf(z.ZodString)
    expect(args.name.isOptional()).toBe(false)

    // Required number field
    expect(args.count).toBeInstanceOf(z.ZodNumber)
    expect(args.count.isOptional()).toBe(false)

    // Required boolean field
    expect(args.is_active).toBeInstanceOf(z.ZodBoolean)
    expect(args.is_active.isOptional()).toBe(false)

    // Required array field
    expect(args.tags).toBeInstanceOf(z.ZodArray)
    expect(args.tags.isOptional()).toBe(false)

    // Optional field
    expect(args.optional_val.isOptional()).toBe(true)
  })

  it('falls back to single-arg mode for unmappable schemas', async () => {
    const mockTools: McpTool[] = [
      {
        name: 'complex_tool',
        server_name: 'complex_server',
        description: 'Complex tool with nested schema',
        input_schema: {
          type: 'object',
          properties: {
            nested: {
              type: 'object',
              properties: {
                deep: { type: 'string' },
              },
            },
          },
          required: ['nested'],
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

    const toolDef = result['mcp_complex_server_complex_tool']
    expect(toolDef).toBeDefined()

    // Should fall back to single-arg mode
    const args = toolDef.args
    expect(args.args).toBeDefined()
    expect(args.args).toBeInstanceOf(tool.schema.ZodRecord)
  })

  it('falls back to single-arg mode for $ref schemas', async () => {
    const mockTools: McpTool[] = [
      {
        name: 'ref_tool',
        server_name: 'ref_server',
        description: 'Tool with $ref',
        input_schema: {
          type: 'object',
          properties: {
            data: { $ref: '#/definitions/Data' },
          },
          required: ['data'],
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

    const toolDef = result['mcp_ref_server_ref_tool']
    expect(toolDef).toBeDefined()

    // Should fall back to single-arg mode
    const args = toolDef.args
    expect(args.args).toBeDefined()
    expect(args.args).toBeInstanceOf(tool.schema.ZodRecord)
  })

  it('falls back to single-arg mode for anyOf schemas', async () => {
    const mockTools: McpTool[] = [
      {
        name: 'anyof_tool',
        server_name: 'anyof_server',
        description: 'Tool with anyOf',
        input_schema: {
          type: 'object',
          properties: {
            value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
          },
          required: ['value'],
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

    const toolDef = result['mcp_anyof_server_anyof_tool']
    expect(toolDef).toBeDefined()

    // Should fall back to single-arg mode
    const args = toolDef.args
    expect(args.args).toBeDefined()
    expect(args.args).toBeInstanceOf(tool.schema.ZodRecord)
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
    const executeResult = await toolDef.execute({ query: 'test' }, {} as any)
    expect(executeResult).toBe(JSON.stringify({ content: [{ type: 'text', text: 'found' }] }, null, 2))
    expect(callCount).toBe(2)
  })

  it('maps integer type to number()', async () => {
    const mockTools: McpTool[] = [
      {
        name: 'int_tool',
        server_name: 'int_server',
        description: 'Tool with integer',
        input_schema: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
          },
          required: ['page'],
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

    const toolDef = result['mcp_int_server_int_tool']
    expect(toolDef).toBeDefined()

    const args = toolDef.args
    expect(args.page).toBeInstanceOf(tool.schema.ZodNumber)
  })
})
