import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tool } from '@opencode-ai/plugin'
import type { PluginConfig, Skill } from './types.js'
import {
  listSkills,
  registerSkill,
  enableSkill,
  disableSkill,
  createSkillToolDefinitions,
} from './skills.js'

const mockSkill: Skill = {
  id: 'skill-1',
  name: 'code-review',
  version: '1.0.0',
  description: 'Reviews code for best practices',
  source: {
    source: 'git-subdir',
    url: 'https://github.com/org/repo',
    path: 'skills/code-review',
  },
  author: null,
  homepage: null,
  keywords: null,
  category: null,
  domain: null,
  namespace: null,
  enabled: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

describe('listSkills', () => {
  const config: PluginConfig = {
    url: 'https://litellm.example.com',
    apiKey: 'test-api-key',
  }
  const token = 'test-token'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns skills from plugins response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ plugins: [mockSkill] }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await listSkills(config, token)

    expect(result).toEqual([mockSkill])
    expect(mockFetch).toHaveBeenCalledWith(
      'https://litellm.example.com/claude-code/plugins',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it('returns [] on error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network error'))
    vi.stubGlobal('fetch', mockFetch)

    const result = await listSkills(config, token)
    expect(result).toEqual([])
  })

  it('returns [] on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    vi.stubGlobal('fetch', mockFetch)

    const result = await listSkills(config, token)
    expect(result).toEqual([])
  })

  it('returns [] on invalid response format', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ plugins: null }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await listSkills(config, token)
    expect(result).toEqual([])
  })

  it('respects timeout', async () => {
    vi.useFakeTimers()

    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        }
      })
    })
    vi.stubGlobal('fetch', mockFetch)

    const promise = listSkills(config, token)
    await vi.advanceTimersByTimeAsync(10001)
    const result = await promise
    vi.useRealTimers()

    expect(result).toEqual([])
  })
})

describe('registerSkill', () => {
  const config: PluginConfig = {
    url: 'https://litellm.example.com',
    apiKey: 'test-api-key',
  }
  const token = 'test-token'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns success message', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ plugin: { id: 'new-1', name: 'my-skill' } }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await registerSkill(
      config, token, 'my-skill', 'https://github.com/org/repo', 'skills/my-skill', 'A test skill',
    )

    expect(result).toBe('Skill "my-skill" registered (id: new-1)')
    expect(mockFetch).toHaveBeenCalledWith(
      'https://litellm.example.com/claude-code/plugins',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'my-skill',
          source: { source: 'git-subdir', url: 'https://github.com/org/repo', path: 'skills/my-skill' },
          description: 'A test skill',
          domain: null,
        }),
      }),
    )
  })

  it('returns error string on failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('connection refused'))
    vi.stubGlobal('fetch', mockFetch)

    const result = await registerSkill(config, token, 'my-skill', 'https://github.com/org/repo', 'skills/my-skill')
    expect(result).toBe('Error registering skill: connection refused')
  })

  it('returns error string on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 400 })
    vi.stubGlobal('fetch', mockFetch)

    const result = await registerSkill(config, token, 'my-skill', 'https://github.com/org/repo', 'skills/my-skill')
    expect(result).toContain('Error registering skill')
  })

  it('includes domain when provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ plugin: { id: 'skill-3', name: 'domain-skill' } }),
    })
    vi.stubGlobal('fetch', mockFetch)

    await registerSkill(
      config, token, 'domain-skill', 'https://github.com/org/repo', 'skills/domain-skill', 'A domain skill', 'Productivity',
    )

    expect(mockFetch).toHaveBeenCalledWith(
      'https://litellm.example.com/claude-code/plugins',
      expect.objectContaining({
        body: JSON.stringify({
          name: 'domain-skill',
          source: { source: 'git-subdir', url: 'https://github.com/org/repo', path: 'skills/domain-skill' },
          description: 'A domain skill',
          domain: 'Productivity',
        }),
      }),
    )
  })
})

