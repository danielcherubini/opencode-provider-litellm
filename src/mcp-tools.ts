import { tool } from '@opencode-ai/plugin'
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

/**
 * Creates opencode tool definitions for all discovered MCP tools.
 *
 * Each MCP tool is registered as `mcp_${serverName}_${toolName}` with
 * a description appended with the server name.
 *
 * Returns an empty object if no tools are discovered.
 */
export async function createMcpToolDefinitions(
  config: PluginConfig,
  token: string,
): Promise<Record<string, any>> {
  const mcpTools = await discoverMcpTools(config, token)

  if (mcpTools.length === 0) {
    return {}
  }

  const definitions: Record<string, any> = {}

  for (const mcpTool of mcpTools) {
    const serverName = mcpTool.server_name
    const toolName = mcpTool.name

    const safeServer = sanitizeName(serverName)
    const safeTool = sanitizeName(toolName)
    const opencodeName = `mcp_${safeServer}_${safeTool}`

    const description = `${mcpTool.description} (via ${serverName} MCP server)`

    const args = {
      args: tool.schema
        .record(tool.schema.string(), tool.schema.unknown())
        .describe('Tool arguments as key-value pairs'),
    }

    definitions[opencodeName] = tool({
      description,
      args: args as Parameters<typeof tool>[0]['args'],
      async execute(args: Record<string, unknown>, _context: unknown): Promise<string> {
        const toolArgs = args.args && typeof args.args === 'object'
          ? args.args as Record<string, unknown>
          : args
        return executeMcpTool(config, token, serverName, toolName, toolArgs)
      },
    })
  }

  return definitions
}
