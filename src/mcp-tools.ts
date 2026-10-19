import type { PluginConfig, McpTool } from './types.js'

/**
 * A tool definition ready for ctx.tool.transform (V2 Tool.Info shape:
 * name, description, JSON Schema input, and an execute returning
 * structured content).
 */
export interface McpToolDefinition {
  name: string
  description: string
  /** JSON Schema for the tool input. */
  input: any
  execute: (
    input: Record<string, unknown>,
    context: { signal: AbortSignal },
  ) => Promise<{ content: string }>
}

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
 * Uses a 30s timeout via AbortController; an external signal (e.g. the
 * session's abort signal) also cancels the request.
 */
export async function executeMcpTool(
  config: PluginConfig,
  token: string,
  server: string,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30_000)

  let onAbort: (() => void) | undefined
  if (signal) {
    if (signal.aborted) {
      controller.abort()
    } else {
      onAbort = () => controller.abort()
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }

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
    if (signal && onAbort) {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * Sanitize a server name or tool name for use in opencode tool identifiers.
 * Lowercase, replace any non-alphanumeric chars with underscore.
 */
function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '_')
}

function isObjectSchema(inputSchema: Record<string, unknown>): boolean {
  return !!inputSchema && typeof inputSchema === 'object' && inputSchema.type === 'object'
}

/**
 * Converts a LiteLLM input_schema to a V2 tool input schema.
 *
 * V2 tools accept JSON Schema directly, so object schemas pass through
 * as-is (properties/required). Schemas that are not plain objects fall
 * back to a single `args` record field, mirroring the V1 single-arg mode.
 */
function toInputSchema(inputSchema: Record<string, unknown>): any {
  if (isObjectSchema(inputSchema)) {
    return {
      type: 'object',
      properties: inputSchema.properties && typeof inputSchema.properties === 'object'
        ? inputSchema.properties
        : {},
      required: Array.isArray(inputSchema.required) ? inputSchema.required : [],
    }
  }

  // Fallback: single-arg mode
  return {
    type: 'object',
    properties: {
      args: { type: 'object', description: 'Tool arguments as key-value pairs' },
    },
    required: ['args'],
  }
}

/**
 * Creates opencode tool definitions for all discovered MCP tools.
 *
 * Each MCP tool is registered as `mcp_${serverName}_${toolName}` with
 * a description appended with the server name.
 *
 * Returns an empty array if no tools are discovered.
 */
export async function createMcpToolDefinitions(
  config: PluginConfig,
  token: string,
): Promise<McpToolDefinition[]> {
  const mcpTools = await discoverMcpTools(config, token)

  const definitions: McpToolDefinition[] = []

  for (const mcpTool of mcpTools) {
    const serverName = mcpTool.server_name
    const toolName = mcpTool.name

    const safeServer = sanitizeName(serverName)
    const safeTool = sanitizeName(toolName)

    const inputSchema = mcpTool.input_schema ?? {}
    const isFallback = !isObjectSchema(inputSchema)

    definitions.push({
      name: `mcp_${safeServer}_${safeTool}`,
      description: `${mcpTool.description} (via ${serverName} MCP server)`,
      input: toInputSchema(inputSchema),
      async execute(input: Record<string, unknown>, context: { signal: AbortSignal }) {
        // Single-arg mode: the model sends the arguments under `args`
        const raw = input
        const args = isFallback &&
          raw && typeof raw === 'object' &&
          raw.args && typeof raw.args === 'object'
          ? (raw.args as Record<string, unknown>)
          : raw
        return { content: await executeMcpTool(config, token, serverName, toolName, args, context.signal) }
      },
    })
  }

  return definitions
}
