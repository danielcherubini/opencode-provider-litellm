#!/usr/bin/env node
/**
 * Raw E2E tests for an OpenAI-compatible API endpoint (e.g. a LiteLLM
 * proxy) — no opencode, no plugin install.
 *
 * Usage:
 *   node scripts/e2e-proxy.mjs            # discovery + mcp list + chat + tool-call
 *   node scripts/e2e-proxy.mjs --probe 20 # finish-reason probe, N iterations per model
 *
 * Config: LITELLM_URL / LITELLM_KEY env vars, or a local .env file.
 * Test models: E2E_TEST_MODELS (comma-separated, required for any prompt
 * test — see below). Optional E2E_REASONING_EFFORT is sent as
 * `reasoning_effort` on every chat request.
 *
 * IMPORTANT: live prompts are sent ONLY to the exact models listed in
 * E2E_TEST_MODELS. On shared deployments, prompting models outside your
 * test set can offload them and disrupt in-flight sessions.
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..'

function loadEnv() {
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
    }
  } catch { /* no .env */ }
}
loadEnv()

const URL_ = process.env.LITELLM_URL
const KEY = process.env.LITELLM_KEY
if (!URL_ || !KEY) {
  console.error('Missing LITELLM_URL / LITELLM_KEY')
  process.exit(1)
}

/** Exact allowlist — never prompt anything outside it (see header). */
const TEST_MODELS = (process.env.E2E_TEST_MODELS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const results = []
function report(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function withTimeout(ms) {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), ms)
  return { signal: c.signal, cleanup: () => clearTimeout(t) }
}

const REQUEST_TIMEOUT = 60_000

async function main() {
  console.log(`Proxy: ${URL_}`)

  // ---- 1. /v1/model/info ----
  let models = []
  {
    const { signal, cleanup } = withTimeout(15_000)
    try {
      const res = await fetch(`${URL_}/v1/model/info`, {
        headers: { Authorization: `Bearer ${KEY}` },
        signal,
      })
      if (!res.ok) {
        report('GET /v1/model/info', false, `HTTP ${res.status}`)
      } else {
        const body = await res.json()
        models = (body.data ?? [])
          .map((e) => e?.model_name)
          .filter(Boolean)
        report('GET /v1/model/info', true, `${models.length} models`)
        const testables = models.filter((m) => TEST_MODELS.includes(m))
        report('model/info contains test targets', testables.length > 0,
          `found: ${testables.join(', ') || 'NONE'}; missing: ${TEST_MODELS.filter((m) => !models.includes(m)).join(', ') || 'none'}`)
      }
    } catch (e) {
      report('GET /v1/model/info', false, String(e))
    } finally {
      cleanup()
    }
  }

  // ---- 2. /mcp-rest/tools/list ----
  {
    const { signal, cleanup } = withTimeout(10_000)
    try {
      const res = await fetch(`${URL_}/mcp-rest/tools/list`, {
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        signal,
      })
      if (res.ok) {
        const body = await res.json()
        const n = Array.isArray(body) ? body.length : NaN
        report('GET /mcp-rest/tools/list', true, Array.isArray(body) ? `${n} tools` : `non-array body (${typeof body}) — plugin returns []`)
      } else {
        report('GET /mcp-rest/tools/list', true, `HTTP ${res.status} — non-fatal, plugin returns []`)
      }
    } catch (e) {
      report('GET /mcp-rest/tools/list', true, `network error (${String(e)}) — non-fatal, plugin returns []`)
    } finally {
      cleanup()
    }
  }

  const testModels = TEST_MODELS.filter((m) => models.includes(m))
  const missing = TEST_MODELS.filter((m) => !models.includes(m))
  if (missing.length) {
    console.warn(`Missing from discovery (skipped): ${missing.join(', ')}`)
  }
  if (models.length && TEST_MODELS.length === 0) {
    console.warn('E2E_TEST_MODELS is not set — discovery checked, but no chat/tool-call tests will run')
  }

  const isProbe = process.argv[2] === '--probe'
  const iterations = isProbe ? Math.max(1, parseInt(process.argv[3] ?? '20', 10)) : 1

  for (const model of testModels) {
    if (isProbe) {
      await probeFinishReason(model, iterations)
    } else {
      await testChat(model)
      await testToolCall(model)
    }
  }

  // ---- summary ----
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    console.log('Failed:')
    for (const f of failed) console.log(`  - ${f.name}`)
    process.exit(1)
  }
}

function chatHeaders() {
  return {
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json',
    'X-Litellm-Session-ID': 'e2e-proxy-script', // mirror the plugin's model.request hook
  }
}

