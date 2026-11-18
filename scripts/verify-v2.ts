import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, execSync } from 'node:child_process'

function findOpencodeBinary(): string {
  const candidates = ['/usr/local/bin/opencode2', 'opencode2', 'opencode']
  for (const bin of candidates) {
    try {
      const out = execSync(`which ${bin} 2>/dev/null || command -v ${bin} 2>/dev/null`, {
        encoding: 'utf8',
      }).trim()
      if (out && fs.existsSync(out)) {
        return out
      }
    } catch {
      if (fs.existsSync(bin)) {
        return bin
      }
    }
  }
  throw new Error('Neither opencode2 nor opencode binary found in system PATH')
}

interface MockServer {
  server: http.Server
  port: number
  close: () => Promise<void>
}

async function startMockServer(): Promise<MockServer> {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/model/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          data: [
            {
              model_name: 'test-v2-model',
              litellm_params: { model: 'test-v2-model' },
              model_info: { max_tokens: 4096 },
            },
          ],
        }),
      )
    } else if (req.url === '/mcp-rest/tools/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify([]))
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve())
    server.on('error', reject)
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to get mock server address')
  }

  return {
    server,
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function runTestServer(
  opencodeBin: string,
  tmpDir: string,
  serverPort: number,
  env: NodeJS.ProcessEnv,
): Promise<{ logs: () => string; stop: () => Promise<void>; password: string }> {
  const proc = spawn(opencodeBin, ['serve', '--port', String(serverPort), '--log-level', 'all'], {
    cwd: tmpDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let logs = ''
  proc.stdout?.on('data', (d) => {
    logs += d.toString()
  })
  proc.stderr?.on('data', (d) => {
    logs += d.toString()
  })

  // Poll until server announces readiness and password
  const startTime = Date.now()
  let password = ''
  while (Date.now() - startTime < 10000) {
    const pwMatch = logs.match(/server password (\S+)/)
    if (pwMatch) {
      password = pwMatch[1]
      break
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  if (!password) {
    proc.kill('SIGTERM')
    throw new Error(`OpenCode server failed to start within timeout. Logs:\n${logs}`)
  }

  // Await plugin activation via API endpoint
  const authHeader = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64')
  try {
    await fetch(`http://127.0.0.1:${serverPort}/api/plugin/await-activation`, {
      method: 'POST',
      headers: { Authorization: authHeader },
    })
  } catch {
    // If await-activation endpoint not present, wait a short moment for settlement
    await new Promise((r) => setTimeout(r, 500))
  }

  return {
    logs: () => logs,
    password,
    stop: async () => {
      proc.kill('SIGTERM')
      await new Promise((r) => setTimeout(r, 200))
      try {
        proc.kill('SIGKILL')
      } catch {}
    },
  }
}

async function main(): Promise<void> {
  console.log('[verify-v2] Locating OpenCode v2 binary...')
  const opencodeBin = findOpencodeBinary()
  const version = execSync(`${opencodeBin} --version`, { encoding: 'utf8' }).trim()
  console.log(`[verify-v2] Found binary: ${opencodeBin} (${version})`)

  console.log('[verify-v2] Starting mock LiteLLM server...')
  const mockServer = await startMockServer()
  console.log(`[verify-v2] Mock LiteLLM server listening on port ${mockServer.port}`)

  const baseTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-v2-verify-'))
  const posTmpDir = path.join(baseTmpDir, 'positive')
  const negTmpDir = path.join(baseTmpDir, 'negative')
  fs.mkdirSync(posTmpDir, { recursive: true })
  fs.mkdirSync(negTmpDir, { recursive: true })

  const activeServers: Array<{ stop: () => Promise<void> }> = []

  try {
    // Clean conflicting environment variables
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env }
    delete cleanEnv.LITELLM_URL
    delete cleanEnv.LITELLM_KEY
    delete cleanEnv.LITELLM_PROVIDER_ID
    delete cleanEnv.LITELLM_GCLOUD_TOKEN_AUTH
    delete cleanEnv.OPENCODE_PASSWORD
    delete cleanEnv.OPENCODE_SERVER_PASSWORD

    // --- POSITIVE TEST: with plugin configured ---
    console.log('\n[verify-v2] === Running Positive Test (with plugin) ===')
    const posConfigDir = path.join(posTmpDir, '.config', 'opencode')
    fs.mkdirSync(posConfigDir, { recursive: true })

    const pluginConfig = {
      $schema: 'https://opencode.ai/config.json',
      plugins: [
        {
          package: process.cwd(),
          options: {
            url: `http://127.0.0.1:${mockServer.port}`,
            apiKey: 'test-key',
          },
        },
      ],
    }
    fs.writeFileSync(path.join(posConfigDir, 'opencode.json'), JSON.stringify(pluginConfig, null, 2))

    const posEnv: NodeJS.ProcessEnv = {
      ...cleanEnv,
      HOME: posTmpDir,
      XDG_CONFIG_HOME: path.join(posTmpDir, '.config'),
      XDG_DATA_HOME: path.join(posTmpDir, '.local', 'share'),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    }

    const posPort = mockServer.port + 1
    const posServer = await runTestServer(opencodeBin, posTmpDir, posPort, posEnv)
    activeServers.push(posServer)

    try {
      console.log(`[verify-v2] Querying models from server on port ${posPort}...`)
      const posClientEnv = { ...posEnv, OPENCODE_PASSWORD: posServer.password }
      const posOutput = execSync(`${opencodeBin} models --server http://127.0.0.1:${posPort}`, {
        cwd: posTmpDir,
        env: posClientEnv,
        encoding: 'utf8',
      })

      const posServerLogs = posServer.logs()

      console.log('[verify-v2] Positive assertion checks:')
      // Check for error reference
      const hasErrRef = /Reference:\s*err_d8486dea/i.test(posOutput) || /Reference:\s*err_d8486dea/i.test(posServerLogs)
      if (hasErrRef) {
        throw new Error('FAILURE: Found Reference: err_d8486dea in output or server logs!')
      }
      console.log('  ✓ No err_d8486dea error reference detected')

      const hasPluginLoadFail = /Plugin failed to load/i.test(posServerLogs)
      if (hasPluginLoadFail) {
        throw new Error('FAILURE: Found "Plugin failed to load" in server logs!')
      }
      console.log('  ✓ No "Plugin failed to load" error in server logs')

      const hasTestModel = /litellm\/test-v2-model/i.test(posOutput)
      if (!hasTestModel) {
        throw new Error(`FAILURE: test-v2-model was not found in models output!\nOutput was:\n${posOutput}`)
      }
      console.log(`  ✓ Discovered model appears in output: ${posOutput.split('\n').find((l) => /test-v2-model/i.test(l))}`)
    } finally {
      await posServer.stop()
      const idx = activeServers.indexOf(posServer)
      if (idx !== -1) {
        activeServers.splice(idx, 1)
      }
    }

    // --- NEGATIVE CONTROL: without plugin ---
    console.log('\n[verify-v2] === Running Negative Control (without plugin) ===')
    const negConfigDir = path.join(negTmpDir, '.config', 'opencode')
    fs.mkdirSync(negConfigDir, { recursive: true })

    const emptyConfig = {
      $schema: 'https://opencode.ai/config.json',
      plugins: [],
    }
    fs.writeFileSync(path.join(negConfigDir, 'opencode.json'), JSON.stringify(emptyConfig, null, 2))

    const negEnv: NodeJS.ProcessEnv = {
      ...cleanEnv,
      HOME: negTmpDir,
      XDG_CONFIG_HOME: path.join(negTmpDir, '.config'),
      XDG_DATA_HOME: path.join(negTmpDir, '.local', 'share'),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    }

    const negPort = mockServer.port + 2
    const negServer = await runTestServer(opencodeBin, negTmpDir, negPort, negEnv)
    activeServers.push(negServer)

    try {
      const negClientEnv = { ...negEnv, OPENCODE_PASSWORD: negServer.password }
      const negOutput = execSync(`${opencodeBin} models --server http://127.0.0.1:${negPort}`, {
        cwd: negTmpDir,
        env: negClientEnv,
        encoding: 'utf8',
      })

      console.log('[verify-v2] Negative control checks:')
      const negHasTestModel = /test-v2-model/i.test(negOutput)
      if (negHasTestModel) {
        throw new Error('FAILURE: test-v2-model unexpectedly appeared in negative control output!')
      }
      console.log('  ✓ Model test-v2-model correctly absent when plugin is not configured')
    } finally {
      await negServer.stop()
      const idx = activeServers.indexOf(negServer)
      if (idx !== -1) {
        activeServers.splice(idx, 1)
      }
    }

    console.log('\n[verify-v2] All end-to-end OpenCode v2 verification checks passed successfully!')
  } finally {
    for (const server of [...activeServers]) {
      try {
        await server.stop()
      } catch (err) {
        console.error('[verify-v2] Error stopping active server:', err)
      }
    }
    await mockServer.close()
    fs.rmSync(baseTmpDir, { recursive: true, force: true })
    console.log('[verify-v2] Cleaned up temporary directories and stopped mock server.')
  }
}

main().catch((err) => {
  console.error('[verify-v2] VERIFICATION FAILED:', err)
  process.exit(1)
})
