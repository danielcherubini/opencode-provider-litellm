import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mapLiteLLMModel, resolvePluginConfig, readConfigFile } from './utils.js'
import type { LiteLLMModel } from './types.js'

// Mock node:fs and node:os at module level for readConfigFile tests
const mockReadFileSync = vi.fn()
const mockHomedir = vi.fn().mockReturnValue('/mock/home')

vi.mock('node:fs', () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}))

vi.mock('node:os', () => ({
  homedir: () => mockHomedir(),
}))

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>()
  return actual
})

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
    mockReadFileSync.mockReset()
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
      delete process.env.PROTECTOR_ENV
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

    it('returns null when neither env vars nor config are available and no config file', () => {
      delete process.env.PROTECTOR_LLM_URL
      delete process.env.PROTECTOR_LLM_KEY
      mockReadFileSync.mockImplementation(() => {
        const err: NodeJS.ErrnoException = new Error('ENOENT')
        err.code = 'ENOENT'
        throw err
      })
      expect(resolvePluginConfig({})).toBeNull()
    })
  })

  describe('config file fallback', () => {
    beforeEach(() => {
      delete process.env.PROTECTOR_LLM_URL
      delete process.env.PROTECTOR_LLM_KEY
      delete process.env.PROTECTOR_ENV
    })

    it('falls back to config file when neither env vars nor rawConfig available', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ test: { url: 'https://file.example.com', apiKey: 'file-key' } }))

      const config = resolvePluginConfig({})
      expect(config).toEqual({ url: 'https://file.example.com', apiKey: 'file-key' })
    })

    it('prefers rawConfig over config file', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ test: { url: 'https://file.example.com', apiKey: 'file-key' } }))

      const config = resolvePluginConfig({ url: 'https://config.example.com', apiKey: 'config-key' })
      expect(config).toEqual({ url: 'https://config.example.com', apiKey: 'config-key' })
    })

    it('prefers env vars over config file', () => {
      process.env.PROTECTOR_LLM_URL = 'https://env.example.com'
      process.env.PROTECTOR_LLM_KEY = 'env-key-123'
      mockReadFileSync.mockReturnValue(JSON.stringify({ test: { url: 'https://file.example.com', apiKey: 'file-key' } }))

      const config = resolvePluginConfig({})
      expect(config).toEqual({ url: 'https://env.example.com', apiKey: 'env-key-123' })
    })
  })
})

describe('readConfigFile', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    mockReadFileSync.mockReset()
    mockHomedir.mockReturnValue('/mock/home')
    delete process.env.PROTECTOR_ENV
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('returns null for missing file', () => {
    mockReadFileSync.mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('ENOENT')
      err.code = 'ENOENT'
      throw err
    })

    expect(readConfigFile()).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    mockReadFileSync.mockReturnValue('not json')

    expect(readConfigFile()).toBeNull()
  })

  it('returns null when env block is missing', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ production: { url: 'https://prod.com', apiKey: 'key' } }))

    expect(readConfigFile()).toBeNull()
  })

  it('returns config for valid file and matching env block', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ test: { url: 'https://file.example.com', apiKey: 'file-key' } }))

    expect(readConfigFile()).toEqual({ url: 'https://file.example.com', apiKey: 'file-key' })
  })

  it('respects PROTECTOR_ENV to select env block', () => {
    process.env.PROTECTOR_ENV = 'production'
    mockReadFileSync.mockReturnValue(JSON.stringify({
      test: { url: 'https://test.com', apiKey: 'test-key' },
      production: { url: 'https://prod.com', apiKey: 'prod-key' },
    }))

    expect(readConfigFile()).toEqual({ url: 'https://prod.com', apiKey: 'prod-key' })
  })

  it('defaults to "test" env block when PROTECTOR_ENV is not set', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      test: { url: 'https://test.com', apiKey: 'test-key' },
      production: { url: 'https://prod.com', apiKey: 'prod-key' },
    }))

    expect(readConfigFile()).toEqual({ url: 'https://test.com', apiKey: 'test-key' })
  })

  it('returns null when url is missing in env block', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ test: { apiKey: 'key' } }))

    expect(readConfigFile()).toBeNull()
  })

  it('returns null when apiKey is missing in env block', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ test: { url: 'https://example.com' } }))

    expect(readConfigFile()).toBeNull()
  })
})
