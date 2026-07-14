import { describe, it, expect, vi, afterEach } from 'vitest'
import type { OpencodeModelConfig } from './types.js'

const mockReadFileSync = vi.hoisted(() => vi.fn())
const mockWriteFileSync = vi.hoisted(() => vi.fn())

vi.mock('fs', () => ({
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
}))

vi.mock('os', () => ({
  homedir: () => '/home/test',
}))

const { loadModelCache, saveModelCache } = await import('./model-cache.js')

const sampleModels: Record<string, OpencodeModelConfig> = {
  'anthropic/claude-sonnet': {
    name: 'anthropic/claude-sonnet',
    tool_call: true,
    reasoning: true,
    limit: { context: 1_000_000, output: 64_000 },
    cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
  },
  'qwen/qwen3.6-27b': {
    name: 'qwen/qwen3.6-27b',
    tool_call: true,
    reasoning: false,
    limit: { context: 262144, output: 32768 },
    modalities: { input: ['text'], output: ['text'] },
  },
}

describe('loadModelCache', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns null when file does not exist', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT') })
    expect(loadModelCache('protector')).toBeNull()
  })

  it('returns null when file contains invalid JSON', () => {
    mockReadFileSync.mockReturnValue('not valid json{{{')
    expect(loadModelCache('protector')).toBeNull()
  })

  it('returns null when providerId does not match', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      providerId: 'other', models: sampleModels,
    }))
    expect(loadModelCache('protector')).toBeNull()
  })

  it('returns null when models field is missing', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      providerId: 'protector', models: null,
    }))
    expect(loadModelCache('protector')).toBeNull()
  })

  it('returns models when cache is valid', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      providerId: 'protector', models: sampleModels,
    }))
    expect(loadModelCache('protector')).toEqual(sampleModels)
  })

  it('reads from the correct path', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      providerId: 'protector', models: sampleModels,
    }))
    loadModelCache('protector')
    expect(mockReadFileSync).toHaveBeenCalledWith(
      expect.stringContaining('opencode-provider-litellm-cache.json'),
      'utf-8',
    )
  })
})

describe('saveModelCache', () => {
  afterEach(() => vi.clearAllMocks())

  it('writes a valid cache file', () => {
    saveModelCache('protector', sampleModels)
    expect(mockWriteFileSync).toHaveBeenCalledOnce()
    const [filePath, content] = mockWriteFileSync.mock.calls[0] as [string, string, string]
    expect(filePath).toContain('opencode-provider-litellm-cache.json')
    const parsed = JSON.parse(content)
    expect(parsed.providerId).toBe('protector')
    expect(parsed.models).toEqual(sampleModels)
  })

  it('writes to the correct path under ~/.local/share/opencode/', () => {
    saveModelCache('protector', sampleModels)
    const [filePath] = mockWriteFileSync.mock.calls[0] as [string, string, string]
    expect(filePath).toMatch(/\.local[/\\]share[/\\]opencode[/\\]opencode-provider-litellm-cache\.json/)
  })

  it('does not throw when writeFileSync fails', () => {
    mockWriteFileSync.mockImplementation(() => { throw new Error('EACCES') })
    expect(() => saveModelCache('protector', sampleModels)).not.toThrow()
  })

  it('round-trips correctly with loadModelCache', () => {
    let written = ''
    mockWriteFileSync.mockImplementation((_p: string, content: string) => { written = content })
    mockReadFileSync.mockImplementation(() => written)
    saveModelCache('protector', sampleModels)
    expect(loadModelCache('protector')).toEqual(sampleModels)
  })
})
