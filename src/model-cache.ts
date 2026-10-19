import type { Schema } from 'effect'
import type { Plugin } from '@opencode/plugin'
import type { DiscoveredModel } from './types.js'

const CACHE_PREFIX = 'model-cache/'

interface ModelCache {
  savedAt: number
  providerId: string
  models: Record<string, DiscoveredModel>
}

function cacheKey(providerId: string): string {
  return `${CACHE_PREFIX}${providerId}`
}

/**
 * Loads the model cache from plugin storage. Returns null when the cache
 * does not exist, cannot be parsed, or belongs to a different provider.
 * Storage is durable JSON scoped to the plugin (replaces the old
 * ~/.local/share/opencode/opencode-provider-litellm-cache.json file).
 */
export async function loadModelCache(
  ctx: Plugin.Context,
  providerId: string,
): Promise<Record<string, DiscoveredModel> | null> {
  try {
    const raw = await ctx.storage.get(cacheKey(providerId))
    if (raw === undefined || raw === null) return null

    const cache = raw as unknown as ModelCache
    if (cache.providerId !== providerId) return null
    if (!cache.models || typeof cache.models !== 'object') return null
    return cache.models
  } catch {
    return null
  }
}

/**
 * Saves the discovered models to plugin storage. Failures are non-fatal —
 * discovery already succeeded.
 */
export async function saveModelCache(
  ctx: Plugin.Context,
  providerId: string,
  models: Record<string, DiscoveredModel>,
): Promise<void> {
  try {
    const cache: ModelCache = {
      savedAt: Date.now(),
      providerId,
      models,
    }
    // The cache is plain JSON; the structural Json type requires index
    // signatures the ModelCache interface does not declare.
    await ctx.storage.set(cacheKey(providerId), cache as unknown as Schema.Json)
  } catch {
    // Non-fatal — cache will be written next time
  }
}