/** Streams a chat completion; returns { chunks, finish, trailing } for the SSE stream. */
async function streamChat(model, messages, extra = {}) {
  const { signal, cleanup } = withTimeout(REQUEST_TIMEOUT)
  try {
    const res = await fetch(`${URL_}/v1/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(),
      body: JSON.stringify({ model, messages, stream: true, ...extra }),
      signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { error: `HTTP ${res.status}: ${text.slice(0, 300)}` }
    }

    const chunks = []
    let finish = null // index of the chunk carrying finish_reason
    let trailing = []

    const decoder = new TextDecoder()
    let buffer = ''
    for await (const part of res.body) {
      buffer += decoder.decode(part, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') continue
        let json
        try {
          json = JSON.parse(payload)
        } catch {
          continue
        }
        const idx = chunks.length
        chunks.push(json)
        const reason = json.choices?.[0]?.finish_reason
        if (reason != null) {
          if (finish === null) finish = idx
          else trailing.push({ idx, finish_reason: reason, delta: json.choices?.[0]?.delta })
        } else if (finish !== null) {
          trailing.push({ idx, delta: json.choices?.[0]?.delta })
        }
      }
    }
    return { chunks, finish, trailing }
  } catch (e) {
    return { error: String(e) }
  } finally {
    cleanup()
  }
}

function deltaKeys(delta) {
  return Object.keys(delta ?? {})
}

async function testChat(model) {
  const extra = process.env.E2E_REASONING_EFFORT
    ? { reasoning_effort: process.env.E2E_REASONING_EFFORT }
    : {}
  const r = await streamChat(model, [
    { role: 'user', content: 'Reply with exactly: OK' },
  ], extra)
  if (r.error) {
    report(`chat stream: ${model}`, false, r.error)
    return
  }
  const hasFinish = r.finish !== null
  const content = r.chunks
    .map((c) => c.choices?.[0]?.delta?.content ?? '')
    .join('')
  report(`chat stream: ${model}`, hasFinish && content.length > 0,
    `${r.chunks.length} chunks, finish_reason at #${r.finish}, content: ${JSON.stringify(content.slice(0, 40))}`)
  if (r.trailing.length) {
    report(`no chunks after finish_reason: ${model}`, false,
      `${r.trailing.length} trailing chunk(s), delta keys: ${r.trailing.map((t) => deltaKeys(t.delta).join('|') || '∅').join(', ')}`)
  } else {
    report(`no chunks after finish_reason: ${model}`, true)
  }
}

async function testToolCall(model) {
  const { signal, cleanup } = withTimeout(REQUEST_TIMEOUT)
  try {
    const res = await fetch(`${URL_}/v1/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(),
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: 'user', content: "What's the weather in Paris? Use the get_weather tool." }],
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get current weather for a city',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        }],
        tool_choice: 'auto',
      }),
      signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      report(`tool call: ${model}`, false, `HTTP ${res.status}: ${text.slice(0, 200)}`)
      return
    }
    const body = await res.json()
    const calls = body.choices?.[0]?.message?.tool_calls ?? []
    const ok = calls.length > 0 && calls[0]?.function?.name
    report(`tool call: ${model}`, !!ok,
      ok ? `${calls[0].function.name}(${calls[0].function.arguments.slice(0, 60)})` : JSON.stringify(body.choices?.[0]?.message).slice(0, 200))
  } catch (e) {
    report(`tool call: ${model}`, false, String(e))
  } finally {
    cleanup()
  }
}

async function probeFinishReason(model, iterations) {
  const extra = process.env.E2E_REASONING_EFFORT
    ? { reasoning_effort: process.env.E2E_REASONING_EFFORT }
    : {}
  let trailingSeen = 0
  const kinds = new Map()
  for (let i = 0; i < iterations; i++) {
    const r = await streamChat(model, [
      { role: 'user', content: 'Think step by step, then answer: what is 17 * 23 + 5?' },
    ], extra)
    if (r.error) {
      console.log(`  probe ${model} #${i + 1}: ERROR ${r.error}`)
      continue
    }
    if (r.trailing.length) {
      trailingSeen++
      for (const t of r.trailing) {
        const key = deltaKeys(t.delta).join('|') || '∅'
        kinds.set(key, (kinds.get(key) ?? 0) + 1)
      }
    }
  }
  const verdict = trailingSeen === 0
    ? 'PROXY CLEAN'
    : `TRAILING REASONING CHUNK — confirms upstream opencode bug #56455`
  report(`finish-reason probe: ${model} (${iterations} iterations)`, true,
    `${trailingSeen}/${iterations} requests had trailing chunks [${[...kinds.entries()].map(([k, n]) => `${k}: ${n}`).join(', ') || 'none'}] → ${verdict}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
