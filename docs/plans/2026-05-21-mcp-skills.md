# MCP Tools + Skills Integration Plan

**Goal:** Expose LiteLLM proxy's managed MCP tools and Anthropic Skills as native opencode capabilities.

**Architecture:** Two new modules (`mcp-tools.ts`, `skills.ts`) provide tool definitions and a chat.message hook. The existing `plugin.ts` wires them into the `tool` and `chat.message` hooks. Zero changes to discovery/auth.

**Tech Stack:** TypeScript, `@opencode-ai/plugin` (tool helper), fetch API

---

### Task 1: MCP Tools module

**Context:**
LiteLLM proxy manages MCP servers and exposes their tools via a REST API (`/mcp-rest/tools/list` and `/mcp-rest/tools/call`). This task creates a module that discovers those tools at plugin startup and registers each one as an individual opencode tool with its original description and parameter schema. This gives the LLM the best experience — one tool call with full context, no meta-tool indirection.

**Files:**
- Create: `src/mcp-tools.ts`
- Modify: `src/types.ts` (add `McpTool` interface)
- Create: `src/mcp-tools.test.ts`

**What to implement:**

1. In `src/types.ts`, add:
```ts
export interface McpTool {
  name: string
  server_name: string
  description: string
  input_schema: Record<string, unknown>
}
```

2. In `src/mcp-tools.ts`, implement three exports:

**`discoverMcpTools(config: PluginConfig, token: string): Promise<McpTool[]>`**
- `GET {config.url}/mcp-rest/tools/list` with headers `{ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }`
- Parse response — expect an array of `{ name, server_name, description, input_schema }` objects
- If response is not an array or is empty, return `[]`
- On any error (network, 4xx, 5xx, parse failure), return `[]` — do NOT throw
- Use a 10s timeout via AbortController

**`executeMcpTool(config: PluginConfig, token: string, server: string, toolName: string, args: Record<string, unknown>): Promise<string>`**
- `POST {config.url}/mcp-rest/tools/call` with body `{ server, tool: toolName, args }`
- Headers: `{ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }`
- On success, return the response body as a formatted string:
  - If response has a `result` field, stringify it with `JSON.stringify(result, null, 2)`
  - Otherwise, stringify the entire response
- On error, return `Error calling {toolName} on {server}: {error message}` — do NOT throw
- Use a 30s timeout via AbortController

