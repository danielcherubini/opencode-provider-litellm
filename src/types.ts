export interface PluginConfig {
  url: string
  apiKey: string
}

export interface LiteLLMModel {
  id: string
  max_model_len?: number
}

export interface OpencodeModelConfig {
  name: string
  tool_call?: boolean
  reasoning?: boolean
  limit?: {
    context: number
    output: number
  }
  modalities?: {
    input: Array<"text" | "audio" | "image" | "video" | "pdf">
    output: Array<"text" | "audio" | "image" | "video" | "pdf">
  }
}
