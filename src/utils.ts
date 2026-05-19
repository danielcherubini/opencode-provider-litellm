import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LiteLLMModel, OpencodeModelConfig, PluginConfig } from './types.js'

/**
 * Maps a LiteLLM model to OpenCode model config format.
 */
export function mapLiteLLMModel(model: LiteLLMModel): OpencodeModelConfig {
  const maxLen = model.max_model_len ?? 32768
  const reasoning = /qwen3|deepseek-r1|o[134]/i.test(model.id)

  return {
    name: model.id,
    tool_call: true,
    reasoning,
    limit: {
      context: maxLen,
      output: maxLen,
    },
    modalities: {
      input: ['text'],
      output: ['text'],
    },
  }
}

/**
 * Reads plugin configuration from `~/.protector/config.json`.
 *
 * Returns `{ url, apiKey }` from the block matching the current `PROTECTOR_ENV`
 * (defaults to `"test"`), or `null` on any error.
 */
export function readConfigFile(): PluginConfig | null {
  try {
    const env =
      typeof process !== 'undefined' ? process.env.PROTECTOR_ENV : undefined
    const currentEnv = (env && env.length > 0 ? env : 'test') as string

    const filePath = join(homedir(), '.protector', 'config.json')
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw)

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }

    const envBlock = parsed[currentEnv]
    if (!envBlock || typeof envBlock !== 'object' || Array.isArray(envBlock)) {
      return null
    }

    const url = typeof envBlock.url === 'string' ? envBlock.url : ''
    const apiKey = typeof envBlock.apiKey === 'string' ? envBlock.apiKey : ''

    if (url.length === 0 || apiKey.length === 0) {
      return null
    }

    return { url, apiKey }
  } catch {
    return null
  }
}

/**
 * Resolves plugin configuration from environment variables, config options, or config file.
 *
 * Priority:
 * 1. PROTECTOR_LLM_URL / PROTECTOR_LLM_KEY environment variables
 * 2. Values from opencode.json plugin options
 * 3. ~/.protector/config.json config file
 *
 * Returns null if no source provides both url and apiKey.
 */
export function resolvePluginConfig(rawConfig: unknown): PluginConfig | null {
  const envUrl = typeof process !== 'undefined' ? process.env.PROTECTOR_LLM_URL : undefined
  const envKey = typeof process !== 'undefined' ? process.env.PROTECTOR_LLM_KEY : undefined

  const hasEnvVars = envUrl !== undefined && envUrl.length > 0 &&
                     envKey !== undefined && envKey.length > 0

  if (hasEnvVars) {
    return { url: envUrl, apiKey: envKey }
  }

  // Fall back to config options from opencode.json
  if (rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)) {
    const obj = rawConfig as Record<string, unknown>
    const configUrl = typeof obj.url === 'string' ? obj.url : ''
    const configKey = typeof obj.apiKey === 'string' ? obj.apiKey : ''

    if (configUrl.length > 0 && configKey.length > 0) {
      return { url: configUrl, apiKey: configKey }
    }
  }

  // Fall back to config file
  return readConfigFile()
}