**`createMcpToolDefinitions(config: PluginConfig, token: string): Promise<Record<string, any>>`**
- Calls `discoverMcpTools(config, token)`
- For each tool, create an opencode tool definition using `tool()` from `@opencode-ai/plugin`:
  - Tool name: `mcp_${serverName}_${toolName}` — lowercase, replace any non-alphanumeric chars with `_`
  - Description: `{description} (via {serverName} MCP server)`
  - Args: build from `input_schema` using these explicit JSON Schema → zod mapping rules:

    | JSON Schema type | Zod mapping |
    |---|---|
    | `{ "type": "string" }` | `tool.schema.string().describe(propertyName)` |
    | `{ "type": "number" }` / `{ "type": "integer" }` | `tool.schema.number().describe(propertyName)` |
    | `{ "type": "boolean" }` | `tool.schema.boolean().describe(propertyName)` |
    | `{ "type": "array", "items": { "type": "string" } }` | `tool.schema.array(tool.schema.string()).describe(propertyName)` |
    | Property NOT in `required[]` | wrap with `.optional()` |
    | Anything else (nested objects, `$ref`, `anyOf`, etc.) | fallback to single-arg mode |

    Fallback single-arg mode (when schema can't be mapped):
    ```ts
    args: { args: tool.schema.record(tool.schema.string(), tool.schema.unknown()).describe("Tool arguments as key-value pairs") }
    ```

  - Execute signature: `async execute(args, _context)` — accept `_context` parameter to match `tool()` helper signature. Body: call `executeMcpTool(config, token, serverName, toolName, args)` and return the result string.
- Return `Record<string, ToolDefinition>` mapping tool name → definition
- If discovery returns 0 tools, return `{}`

3. In `src/mcp-tools.test.ts`, write tests:
- `discoverMcpTools` returns tools from a mock response
- `discoverMcpTools` returns `[]` on network error
- `discoverMcpTools` returns `[]` on 4xx response
- `discoverMcpTools` respects timeout (AbortError after 10s)
- `executeMcpTool` returns formatted result on success
- `executeMcpTool` returns error string on failure
- `executeMcpTool` respects timeout (AbortError after 30s)
- `createMcpToolDefinitions` produces correct tool names (namespaced, sanitized)
- `createMcpToolDefinitions` returns `{}` when no tools discovered
- `createMcpToolDefinitions` maps JSON Schema types correctly (string → string(), number → number(), etc.)
- `createMcpToolDefinitions` falls back to single-arg mode for unmappable schemas

**Steps:**
- [ ] Add `McpTool` interface to `src/types.ts`
- [ ] Write failing tests in `src/mcp-tools.test.ts` for all three functions
- [ ] Run `npm run test:run` — verify tests fail
- [ ] Implement `discoverMcpTools` in `src/mcp-tools.ts`
- [ ] Implement `executeMcpTool` in `src/mcp-tools.ts`
- [ ] Implement `createMcpToolDefinitions` in `src/mcp-tools.ts`
- [ ] Run `npm run test:run` — verify all tests pass
- [ ] Run `npm run typecheck` — verify no type errors
- [ ] Commit with message: "feat: add MCP tools discovery and execution module"

**Acceptance criteria:**
- [ ] `discoverMcpTools` fetches from `/mcp-rest/tools/list` and returns `McpTool[]`
- [ ] `discoverMcpTools` returns `[]` on any error (never throws)
- [ ] `executeMcpTool` POSTs to `/mcp-rest/tools/call` and returns formatted string
- [ ] `executeMcpTool` returns error string on failure (never throws)
- [ ] `createMcpToolDefinitions` produces namespaced tool definitions with correct descriptions
- [ ] All tests pass, typecheck passes

---

### Task 2: Skills module

**Context:**
LiteLLM proxy supports Anthropic-style Skills — named context blocks that get injected into conversations. This task creates a module that (a) exposes CRUD tools for managing skills, and (b) provides a `chat.message` hook that fetches active skills and injects them as context. An in-memory cache with 60s TTL prevents hammering the API on every message.

**Files:**
- Create: `src/skills.ts`
- Modify: `src/types.ts` (add `Skill` interface)
- Create: `src/skills.test.ts`

**What to implement:**

1. In `src/types.ts`, add:
```ts
export interface Skill {
  id: string
  name: string
  description: string
  enabled?: boolean
  [key: string]: unknown
}
```

2. In `src/skills.ts`, implement:

**In-memory cache helper (simple, non-generic):**
```ts
interface CacheEntry<T> {
  data: T
  timestamp: number
}
let skillsCache: CacheEntry<Skill[]> | null = null
const CACHE_TTL_MS = 60_000
```

**`listSkills(config: PluginConfig, token: string): Promise<Skill[]>`**
- `GET {config.url}/v1/skills` with Bearer auth
- Parse response — expect array of skill objects
- On error, return `[]` — do NOT throw
- Use a 10s timeout

**`createSkill(config: PluginConfig, token: string, name: string, description: string, inputSchema?: Record<string, unknown>, code?: string): Promise<string>`**
- `POST {config.url}/v1/skills` with body `{ name, description, input_schema: inputSchema, code }`
- On success, return `Skill "{name}" created (id: {id})`
- On error, return `Error creating skill: {message}` — do NOT throw

**`deleteSkill(config: PluginConfig, token: string, skillId: string): Promise<string>`**
- `DELETE {config.url}/v1/skills/{skillId}`
- On success, return `Skill "{skillId}" deleted`
- On error, return `Error deleting skill: {message}` — do NOT throw

**`createSkillToolDefinitions(config: PluginConfig, token: string): Record<string, any>`**
- Returns a static `Record<string, ToolDefinition>` with three tools using `tool()` from `@opencode-ai/plugin`:
  - **`skill_list`** — description: "List all skills registered on the LiteLLM proxy", args: `{}` (empty), execute: calls `listSkills` and returns formatted markdown table
  - **`skill_create`** — description: "Create a new skill on the LiteLLM proxy", args: `{ name: string, description: string, input_schema: object (optional), code: string (optional) }`, execute: calls `createSkill`
  - **`skill_delete`** — description: "Delete a skill from the LiteLLM proxy", args: `{ skill_id: string }`, execute: calls `deleteSkill`

**`createSkillsInjector(config: PluginConfig, token: string): (input: { sessionID: string; agent?: string; model?: any; messageID?: string; variant?: string }, output: { message: any; parts: any[] }) => Promise<void>`**
- Returns a function matching the `chat.message` hook signature from `@opencode-ai/plugin`:
  ```ts
  async (input, output) => {
    // Only inject for main agent session — skip ALL sub-agents
    if (input.agent) return

    // Fetch skills with simple in-memory cache
    let skills: Skill[] = []
    if (skillsCache && Date.now() - skillsCache.timestamp < CACHE_TTL_MS) {
      skills = skillsCache.data
    } else {
      skills = await listSkills(config, token)
      skillsCache = { data: skills, timestamp: Date.now() }
    }

    const enabledSkills = skills.filter(s => s.enabled !== false)
    if (enabledSkills.length === 0) return

    const context = enabledSkills
      .map(s => `<skill name="${s.name}">${s.description}</skill>`)
      .join('\n')

    output.parts.push({ type: 'text', text: context })
  }
  ```
- On fetch failure, silently skip (`listSkills` returns `[]` on error)

3. In `src/skills.test.ts`, write tests:
- `listSkills` returns skills from mock response
- `listSkills` returns `[]` on error
- `listSkills` respects timeout (AbortError after 10s)
- `createSkill` returns success message
- `createSkill` returns error string on failure
- `deleteSkill` returns success message
- `deleteSkill` returns error string on failure
- `createSkillToolDefinitions` returns 3 tools with correct names
- `createSkillsInjector` injects skills as text parts
- `createSkillsInjector` skips ALL sub-agent sessions (returns when `input.agent` is truthy)
- Cache TTL works (second call within TTL uses cache)

**Steps:**
- [ ] Add `Skill` interface to `src/types.ts`
- [ ] Write failing tests in `src/skills.test.ts`
- [ ] Run `npm run test:run` — verify tests fail
- [ ] Implement cache helper in `src/skills.ts`
- [ ] Implement `listSkills`, `createSkill`, `deleteSkill` in `src/skills.ts`
- [ ] Implement `createSkillToolDefinitions` in `src/skills.ts`
- [ ] Implement `createSkillsInjector` in `src/skills.ts`
- [ ] Run `npm run test:run` — verify all tests pass
- [ ] Run `npm run typecheck` — verify no type errors
- [ ] Commit with message: "feat: add Skills CRUD and context injection module"

**Acceptance criteria:**
- [ ] `listSkills` fetches from `/v1/skills` and returns `Skill[]`
- [ ] `createSkill` / `deleteSkill` return formatted success/error strings (never throw)
- [ ] `createSkillToolDefinitions` returns 3 tools: `skill_list`, `skill_create`, `skill_delete`
- [ ] `createSkillsInjector` injects enabled skills as `<skill>` XML-tagged text parts (description only)
- [ ] `createSkillsInjector` skips ALL sub-agent sessions (returns when `input.agent` is truthy)
- [ ] In-memory cache respects 60s TTL
- [ ] All tests pass, typecheck passes

---

### Task 3: Wire into plugin

**Context:**
The final task integrates the MCP Tools and Skills modules into the existing `LiteLLMPlugin`. The plugin's `tool` hook merges MCP tool definitions (dynamic, discovered at startup) with Skills CRUD tools (static). The `chat.message` hook injects Skills context. Existing `config` and `auth` hooks are unchanged.

**Files:**
- Modify: `src/plugin.ts`
- Modify: `src/plugin.test.ts` (add tests for new hooks)

**What to implement:**

1. In `src/plugin.ts`:
   - Import `createMcpToolDefinitions` from `./mcp-tools.js`
   - Import `createSkillToolDefinitions`, `createSkillsInjector` from `./skills.js`
   - In the plugin's return object, add:
     ```ts
     tool: {
       ...(await createMcpToolDefinitions(pluginConfig, pluginConfig.apiKey)),
       ...createSkillToolDefinitions(pluginConfig, pluginConfig.apiKey),
     },
     "chat.message": createSkillsInjector(pluginConfig, pluginConfig.apiKey),
     ```
   - Wrap MCP tool discovery in try/catch — if it fails, use `console.warn` and continue with just Skills tools:
     ```ts
     let mcpTools: Record<string, any> = {}
     try {
       mcpTools = await createMcpToolDefinitions(pluginConfig, pluginConfig.apiKey)
     } catch (e) {
       console.warn(`[opencode-provider-litellm] MCP tool discovery failed: ${e}`)
     }
     ```
   - Note: The new MCP/Skills functions take `token: string` directly (not `getToken: () => Promise<string>`). This is intentional — they're called once at plugin init, not repeatedly like `discoverModels`. Pass `pluginConfig.apiKey` directly.

2. In `src/plugin.test.ts`:
   - Test that `tool` hook returns merged MCP + Skills tools
   - Test that `chat.message` hook is defined
   - Test that MCP discovery failure doesn't break the plugin (Skills tools still present)
   - Add `vi.mock('./mcp-tools.js')` and `vi.mock('./skills.js')` following existing `vi.mock('./discovery.js')` pattern
   - Test that the plugin still works with just env vars (no inline config)

**Steps:**
- [ ] Add imports to `src/plugin.ts`
- [ ] Add `tool` hook merging MCP + Skills definitions
- [ ] Add `chat.message` hook for Skills injection
- [ ] Add error handling for MCP discovery failure
- [ ] Write tests in `src/plugin.test.ts`
- [ ] Run `npm run test:run` — verify all tests pass
- [ ] Run `npm run typecheck` — verify no type errors
- [ ] Commit with message: "feat: wire MCP tools and Skills into plugin hooks"

**Acceptance criteria:**
- [ ] Plugin returns `tool` hook with MCP tools (if discovered) + Skills CRUD tools
- [ ] Plugin returns `chat.message` hook for Skills context injection
- [ ] MCP discovery failure doesn't crash the plugin — Skills tools still work
- [ ] Existing `config` and `auth` hooks work unchanged
- [ ] All tests pass, typecheck passes

---
