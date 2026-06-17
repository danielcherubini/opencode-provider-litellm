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

export interface OpencodeModelConfig {
  name: string
  tool_call?: boolean
  reasoning?: boolean
  limit?: {
    context: number
    output: number
  }
  cost?: {
    input: number
    output: number
    cache_read?: number
    cache_write?: number
    context_over_200k?: {
      input: number
      output: number
    }
  }
  modalities?: {
    input: Array<"text" | "audio" | "image" | "video" | "pdf">
    output: Array<"text" | "audio" | "image" | "video" | "pdf">
  }
}
