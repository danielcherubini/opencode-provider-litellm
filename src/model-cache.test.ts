import { describe, it, expect, vi } from 'vitest'
import type { DiscoveredModel } from './types.js'
import { loadModelCache, saveModelCache } from './model-cache.js'

const sampleModels: Record<string, DiscoveredModel> = {
  'anthropic/claude-sonnet': {
    name: 'anthropic/claude-sonnet',
    tool_call: true,
    reasoning: true,
    limit: { context: 1_000_000, output: 64_000 },
    cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
  },
  'qwen/qwen3.6-27b': {
    name: 'qwen/qwen3.6-27b',
    tool_call: true,
    reasoning: false,
    limit: { context: 262144, output: 32768 },
    modalities: { input: ['text'], output: ['text'] },
  },
}

function makeCtx(storage: {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
}) {
  return { storage } as never
}

describe('loadModelCache', () => {
  it('returns null when no cache is stored', async () => {
    const ctx = makeCtx({ get: vi.fn().mockResolvedValue(undefined), set: vi.fn() })
    expect(await loadModelCache(ctx, 'protector')).toBeNull()
  })

  it('returns null when storage.get rejects', async () => {
    const ctx = makeCtx({
      get: vi.fn().mockRejectedValue(new Error('storage down')),
      set: vi.fn(),
    })
    expect(await loadModelCache(ctx, 'protector')).toBeNull()
  })

  it('returns null when providerId does not match', async () => {
    const ctx = makeCtx({
      get: vi.fn().mockResolvedValue({
        savedAt: Date.now(),
        providerId: 'other',
        models: sampleModels,
      }),
      set: vi.fn(),
    })
    expect(await loadModelCache(ctx, 'protector')).toBeNull()
  })

  it('returns null when models field is missing', async () => {
    const ctx = makeCtx({
      get: vi.fn().mockResolvedValue({
        savedAt: Date.now(),
        providerId: 'protector',
        models: null,
      }),
      set: vi.fn(),
    })
    expect(await loadModelCache(ctx, 'protector')).toBeNull()
  })

  it('returns models when cache is valid', async () => {
    const ctx = makeCtx({
      get: vi.fn().mockResolvedValue({
        savedAt: Date.now(),
        providerId: 'protector',
        models: sampleModels,
      }),
      set: vi.fn(),
    })
    expect(await loadModelCache(ctx, 'protector')).toEqual(sampleModels)
  })

  it('reads from the model-cache/<providerId> key', async () => {
    const get = vi.fn().mockResolvedValue(undefined)
    const ctx = makeCtx({ get, set: vi.fn() })

    await loadModelCache(ctx, 'protector')

    expect(get).toHaveBeenCalledWith('model-cache/protector')
  })
})

describe('saveModelCache', () => {
  it('writes the cache under model-cache/<providerId>', async () => {
    const set = vi.fn().mockResolvedValue(undefined)
    const ctx = makeCtx({ get: vi.fn(), set })

    await saveModelCache(ctx, 'protector', sampleModels)

    expect(set).toHaveBeenCalledOnce()
    const [key, value] = set.mock.calls[0] as [string, Record<string, unknown>]
    expect(key).toBe('model-cache/protector')
    expect(value.providerId).toBe('protector')
    expect(value.models).toEqual(sampleModels)
    expect(typeof value.savedAt).toBe('number')
  })

  it('does not throw when storage.set rejects', async () => {
    const ctx = makeCtx({
      get: vi.fn(),
      set: vi.fn().mockRejectedValue(new Error('EACCES')),
    })

    await expect(saveModelCache(ctx, 'protector', sampleModels)).resolves.toBeUndefined()
  })

  it('round-trips correctly with loadModelCache', async () => {
    let stored: unknown
    const ctx = makeCtx({
      get: vi.fn().mockImplementation(async () => stored),
      set: vi.fn().mockImplementation(async (_key: string, value: unknown) => {
        stored = value
      }),
    })

    await saveModelCache(ctx, 'protector', sampleModels)

    expect(await loadModelCache(ctx, 'protector')).toEqual(sampleModels)
  })
})
