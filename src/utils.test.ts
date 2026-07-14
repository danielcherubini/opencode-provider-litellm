import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolvePluginConfig } from './utils.js'

describe('resolvePluginConfig', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  describe('environment variable priority', () => {
    beforeEach(() => {
      delete process.env.LITELLM_GCLOUD_TOKEN_AUTH
    })

    it('returns config from env vars when both are set', () => {
      process.env.LITELLM_URL = 'https://env.example.com'
      process.env.LITELLM_KEY = 'env-key-123'

      const config = resolvePluginConfig({ url: 'https://config.example.com', apiKey: 'config-key' })
      expect(config).toEqual({ url: 'https://env.example.com', apiKey: 'env-key-123' })
    })

    it('ignores config options when env vars are set', () => {
      process.env.LITELLM_URL = 'https://env.example.com'
      process.env.LITELLM_KEY = 'env-key-123'

      const config = resolvePluginConfig({ url: 'https://different.example.com', apiKey: 'different-key' })
      expect(config).toEqual({ url: 'https://env.example.com', apiKey: 'env-key-123' })
    })

    it('falls back to config when only one env var is set', () => {
      process.env.LITELLM_URL = 'https://env.example.com'
      delete process.env.LITELLM_KEY

      const config = resolvePluginConfig({ url: 'https://config.example.com', apiKey: 'config-key' })
      expect(config).toEqual({ url: 'https://config.example.com', apiKey: 'config-key' })
    })

    it('falls back to config when env vars are empty strings', () => {
      process.env.LITELLM_URL = ''
      process.env.LITELLM_KEY = ''

      const config = resolvePluginConfig({ url: 'https://config.example.com', apiKey: 'config-key' })
      expect(config).toEqual({ url: 'https://config.example.com', apiKey: 'config-key' })
    })
  })

  describe('config options fallback', () => {
    beforeEach(() => {
      delete process.env.LITELLM_URL
      delete process.env.LITELLM_KEY
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
      delete process.env.LITELLM_URL
      delete process.env.LITELLM_KEY
      expect(resolvePluginConfig({})).toBeNull()
    })
  })

  describe('gcloud token auth', () => {
    beforeEach(() => {
      delete process.env.LITELLM_GCLOUD_TOKEN_AUTH
    })

    it('allows missing LITELLM_KEY when LITELLM_GCLOUD_TOKEN_AUTH is set', () => {
      process.env.LITELLM_URL = 'https://gcloud.example.com'
      process.env.LITELLM_GCLOUD_TOKEN_AUTH = '1'
      delete process.env.LITELLM_KEY

      const config = resolvePluginConfig({})
      expect(config).toEqual({ url: 'https://gcloud.example.com', apiKey: '' })
    })

    it('does not allow missing key when gcloud auth is disabled', () => {
      process.env.LITELLM_URL = 'https://gcloud.example.com'
      delete process.env.LITELLM_KEY
      delete process.env.LITELLM_GCLOUD_TOKEN_AUTH

      const config = resolvePluginConfig({})
      expect(config).toBeNull()
    })

    it('does not allow missing key when gcloud auth is set to 0', () => {
      process.env.LITELLM_URL = 'https://gcloud.example.com'
      process.env.LITELLM_GCLOUD_TOKEN_AUTH = '0'
      delete process.env.LITELLM_KEY

      const config = resolvePluginConfig({})
      expect(config).toBeNull()
    })

    it('does not allow missing key when gcloud auth is empty string', () => {
      process.env.LITELLM_URL = 'https://gcloud.example.com'
      process.env.LITELLM_GCLOUD_TOKEN_AUTH = ''
      delete process.env.LITELLM_KEY

      const config = resolvePluginConfig({})
      expect(config).toBeNull()
    })

    it('prefers full env vars over gcloud fallback', () => {
      process.env.LITELLM_URL = 'https://gcloud.example.com'
      process.env.LITELLM_KEY = 'normal-key'
      process.env.LITELLM_GCLOUD_TOKEN_AUTH = '1'

      const config = resolvePluginConfig({})
      expect(config).toEqual({ url: 'https://gcloud.example.com', apiKey: 'normal-key' })
    })
  })
})
