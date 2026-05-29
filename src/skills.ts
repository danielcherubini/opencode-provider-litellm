import { tool } from '@opencode-ai/plugin'
import type { PluginConfig, Skill } from './types.js'

/**
 * Fetches all skills from the LiteLLM Skills Gateway.
 * Returns an empty array on any error.
 */
export async function listSkills(
  config: PluginConfig,
  token: string,
): Promise<Skill[]> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await fetch(`${config.url}/claude-code/plugins`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })

    if (!response.ok) return []

    const body = await response.json()
    if (!body || !Array.isArray(body.plugins)) return []

    return body.plugins as Skill[]
  } catch {
    return []
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Registers a new skill on the LiteLLM Skills Gateway.
 */
export async function registerSkill(
  config: PluginConfig,
  token: string,
  name: string,
  gitUrl: string,
  gitPath: string,
  description?: string,
  domain?: string,
): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await fetch(`${config.url}/claude-code/plugins`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        source: { source: 'git-subdir', url: gitUrl, path: gitPath },
        description: description || null,
        domain: domain || null,
      }),
      signal: controller.signal,
    })

    if (!response.ok) return `Error registering skill: HTTP ${response.status}`

    const body = await response.json()
    const id = body?.plugin?.id ?? 'unknown'
    return `Skill "${name}" registered (id: ${id})`
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return `Error registering skill: ${message}`
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Enables (publishes) a skill on the LiteLLM Skills Gateway.
 */
export async function enableSkill(
  config: PluginConfig,
  token: string,
  name: string,
): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await fetch(`${config.url}/claude-code/plugins/${name}/enable`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })

    if (!response.ok) return `Error enabling skill: HTTP ${response.status}`
    return `Skill "${name}" enabled`
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return `Error enabling skill: ${message}`
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Disables (unpublishes) a skill on the LiteLLM Skills Gateway.
 */
export async function disableSkill(
  config: PluginConfig,
  token: string,
  name: string,
): Promise<string> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await fetch(`${config.url}/claude-code/plugins/${name}/disable`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })

    if (!response.ok) return `Error disabling skill: HTTP ${response.status}`
    return `Skill "${name}" disabled`
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return `Error disabling skill: ${message}`
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Creates opencode tool definitions for skill management.
 * Returns tools: skill_list, skill_register, skill_enable, skill_disable.
 */
export function createSkillToolDefinitions(
  config: PluginConfig,
  token: string,
): Record<string, any> {
  return {
    skill_list: tool({
      description: 'List all skills registered on the LiteLLM Skills Gateway',
      args: {},
      async execute(_args: Record<string, unknown>, _context: unknown): Promise<string> {
        const skills = await listSkills(config, token)

        if (skills.length === 0) {
          return 'No skills found.'
        }

        const header = '| Name | Description | Enabled | Source |'
        const sep = '|--------|-------------|---------|--------|'
        const rows = skills
          .map(
            (s) =>
              `| ${s.name} | ${s.description || '-'} | ${s.enabled ? 'yes' : 'no'} | ${s.source.url} |`,
          )
          .join('\n')

        return [header, sep, ...rows.split('\n')].join('\n')
      },
    }),

    skill_register: tool({
      description: 'Register a new skill on the LiteLLM Skills Gateway pointing to a git source',
      args: {
        name: tool.schema.string().describe('Name of the skill'),
        git_url: tool.schema.string().describe('GitHub repository URL containing the skill'),
        git_path: tool.schema.string().describe('Path within the repo to the skill directory (must contain SKILL.md)'),
        description: tool.schema.string().optional().describe('Description of the skill'),
        domain: tool.schema.string().optional().describe('Domain/category for the skill'),
      },
      async execute(args: Record<string, unknown>, _context: unknown): Promise<string> {
        return registerSkill(
          config,
          token,
          args.name as string,
          args.git_url as string,
          args.git_path as string,
          args.description as string | undefined,
          args.domain as string | undefined,
        )
      },
    }),

    skill_enable: tool({
      description: 'Enable (publish) a skill on the LiteLLM Skills Gateway',
      args: {
        name: tool.schema.string().describe('Name of the skill to enable'),
      },
      async execute(args: Record<string, unknown>, _context: unknown): Promise<string> {
        return enableSkill(config, token, args.name as string)
      },
    }),

    skill_disable: tool({
      description: 'Disable (unpublish) a skill on the LiteLLM Skills Gateway',
      args: {
        name: tool.schema.string().describe('Name of the skill to disable'),
      },
      async execute(args: Record<string, unknown>, _context: unknown): Promise<string> {
        return disableSkill(config, token, args.name as string)
      },
    }),
  }
}
