import { Plugin } from '@opencode/plugin'
import { setup } from './plugin.js'

export default Plugin.define({
  id: 'opencode-provider-litellm',
  setup,
})
