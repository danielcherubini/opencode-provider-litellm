# gcloud Token Auth via chat.headers Plan

**Goal:** Add automatic gcloud OAuth token injection to the OpenCode LiteLLM provider plugin so CLI users don't need to manually pass `Authorization: Bearer <gcloud-token>`.
**Architecture:** The plugin registers a `chat.headers` hook that runs before every LLM request. When `LITELLM_GCLOUD_TOKEN_AUTH=1` is set, it reads the Google ADC (Application Default Credentials) JSON file, exchanges the `refresh_token` for an access token via `POST https://oauth2.googleapis.com/token`, caches the result for 50 minutes, and injects it as the `Authorization: Bearer` header. `LITELLM_KEY` becomes optional when this feature is enabled. When the env var is unset, the existing static `apiKey` flow is unchanged.
**Tech Stack:** TypeScript, built-in `fetch` with `AbortSignal.timeout(10_000)`, Node.js `fs`/`path`, OpenCode plugin `chat.headers` hook, vitest. No `gcloud` CLI dependency — works on Linux, macOS, Windows.

---

### Task 1: Add gcloud token cache, relax LITELLM_KEY requirement, and register chat.headers hook

**Context:**
The plugin currently passes a static `apiKey` to the OpenCode config at startup. Users who authenticate via gcloud OAuth tokens must manually set `LITELLM_KEY` to their current gcloud token (which expires every hour). The `chat.headers` hook is called before every LLM request and allows dynamically injecting headers. We'll use this to automatically fetch and cache gcloud tokens.

Two blockers must be addressed:
1. `resolvePluginConfig` in `src/utils.ts` currently requires both `LITELLM_URL` and `LITELLM_KEY`. When `LITELLM_GCLOUD_TOKEN_AUTH=1` is set, `LITELLM_KEY` should be optional (defaulting to empty string).
2. The `createMcpToolDefinitions` call passes `pluginConfig.apiKey` — it must handle an empty-string key gracefully (it already does: it tries the API key and falls back to discovery without auth).

The feature is gated behind `LITELLM_GCLOUD_TOKEN_AUTH=1`. When set, the `chat.headers` hook reads the Google ADC (Application Default Credentials) JSON file, exchanges the `refresh_token` for an access token via `POST https://oauth2.googleapis.com/token`, and injects the result as `Authorization: Bearer <token>`. The token is cached in memory with a 50-minute TTL (gcloud tokens last 60 minutes; 50 min provides a 10-minute safety margin for long streaming responses). When the env var is not set, the hook is not registered and the existing static `apiKey` flow is unchanged.

**No CLI dependency.** The implementation reads the ADC JSON file directly (via `fs.readFileSync`) instead of invoking `gcloud auth print-access-token`. It locates the credentials file in this order:
1. `GOOGLE_APPLICATION_CREDENTIALS` env var (all platforms)
2. `~/.config/gcloud/application_default_credentials.json` (Linux / macOS)
3. `%APPDATA%/gcloud/application_default_credentials.json` (Windows)

Only `authorized_user` credentials are supported. `service_account` credentials return null with a warning.

If the ADC file is missing, invalid, or the token exchange fails, the hook logs a warning via `console.warn` (matching existing pattern in `plugin.ts`) and does not inject a header — the request fails with a 401 from the upstream server, which is the correct behavior.

**Files:**
- Modify: `src/utils.ts`
- Modify: `src/plugin.ts`
- Create: `src/gcloud-token.ts`
- Create: `src/gcloud-token.test.ts`
- Modify: `src/plugin.test.ts`

**What to implement:**

1. **Create `src/gcloud-token.ts`** — a standalone module with ADC file reading, token exchange, and caching:

