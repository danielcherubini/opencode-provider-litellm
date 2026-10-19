import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { Plugin } from '@opencode/plugin'
import { setup } from './plugin.js'
import { loadModelCache } from './model-cache.js'

/**
 * Live E2E against the real LiteLLM proxy. Opt-in — the default `npm test`
 * stays offline:
 *
 *   RUN_E2E=1 npx vitest run src/plugin.e2e.test.ts
 *
 * Requires LITELLM_URL + LITELLM_KEY (reads the local .env if present).
 * Set E2E_TEST_MODELS (comma-separated) to assert specific models were
 * discovered; live prompts are never sent by these tests.
 */

function loadDotEnv() {
  try {
    for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
    }
  } catch { /* no .env */ }
}
loadDotEnv()

const RUN = !!process.env.RUN_E2E
const URL_ = process.env.LITELLM_URL
const KEY = process.env.LITELLM_KEY

/** Models asserted present after discovery; from E2E_TEST_MODELS (comma-separated). */
const TEST_MODELS = (process.env.E2E_TEST_MODELS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// ---------- mocked Plugin.Context ----------

interface Added {
  info: unknown
  models: Array<{ id?: unknown; name?: string; capabilities?: unknown; limit?: unknown; cost?: unknown }>
}

function makeEditor() {
  const added: Added[] = []
  return {
    added,
    add(input: { info: unknown; models: Added['models'] }) {
      added.push(input)
    },
  }
}

interface ToolAdded {
  name: string
  description: string
  input: unknown
  execute: (input: Record<string, unknown>, context: { signal: AbortSignal }) => Promise<unknown>
}

function makeMockCtx(options: unknown = {}) {
  const storage = new Map<string, unknown>()
  const providerTransformCbs: Array<(editor: ReturnType<typeof makeEditor>) => void> = []
  const toolTransformCbs: Array<(editor: { add: (t: ToolAdded) => void }) => void> = []
  const sessionHooks: Record<string, unknown> = {}

  const reload = vi.fn(async () => {
    for (const cb of providerTransformCbs) cb(makeEditor() as never)
  })

  const ctx = {
    options,
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => void storage.set(key, value),
      remove: async (key: string) => void storage.delete(key),
      scan: async () => ({ entries: [] }),
    },
    provider: {
      transform: async (cb: (editor: unknown) => void) => {
        providerTransformCbs.push(cb as never)
        const editor = makeEditor()
        cb(editor as never)
        return { dispose: async () => {} }
      },
      reload,
    },
    tool: {
      transform: async (cb: (editor: unknown) => void) => {
        const added: ToolAdded[] = []
        cb({ add: (t: ToolAdded) => added.push(t) } as never)
        toolTransformCbs.push(cb as never)
        return { added, dispose: async () => {} }
      },
    },
    session: {
      hook: async (name: string, cb: unknown) => {
        sessionHooks[name] = cb
        return { dispose: async () => {} }
      },
    },
    __internals: { storage, providerTransformCbs, toolTransformCbs, sessionHooks, reload },
  }

  return ctx as unknown as Plugin.Context & typeof ctx & { __internals: typeof ctx['__internals'] }
}

