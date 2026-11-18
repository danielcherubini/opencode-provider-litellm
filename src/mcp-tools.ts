import type { PluginConfig, McpTool } from './types.js'

/**
 * Discovers MCP tools available on the LiteLLM proxy by calling
 * GET /mcp-rest/tools/list.
 *
 * Returns an empty array on any error (network, 4xx, 5xx, parse failure).
 * Uses a 10s timeout via AbortController.
 */
export async function discoverMcpTools(
  config: PluginConfig,
  token: string,
): Promise<McpTool[]> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await fetch(`${config.url}/mcp-rest/tools/list`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      return []
    }

    const body = await response.json()

    if (!Array.isArray(body)) {
      return []
    }

    return body as McpTool[]
  } catch {
    return []
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Executes a specific MCP tool on the LiteLLM proxy by calling
 * POST /mcp-rest/tools/call.
 *
 * Returns the result as a formatted string. On error, returns an error
 * message string instead of throwing.
 * Uses a 30s timeout via AbortController.
 */
export async function executeMcpTool(
  config: PluginConfig,
  token: string,
  server: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30_000)

  try {
    const response = await fetch(`${config.url}/mcp-rest/tools/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ server, tool: toolName, args }),
      signal: controller.signal,
    })

    if (!response.ok) {
      return `Error calling ${toolName} on ${server}: HTTP ${response.status}`
    }

    const body = await response.json()

    if (body && typeof body === 'object' && 'result' in body) {
      return JSON.stringify(body.result, null, 2)
    }

    return JSON.stringify(body, null, 2)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return `Error calling ${toolName} on ${server}: ${message}`
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Sanitize a server name or tool name for use in opencode tool identifiers.
 * Lowercase, replace any non-alphanumeric chars with underscore.
 */
function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '_')
}

export interface McpToolDefinition {
  name: string
  description: string
  input: Record<string, unknown>
  execute: (input: unknown) => Promise<{ content: string }>
}

/**
 * Builds OpenCode v2 tool definitions using JSON Schema for all discovered MCP tools.
 *
 * Each MCP tool is registered with:
 * - name: mcp_${sanitizeName(server_name)}_${sanitizeName(name)}
 * - description: ${description || name} (via ${server_name} MCP server)
 * - input: JSON Schema object
 * - execute: returns { content: result }
 */
export async function buildMcpToolDefinitions(
  config: PluginConfig,
  getToken: () => Promise<string>,
): Promise<McpToolDefinition[]> {
  const token = await getToken()
  const mcpTools = await discoverMcpTools(config, token)

  if (mcpTools.length === 0) {
    return []
  }

  return mcpTools.map((mcpTool) => {
    const serverName = mcpTool.server_name
    const toolName = mcpTool.name
    const safeServer = sanitizeName(serverName)
    const safeTool = sanitizeName(toolName)
    const name = `mcp_${safeServer}_${safeTool}`
    const description = `${mcpTool.description || toolName} (via ${serverName} MCP server)`
    const input =
      mcpTool.input_schema && typeof mcpTool.input_schema === 'object'
        ? mcpTool.input_schema
        : { type: 'object', properties: {} }

    return {
      name,
      description,
      input,
      execute: async (args: unknown) => {
        const freshToken = await getToken()
        const normalizedArgs =
          args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
        const result = await executeMcpTool(
          config,
          freshToken,
          serverName,
          toolName,
          normalizedArgs,
        )
        return { content: result }
      },
    }
  })
}
