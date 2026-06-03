import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getGcloudToken, resetTokenCache, CACHE_TTL } from './gcloud-token.js'

const mockReadFileSync = vi.hoisted(() => vi.fn())
const mockExistsSync = vi.hoisted(() => vi.fn())
const mockFetch = vi.hoisted(() => vi.fn())

vi.mock('fs', () => ({
  get readFileSync() { return mockReadFileSync },
  get existsSync() { return mockExistsSync },
}))

// Mock global fetch
beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const mockEnv = (vars: Record<string, string | undefined>) => {
  const original = { ...process.env }
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = v
    }
  }
  return () => {
    process.env = { ...original }
  }
}

const authorizedUserCredentials = {
  type: 'authorized_user',
  client_id: 'test-client-id.apps.googleusercontent.com',
  client_secret: 'test-client-secret',
  refresh_token: 'test-refresh-token',
  account: 'test@example.com',
}

const serviceAccountCredentials = {
  type: 'service_account',
  private_key_id: 'key123',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n',
  client_email: 'test@project.iam.gserviceaccount.com',
  client_id: '123456789',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
}

describe('getGcloudToken', () => {
  afterEach(() => {
    vi.clearAllMocks()
    resetTokenCache()
  })

  it('returns token from authorized_user credentials', async () => {
    const restore = mockEnv({
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/adc.json',
      HOME: '/home/test',
    })

    mockReadFileSync.mockReturnValue(JSON.stringify(authorizedUserCredentials))

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'exchanged-access-token' }),
    })

    const token = await getGcloudToken()
    expect(token).toBe('exchanged-access-token')

    expect(mockFetch).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    )

    restore()
  })

  it('caches token within TTL', async () => {
    const restore = mockEnv({
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/adc.json',
      HOME: '/home/test',
    })

    mockReadFileSync.mockReturnValue(JSON.stringify(authorizedUserCredentials))
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'cached-token' }),
    })

    await getGcloudToken()
    const cached = await getGcloudToken()
    expect(cached).toBe('cached-token')
    expect(mockFetch).toHaveBeenCalledTimes(1)

    restore()
  })

  it('returns null when ADC file not found (no env, no default)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const restore = mockEnv({
      GOOGLE_APPLICATION_CREDENTIALS: undefined,
      HOME: undefined,
      USERPROFILE: undefined,
      APPDATA: undefined,
    })

    const token = await getGcloudToken()
    expect(token).toBeNull()
    expect(warnSpy).toHaveBeenCalled()

    restore()
    warnSpy.mockRestore()
  })

  it('returns null when ADC file is invalid JSON', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const restore = mockEnv({
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/adc.json',
      HOME: '/home/test',
    })

    mockReadFileSync.mockReturnValue('not valid json{{{')

    const token = await getGcloudToken()
    expect(token).toBeNull()
    expect(warnSpy).toHaveBeenCalled()

    restore()
    warnSpy.mockRestore()
  })

  it('returns null and warns for service_account type', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const restore = mockEnv({
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/adc.json',
      HOME: '/home/test',
    })

    mockReadFileSync.mockReturnValue(JSON.stringify(serviceAccountCredentials))

    const token = await getGcloudToken()
    expect(token).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      '[opencode-provider-litellm] Service account credentials are not yet supported. Use an authorized_user credential or set GOOGLE_APPLICATION_CREDENTIALS to an authorized_user JSON file.',
    )

    restore()
    warnSpy.mockRestore()
  })

  it('returns null on token exchange failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const restore = mockEnv({
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/adc.json',
      HOME: '/home/test',
    })

    mockReadFileSync.mockReturnValue(JSON.stringify(authorizedUserCredentials))
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant"}',
    })

    const token = await getGcloudToken()
    expect(token).toBeNull()
    expect(warnSpy).toHaveBeenCalled()

    restore()
    warnSpy.mockRestore()
  })

  it('returns null on token exchange network error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const restore = mockEnv({
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/adc.json',
      HOME: '/home/test',
    })

    mockReadFileSync.mockReturnValue(JSON.stringify(authorizedUserCredentials))
    mockFetch.mockRejectedValue(new Error('network error'))

    const token = await getGcloudToken()
    expect(token).toBeNull()
    expect(warnSpy).toHaveBeenCalled()

    restore()
    warnSpy.mockRestore()
  })

  it('reads default ADC location when GOOGLE_APPLICATION_CREDENTIALS is not set', async () => {
    const restore = mockEnv({
      GOOGLE_APPLICATION_CREDENTIALS: undefined,
      HOME: '/home/test',
      APPDATA: undefined,
    })

    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify(authorizedUserCredentials))
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'default-loc-token' }),
    })

    const token = await getGcloudToken()
    expect(token).toBe('default-loc-token')
    expect(mockReadFileSync).toHaveBeenCalledWith(
      expect.stringContaining('application_default_credentials.json'),
      'utf-8',
    )

    restore()
  })

  it('reads Windows APPDATA ADC location', async () => {
    const restore = mockEnv({
      GOOGLE_APPLICATION_CREDENTIALS: undefined,
      HOME: undefined,
      APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
    })

    mockExistsSync.mockImplementation((path: string) => {
      return typeof path === 'string' && path.includes('AppData') && path.includes('gcloud')
    })
    mockReadFileSync.mockReturnValue(JSON.stringify(authorizedUserCredentials))
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'windows-token' }),
    })

    const token = await getGcloudToken()
    expect(token).toBe('windows-token')
    // On Linux, path.join mixes slashes; just check it contains the key parts
    expect(mockReadFileSync).toHaveBeenCalledWith(
      expect.stringContaining('gcloud'),
      'utf-8',
    )

    restore()
  })

  it('respects GOOGLE_APPLICATION_CREDENTIALS path over default', async () => {
    const restore = mockEnv({
      GOOGLE_APPLICATION_CREDENTIALS: '/custom/path/creds.json',
      HOME: '/home/test',
    })

    mockReadFileSync.mockReturnValue(JSON.stringify(authorizedUserCredentials))
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'custom-path-token' }),
    })

    const token = await getGcloudToken()
    expect(token).toBe('custom-path-token')
    expect(mockReadFileSync).toHaveBeenCalledWith('/custom/path/creds.json', 'utf-8')

    restore()
  })

  it('stale cache triggers new token fetch', async () => {
    const restore = mockEnv({
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/adc.json',
      HOME: '/home/test',
    })

    mockReadFileSync.mockReturnValue(JSON.stringify(authorizedUserCredentials))
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'token-v1' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'token-v2' }),
      })

    const first = await getGcloudToken()
    expect(first).toBe('token-v1')

    // Stub the cache to be stale
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + CACHE_TTL + 1000)

    const second = await getGcloudToken()
    expect(second).toBe('token-v2')
    expect(mockFetch).toHaveBeenCalledTimes(2)

    vi.restoreAllMocks()
    restore()
  })
})
