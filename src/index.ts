import type { Plugin } from '@opencode-ai/plugin'
import { GraphifyRefresh } from './graphify-refresh.js'
import v2 from './v2.js'

/**
 * Dual-runtime entrypoint (OpenCode **v1 + v2**), per the official v2 migration guide
 * (“Support V1 and V2 from one package”): a single object default export that carries both
 * implementations — **v1 calls `server(input, options)`**, **v2 calls `setup(ctx)`**.
 *
 * `PluginModule` on v1 is `{ id?: string; server: Plugin; tui?: never }` and v2's `Plugin` is
 * `{ id, setup }`, so one object serves both. v1 object entrypoints require OpenCode **>= 1.18.29**.
 *
 * Only the default export exists on purpose: this is a plugin *module*, and a stray named export is
 * an extra plugin factory to the loader.
 */
export default {
  id: v2.id,
  setup: v2.setup,
  server: GraphifyRefresh as Plugin,
}
