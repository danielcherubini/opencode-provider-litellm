---
status: committed
task: tsk_3f1d82f4-9c65-47b1-a15a-82caf43cdd10
done-when: The plugin installs and loads cleanly in OpenCode v2 without errors, registers the LiteLLM provider and models via v2 transforms with correct limits and auth, discovers and registers MCP tools with native JSON Schema, and handles provider-scoped session hooks (model.request and context) correctly. End-to-end verification confirms models appear in `opencode2 models`. All test suites pass.
---

# Migrate Plugin to OpenCode v2

## Spec

**Problem:** OpenCode v2 rejects the current plugin with `Error: Plugin failed to load (Reference: err_d8486dea)` because v2 completely replaced the v1 hook-dictionary plugin architecture with an Effect/Promise-based runtime centered around `@opencode/plugin`, domain transforms, and typed session hooks.
**Solution:** Port the plugin to OpenCode v2 by upgrading dependencies to `@opencode/plugin` and `@opencode/schema`, exporting a `Plugin.define({ id, setup })` default export, migrating model and MCP tool registration to domain transforms (`ctx.provider.transform`, `ctx.tool.transform`), and moving auth token injection and thinking parameter normalization to provider-scoped `ctx.session.hook` listeners.
**Out of scope:**
- Legacy v1 backward-compatibility: This is a clean major migration targeting OpenCode v2 exclusively (bump version to 0.11.0; engines `opencode: ">=2.0.0"`).
- GUI or TUI visual panels (the plugin remains a headless backend provider plugin).
- `/connect` GUI integration method: auth continues to be configured via plugin options (`url`, `apiKey`) or environment variables (`LITELLM_URL`, `LITELLM_KEY`, `LITELLM_GCLOUD_TOKEN_AUTH`).
- Replacing `client.app.log`: replaced with standard stderr logging (`console.warn`, `console.error`) with prefix `[opencode-provider-litellm]`.
**Decisions:**
- Target OpenCode v2 native API cleanly: remove `@opencode-ai/plugin` and v1 hook dictionaries in Task 4.
- During Wave 2, maintain additive backward compatibility in `src/mcp-tools.ts` and `src/discovery.ts` so `src/plugin.ts` continues to compile and all tests pass after every intermediate commit.
- Provide `apiKey` in `Provider.Info.settings` for static auth, and use `ctx.session.hook("model.request", ..., { providerID })` for both dynamic GCloud Bearer token injection and `X-Litellm-Session-ID` tracing.
- Scope all session hooks (`model.request` and `context`) strictly to `{ providerID: providerId }` to prevent credential and parameter leakage to other providers.
- Retain exact MCP tool naming `mcp_${sanitizeName(server)}_${sanitizeName(tool)}` and description suffix `(via ${server} MCP server)`. Pass JSON Schema directly to `ctx.tool.transform`, and execute `getToken()` per call to ensure fresh tokens.
- Map models to `@opencode/schema`'s `Model.Info` using `Model.Info.default` with `@opencode/ai/providers/openai-compatible` and `activation: "enabled"`.
- Preserve `OpencodeModelConfig` as an internal intermediate type so on-disk model cache (`model-cache.ts`) and discovery utilities continue to work seamlessly.
**Evidence:** `docs/research/migrate-plugin-to-v2.md` based on official OpenCode v2 migration docs ([opencode.ai/v2/docs/build/plugins/migrate-v1](https://opencode.ai/v2/docs/build/plugins/migrate-v1)), server plugin guide ([opencode.ai/v2/docs/build/plugins/server](https://opencode.ai/v2/docs/build/plugins/server)), and local testing against `opencode2 v2.0.1`.

## Plan

**Goal:** Migrate `opencode-provider-litellm` to fully conform to the OpenCode v2 plugin specifications with zero regressions in capabilities.
**Architecture:** The plugin default-exports `Plugin.define({ id, setup })`. In `setup(ctx)`:
1. Resolves config via `resolvePluginConfig(ctx.options)` and environment variables.
2. Synchronously registers the provider with `activation: "enabled"`, package `@opencode/ai/providers/openai-compatible`, `settings: { baseURL: url, ...(apiKey ? { apiKey } : {}) }`, and cached `Model.Info` definitions using `ctx.provider.transform`.
3. Background discovery fetches fresh models, updates the cache, updates the in-memory provider models, and triggers `ctx.provider.reload()`.
4. Asynchronously discovers MCP tools and registers them via `ctx.tool.transform`, defaulting missing input schemas to `{ type: 'object', properties: {} }`.
5. Attaches provider-scoped `ctx.session.hook("model.request", ..., { providerID })` for GCloud auth and session tracking, and `ctx.session.hook("context", ..., { providerID })` for Claude thinking normalization.
**Tech Stack:** TypeScript 5.7+, `@opencode/plugin` (`^2.3.2`), `@opencode/schema` (`^2.3.2`), Vitest, Node 20+.

---

## Parallelisation

**Verdict:** PARALLEL — 4 waves
- Wave 1: Task 1 (package.json + install `@opencode/plugin`, `@opencode/schema`, and `tsx` as devDependency — build stays green)
- Wave 2: Task 2 (MCP tool v2 definitions) and Task 3 (Model & Provider v2 builders) — completely disjoint files; both keep legacy exports temporarily so the tree remains 100% green
- Wave 3: Task 4 (Plugin entrypoint, transforms, hooks, and removing v1 dependency & legacy exports)
- Wave 4: Task 5 (End-to-end integration and verification with `opencode2`)

---

### Task 1: Add OpenCode v2 Dependencies and Update Configuration

**Parallel:** none — modifies `package.json`.

**Context:**
OpenCode v2 plugins require `@opencode/plugin` and `@opencode/schema`. In this task, we install both packages alongside `@opencode-ai/plugin` and add `tsx` to devDependencies so that the project remains green and compiling while downstream tasks migrate modules in parallel.

**Files:**
- Modify: `package.json`

**What to implement:**
- In `package.json`:
  - Add `@opencode/plugin: "^2.3.2"` and `@opencode/schema: "^2.3.2"` to `dependencies`.
  - Add `tsx: "^4.19.0"` to `devDependencies` for the Task 5 verification harness.
  - Keep `@opencode-ai/plugin` temporarily so `src/mcp-tools.ts` and `src/plugin.ts` still compile during Wave 2.
  - Update `engines.opencode` to `>=2.0.0`.
  - Bump package version to `0.11.0`.
- Run `npm install` to update `package-lock.json`.

**Steps:**
- [ ] Add `@opencode/plugin`, `@opencode/schema`, and `tsx` to `package.json`.
- [ ] Run `npm install`
  - Did the dependencies install cleanly?
- [ ] Run `npm run typecheck`
  - Confirm existing code compiles without errors.
- [ ] Run `npm run test:run`
  - Confirm all 102 tests continue to pass.
- [ ] Commit with message: "build: add @opencode/plugin and @opencode/schema dependencies"

**Acceptance criteria:**
- [ ] `@opencode/plugin`, `@opencode/schema`, and `tsx` are installed in `node_modules` and listed in `package.json`.
- [ ] `npm run typecheck` and `npm run test:run` pass cleanly.

---

### Task 2: Migrate MCP Tool Definitions to v2 Format

**Parallel:** wave 2 — disjoint from Task 3 (`src/types.ts`, `src/discovery.ts`, `src/discovery.test.ts`).

**Context:**
In v1, `src/mcp-tools.ts` used `@opencode-ai/plugin`'s `tool()` function which required mapping JSON Schema properties into Zod schemas. In v2, `ctx.tool.transform` natively takes JSON Schema in `input` and expects `execute` to return `{ content: string }`.

**Files:**
- Modify: `src/mcp-tools.ts`
- Modify: `src/mcp-tools.test.ts`

**What to implement:**
- Define and export type `McpToolDefinition`:
  ```ts
  export interface McpToolDefinition {
    name: string
    description: string
    input: Record<string, unknown>
    execute: (input: unknown) => Promise<{ content: string }>
  }
  ```
- Export `buildMcpToolDefinitions(config: PluginConfig, getToken: () => Promise<string>): Promise<McpToolDefinition[]>`:
  - Discovers tools using `discoverMcpTools`.
  - Preserves naming rule: `name: \`mcp_${sanitizeName(tool.server_name)}_${sanitizeName(tool.name)}\``.
  - Preserves description rule: `description: \`${tool.description || tool.name} (via ${tool.server_name} MCP server)\``.
  - Sets `input: tool.input_schema && typeof tool.input_schema === 'object' ? tool.input_schema : { type: 'object', properties: {} }`.
  - In `execute(args)`: calls `await getToken()` per call, executes via `executeMcpTool(config, token, tool.server_name, tool.name, (args && typeof args === 'object' ? args : {}) as Record<string, unknown>)`, and returns `{ content: result }`.
- Keep existing `createMcpToolDefinitions` as a wrapper temporarily so `src/plugin.ts` continues to compile during Wave 2.
- In `src/mcp-tools.test.ts`:
  - Add tests for `buildMcpToolDefinitions` asserting exact naming, description suffix, fallback empty object schema, fresh token invocation, and `{ content: string }` return format.

**Steps:**
- [ ] Write unit tests in `src/mcp-tools.test.ts` for `buildMcpToolDefinitions`.
- [ ] Run `npm test run src/mcp-tools.test.ts`
  - Did it fail as expected?
- [ ] Implement `buildMcpToolDefinitions` in `src/mcp-tools.ts`.
- [ ] Run `npm test run src/mcp-tools.test.ts`
  - Did all tests pass?
- [ ] Run `npm run typecheck`
  - Confirm the entire codebase continues to typecheck cleanly.
- [ ] Commit with message: "refactor(mcp): add OpenCode v2 tool definitions using JSON Schema"

**Acceptance criteria:**
- [ ] `buildMcpToolDefinitions` returns `McpToolDefinition[]` with exact naming `mcp_<server>_<tool>` and description suffix `(via <server> MCP server)`.
- [ ] `execute(input)` fetches fresh token per call and returns `{ content: string }`.
- [ ] All unit tests in `src/mcp-tools.test.ts` and `npm run typecheck` pass.

---

### Task 3: Migrate Model and Provider Discovery to v2 Schema Format

**Parallel:** wave 2 — disjoint from Task 2 (`src/mcp-tools.ts`, `src/mcp-tools.test.ts`).

**Context:**
In v1, `src/discovery.ts` mutated `config.provider[providerId].models` with plain objects. In v2, models are instances of `Model.Info` with structured `capabilities`, `limit`, and `cost`, and the provider is defined with package `@opencode/ai/providers/openai-compatible`. `OpencodeModelConfig` is retained as an intermediate discovery/cache type to preserve cache file compatibility.

**Files:**
- Modify: `src/types.ts`
- Modify: `src/discovery.ts`
- Modify: `src/discovery.test.ts`

**What to implement:**
- In `src/types.ts`:
  - Retain `OpencodeModelConfig` so `src/model-cache.ts` and `src/utils.ts` remain intact.
  - Add imports from `@opencode/schema/model` and `@opencode/schema/provider` for v2 types (`Model`, `Provider`).
- In `src/discovery.ts`:
  - Implement `buildProviderInfo(providerId: string, url: string, apiKey?: string): Provider.Info`:
    - Uses `Provider.Info.empty(Provider.ID.make(providerId))`.
    - Sets `name: "LiteLLM"`.
    - Sets `activation: "enabled"`.
    - Sets `package: "@opencode/ai/providers/openai-compatible"`.
    - Sets `settings: { baseURL: url, ...(apiKey ? { apiKey } : {}) }`.
  - Implement `buildModelInfo(providerID: Provider.ID, id: string, config: OpencodeModelConfig): Model.Info`:
    - Uses `Model.Info.default(providerID, Model.ID.make(id))`.
    - Sets `name: config.name || id`.
    - Sets `limit`:
      - `context`: `Math.floor(config.limit?.context ?? 32768)`
      - `output`: `Math.floor(config.limit?.output ?? 4096)`
    - Sets `capabilities`:
      - `tools`: `config.tool_call !== false`
      - `input`: `config.modalities?.input || ["text"]`
      - `output`: `config.modalities?.output || ["text"]`
    - Sets `cost`: converts `config.cost` into valid tiers with `cache: { read: 0 as any, write: 0 as any }`, or empty array `[]`.
  - Implement `buildProviderRecord(providerId: string, url: string, apiKey: string | undefined, models: Record<string, OpencodeModelConfig>)`:
    - Returns `{ info: Provider.Info, models: Model.Info[] }`.
  - Keep `injectModelsIntoConfig` temporarily as a deprecated helper so `src/plugin.ts` continues to compile during Wave 2.
- In `src/discovery.test.ts`:
  - Add unit tests asserting `buildProviderInfo`, `buildModelInfo`, and `buildProviderRecord`.
  - Verify floored integer limits, tool capabilities, and cost structure.

**Steps:**
- [ ] Write unit tests in `src/discovery.test.ts` for `buildProviderInfo` and `buildModelInfo`.
- [ ] Run `npm test run src/discovery.test.ts`
  - Did it fail as expected?
- [ ] Implement `buildProviderInfo`, `buildModelInfo`, and `buildProviderRecord` in `src/discovery.ts`.
- [ ] Run `npm test run src/discovery.test.ts`
  - Did all tests pass?
- [ ] Run `npm run typecheck`
  - Confirm the entire codebase continues to typecheck cleanly.
- [ ] Commit with message: "feat(discovery): map LiteLLM models and provider to OpenCode v2 schema"

**Acceptance criteria:**
- [ ] `buildProviderInfo` sets `activation: "enabled"`, `package: "@opencode/ai/providers/openai-compatible"`, and `settings.baseURL` + `settings.apiKey`.
- [ ] `buildModelInfo` constructs valid `Model.Info` with floored integer limits and complete capability/cost objects.
- [ ] All tests in `src/discovery.test.ts` and `npm run typecheck` pass.

---

### Task 4: Port Plugin Entrypoint, Transforms, and Session Hooks

**Parallel:** none — wires together Tasks 1-3.

**Context:**
Replace the v1 hook dictionary with `Plugin.define({ id, setup })` from `@opencode/plugin`. Use `ctx.provider.transform` for provider and model registration with live reload, `ctx.tool.transform` for MCP tools, and provider-scoped `ctx.session.hook` for auth headers and thinking parameter normalization. Remove the deprecated `@opencode-ai/plugin` dependency and all temporary backward-compatibility shims.

**Files:**
- Modify: `src/plugin.ts`
- Modify: `src/index.ts`
- Modify: `src/mcp-tools.ts`
- Modify: `src/discovery.ts`
- Modify: `src/plugin.test.ts`
- Modify: `package.json`

**What to implement:**
- In `package.json`: remove `@opencode-ai/plugin` from dependencies.
- In `src/mcp-tools.ts`: remove deprecated `createMcpToolDefinitions` and export `buildMcpToolDefinitions`.
- In `src/discovery.ts`: remove deprecated `injectModelsIntoConfig`.
- In `src/plugin.ts`:
  - Import `{ Plugin, Provider, Model }` from `@opencode/plugin`.
  - Define `export const LiteLLMPlugin = Plugin.define({ id: "litellm", async setup(ctx) { ... } })`.
  - In `setup(ctx)`:
    - Resolve config: `const pluginConfig = resolvePluginConfig(ctx.options)`.
    - If config is null, throw informative error.
    - Setup mutable `source = { info: buildProviderInfo(providerId, pluginConfig.url, pluginConfig.apiKey), models: [] as Model.Info[] }`.
    - Preload cached models: read `loadModelCache(providerId)`, map each to `Model.Info` via `buildModelInfo`, and populate `source.models`.
    - Register provider synchronously via `await ctx.provider.transform((editor) => { editor.add(source) })`.
    - Setup live discovery in background with error handling:
      - `void discoverModels(pluginConfig, getToken).then(async (models) => { if (Object.keys(models).length > 0) { saveModelCache(providerId, models); source.models = Object.entries(models).map(([id, m]) => buildModelInfo(Provider.ID.make(providerId), id, m)); await ctx.provider.reload(); } }).catch((err) => console.warn(`[opencode-provider-litellm] Model discovery failed: ${err}`))`.
    - Register MCP tools:
      - Call `await buildMcpToolDefinitions(pluginConfig, getToken)`.
      - Register each in `ctx.tool.transform((editor) => { for (const t of tools) editor.add(t) })`.
    - Register provider-scoped session hooks with `{ providerID: providerId }`:
      - `"model.request"`:
        - If `isGcloudAuth`, fetch live token and set `event.headers['Authorization'] = `Bearer ${token}``.
        - Else if `pluginConfig.apiKey`, ensure `event.headers['Authorization'] = `Bearer ${pluginConfig.apiKey}``.
        - If `event.sessionID`, set `event.headers['X-Litellm-Session-ID'] = event.sessionID`.
      - `"context"`, `"compaction"`, `"generate"`, `"title"`:
        - Normalize `options.thinking` to Vertex AI Claude format (`"adaptive"` / `"disabled"`).
- In `src/index.ts`:
  - `export default LiteLLMPlugin`
  - Remove named export `{ LiteLLMPlugin as server }`.
- Update `src/plugin.test.ts`:
  - Mock `ctx` (`ctx.provider.transform`, `ctx.provider.reload`, `ctx.tool.transform`, `ctx.session.hook`).
  - Test setup lifecycle: provider registration, model caching, live reload, MCP tool registration, scoped session hooks.
  - Test `model.request` hook setting headers and respecting `{ providerID: providerId }`.
  - Test `context` hook normalizing thinking options.

**Steps:**
- [ ] Remove `@opencode-ai/plugin` from `package.json`.
- [ ] Write failing unit test in `src/plugin.test.ts` asserting v2 `setup(ctx)` behavior and hook calls.
- [ ] Run `npm test run src/plugin.test.ts`
  - Did it fail as expected?
- [ ] Implement `LiteLLMPlugin` and `src/index.ts`.
- [ ] Run `npm run test:run` (entire test suite).
  - Did all tests pass?
- [ ] Run `npm run typecheck` and `npm run build`.
  - Did TypeScript compilation and esbuild bundle generation succeed?
- [ ] Commit with message: "feat: port LiteLLM plugin entrypoint and hooks to OpenCode v2"

**Acceptance criteria:**
- [ ] `@opencode-ai/plugin` is completely removed from the project.
- [ ] `src/index.ts` default-exports a valid OpenCode v2 `Plugin.define` instance.
- [ ] Provider and MCP tools are registered via domain transforms.
- [ ] Session hooks are scoped to `{ providerID: providerId }`.
- [ ] `npm run typecheck`, `npm run test:run`, and `npm run build` all pass cleanly.

---

### Task 5: End-to-End Verification with OpenCode v2

**Parallel:** none — verifies the final built artifact.

**Context:**
Verify that the built plugin can be loaded by `opencode2` (OpenCode v2.0.1) without throwing the `Reference: err_d8486dea` error, and that `opencode2 models` positively outputs the discovered models.

**Files:**
- Create: `scripts/verify-v2.ts`
- Modify: `README.md` (update documentation to reflect v2 usage and config)

**What to implement:**
- In `scripts/verify-v2.ts`, implement an isolated integration verification harness:
  - Creates a temporary directory for `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` to prevent cache/global config contamination.
  - Clears any conflicting environment variables (`LITELLM_URL`, `LITELLM_KEY`, `LITELLM_PROVIDER_ID`).
  - Starts an HTTP mock server on `127.0.0.1:0` serving:
    - `/v1/model/info` returning `{ data: [{ model_name: "test-v2-model", litellm_params: { model: "test-v2-model" }, model_info: { max_tokens: 4096 } }] }`.
    - `/mcp-rest/tools/list` returning `[]`.
  - Writes a temporary `opencode.json`:
    `{ "plugins": [ { "package": "<cwd>", "options": { "url": "http://127.0.0.1:<port>", "apiKey": "test-key" } } ] }`.
  - Runs `opencode2 models --standalone` pointing `OPENCODE_CONFIG` to the temporary config.
  - Positive Assertion: Checks that the command output contains `litellm/test-v2-model` and contains no error references.
  - Negative Control: Verifies that running without the plugin does not output `test-v2-model`.
- In `README.md`:
  - Update configuration examples from v1 `"plugin": [...]` to v2 `"plugins": [...]`.
  - Remove v1 hook mentions and document OpenCode v2 compatibility.

**Steps:**
- [ ] Implement `scripts/verify-v2.ts`.
- [ ] Run `npx tsx scripts/verify-v2.ts`.
  - Verify that the positive assertion (`litellm/test-v2-model` found) passes.
- [ ] Update `README.md` with v2 configuration instructions.
- [ ] Run `npm run test:run` and `npm run build`.
- [ ] Commit with message: "docs and test: add OpenCode v2 verification script and update README"

**Acceptance criteria:**
- [ ] `opencode2` loads the built plugin without errors.
- [ ] `scripts/verify-v2.ts` runs and positively asserts that models from the provider appear in `opencode2 models`.
- [ ] `README.md` accurately documents OpenCode v2 configuration.
