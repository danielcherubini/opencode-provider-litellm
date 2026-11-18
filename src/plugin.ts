import { Plugin } from '@opencode/plugin'
import { Provider, Model } from '@opencode/schema'
import { resolvePluginConfig, getProviderId, getProviderDisplayName } from './utils.js'
import { discoverModels, buildProviderInfo, buildModelInfo } from './discovery.js'
import { buildMcpToolDefinitions } from './mcp-tools.js'
import { getGcloudToken } from './gcloud-token.js'
import { loadModelCache, saveModelCache } from './model-cache.js'

function normalizeThinkingParams(options: Record<string, unknown>): void {
  const thinking = options.thinking
  if (typeof thinking === 'string') {
    const type = (thinking === 'off' || thinking === 'disabled')
      ? 'disabled'
      : 'adaptive'
    options.thinking = { type }
  } else if (typeof thinking === 'object' && thinking !== null && !Array.isArray(thinking)) {
    const thinkingObj = thinking as Record<string, unknown>
    const type = thinkingObj.type as string | undefined
    if (typeof type === 'string' && !['adaptive', 'disabled', 'enabled'].includes(type)) {
      thinkingObj.type = 'adaptive'
    }
  }
}

export const LiteLLMPlugin = Plugin.define({
  id: 'litellm',
  async setup(ctx) {
    const isGcloudAuth = !!(
      (process.env.LITELLM_GCLOUD_TOKEN_AUTH &&
        process.env.LITELLM_GCLOUD_TOKEN_AUTH !== '' &&
        process.env.LITELLM_GCLOUD_TOKEN_AUTH !== '0' &&
        process.env.LITELLM_GCLOUD_TOKEN_AUTH !== 'false') ||
      (process.env.LITELLM_PROVIDER_PROTECTOR_USE_GCLOUD_AUTH &&
        process.env.LITELLM_PROVIDER_PROTECTOR_USE_GCLOUD_AUTH !== '' &&
        process.env.LITELLM_PROVIDER_PROTECTOR_USE_GCLOUD_AUTH !== '0' &&
        process.env.LITELLM_PROVIDER_PROTECTOR_USE_GCLOUD_AUTH !== 'false') ||
      (ctx.options && typeof ctx.options === 'object' && (ctx.options as Record<string, unknown>).gcloudAuth === true)
    )

    const pluginConfig = resolvePluginConfig(ctx.options)
    if (pluginConfig === null) {
      throw new Error(
        isGcloudAuth
          ? 'Plugin config error: set LITELLM_URL (LITELLM_KEY is optional when LITELLM_GCLOUD_TOKEN_AUTH=1).'
          : "Plugin config error: set 'url' and 'apiKey' in plugin options, " +
            'or set LITELLM_URL and LITELLM_KEY environment variables.',
      )
    }

    const providerId = getProviderId(ctx.options)
    const providerDisplayName = getProviderDisplayName(ctx.options, providerId)
    const providerID = Provider.ID.make(providerId)

    const getToken = async (): Promise<string> => {
      if (isGcloudAuth) {
        return (await getGcloudToken()) ?? ''
      }
      return pluginConfig.apiKey ?? ''
    }

    const source = {
      info: buildProviderInfo(providerId, pluginConfig.url, pluginConfig.apiKey, providerDisplayName),
      models: [] as Model.Info[],
    }

    const cachedModels = loadModelCache(providerId)
    if (cachedModels) {
      source.models = Object.entries(cachedModels).map(([id, m]) =>
        buildModelInfo(providerID, id, m),
      )
    }

    const targetDomain = ctx.provider ?? (ctx as any).catalog
    if (targetDomain) {
      await targetDomain.transform((editor: any) => {
        if (typeof editor.add === 'function') {
          editor.add(source)
        } else if (editor.provider && editor.model) {
          editor.provider.update(providerId, (p: any) => {
            Object.assign(p, source.info)
          })
          for (const m of source.models) {
            editor.model.update(providerId, m.id, (model: any) => {
              Object.assign(model, m)
            })
          }
        }
      })
    }

    void discoverModels(pluginConfig, getToken)
      .then(async (models) => {
        if (Object.keys(models).length > 0) {
          saveModelCache(providerId, models)
          source.models = Object.entries(models).map(([id, m]) =>
            buildModelInfo(providerID, id, m),
          )
          if (ctx.provider?.reload) {
            await ctx.provider.reload()
          } else if ((ctx as any).catalog) {
            const cat = (ctx as any).catalog
            await cat.transform((editor: any) => {
              for (const m of source.models) {
                editor.model.update(providerId, m.id, (model: any) => {
                  Object.assign(model, m)
                })
              }
            })
            if (typeof cat.reload === 'function') {
              await cat.reload()
            }
          }
        }
      })
      .catch((err) => {
        console.warn(`[opencode-provider-litellm] Model discovery failed: ${err}`)
      })

    if (ctx.tool) {
      try {
        const tools = await buildMcpToolDefinitions(pluginConfig, getToken)
        await ctx.tool.transform((editor) => {
          for (const t of tools) {
            editor.add(t)
          }
        })
      } catch (e) {
        console.warn(`[opencode-provider-litellm] MCP tool discovery failed: ${e}`)
      }
    }

    if (ctx.session?.hook) {
      const providerScoped = { providerID }

      await ctx.session.hook(
        'model.request',
        async (event) => {
          if (isGcloudAuth) {
            const token = await getGcloudToken()
            if (token) {
              event.headers['Authorization'] = `Bearer ${token}`
            }
          } else if (pluginConfig.apiKey) {
            event.headers['Authorization'] = `Bearer ${pluginConfig.apiKey}`
          }

          if (event.sessionID) {
            event.headers['X-Litellm-Session-ID'] = event.sessionID
          }
        },
        providerScoped,
      )

      const thinkingHooks = ['context', 'compaction', 'generate', 'title'] as const
      for (const hookName of thinkingHooks) {
        await ctx.session.hook(
          hookName,
          (event) => {
            if (event.options && typeof event.options === 'object') {
              normalizeThinkingParams(event.options as Record<string, unknown>)
            }
          },
          providerScoped,
        )
      }
    }
  },
})
