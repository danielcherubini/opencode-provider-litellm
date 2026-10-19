export interface PluginConfig {
  url: string
  apiKey: string
}

export interface McpTool {
  name: string
  server_name: string
  description: string
  input_schema: Record<string, unknown>
}

/**
 * Model metadata discovered from the LiteLLM proxy.
 *
 * Intermediate shape between the proxy's /v1/model/info response and
 * OpenCode V2's `Model.Info` — see `toModelInfos` in discovery.ts.
 */
export interface DiscoveredModel {
  name: string
  tool_call?: boolean
  reasoning?: boolean
  limit: {
    context: number
    output: number
  }
  modalities?: {
    input: Array<'text' | 'audio' | 'image' | 'video' | 'pdf'>
    output: Array<'text' | 'audio' | 'image' | 'video' | 'pdf'>
  }
  cost?: {
    input: number
    output: number
    cache_read?: number
    cache_write?: number
  }
}
