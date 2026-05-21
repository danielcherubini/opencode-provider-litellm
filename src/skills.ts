import { tool } from '@opencode-ai/plugin'
import type { PluginConfig, Skill } from './types.js'

interface CacheEntry<T> {
  data: T
  timestamp: number
}

let skillsCache: CacheEntry<Skill[]> | null = null
const CACHE_TTL_MS = 60_000

/** Reset the skills cache. Used for testing. */
export function resetSkillsCache(): void {
  skillsCache = null
}

/**
 * Fetches all skills from the LiteLLM proxy.
 * Returns an empty array on any error (network, 4xx, 5xx, parse failure).
 * Uses a 10s timeout via AbortController.
 */
export async function listSkills(
  config: PluginConfig,
  token: string,
): Promise<Skill[]> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await fetch(`${config.url}/v1/skills`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      return []
    }

    const body = await response.json()

    if (!Array.isArray(body)) {
      return []
    }

    return body as Skill[]
  } catch {
    return []
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Creates a new skill on the LiteLLM proxy.
 * Returns a success message string on success, error string on failure.
 * Uses a 10s timeout via AbortController.
 */
export async function createSkill(
  config: PluginConfig,
  token: string,
  name: string,
  description: string,
  inputSchema?: Record<string, unknown>,
  code?: string,
): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await fetch(`${config.url}/v1/skills`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        description,
        input_schema: inputSchema,
        code,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      return `Error creating skill: HTTP ${response.status}`
    }

    const body = await response.json()
    const id = body.id ?? 'unknown'
    return `Skill "${name}" created (id: ${id})`
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return `Error creating skill: ${message}`
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Deletes a skill from the LiteLLM proxy.
 * Returns a success message string on success, error string on failure.
 * Uses a 10s timeout via AbortController.
 */
export async function deleteSkill(
  config: PluginConfig,
  token: string,
  skillId: string,
): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await fetch(`${config.url}/v1/skills/${skillId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      return `Error deleting skill: HTTP ${response.status}`
    }

    return `Skill "${skillId}" deleted`
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return `Error deleting skill: ${message}`
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Creates opencode tool definitions for skill CRUD operations.
 * Returns a static Record with three tools: skill_list, skill_create, skill_delete.
 */
export function createSkillToolDefinitions(
  config: PluginConfig,
  token: string,
): Record<string, any> {
  return {
    skill_list: tool({
      description: 'List all skills registered on the LiteLLM proxy',
      args: {},
      async execute(_args: Record<string, unknown>, _context: unknown): Promise<string> {
        const skills = await listSkills(config, token)

        if (skills.length === 0) {
          return 'No skills found.'
        }

        const header = '| ID | Name | Description | Enabled |'
        const sep = '|------|------|-------------|---------|'
        const rows = skills
          .map(
            (s) =>
              `| ${s.id} | ${s.name} | ${s.description} | ${s.enabled !== false ? 'yes' : 'no'} |`,
          )
          .join('\n')

        return [header, sep, ...rows.split('\n')].join('\n')
      },
    }),

    skill_create: tool({
      description: 'Create a new skill on the LiteLLM proxy',
      args: {
        name: tool.schema.string().describe('Name of the skill'),
        description: tool.schema.string().describe('Description of the skill'),
        input_schema: tool.schema
          .object({})
          .passthrough()
          .optional()
          .describe('Input schema for the skill'),
        code: tool.schema.string().optional().describe('Code for the skill'),
      },
      async execute(args: Record<string, unknown>, _context: unknown): Promise<string> {
        return createSkill(
          config,
          token,
          args.name as string,
          args.description as string,
          args.input_schema as Record<string, unknown> | undefined,
          args.code as string | undefined,
        )
      },
    }),

    skill_delete: tool({
      description: 'Delete a skill from the LiteLLM proxy',
      args: {
        skill_id: tool.schema.string().describe('ID of the skill to delete'),
      },
      async execute(args: Record<string, unknown>, _context: unknown): Promise<string> {
        return deleteSkill(config, token, args.skill_id as string)
      },
    }),
  }
}

/**
 * Creates a chat.message hook that injects active skills as context.
 * Uses in-memory cache with 60s TTL to avoid hammering the API.
 * Only injects for main agent sessions — skips all sub-agents.
 */
export function createSkillsInjector(
  config: PluginConfig,
  token: string,
): (
  input: { sessionID: string; agent?: string; model?: any; messageID?: string; variant?: string },
  output: { message: any; parts: any[] },
) => Promise<void> {
  return async (input, output) => {
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

    const enabledSkills = skills.filter((s) => s.enabled !== false)
    if (enabledSkills.length === 0) return

    const context = enabledSkills
      .map((s) => `<skill name="${s.name}">${s.description}</skill>`)
      .join('\n')

    output.parts.push({ type: 'text', text: context })
  }
}
