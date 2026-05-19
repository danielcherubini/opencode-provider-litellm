import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mapLiteLLMModel, resolvePluginConfig } from './utils.js'
import type { LiteLLMModel } from './types.js'

describe('mapLiteLLMModel', () => {
  it('maps basic model correctly', () => {
    const model: LiteLLMModel = { id: 'gpt-4o' }
    const result = mapLiteLLMModel(model)

    expect(result.name).toBe('gpt-4o')
    expect(result.tool_call).toBe(true)
    expect(result.reasoning).toBe(false)
    expect(result.limit).toEqual({ context: 32768, output: 32768 })
    expect(result.modalities).toEqual({ input: ['text'], output: ['text'] })
  })

  it('matches reasoning heuristic for qwen3 models', () => {
    const model: LiteLLMModel = { id: 'qwen/qwen3.6-27b' }
    expect(mapLiteLLMModel(model).reasoning).toBe(true)
  })

  it('matches reasoning heuristic for deepseek-r1', () => {
    const model: LiteLLMModel = { id: 'deepseek-r1' }
    expect(mapLiteLLMModel(model).reasoning).toBe(true)
  })

  it('matches reasoning heuristic for o3-mini', () => {
    const model: LiteLLMModel = { id: 'o3-mini' }
    expect(mapLiteLLMModel(model).reasoning).toBe(true)
  })

  it('does NOT match reasoning for gpt-4o', () => {
    const model: LiteLLMModel = { id: 'gpt-4o' }
    expect(mapLiteLLMModel(model).reasoning).toBe(false)
  })

  it('does NOT match reasoning for claude-sonnet-4', () => {
    const model: LiteLLMModel = { id: 'claude-sonnet-4' }
    expect(mapLiteLLMModel(model).reasoning).toBe(false)
  })

  it('uses custom max_model_len for limits', () => {
    const model: LiteLLMModel = { id: 'gpt-4', max_model_len: 128000 }
    const result = mapLiteLLMModel(model)

    expect(result.limit).toEqual({ context: 128000, output: 128000 })
  })
})

describe('resolvePluginConfig', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  describe('environment variable priority', () => {
    it('returns config from env vars when both are set', () => {
      process.env.PROTECTOR_LLM_URL = 'https://env.example.com'
      process.env.PROTECTOR_LLM_KEY = 'env-key-123'

      const config = resolvePluginConfig({ url: 'https://config.example.com', apiKey: 'config-key' })
      expect(config).toEqual({ url: 'https://env.example.com', apiKey: 'env-key-123' })
    })

    it('ignores config options when env vars are set', () => {
      process.env.PROTECTOR_LLM_URL = 'https://env.example.com'
      process.env.PROTECTOR_LLM_KEY = 'env-key-123'

      const config = resolvePluginConfig({ url: 'https://different.example.com', apiKey: 'different-key' })
      expect(config).toEqual({ url: 'https://env.example.com', apiKey: 'env-key-123' })
    })

    it('falls back to config when only one env var is set', () => {
      process.env.PROTECTOR_LLM_URL = 'https://env.example.com'
      delete process.env.PROTECTOR_LLM_KEY

      const config = resolvePluginConfig({ url: 'https://config.example.com', apiKey: 'config-key' })
      expect(config).toEqual({ url: 'https://config.example.com', apiKey: 'config-key' })
    })

    it('falls back to config when env vars are empty strings', () => {
      process.env.PROTECTOR_LLM_URL = ''
      process.env.PROTECTOR_LLM_KEY = ''

      const config = resolvePluginConfig({ url: 'https://config.example.com', apiKey: 'config-key' })
      expect(config).toEqual({ url: 'https://config.example.com', apiKey: 'config-key' })
    })
  })

  describe('config options fallback', () => {
    beforeEach(() => {
      delete process.env.PROTECTOR_LLM_URL
      delete process.env.PROTECTOR_LLM_KEY
    })

    it('returns config for valid input', () => {
      const config = resolvePluginConfig({ url: 'https://config.example.com', apiKey: 'my-api-key' })
      expect(config).toEqual({ url: 'https://config.example.com', apiKey: 'my-api-key' })
    })

    it('returns null when url is missing', () => {
      const config = resolvePluginConfig({ apiKey: 'my-api-key' })
      expect(config).toBeNull()
    })

    it('returns null when apiKey is missing', () => {
      const config = resolvePluginConfig({ url: 'https://config.example.com' })
      expect(config).toBeNull()
    })

    it('returns null for null input', () => {
      expect(resolvePluginConfig(null)).toBeNull()
    })

    it('returns null for undefined input', () => {
      expect(resolvePluginConfig(undefined)).toBeNull()
    })

    it('returns null for non-object input', () => {
      expect(resolvePluginConfig('string')).toBeNull()
      expect(resolvePluginConfig(42)).toBeNull()
      expect(resolvePluginConfig([])).toBeNull()
    })

    it('returns null for empty string url', () => {
      expect(resolvePluginConfig({ url: '', apiKey: 'valid' })).toBeNull()
    })

    it('returns null for empty string apiKey', () => {
      expect(resolvePluginConfig({ url: 'https://config.example.com', apiKey: '' })).toBeNull()
    })

    it('returns null when neither env vars nor config are available', () => {
      delete process.env.PROTECTOR_LLM_URL
      delete process.env.PROTECTOR_LLM_KEY
      expect(resolvePluginConfig({})).toBeNull()
    })
  })
})
