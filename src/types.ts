export interface PluginConfig {
  url: string
  apiKey: string
}

export interface LiteLLMModel {
  id: string
  max_model_len?: number
}

export interface McpTool {
  name: string
  server_name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface SkillSource {
  source: string
  url: string
  path?: string
}

export interface Skill {
  id: string
  name: string
  version: string
  description: string | null
  source: SkillSource
  author: string | null
  homepage: string | null
  keywords: string | null
  category: string | null
  domain: string | null
  namespace: string | null
  enabled: boolean
  created_at: string
  updated_at: string
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
