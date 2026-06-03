# gcloud Token Auth via chat.headers Plan

**Goal:** Add automatic gcloud OAuth token injection to the OpenCode LiteLLM provider plugin so CLI users don't need to manually pass `Authorization: Bearer <gcloud-token>`.
**Architecture:** The plugin registers a `chat.headers` hook that runs before every LLM request. When `LITELLM_GCLOUD_TOKEN_AUTH=1` is set, it executes `gcloud auth print-access-token`, caches the result for 50 minutes, and injects it as the `Authorization: Bearer` header. `LITELLM_KEY` becomes optional when this feature is enabled. When the env var is unset, the existing static `apiKey` flow is unchanged.
**Tech Stack:** TypeScript, Node.js `child_process.exec`, OpenCode plugin `chat.headers` hook, vitest

---

### Task 1: Add gcloud token cache, relax LITELLM_KEY requirement, and register chat.headers hook

**Context:**
The plugin currently passes a static `apiKey` to the OpenCode config at startup. Users who authenticate via gcloud OAuth tokens must manually set `LITELLM_KEY` to their current gcloud token (which expires every hour). The `chat.headers` hook is called before every LLM request and allows dynamically injecting headers. We'll use this to automatically fetch and cache gcloud tokens.

Two blockers must be addressed:
1. `resolvePluginConfig` in `src/utils.ts` currently requires both `LITELLM_URL` and `LITELLM_KEY`. When `LITELLM_GCLOUD_TOKEN_AUTH=1` is set, `LITELLM_KEY` should be optional (defaulting to empty string).
2. The `createMcpToolDefinitions` call passes `pluginConfig.apiKey` — it must handle an empty-string key gracefully (it already does: it tries the API key and falls back to discovery without auth).

The feature is gated behind `LITELLM_GCLOUD_TOKEN_AUTH=1`. When set, the `chat.headers` hook runs `gcloud auth print-access-token` and injects the result as `Authorization: Bearer <token>`. The token is cached in memory with a 50-minute TTL (gcloud tokens last 60 minutes; 50 min provides a 10-minute safety margin for long streaming responses). When the env var is not set, the hook is not registered and the existing static `apiKey` flow is unchanged.

If `gcloud` fails (not installed, not logged in, expired session), the hook logs a warning via `console.warn` (matching existing pattern in `plugin.ts`) and does not inject a header — the request fails with a 401 from the upstream server, which is the correct behavior.

**Files:**
- Modify: `src/utils.ts`
- Modify: `src/plugin.ts`
- Create: `src/gcloud-token.ts`
- Create: `src/gcloud-token.test.ts`
- Modify: `src/plugin.test.ts`

**What to implement:**

1. **Create `src/gcloud-token.ts`** — a standalone module with token fetching and caching:

```typescript
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

let cachedToken: string | null = null
let cachedAt: number = 0
const CACHE_TTL = 50 * 60 * 1000 // 50 minutes in ms

/**
 * Gets a gcloud OAuth access token, cached with a 50-minute TTL.
 * Returns null if gcloud is not available or the token cannot be fetched.
 * Logs a warning on failure.
 */
export async function getGcloudToken(): Promise<string | null> {
  // Return cached token if still valid
  if (cachedToken && (Date.now() - cachedAt) < CACHE_TTL) {
    return cachedToken
  }

  try {
    const { stdout } = await execAsync('gcloud auth print-access-token', {
      timeout: 10_000,
    })
    const token = stdout.trim()
    if (token.length === 0) {
      return null
    }
    cachedToken = token
    cachedAt = Date.now()
    return token
  } catch (error) {
    console.warn(
      `[opencode-provider-litellm] gcloud token fetch failed: ${error}`,
    )
    return null
  }
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

4. **Create `src/gcloud-token.test.ts`** — unit tests for the token cache using vitest:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getGcloudToken, resetTokenCache } from './gcloud-token.js'
import * as childProcess from 'child_process'

beforeEach(() => {
  vi.restoreAllMocks()
  resetTokenCache()
})

describe('getGcloudToken', () => {
  it('returns token from gcloud', async () => {
    vi.spyOn(childProcess, 'exec').mockImplementation((cmd, opts, cb) => {
      if (typeof cb === 'function') {
        cb(null, { stdout: 'test-token-123' } as any)
      }
      return {} as any
    })
    const token = await getGcloudToken()
    expect(token).toBe('test-token-123')
  })

  it('caches token within TTL', async () => {
    const execSpy = vi.spyOn(childProcess, 'exec').mockImplementation((cmd, opts, cb) => {
      if (typeof cb === 'function') {
        cb(null, { stdout: 'cached-token' } as any)
      }
      return {} as any
    })
    await getGcloudToken()
    const cached = await getGcloudToken()
    expect(cached).toBe('cached-token')
    expect(execSpy).toHaveBeenCalledTimes(1)
  })

  it('returns null on gcloud failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(childProcess, 'exec').mockImplementation((cmd, opts, cb) => {
      if (typeof cb === 'function') {
        cb(new Error('gcloud not found'), null as any)
      }
      return {} as any
    })
    const token = await getGcloudToken()
    expect(token).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('returns null on empty stdout', async () => {
    vi.spyOn(childProcess, 'exec').mockImplementation((cmd, opts, cb) => {
      if (typeof cb === 'function') {
        cb(null, { stdout: '' } as any)
      }
      return {} as any
    })
    const token = await getGcloudToken()
    expect(token).toBeNull()
  })
})
```

5. **Modify `src/plugin.test.ts`** — add integration tests for the `chat.headers` hook:

Add two tests at the end of the file:
- Test: when `LITELLM_GCLOUD_TOKEN_AUTH=1`, the plugin returns an object with a `chat.headers` property
- Test: when `LITELLM_GCLOUD_TOKEN_AUTH` is unset, the plugin returns an object without `chat.headers`

Use `vi.mock('./gcloud-token.js', () => ({ getGcloudToken: vi.fn().mockResolvedValue('mock-token') }))` to mock the token module.

**Steps:**
- [ ] Create `src/gcloud-token.ts` with `getGcloudToken()` (exec `gcloud auth print-access-token`, cache with 50min TTL, warn on failure) and `resetTokenCache()`
- [ ] Create `src/gcloud-token.test.ts` with tests for caching, expiry, failure, and empty stdout
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
- [ ] `getGcloudToken()` executes `gcloud auth print-access-token` and caches the result for 50 minutes
- [ ] `getGcloudToken()` returns null and logs a warning on failure (gcloud not installed, not logged in, timeout)
- [ ] `resetTokenCache()` is exported and clears the cache for testing
- [ ] `resolvePluginConfig` accepts `LITELLM_URL` without `LITELLM_KEY` when `LITELLM_GCLOUD_TOKEN_AUTH` is set
- [ ] `chat.headers` hook is only registered when `LITELLM_GCLOUD_TOKEN_AUTH` is truthy (not empty, not "0")
- [ ] When hook is active, `Authorization: Bearer <gcloud-token>` is injected on every LLM request
- [ ] When hook is inactive (env var unset), behavior is identical to before (static apiKey)
- [ ] All tests pass, build succeeds, no type errors
