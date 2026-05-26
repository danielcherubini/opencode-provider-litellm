import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tool } from '@opencode-ai/plugin'
import type { PluginConfig, Skill } from './types.js'
import {
  listSkills,
  createSkill,
  deleteSkill,
  createSkillToolDefinitions,
  createSkillsInjector,
  resetSkillsCache,
} from './skills.js'

describe('listSkills', () => {
  const config: PluginConfig = {
    url: 'https://litellm.example.com',
    apiKey: 'test-api-key',
  }
  const token = 'test-token'

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns skills from mock response', async () => {
    const mockSkills: Skill[] = [
      { id: 'skill-1', name: 'code-review', description: 'Reviews code for best practices', enabled: true },
      { id: 'skill-2', name: 'security-scan', description: 'Scans for security issues', enabled: true },
    ]

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockSkills,
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await listSkills(config, token)

    expect(result).toEqual(mockSkills)
    expect(mockFetch).toHaveBeenCalledWith(
      'https://litellm.example.com/v1/skills',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
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
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await listSkills(config, token)
    expect(result).toEqual([])
  })

  it('respects timeout (AbortError after 10s)', async () => {
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

describe('createSkill', () => {
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
      status: 200,
      json: async () => ({ id: 'skill-new-1', name: 'my-skill' }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await createSkill(config, token, 'my-skill', 'A test skill')

    expect(result).toBe('Skill "my-skill" created (id: skill-new-1)')
    expect(mockFetch).toHaveBeenCalledWith(
      'https://litellm.example.com/v1/skills',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ name: 'my-skill', description: 'A test skill', input_schema: undefined, code: undefined }),
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it('returns error string on failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('connection refused'))
    vi.stubGlobal('fetch', mockFetch)

    const result = await createSkill(config, token, 'my-skill', 'A test skill')

    expect(result).toBe('Error creating skill: connection refused')
  })

  it('returns error string on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await createSkill(config, token, 'my-skill', 'A test skill')

    expect(result).toContain('Error creating skill')
  })

  it('includes input_schema and code when provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'skill-3', name: 'complex-skill' }),
    })
    vi.stubGlobal('fetch', mockFetch)

    await createSkill(
      config,
      token,
      'complex-skill',
      'A complex skill',
      { type: 'object', properties: { value: { type: 'string' } } },
      'print("hello")',
    )

    expect(mockFetch).toHaveBeenCalledWith(
      'https://litellm.example.com/v1/skills',
      expect.objectContaining({
        body: JSON.stringify({
          name: 'complex-skill',
          description: 'A complex skill',
          input_schema: { type: 'object', properties: { value: { type: 'string' } } },
          code: 'print("hello")',
        }),
      }),
    )
  })
})

describe('deleteSkill', () => {
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
      status: 200,
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await deleteSkill(config, token, 'skill-1')

    expect(result).toBe('Skill "skill-1" deleted')
    expect(mockFetch).toHaveBeenCalledWith(
      'https://litellm.example.com/v1/skills/skill-1',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it('returns error string on failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('connection refused'))
    vi.stubGlobal('fetch', mockFetch)

    const result = await deleteSkill(config, token, 'skill-1')

    expect(result).toBe('Error deleting skill: connection refused')
  })

  it('returns error string on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await deleteSkill(config, token, 'skill-1')

    expect(result).toContain('Error deleting skill')
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

  it('returns 3 tools with correct names', () => {
    const result = createSkillToolDefinitions(config, token)

    expect(Object.keys(result)).toHaveLength(3)
    expect(result).toHaveProperty('skill_list')
    expect(result).toHaveProperty('skill_create')
    expect(result).toHaveProperty('skill_delete')
  })

  it('skill_list has correct description', () => {
    const result = createSkillToolDefinitions(config, token)

    expect(result.skill_list.description).toBe('List all skills registered on the LiteLLM proxy')
  })

  it('skill_create has correct description', () => {
    const result = createSkillToolDefinitions(config, token)

    expect(result.skill_create.description).toBe('Create a new skill on the LiteLLM proxy')
  })

  it('skill_delete has correct description', () => {
    const result = createSkillToolDefinitions(config, token)

    expect(result.skill_delete.description).toBe('Delete a skill from the LiteLLM proxy')
  })

  it('skill_list execute returns formatted markdown table', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { id: 'skill-1', name: 'code-review', description: 'Reviews code', enabled: true },
        { id: 'skill-2', name: 'security-scan', description: 'Scans security', enabled: false },
      ],
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = createSkillToolDefinitions(config, token)

    const output = await result.skill_list.execute({}, {} as any)

    expect(output).toContain('code-review')
    expect(output).toContain('security-scan')
    expect(output).toContain('Reviews code')
    expect(output).toContain('Scans security')
  })

  it('skill_create execute calls createSkill', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'skill-new', name: 'new-skill' }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = createSkillToolDefinitions(config, token)

    const output = await result.skill_create.execute(
      { name: 'new-skill', description: 'A new skill' },
      {} as any,
    )

    expect(output).toBe('Skill "new-skill" created (id: skill-new)')
  })

  it('skill_delete execute calls deleteSkill', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = createSkillToolDefinitions(config, token)

    const output = await result.skill_delete.execute(
      { skill_id: 'skill-to-delete' },
      {} as any,
    )

    expect(output).toBe('Skill "skill-to-delete" deleted')
  })
})

