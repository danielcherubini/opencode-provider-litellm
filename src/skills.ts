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
 * Fetches all skills from the LiteLLM Skills Gateway.
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
    const response = await fetch(`${config.url}/claude-code/plugins`, {
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

    if (!body || !Array.isArray(body.plugins)) {
      return []
    }

    return body.plugins as Skill[]
  } catch {
    return []
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Fetches only enabled (public) skills from the LiteLLM Skill Hub.
 * No auth required. Useful for discovery without credentials.
 */
export async function listPublicSkills(config: PluginConfig): Promise<Skill[]> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await fetch(`${config.url}/public/skill_hub`, {
      method: 'GET',
      signal: controller.signal,
    })

    if (!response.ok) {
      return []
    }

    const body = await response.json()

    if (!body || !Array.isArray(body.plugins)) {
      return []
    }

    return body.plugins as Skill[]
  } catch {
    return []
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Registers a new skill on the LiteLLM Skills Gateway.
 * The skill points to a git source containing a SKILL.md file.
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
        source: {
          source: 'git-subdir',
          url: gitUrl,
          path: gitPath,
        },
        description: description || null,
        domain: domain || null,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      return `Error registering skill: HTTP ${response.status}`
    }

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
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      return `Error enabling skill: HTTP ${response.status}`
    }

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
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      return `Error disabling skill: HTTP ${response.status}`
    }

    return `Skill "${name}" disabled`
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return `Error disabling skill: ${message}`
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Fetches the SKILL.md content from a skill's git source.
 * Currently supports GitHub raw URLs.
 */
export async function fetchSkillContent(skill: Skill): Promise<string | null> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10_000)

  try {
    const rawUrl = buildRawGitUrl(skill.source)
    if (!rawUrl) return null

    const response = await fetch(rawUrl, {
      signal: controller.signal,
    })

    if (!response.ok) return null

    return await response.text()
  } catch {
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Builds a raw git URL for the SKILL.md file from a skill's source.
 * Currently supports GitHub git-subdir sources.
 */
function buildRawGitUrl(source: Skill['source']): string | null {
  if (source.source !== 'git-subdir') return null

  const url = source.url
  if (!url.includes('github.com')) return null

  const isRaw = url.startsWith('https://raw.githubusercontent.com')
  if (isRaw) {
    const branch = extractBranch(url)
    const path = source.path || ''
    return `https://raw.githubusercontent.com/${url.replace('https://raw.githubusercontent.com/', '').split('/').slice(0, 2).join('/')}/${branch}/${path}/SKILL.md`
  }

  const match = url.match(/https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/.*)?/)
  if (!match) return null

  const [, owner, repo] = match
  const branch = extractBranch(url) || 'master'
  const path = source.path || ''

  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}/SKILL.md`
}

/**
 * Extracts the branch name from a GitHub URL.
 * Falls back to 'master' if not found.
 */
function extractBranch(url: string): string | null {
  const match = url.match(/\/tree\/([^/]+)/)
  return match ? match[1] : null
}

/**
 * Creates opencode tool definitions for skill management operations.
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
    if (input.agent) return

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
      .map((s) => `<skill name="${s.name}">${s.description || 'No description'}</skill>`)
      .join('\n')

    output.parts.push({ type: 'text', text: context })
  }
}