```typescript
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

let cachedToken: string | null = null
let cachedAt: number = 0
export const CACHE_TTL = 50 * 60 * 1000 // 50 minutes in ms

interface AuthorizedUserCredentials {
  type: 'authorized_user'
  client_id: string
  client_secret: string
  refresh_token: string
  account?: string
  universe_domain?: string
}

interface ServiceAccountCredentials {
  type: 'service_account'
}

type GoogleCredentials = AuthorizedUserCredentials | ServiceAccountCredentials

const ADC_FILENAME = 'application_default_credentials.json'

function getAdcPath(): string | null {
  // 1. GOOGLE_APPLICATION_CREDENTIALS env var (all platforms)
  const envPath = typeof process !== 'undefined' ? process.env.GOOGLE_APPLICATION_CREDENTIALS : undefined
  if (envPath) {
    return envPath
  }

  // 2. Default ADC locations (Google's official search order)
  const candidates: string[] = []

  // Linux / macOS: ~/.config/gcloud/
  const home = typeof process !== 'undefined' ? process.env.HOME : undefined
  if (home) {
    candidates.push(join(home, '.config', 'gcloud', ADC_FILENAME))
  }

  // Windows: %APPDATA%/gcloud/
  const appData = typeof process !== 'undefined' ? process.env.APPDATA : undefined
  if (appData) {
    candidates.push(join(appData, 'gcloud', ADC_FILENAME))
  }

  for (const path of candidates) {
    if (existsSync(path)) {
      return path
    }
  }

  return null
}

function readCredentials(path: string): GoogleCredentials | null {
  try {
    const content = readFileSync(path, 'utf-8')
    return JSON.parse(content) as GoogleCredentials
  } catch {
    return null
  }
}

async function exchangeRefreshToken(credentials: AuthorizedUserCredentials): Promise<string | null> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: credentials.client_id,
    client_secret: credentials.client_secret,
    refresh_token: credentials.refresh_token,
  }).toString()

  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      const text = await response.text()
      console.warn(`[opencode-provider-litellm] Token exchange failed (${response.status}): ${text}`)
      return null
    }

    const data = await response.json()
    return data.access_token || null
  } catch (error) {
    console.warn(`[opencode-provider-litellm] Token exchange failed: ${error}`)
    return null
  }
}

/**
 * Gets a Google OAuth access token from the ADC JSON file, cached with a 50-minute TTL.
 * Returns null if credentials are not available or the token cannot be fetched.
 * Logs a warning on failure.
 */
export async function getGcloudToken(): Promise<string | null> {
  // Return cached token if still valid
  if (cachedToken && (Date.now() - cachedAt) < CACHE_TTL) {
    return cachedToken
  }

  const adcPath = getAdcPath()
  if (!adcPath) {
    console.warn(
      '[opencode-provider-litellm] No Google ADC file found. Set GOOGLE_APPLICATION_CREDENTIALS or run `gcloud auth application-default login`.',
    )
    return null
  }

  const credentials = readCredentials(adcPath)
  if (!credentials) {
    console.warn(`[opencode-provider-litellm] Failed to read ADC file: ${adcPath}`)
    return null
  }

  if (credentials.type === 'authorized_user') {
    const token = await exchangeRefreshToken(credentials)
    if (token) {
      cachedToken = token
      cachedAt = Date.now()
    }
    return token
  }

  if (credentials.type === 'service_account') {
    console.warn('[opencode-provider-litellm] Service account credentials are not yet supported. Use an authorized_user credential or set GOOGLE_APPLICATION_CREDENTIALS to an authorized_user JSON file.')
    return null
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  console.warn(`[opencode-provider-litellm] Unknown credential type: ${(credentials as { type: string }).type}`)
  return null
}

/**
 * Resets the token cache. Exported for testing purposes.
 */
export function resetTokenCache(): void {
  cachedToken = null
  cachedAt = 0
}
```

2. **Modify `src/utils.ts`** — relax `resolvePluginConfig` to allow missing `LITELLM_KEY` when `LITELLM_GCLOUD_TOKEN_AUTH` is set:

Find the `resolvePluginConfig` function. After the existing env var block (lines 38–43), add a fallback:

```typescript
export function resolvePluginConfig(rawConfig: unknown): PluginConfig | null {
  const envUrl = typeof process !== 'undefined' ? process.env.LITELLM_URL : undefined
  const envKey = typeof process !== 'undefined' ? process.env.LITELLM_KEY : undefined
  const envGcloudAuth = typeof process !== 'undefined'
    ? process.env.LITELLM_GCLOUD_TOKEN_AUTH
    : undefined

  const hasEnvVars = envUrl !== undefined && envUrl.length > 0 &&
                      envKey !== undefined && envKey.length > 0

  if (hasEnvVars) {
    return { url: envUrl, apiKey: envKey }
  }

  // Allow missing LITELLM_KEY when gcloud token auth is enabled
  if (envUrl !== undefined && envUrl.length > 0 &&
      envGcloudAuth !== undefined && envGcloudAuth !== '' && envGcloudAuth !== '0') {
    return { url: envUrl, apiKey: envKey || '' }
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

  return null
}
```

3. **Modify `src/plugin.ts`** — add the `chat.headers` hook when `LITELLM_GCLOUD_TOKEN_AUTH` is set:

At the top of the file, add the import:
```typescript
import { getGcloudToken } from './gcloud-token.js'
```

In the `LiteLLMPlugin` function, restructure the return so the hook can be conditionally added. Replace the `return { ... }` block with:

```typescript
const result: Record<string, unknown> = {
  config: async (config: Record<string, any>) => { ... }, // existing config hook
  auth: { ... }, // existing auth object
  tool: { ...mcpTools },
}

if (process.env.LITELLM_GCLOUD_TOKEN_AUTH &&
    process.env.LITELLM_GCLOUD_TOKEN_AUTH !== '' &&
    process.env.LITELLM_GCLOUD_TOKEN_AUTH !== '0') {
  result['chat.headers'] = async (input: Record<string, unknown>, output: { headers: Record<string, string> }) => {
    const token = await getGcloudToken()
    if (token) {
      output.headers['Authorization'] = `Bearer ${token}`
    }
  }
}

return result
```

Note: `Record<string, unknown>` is used for the result object because the `Plugin` return type from `@opencode-ai/plugin` includes `chat.headers` as a valid key (verified against `dist/index.d.ts`). The `output` parameter uses the exact type from the hook signature: `{ headers: Record<string, string> }`.

4. **Create `src/gcloud-token.test.ts`** — unit tests for the token cache using vitest. Mock `fs` (`readFileSync`, `existsSync`) and global `fetch`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getGcloudToken, resetTokenCache, CACHE_TTL } from './gcloud-token.js'

const mockReadFileSync = vi.hoisted(() => vi.fn())
const mockExistsSync = vi.hoisted(() => vi.fn())
const mockFetch = vi.hoisted(() => vi.fn())

vi.mock('fs', () => ({
  get readFileSync() { return mockReadFileSync },
  get existsSync() { return mockExistsSync },
}))

beforeEach(() => { vi.stubGlobal('fetch', mockFetch) })
afterEach(() => { vi.unstubAllGlobals() })

