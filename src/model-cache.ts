import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { OpencodeModelConfig } from './types.js'

const CACHE_FILENAME = 'opencode-provider-litellm-cache.json'

interface ModelCache {
  savedAt: number
  providerId: string
  models: Record<string, OpencodeModelConfig>
}

function getCachePath(): string {
  return join(homedir(), '.local', 'share', 'opencode', CACHE_FILENAME)
}

/**
 * Loads the model cache from disk. Returns null if the file does not exist,
 * cannot be parsed, or belongs to a different provider.
 */
export function loadModelCache(providerId: string): Record<string, OpencodeModelConfig> | null {
  try {
    const raw = readFileSync(getCachePath(), 'utf-8')
    const cache = JSON.parse(raw) as ModelCache
    if (cache.providerId !== providerId) return null
    if (!cache.models || typeof cache.models !== 'object') return null
    return cache.models
  } catch {
    return null
  }
}

/**
 * Saves the discovered models to the cache file on disk. Failures are
 * non-fatal — discovery already succeeded.
 */
export function saveModelCache(providerId: string, models: Record<string, OpencodeModelConfig>): void {
  try {
    const cache: ModelCache = {
      savedAt: Date.now(),
      providerId,
      models,
    }
    writeFileSync(getCachePath(), JSON.stringify(cache, null, 2), 'utf-8')
  } catch {
    // Non-fatal — cache will be written next time
  }
}
