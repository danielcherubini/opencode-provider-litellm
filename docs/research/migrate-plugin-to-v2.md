---
status: current
last-verified: 2026-11-18
verified-by: web research + codebase inspection, 2026-11-18
task: tsk_3f1d82f4-9c65-47b1-a15a-82caf43cdd10
---

# Research: Migrating opencode-provider-litellm to OpenCode v2

## Executive Summary

OpenCode v2 introduces a completely redesigned plugin architecture. V1 plugins that return an object with hook strings (`config`, `auth`, `tool`, `chat.headers`, `chat.params`) fail to load under OpenCode v2, producing:
`Error: Plugin failed to load (Reference: err_d8486dea)`.

In OpenCode v2, plugins must export a default object produced by `Plugin.define({ id, setup(ctx) })` from `@opencode/plugin`. Global config mutation is replaced by domain transforms (`ctx.provider.transform`, `ctx.tool.transform`), and request hooks are migrated to `ctx.session.hook("model.request")` and `ctx.session.hook("context")`.

## Findings

### 1. Plugin Entrypoint and Package Structure

* **Package Dependency:** Replace `@opencode-ai/plugin` with `@opencode/plugin` (`^2.3.2`).
* **Entrypoint Export:** In v1, the entrypoint had a named export `export { LiteLLMPlugin as server }`. In v2, the entrypoint must have a `default` export using `Plugin.define({ id, setup(ctx) })`.
* **Dual V1/V2 Support (Optional):** OpenCode's migration guide demonstrates that packages can optionally export both `setup` and `server` on the default export:
  ```ts
  import { Plugin } from "@opencode/plugin"

  export default {
    ...Plugin.define({
      id: "litellm",
      async setup(ctx) { /* v2 setup */ },
    }),
    async server(input, options) { /* v1 hook object */ },
  }
  ```

### 2. Provider and Model Registration

* In v1, model discovery injected models directly into `config.provider[providerId].models`.
* In v2, providers and models are registered via `ctx.provider.transform`:
  ```ts
  await ctx.provider.transform((editor) => {
    editor.add({
      info: {
        ...Provider.Info.empty(providerID),
        name: "LiteLLM",
        activation: "enabled",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: pluginConfig.url },
      },
      models: modelInfoList,
    })
  })
  ```
* Models are instances of `Model.Info`, created using `Model.Info.default(providerID, Model.ID.make(id))` and customized with capabilities (`tools: true`, `input: ["text"]`), limits (`context`, `output`), and pricing.
* Caching: Cached models can be injected during initial `setup`. Once background live discovery completes, `ctx.provider.reload()` or `editor.models.set(providerID, liveModels)` updates the registry dynamically.

### 3. MCP Tool Discovery and Registration

* In v1, `src/mcp-tools.ts` contained custom logic to map JSON Schema to Zod types because v1's `tool({ args: ... })` required Zod.
* In v2, `ctx.tool.transform` natively accepts standard JSON Schema:
  ```ts
  await ctx.tool.transform((editor) => {
    for (const t of discoveredTools) {
      editor.add({
        name: t.name,
        description: t.description,
        input: t.input_schema,
        async execute(input) {
          const result = await executeMcpTool(...)
          return { content: result }
        },
      })
    }
  })
  ```
* This significantly simplifies `src/mcp-tools.ts` and removes the need for Zod property mapping.

### 4. Dynamic Auth and Headers

* In v1, `'chat.headers'` set `Authorization: Bearer <gcloudToken>` and `X-Litellm-Session-ID: <sessionID>`.
* In v2, this is registered via `ctx.session.hook("model.request", async (event) => { ... }, { providerID: providerId })`:
  ```ts
  await ctx.session.hook(
    "model.request",
    async (event) => {
      if (isGcloudAuth) {
        const token = await getGcloudToken()
        if (token) event.headers["Authorization"] = `Bearer ${token}`
      }
      if (event.sessionID) {
        event.headers["X-Litellm-Session-ID"] = event.sessionID
      }
    },
    { providerID: providerId },
  )
  ```

### 5. Thinking Parameter Normalization

* In v1, `'chat.params'` normalized the `thinking` option for Vertex AI Claude.
* In v2, this is registered via `ctx.session.hook("context", (event) => { ... }, { providerID: providerId })`:
  ```ts
  await ctx.session.hook(
    "context",
    (event) => {
      const thinking = event.options.thinking
      if (typeof thinking === 'string') {
        const type = (thinking === 'off' || thinking === 'disabled') ? 'disabled' : 'adaptive'
        event.options.thinking = { type }
      } else if (typeof thinking === 'object' && thinking !== null && !Array.isArray(thinking)) {
        const thinkingObj = thinking as Record<string, unknown>
        const type = thinkingObj.type as string | undefined
        if (typeof type === 'string' && !['adaptive', 'disabled', 'enabled'].includes(type)) {
          thinkingObj.type = 'adaptive'
        }
      }
    },
    { providerID: providerId },
  )
  ```

## Evidence

* OpenCode V2 Migration Documentation: `https://opencode.ai/v2/docs/build/plugins/migrate-v1`
* OpenCode Server Plugin Documentation: `https://opencode.ai/v2/docs/build/plugins/server`
* OpenCode V2 Packages on npm: `@opencode/plugin@2.3.2`, `@opencode/ai@2.3.2`, `@opencode/schema@2.3.2`
* Local OpenCode v2 binary inspection: `opencode2 --version` -> `opencode v2.0.1` at `/usr/local/bin/opencode2`

## Unresolved Contradictions
* None. The API requirements for OpenCode v2 plugins are clearly documented and confirmed by inspecting the package type definitions.

## Gaps
* None. All hooks and capabilities currently implemented in v1 have direct equivalents in v2.