describe('enableSkill', () => {
  const config: PluginConfig = {
    url: 'https://litellm.example.com',
    apiKey: 'test-api-key',
  }
  const token = 'test-token'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns success message', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', mockFetch)

    const result = await enableSkill(config, token, 'my-skill')
    expect(result).toBe('Skill "my-skill" enabled')
    expect(mockFetch).toHaveBeenCalledWith(
      'https://litellm.example.com/claude-code/plugins/my-skill/enable',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    )
  })

  it('returns error string on failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('connection refused'))
    vi.stubGlobal('fetch', mockFetch)

    const result = await enableSkill(config, token, 'my-skill')
    expect(result).toBe('Error enabling skill: connection refused')
  })

  it('returns error string on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 })
    vi.stubGlobal('fetch', mockFetch)

    const result = await enableSkill(config, token, 'my-skill')
    expect(result).toContain('Error enabling skill')
  })
})

describe('disableSkill', () => {
  const config: PluginConfig = {
    url: 'https://litellm.example.com',
    apiKey: 'test-api-key',
  }
  const token = 'test-token'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns success message', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', mockFetch)

    const result = await disableSkill(config, token, 'my-skill')
    expect(result).toBe('Skill "my-skill" disabled')
    expect(mockFetch).toHaveBeenCalledWith(
      'https://litellm.example.com/claude-code/plugins/my-skill/disable',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    )
  })

  it('returns error string on failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('connection refused'))
    vi.stubGlobal('fetch', mockFetch)

    const result = await disableSkill(config, token, 'my-skill')
    expect(result).toBe('Error disabling skill: connection refused')
  })

  it('returns error string on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 })
    vi.stubGlobal('fetch', mockFetch)

    const result = await disableSkill(config, token, 'my-skill')
    expect(result).toContain('Error disabling skill')
  })
})

describe('createSkillToolDefinitions', () => {
  const config: PluginConfig = {
    url: 'https://litellm.example.com',
    apiKey: 'test-api-key',
  }
  const token = 'test-token'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns 4 tools with correct names', () => {
    const result = createSkillToolDefinitions(config, token)

    expect(Object.keys(result)).toHaveLength(4)
    expect(result).toHaveProperty('skill_list')
    expect(result).toHaveProperty('skill_register')
    expect(result).toHaveProperty('skill_enable')
    expect(result).toHaveProperty('skill_disable')
  })

  it('skill_list has correct description', () => {
    const result = createSkillToolDefinitions(config, token)
    expect(result.skill_list.description).toBe('List all skills registered on the LiteLLM Skills Gateway')
  })

  it('skill_register has correct description', () => {
    const result = createSkillToolDefinitions(config, token)
    expect(result.skill_register.description).toBe('Register a new skill on the LiteLLM Skills Gateway pointing to a git source')
  })

  it('skill_enable has correct description', () => {
    const result = createSkillToolDefinitions(config, token)
    expect(result.skill_enable.description).toBe('Enable (publish) a skill on the LiteLLM Skills Gateway')
  })

  it('skill_disable has correct description', () => {
    const result = createSkillToolDefinitions(config, token)
    expect(result.skill_disable.description).toBe('Disable (unpublish) a skill on the LiteLLM Skills Gateway')
  })

  it('skill_list execute returns formatted markdown table', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        plugins: [
          { ...mockSkill, name: 'code-review', description: 'Reviews code', enabled: true },
          { ...mockSkill, name: 'security-scan', description: 'Scans security', enabled: false },
        ],
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = createSkillToolDefinitions(config, token)
    const output = await result.skill_list.execute({}, {} as any)

    expect(output).toContain('code-review')
    expect(output).toContain('security-scan')
    expect(output).toContain('Reviews code')
    expect(output).toContain('Scans security')
  })

  it('skill_register execute calls registerSkill', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ plugin: { id: 'new-skill', name: 'new-skill' } }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = createSkillToolDefinitions(config, token)

    const output = await result.skill_register.execute(
      { name: 'new-skill', git_url: 'https://github.com/org/repo', git_path: 'skills/new-skill', description: 'A new skill' },
      {} as any,
    )

    expect(output).toBe('Skill "new-skill" registered (id: new-skill)')
  })

  it('skill_enable execute calls enableSkill', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', mockFetch)

    const result = createSkillToolDefinitions(config, token)
    const output = await result.skill_enable.execute({ name: 'skill-to-enable' }, {} as any)
    expect(output).toBe('Skill "skill-to-enable" enabled')
  })

  it('skill_disable execute calls disableSkill', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', mockFetch)

    const result = createSkillToolDefinitions(config, token)
    const output = await result.skill_disable.execute({ name: 'skill-to-disable' }, {} as any)
    expect(output).toBe('Skill "skill-to-disable" disabled')
  })
})