describe('getGcloudToken', () => {
  afterEach(() => { vi.clearAllMocks(); resetTokenCache() })

  it('returns token from authorized_user credentials', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/adc.json'
    mockReadFileSync.mockReturnValue(JSON.stringify({
      type: 'authorized_user',
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      refresh_token: 'test-refresh-token',
    }))
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
  })

  it('caches token within TTL', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/adc.json'
    mockReadFileSync.mockReturnValue(JSON.stringify({
      type: 'authorized_user', client_id: 'c', client_secret: 's', refresh_token: 'r',
    }))
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'cached-token' }) })
    await getGcloudToken()
    const cached = await getGcloudToken()
    expect(cached).toBe('cached-token')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('returns null when ADC file not found', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS
    delete process.env.HOME
    delete process.env.APPDATA
    const token = await getGcloudToken()
    expect(token).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('returns null and warns for service_account type', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/adc.json'
    mockReadFileSync.mockReturnValue(JSON.stringify({ type: 'service_account' }))
    const token = await getGcloudToken()
    expect(token).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('returns null on token exchange failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/adc.json'
    mockReadFileSync.mockReturnValue(JSON.stringify({
      type: 'authorized_user', client_id: 'c', client_secret: 's', refresh_token: 'r',
    }))
    mockFetch.mockResolvedValue({ ok: false, status: 400, text: async () => 'invalid_grant' })
    const token = await getGcloudToken()
    expect(token).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('stale cache triggers new token fetch', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/adc.json'
    mockReadFileSync.mockReturnValue(JSON.stringify({
      type: 'authorized_user', client_id: 'c', client_secret: 's', refresh_token: 'r',
    }))
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'v1' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'v2' }) })
    expect(await getGcloudToken()).toBe('v1')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + CACHE_TTL + 1000)
    expect(await getGcloudToken()).toBe('v2')
    expect(mockFetch).toHaveBeenCalledTimes(2)
    vi.restoreAllMocks()
  })
})
```

5. **Modify `src/plugin.test.ts`** — add integration tests for the `chat.headers` hook:

Add two tests at the end of the file:
- Test: when `LITELLM_GCLOUD_TOKEN_AUTH=1`, the plugin returns an object with a `chat.headers` property
- Test: when `LITELLM_GCLOUD_TOKEN_AUTH` is unset, the plugin returns an object without `chat.headers`

Use `vi.mock('./gcloud-token.js', () => ({ getGcloudToken: vi.fn().mockResolvedValue('mock-token') }))` to mock the token module.

**Steps:**
- [ ] Create `src/gcloud-token.ts` with `getGcloudToken()` (read ADC JSON, exchange refresh_token via `POST https://oauth2.googleapis.com/token`, cache with 50min TTL, warn on failure) and `resetTokenCache()`. Uses built-in `fetch` with `AbortSignal.timeout(10_000)`. Only `authorized_user` credentials supported.
- [ ] Create `src/gcloud-token.test.ts` with tests for caching, expiry, ADC not found, invalid JSON, service_account rejection, exchange failure, default location resolution, and `GOOGLE_APPLICATION_CREDENTIALS` override
- [ ] Modify `src/utils.ts` — relax `resolvePluginConfig` to allow missing `LITELLM_KEY` when `LITELLM_GCLOUD_TOKEN_AUTH` is set
- [ ] Modify `src/plugin.ts` — import `getGcloudToken`, add `chat.headers` hook gated on `LITELLM_GCLOUD_TOKEN_AUTH`
- [ ] Modify `src/plugin.test.ts` — add tests for `chat.headers` hook registration (present when env var set, absent when unset)
- [ ] Run `npm test`
  - Did all tests pass? If not, fix failures and re-run.
- [ ] Run `npm run build`
  - Did it succeed? If not, fix and re-run.
- [ ] Run `npx tsc --noEmit`
  - Did it succeed? If not, fix type errors and re-run.
- [ ] Commit with message: "feat: add gcloud token auth via chat.headers hook"

**Acceptance criteria:**
- [ ] `getGcloudToken()` reads the ADC JSON file (`GOOGLE_APPLICATION_CREDENTIALS` or platform default path), exchanges `refresh_token` via `POST https://oauth2.googleapis.com/token`, and caches the result for 50 minutes
- [ ] `getGcloudToken()` returns null and logs a warning on failure (ADC file not found, invalid JSON, token exchange HTTP error, network error, timeout)
- [ ] Only `authorized_user` credentials are supported; `service_account` returns null with a warning
- [ ] `resetTokenCache()` is exported and clears the cache for testing
- [ ] `resolvePluginConfig` accepts `LITELLM_URL` without `LITELLM_KEY` when `LITELLM_GCLOUD_TOKEN_AUTH` is set
- [ ] `chat.headers` hook is only registered when `LITELLM_GCLOUD_TOKEN_AUTH` is truthy (not empty, not "0")
- [ ] When hook is active, `Authorization: Bearer <gcloud-token>` is injected on every LLM request
- [ ] When hook is inactive (env var unset), behavior is identical to before (static apiKey)
- [ ] All tests pass, build succeeds, no type errors
