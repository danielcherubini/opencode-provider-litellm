import { exec } from 'child_process'

let cachedToken: string | null = null
let cachedAt: number = 0
export const CACHE_TTL = 50 * 60 * 1000 // 50 minutes in ms

/**
 * Runs exec as a Promise, returning { stdout, stderr }.
 */
function execPromise(
  command: string,
  options?: Parameters<typeof exec>[1],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, options, (error, stdout, stderr) => {
      if (error) {
        reject(error)
      } else {
        resolve({
          stdout: typeof stdout === 'string' ? stdout : stdout.toString(),
          stderr: typeof stderr === 'string' ? stderr : stderr.toString(),
        })
      }
    })
  })
}

/**
 * Gets a gcloud OAuth access token, cached with a 50-minute TTL.
 * Returns null if gcloud is not available or the token cannot be fetched.
 * Logs a warning on failure.
 */
export async function getGcloudToken(): Promise<string | null> {
  // Return cached token if still valid
  if (cachedToken && (Date.now() - cachedAt) < CACHE_TTL) {
    return cachedToken
  }

  try {
    const { stdout } = await execPromise('gcloud auth print-access-token', {
      timeout: 10_000,
    })
    const token = stdout.trim()
    if (token.length === 0) {
      return null
    }
    cachedToken = token
    cachedAt = Date.now()
    return token
  } catch (error) {
    console.warn(
      `[opencode-provider-litellm] gcloud token fetch failed: ${error}`,
    )
    return null
  }
}

/**
 * Resets the token cache. Exported for testing purposes.
 */
export function resetTokenCache(): void {
  cachedToken = null
  cachedAt = 0
}
