import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getGcloudToken, resetTokenCache } from './gcloud-token.js'

const mockExec = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({
  get exec() { return mockExec },
}))

beforeEach(() => {
  vi.clearAllMocks()
  resetTokenCache()
})

describe('getGcloudToken', () => {
  it('returns token from gcloud', async () => {
    mockExec.mockImplementation(
      function (cmd: string, opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) {
        cb(null, 'test-token-123', '')
      },
    )
    const token = await getGcloudToken()
    expect(token).toBe('test-token-123')
  })

  it('caches token within TTL', async () => {
    mockExec.mockImplementation(
      function (cmd: string, opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) {
        cb(null, 'cached-token', '')
      },
    )
    await getGcloudToken()
    const cached = await getGcloudToken()
    expect(cached).toBe('cached-token')
    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  it('returns null on gcloud failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockExec.mockImplementation(
      function (cmd: string, opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) {
        cb(new Error('gcloud not found'), '', '')
      },
    )
    const token = await getGcloudToken()
    expect(token).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('returns null on empty stdout', async () => {
    mockExec.mockImplementation(
      function (cmd: string, opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) {
        cb(null, '', '')
      },
    )
    const token = await getGcloudToken()
    expect(token).toBeNull()
  })
})
