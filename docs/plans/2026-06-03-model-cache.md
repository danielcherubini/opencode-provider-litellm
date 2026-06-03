# Model Discovery Cache Plan

**Goal:** Add a file-based cache for model discovery results with a 12-hour TTL to reduce unnecessary HTTP requests to the LiteLLM proxy.
**Architecture:** A new `model-cache.ts` module handles reading/writing discovered models to a JSON file in the system cache directory. The `discoverModels()` function in `discovery.ts` is wrapped to check the cache first before hitting the network.
**Tech Stack:** Node.js `node:fs/promises`, `node:os`, `node:path`, JSON file format.

---

### Task 1: Create model-cache module

**Context:**
The `discoverModels()` function currently hits the LiteLLM proxy on every call — one `/health` request plus N `/model/info` requests. Model metadata (context limits, capabilities, costs) changes infrequently. We need a file-based cache so the data persists across process restarts. This module follows the same caching philosophy as `gcloud-token.ts` (TTL-based invalidation) but uses disk storage instead of in-memory state.

**Files:**
- Create: `src/model-cache.ts`
- Create: `src/model-cache.test.ts`

**What to implement:**

Create `src/model-cache.ts` with:

1. **Imports:** Use `import { mkdir, readFile, writeFile } from 'node:fs/promises'`, `import { homedir } from 'node:os'`, `import { join } from 'node:path'`.

2. **`getCachePath(): string` — exported helper:**
   Returns `~/.cache/opencode-provider-litellm/models.json` using `homedir()` + `join()`. Export for testability.

3. **`CACHE_TTL` constant:** `12 * 60 * 60 * 1000` (12 hours in milliseconds). Export for testing.

4. **`CacheEntry` interface — exported:**
   ```typescript
   export interface CacheEntry {
     timestamp: number  // Date.now() when cached
     models: Record<string, OpencodeModelConfig>
   }
   ```

5. **`readCachedModels(): Promise<Record<string, OpencodeModelConfig> | null>`:**
   - Use `getCachePath()` to get the file path
   - Read the cache file via `readFile(path, 'utf-8')`, parse JSON
   - If file doesn't exist (ENOENT error), return `null`
   - If file is corrupted/invalid JSON, return `null`
   - If `Date.now() - timestamp >= CACHE_TTL`, return `null` (stale — use `>=` so exactly-at-TTL is stale)
   - Otherwise return `models`
   - All errors should be caught and return `null` silently (cache miss is a soft failure)

6. **`writeCachedModels(models: Record<string, OpencodeModelConfig>): Promise<void>`:**
   - Ensure `~/.cache/opencode-provider-litellm/` directory exists via `mkdir(dir, { recursive: true })`
   - Write JSON with `timestamp: Date.now()` and `models` via `writeFile()`
   - Catch and silently ignore write errors (cache write failure is non-critical)

7. **`clearCache(): void` — exported for testing:**
   - Use `import { unlinkSync, existsSync } from 'node:fs'` (sync is fine for this helper)
   - Delete the cache file if it exists, ignore errors

**Test isolation:** Mock `node:fs/promises` and `node:os` in tests using `vi.hoisted` + `vi.mock`, mirroring the pattern already used in `gcloud-token.test.ts`. Override `homedir()` to return a temp path like `/tmp/test-home`.

**Steps:**
- [ ] Write tests in `src/model-cache.test.ts` with `vi.mock('node:fs/promises')` and `vi.mock('node:os')`:
  - `getCachePath()` returns a path ending in `.cache/opencode-provider-litellm/models.json`
  - `readCachedModels` returns `null` when cache file doesn't exist (ENOENT)
  - `readCachedModels` returns `null` when cache file contains invalid JSON
  - `readCachedModels` returns `null` when cache is stale (timestamp > CACHE_TTL ago)
  - `readCachedModels` returns `null` when cache is exactly at TTL boundary (`Date.now() - timestamp === CACHE_TTL`)
  - `readCachedModels` returns models when cache is fresh
  - `writeCachedModels` creates the cache directory if missing (calls `mkdir` with `recursive: true`)
  - `writeCachedModels` writes valid JSON with timestamp and models
  - `writeCachedModels` handles write errors gracefully (no throw)
  - `clearCache` removes the cache file
  - Round-trip: write then read returns the same models
