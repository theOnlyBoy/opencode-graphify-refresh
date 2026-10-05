import {
  isActionable,
  refresh,
  resolveConfig,
  resolveRoot,
  type GraphifyRefreshOptions,
} from './graphify-refresh.js'

/**
 * OpenCode **v2** entrypoint (`opencode-graphify-refresh/v2`).
 *
 * v2 requires a plain-object default export `{ id, setup }` — a function does not load
 * (`PluginModule.LoadError … SchemaError(Expected object at ["default"])`). So v2 lives here as a
 * separate subpath and `src/index.ts` stays the untouched v1 factory.
 *
 * The v1 hook is `tool.execute.after(input, output)` and mutates `output.output`. v2 exposes
 * `ctx.tool.hook("execute.after", (event) => …)` with a single mutable event and a different result
 * shape (captured live on 2.0.22):
 *   - the shell tool is named `shell` (not `bash`); its command is `event.input.command`;
 *   - on success `event.result = { output: { exit, truncated, output, status }, content:
 *     [{ type: "text", text }], metadata }` — the stdout string is `result.output.output`;
 *   - on failure the event carries `error` instead of `result`.
 * The event object is mutable, so notes are appended in place to both `result.output.output` and the
 * text part of `result.content` (the model reads `content`).
 *
 * IMPORTANT: nothing is imported from `@opencode/plugin` at runtime — it is not installed in the
 * config dir and the import kills the plugin. Types are structural (`any`), as our v2 plugins do.
 */

interface V2Result {
  output?: unknown
  content?: unknown
  metadata?: unknown
}

interface V2ToolEvent {
  tool?: string
  input?: { command?: string }
  status?: string
  result?: V2Result
  error?: { message?: string }
}

const NOTE_PREFIX = '[graphify] '

/** Append the refresh note wherever v2 keeps the model-visible output. Mutates in place, never throws. */
const appendNote = (event: V2ToolEvent, note: string): void => {
  const onNewLine = (base: string): string => `${base}${base.endsWith('\n') ? '' : '\n'}${note}`
  const result = event.result

  if (result) {
    if (typeof result.output === 'string') {
      result.output = onNewLine(result.output)
    } else if (result.output && typeof result.output === 'object') {
      const nested = result.output as { output?: unknown }
      if (typeof nested.output === 'string') {
        nested.output = onNewLine(nested.output)
      }
    }

    if (Array.isArray(result.content)) {
      const parts = result.content as Array<{ type?: string; text?: string }>
      const textPart = parts.find((part) => part?.type === 'text' && typeof part.text === 'string')
      if (textPart && typeof textPart.text === 'string') {
        textPart.text = onNewLine(textPart.text)
      } else {
        parts.push({ type: 'text', text: note })
      }
    }
    return
  }

  if (event.error && typeof event.error.message === 'string') {
    event.error.message = onNewLine(event.error.message)
  }
}

export default {
  id: 'graphify-refresh',
  async setup(ctx: any) {
    const options: GraphifyRefreshOptions = (ctx?.options as GraphifyRefreshOptions) ?? {}
    const directory: string | undefined =
      ctx?.location?.directory ?? ctx?.location?.path ?? ctx?.app?.directory

    try {
      if (typeof ctx?.tool?.hook !== 'function') {
        return
      }

      await ctx.tool.hook('execute.after', (event: V2ToolEvent) => {
        try {
          const tool = event?.tool
          if (tool !== 'shell' && tool !== 'bash') {
            return
          }

          const command = event?.input?.command
          if (typeof command !== 'string' || !isActionable(command)) {
            return
          }

          const config = resolveConfig(options)
          if (!directory) {
            return
          }

          const root = resolveRoot(command, directory, config.graphDir)
          if (!root) {
            return
          }

          const notes = refresh(root, config)
          if (notes.length > 0) {
            appendNote(event, `${NOTE_PREFIX}${notes.join(' | ')}`)
          }
        } catch {
          /* a hook must never break a session */
        }
      })
    } catch {
      /* fail open */
    }
  },
}