describe.skipIf(!RUN)('plugin E2E (live proxy, RUN_E2E=1)', () => {
  it('loads against the real proxy: provider, models, cache, hooks', async () => {
    process.env.LITELLM_URL = URL_
    process.env.LITELLM_KEY = KEY
    delete process.env.LITELLM_PROVIDER_ID
    delete process.env.LITELLM_GCLOUD_TOKEN_AUTH

    const ctx = makeMockCtx()
    await setup(ctx)

    // --- provider transform: connection settings ---
    const first = ctx.__internals.providerTransformCbs[0]
    expect(first).toBeDefined()
    const editor = makeEditor()
    first!(editor as never)
    expect(editor.added).toHaveLength(1)
    const info = editor.added[0].info as {
      name?: string
      activation?: string
      package?: string
      settings?: { baseURL?: string; apiKey?: string }
    }
    expect(info.name).toBe('LiteLLM')
    expect(info.activation).toBe('enabled')
    expect(info.package).toBe('@opencode/ai/providers/openai-compatible')
    expect(info.settings?.baseURL).toBe(`${URL_!.replace(/\/+$/, '')}/v1`)
    expect(info.settings?.apiKey).toBe(KEY)

    // --- models discovered live ---
    const models = editor.added[0].models
    expect(models.length).toBeGreaterThan(0)
    const names = models.map((m) => String((m as { name?: string }).name ?? ''))
    for (const target of TEST_MODELS) {
      expect(names).toContain(target)
    }

    // --- Model.Info mapping sanity on the first listed target (when set) ---
    const sample = (TEST_MODELS.length
      ? models.find((m) => (m as { name?: string }).name === TEST_MODELS[0])
      : models[0]) as {
      capabilities?: { tools?: boolean; input?: string[] }
      limit?: { context?: number; output?: number }
    }
    expect(sample.capabilities?.tools).toBe(true)
    expect(sample.capabilities?.input).toContain('text')
    expect(sample.limit?.context).toBeGreaterThan(0)
    expect(sample.limit?.output).toBeGreaterThan(0)

    // --- cache roundtrip: saved to storage, loadable ---
    const cached = await loadModelCache(ctx, 'LiteLLM')
    expect(cached).not.toBeNull()
    expect(Object.keys(cached ?? {}).sort()).toEqual([...names].sort())

    // --- reload re-runs the transform ---
    expect(ctx.__internals.reload).toHaveBeenCalled()

    // --- session hooks registered ---
    expect(typeof ctx.__internals.sessionHooks['model.request']).toBe('function')
    expect(typeof ctx.__internals.sessionHooks['context']).toBe('function')
  })

  it('model.request hook injects the session header', async () => {
    process.env.LITELLM_URL = URL_
    process.env.LITELLM_KEY = KEY
    const ctx = makeMockCtx()
    await setup(ctx)

    const hook = ctx.__internals.sessionHooks['model.request'] as (e: {
      headers: Record<string, string>
      sessionID?: string
    }) => Promise<void>
    const event = { headers: {} as Record<string, string>, sessionID: 'ses_test_123' }
    await hook(event)
    expect(event.headers['X-Litellm-Session-ID']).toBe('ses_test_123')
    expect(event.headers['Authorization']).toBeUndefined() // non-gcloud: no override
  })

  it('context hook normalizes thinking strings to Vertex dicts', async () => {
    process.env.LITELLM_URL = URL_
    process.env.LITELLM_KEY = KEY
    const ctx = makeMockCtx()
    await setup(ctx)

    const hook = ctx.__internals.sessionHooks['context'] as (e: {
      options: { thinking: unknown }
    }) => void

    const a = { options: { thinking: 'high' } }
    hook(a)
    expect(a.options.thinking).toEqual({ type: 'adaptive' })

    const b = { options: { thinking: 'off' } }
    hook(b)
    expect(b.options.thinking).toEqual({ type: 'disabled' })

    const c = { options: { thinking: { type: 'weird' } } }
    hook(c)
    expect((c.options.thinking as { type: string }).type).toBe('adaptive')

    const d = { options: { thinking: { type: 'disabled' } } }
    hook(d)
    expect((d.options.thinking as { type: string }).type).toBe('disabled')
  })

  it('degrades gracefully when the proxy is unreachable', async () => {
    const savedUrl = process.env.LITELLM_URL
    const savedKey = process.env.LITELLM_KEY
    process.env.LITELLM_URL = 'http://127.0.0.1:9' // nothing listens here
    process.env.LITELLM_KEY = 'sk-test'
    try {
      const ctx = makeMockCtx()
      await expect(setup(ctx)).resolves.toBeUndefined() // no throw
      const hook = ctx.__internals.sessionHooks['model.request']
      expect(typeof hook).toBe('function') // hooks still registered
    } finally {
      process.env.LITELLM_URL = savedUrl
      process.env.LITELLM_KEY = savedKey
    }
  }, 60_000)
})