describe('createSkillsInjector', () => {
  const config: PluginConfig = {
    url: 'https://litellm.example.com',
    apiKey: 'test-api-key',
  }
  const token = 'test-token'

  beforeEach(() => {
    vi.restoreAllMocks()
    resetSkillsCache()
  })

  it('injects skills as text parts', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { id: 'skill-1', name: 'code-review', description: 'Reviews code', enabled: true },
        { id: 'skill-2', name: 'security-scan', description: 'Scans security' },
      ],
    })
    vi.stubGlobal('fetch', mockFetch)

    const injector = createSkillsInjector(config, token)

    const input = { sessionID: 'main-session' }
    const output: { message: any; parts: Array<{ type: string; text: string }> } = { message: { content: 'Hello' }, parts: [] }

    await injector(input, output)

    expect(output.parts).toHaveLength(1)
    expect(output.parts[0].type).toBe('text')
    expect(output.parts[0].text).toContain('<skill name="code-review">Reviews code</skill>')
    expect(output.parts[0].text).toContain('<skill name="security-scan">Scans security</skill>')
  })

  it('skips ALL sub-agent sessions (returns when input.agent is truthy)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { id: 'skill-1', name: 'code-review', description: 'Reviews code', enabled: true },
      ],
    })
    vi.stubGlobal('fetch', mockFetch)

    const injector = createSkillsInjector(config, token)

    const input = { sessionID: 'main-session', agent: 'sub-agent-1' }
    const output = { message: { content: 'Hello' }, parts: [] }

    await injector(input, output)

    // Should not have injected anything — sub-agent sessions are skipped
    expect(output.parts).toEqual([])
    // Should not have called fetch since it returns early
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('skips when no enabled skills', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { id: 'skill-1', name: 'disabled-skill', description: 'Disabled', enabled: false },
      ],
    })
    vi.stubGlobal('fetch', mockFetch)

    const injector = createSkillsInjector(config, token)

    const input = { sessionID: 'main-session' }
    const output = { message: { content: 'Hello' }, parts: [] }

    await injector(input, output)

    expect(output.parts).toEqual([])
  })

  it('cache TTL works (second call within TTL uses cache)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { id: 'skill-1', name: 'cached-skill', description: 'Cached', enabled: true },
      ],
    })
    vi.stubGlobal('fetch', mockFetch)

    const injector = createSkillsInjector(config, token)

    // First call — should fetch
    await injector({ sessionID: 'session-1' }, { message: {}, parts: [] })
    expect(mockFetch).toHaveBeenCalledTimes(1)

    // Second call — should use cache (fetch not called again)
    await injector({ sessionID: 'session-2' }, { message: {}, parts: [] })
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('silently skips on fetch failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network error'))
    vi.stubGlobal('fetch', mockFetch)

    const injector = createSkillsInjector(config, token)

    const input = { sessionID: 'main-session' }
    const output = { message: { content: 'Hello' }, parts: [] }

    // Should not throw
    await expect(injector(input, output)).resolves.toBeUndefined()
    expect(output.parts).toEqual([])
  })
})
