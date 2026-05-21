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
 * Check if a JSON Schema property can be mapped to a zod type.
 * Returns true for: string, number, integer, boolean, array of strings.
 * Returns false for: nested objects, $ref, anyOf, etc.
 */
function isMappableSchema(propSchema: unknown): boolean {
  if (!propSchema || typeof propSchema !== 'object') return false

  const schema = propSchema as Record<string, unknown>

  // Reject if it has $ref or anyOf
  if ('$ref' in schema || 'anyOf' in schema || 'oneOf' in schema || 'allOf' in schema) {
    return false
  }

  const type = schema.type as string | undefined
  if (!type) return false

  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean') {
    return true
  }

  if (type === 'array') {
    const items = schema.items as Record<string, unknown> | undefined
    if (items && items.type === 'string') {
      return true
    }
    return false
  }

  return false
}

/**
 * Build zod args from a JSON Schema input_schema.
 * Returns null if the schema cannot be mapped (use single-arg fallback).
 */
function buildZodArgs(inputSchema: Record<string, unknown>): Record<string, unknown> | null {
  const properties = inputSchema.properties as Record<string, unknown> | undefined
  const required = (inputSchema.required as string[] | undefined) ?? []

  if (!properties || typeof properties !== 'object') {
    return null
  }

  // Check if all properties are mappable
  for (const key of Object.keys(properties)) {
    if (!isMappableSchema(properties[key])) {
      return null
    }
  }

  const zodArgs: Record<string, unknown> = {}

  for (const [key, propSchema] of Object.entries(properties)) {
    const schema = propSchema as Record<string, unknown>
    const type = schema.type as string | undefined
    const isRequired = required.includes(key)

    let zodField: unknown

    switch (type) {
      case 'string':
        zodField = tool.schema.string().describe(key)
        break
      case 'number':
      case 'integer':
        zodField = tool.schema.number().describe(key)
        break
      case 'boolean':
        zodField = tool.schema.boolean().describe(key)
        break
      case 'array': {
        const items = schema.items as Record<string, unknown> | undefined
        if (items && items.type === 'string') {
          zodField = tool.schema.array(tool.schema.string()).describe(key)
        } else {
          return null
        }
        break
      }
      default:
        return null
    }

    if (!isRequired) {
      // @ts-expect-error — optional() is available on all zod types
      zodField = zodField.optional()
    }

    zodArgs[key] = zodField
  }

  return zodArgs
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

    // Build args from input_schema
    const zodArgs = buildZodArgs(mcpTool.input_schema)

    let args: Record<string, any>
    if (zodArgs) {
      args = zodArgs
    } else {
      // Fallback: single-arg mode
      args = {
        args: tool.schema
          .record(tool.schema.string(), tool.schema.unknown())
          .describe('Tool arguments as key-value pairs'),
      }
    }

    definitions[opencodeName] = tool({
      description,
      args: args as Parameters<typeof tool>[0]['args'],
      async execute(args: Record<string, unknown>, _context: unknown): Promise<string> {
        return executeMcpTool(config, token, serverName, toolName, args)
      },
    })
  }

  return definitions
}
