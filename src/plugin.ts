import type { Plugin } from '@opencode/plugin'
import { resolvePluginConfig, getProviderId } from './utils.js'
import { discoverModels, toProviderInfo, toModelInfos } from './discovery.js'
import { createMcpToolDefinitions, type McpToolDefinition } from './mcp-tools.js'
import { getGcloudToken } from './gcloud-token.js'
import { loadModelCache, saveModelCache } from './model-cache.js'
import type { DiscoveredModel } from './types.js'

function isGcloudTokenAuth(): boolean {
  const value = process.env.LITELLM_GCLOUD_TOKEN_AUTH
  return !!value && value !== '' && value !== '0'
}

export async function setup(ctx: Plugin.Context): Promise<void> {
  const pluginConfig = resolvePluginConfig(ctx.options)
  if (pluginConfig === null) {
    throw new Error(
      isGcloudTokenAuth()
        ? "Plugin config error: set LITELLM_URL (LITELLM_KEY is optional when LITELLM_GCLOUD_TOKEN_AUTH=1)."
        : "Plugin config error: set 'url' and 'apiKey' in plugin options, " +
          'or set LITELLM_URL and LITELLM_KEY environment variables.',
    )
  }

  const providerId = getProviderId()

  const isGcloudAuth = isGcloudTokenAuth()

  // When gcloud token auth is enabled, fetch a live token instead of using
  // the static apiKey.
  const getToken = async (): Promise<string> => {
    if (isGcloudAuth) {
      return (await getGcloudToken()) ?? ''
    }
    return pluginConfig.apiKey
  }

  // Seed the provider from the model cache so opencode has something to
  // work with while live discovery runs.
  const state: { token: string; models: Record<string, DiscoveredModel> } = {
    token: await getToken(),
    models: (await loadModelCache(ctx, providerId)) ?? {},
  }

  // The transform callback is replayed on every registry rebuild, so it
  // must stay synchronous and read from captured state only.
  await ctx.provider.transform((editor) => {
    editor.add({
      info: toProviderInfo(providerId, pluginConfig.url, state.token),
      models: toModelInfos(providerId, state.models),
    })
  })

  // Discover live models, update the cache, and rebuild the registry.
  try {
    const discovered = await discoverModels(pluginConfig, getToken)

    if (Object.keys(discovered).length === 0) {
      console.warn('[opencode-provider-litellm] No models discovered')
    } else {
      state.models = discovered
      state.token = await getToken()
      await saveModelCache(ctx, providerId, discovered)
      console.log(`[opencode-provider-litellm] Discovered ${Object.keys(discovered).length} models`)
      await ctx.provider.reload()
    }
  } catch (error: unknown) {
    console.warn(`[opencode-provider-litellm] Model discovery failed: ${error}`)
  }

  // Discover MCP tools on the proxy. Failures are non-fatal: the plugin
  // works without them.
  let mcpToolDefinitions: McpToolDefinition[] = []
  try {
    mcpToolDefinitions = await createMcpToolDefinitions(pluginConfig, await getToken())
  } catch (e: unknown) {
    console.warn(`[opencode-provider-litellm] MCP tool discovery failed: ${e}`)
  }

  const toolDefinitions = mcpToolDefinitions
  await ctx.tool.transform((editor) => {
    for (const tool of toolDefinitions) {
      editor.add({
        name: tool.name,
        description: tool.description,
        input: tool.input,
        execute: (input, context) => tool.execute(input, context),
      })
    }
  })

  // Inject the session ID into LiteLLM requests so all messages from the
  // same opencode session are grouped under one conversation in LiteLLM
  // logs. With gcloud token auth, also inject a fresh OAuth token on
  // every request (the token in the provider settings goes stale).
  await ctx.session.hook(
    'model.request',
    async (event) => {
      if (isGcloudAuth) {
        const token = await getGcloudToken()
        if (token) {
          event.headers['Authorization'] = `Bearer ${token}`
        }
      }
      if (event.sessionID) {
        event.headers['X-Litellm-Session-ID'] = event.sessionID
      }
    },
    { providerID: providerId },
  )

  // Normalize `thinking` param to Vertex AI Claude format.
  // Vertex AI Claude only accepts type in {"adaptive", "disabled", "enabled"}.
  // Opencode may send string levels like "medium"/"low"/"high" or dict with
  // non-standard type values — map them to "adaptive" (Claude decides budget)
  // or "disabled" (no thinking).
  // Also ensures thinking is always a dict (LiteLLM's is_thinking_enabled
  // assumes dict shape — see BerriAI/litellm#28576, PR #28861).
  await ctx.session.hook(
    'context',
    (event) => {
      const thinking = event.options.thinking
      if (typeof thinking === 'string') {
        const type = (thinking === 'off' || thinking === 'disabled')
          ? 'disabled'
          : 'adaptive'
        event.options.thinking = { type }
      } else if (typeof thinking === 'object' && thinking !== null && !Array.isArray(thinking)) {
        const thinkingObj = thinking as Record<string, unknown>
        const type = thinkingObj.type as string | undefined
        if (typeof type === 'string' && !['adaptive', 'disabled', 'enabled'].includes(type)) {
          thinkingObj.type = 'adaptive'
        }
      }
    },
    { providerID: providerId },
  )

  console.log(
    `[opencode-provider-litellm] loaded (provider: ${providerId}, auth: ${isGcloudAuth ? 'gcloud-token' : 'api-key'})`,
  )
}