- [ ] Run `npm run test -- model-cache.test.ts` — should fail (file doesn't exist yet)
- [ ] Implement `src/model-cache.ts`
- [ ] Run `npm run test -- model-cache.test.ts` — all tests must pass
- [ ] Run `npm run typecheck` — must pass
- [ ] Commit with message: "feat: add file-based model discovery cache"

**Acceptance criteria:**
- [ ] Cache module compiles with no TypeScript errors
- [ ] All tests pass
- [ ] Cache is stored at `~/.cache/opencode-provider-litellm/models.json`
- [ ] TTL is 12 hours
- [ ] All error paths return `null` / don't throw
- [ ] `getCachePath()`, `CACHE_TTL`, `CacheEntry` are exported

---

### Task 2: Wire cache into discoverModels

**Context:**
Now that we have a cache module, we need to integrate it into the actual model discovery flow. The `discoverModels()` function should check the cache before making network requests. If the cache hit is valid, skip the network entirely. On a cache miss (or stale cache), fetch from the network and update the cache.

**Files:**
- Modify: `src/discovery.ts`
- Modify: `src/discovery.test.ts`

**What to implement:**

In `src/discovery.ts`:

1. Import `readCachedModels`, `writeCachedModels`, `clearCache` from `./model-cache.js`

2. Wrap the `discoverModels` function logic:
   - At the very top of `discoverModels`, before any network logic, call `await readCachedModels()`
   - If cache returns non-null models, log `console.debug('[opencode-provider-litellm] Returning cached models (TTL valid)')` and return the cached models immediately (skip all network calls)
   - If cache returns null (miss or stale), proceed with existing network logic unchanged
   - After successfully fetching models from the network (at the point where we return the populated `models` object, before the `return models` on line 136), call `await writeCachedModels(models)` — this only runs if we have non-empty models from the network
   - Do NOT cache empty results — only cache successful discoveries with models
   - Do NOT cache on error — leave existing cache alone

3. Export a `resetModelCache()` function that calls `clearCache()` from the cache module, for use in tests

In `src/discovery.test.ts`:

4. Add `vi.mock('./model-cache.js', ...)` at the top of the file alongside new test cases. The mock should provide `readCachedModels` (returning `null` by default), `writeCachedModels` (no-op), and `clearCache` (no-op). Each existing test already restores mocks, so the default `null` return ensures cache is always a miss for existing tests.
5. Add new tests:
   - `discoverModels` returns cached models on cache hit (no fetch called)
   - `discoverModels` writes to cache after successful discovery
   - `discoverModels` does NOT write to cache on empty result
   - `discoverModels` does NOT write to cache on network error
   - `discoverModels` does NOT write to cache when 403 error is thrown (re-throw path)
   - `discoverModels` falls through to network on cache miss
   - `resetModelCache` calls `clearCache`

**Steps:**
- [ ] Add `vi.mock('./model-cache.js', ...)` to isolate existing tests AND add new cache hit/miss test cases to `src/discovery.test.ts` (all in one step)
- [ ] Run `npm run test -- discovery.test.ts` — new tests should fail
- [ ] Implement cache integration in `src/discovery.ts`
- [ ] Run `npm run test -- discovery.test.ts` — all tests must pass
- [ ] Run `npm run typecheck` — must pass
- [ ] Commit with message: "feat: integrate model cache into discovery"

**Acceptance criteria:**
- [ ] All existing discovery tests still pass
- [ ] Cache hit skips all network requests
- [ ] Cache is written only on successful non-empty discovery
- [ ] `resetModelCache()` is exported and works
- [ ] No TypeScript errors

---

### Task 3: Full test run and verification

**Context:**
Final verification pass to ensure nothing is broken across the entire test suite. No code changes expected — just verification.

**Files:**
- All test files

**Steps:**
- [ ] Run `npm run test:run` — full suite must pass
- [ ] Run `npm run build` — must succeed
- [ ] If any fixes were needed, commit them. Otherwise no commit needed.

**Acceptance criteria:**
- [ ] Full test suite passes
- [ ] Build succeeds
- [ ] No regressions
