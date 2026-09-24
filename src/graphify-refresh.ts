import type { Plugin } from '@opencode-ai/plugin'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface GraphifyRefreshOptions {
  /** Bundle directory to import, relative to the project root. Default `okf`. */
  bundleDir?: string
  /** Drop graph nodes whose `source_file` does not resolve to a real file. Default true. */
  prune?: boolean
  /** Import the OKF bundle and merge it into `graphify-out/merged.json`. Default true. */
  connect?: boolean
  /** Check the bundle after a rebuild — OKF conformance and whether it is ignored. Default true. */
  validate?: boolean
}

const GRAPH_REL = 'graphify-out/graph.json'
const MERGED_REL = 'graphify-out/merged.json'
const TMP_REL = '.tmp'
const OKF_INDEX = 'index.md'
const TABLES_DIR = 'tables'

/**
 * Rebuilds the graph — the only commands worth refreshing after. `add` fetches a URL into `raw/`
 * and updates the graph too. Anchored to the start of a segment, optionally behind `VAR=value`
 * assignments, so a command that merely *quotes* the trigger — a `git commit -m '… graphify update
 * …'`, a docs echo — never fires a refresh.
 */
const TRIGGER = /^\s*(?:[A-Z_]+=\S+\s+)*graphify\s+(?:update|extract|add)\b/

/** `graphify update --help` is a question, not a rebuild. */
const HELP = /(?:^|\s)(?:--help|-h)(?=\s|$)/

const DEFAULTS: Required<GraphifyRefreshOptions> = { bundleDir: 'okf', prune: true, connect: true, validate: true }

interface GraphNode {
  id: string
  file_type?: string
  source_file?: string
  _origin?: string
}

interface GraphEdge {
  source?: string
  target?: string
}

interface GraphJson {
  nodes: GraphNode[]
  links: GraphEdge[]
}

interface CommandResult {
  status: number | null
  failed: boolean
  stdout: string
  stderr: string
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T

const writeJson = (path: string, value: unknown): void => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)

const sh = (cmd: string, args: string[], cwd: string): CommandResult => {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' })

  return {
    status: result.status,
    failed: result.error !== undefined || result.status !== 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  }
}

/**
 * Split a shell command into independently evaluated segments.
 *
 * opencode loads several plugins at once, and they all mutate the same `output.args.command`
 * string — the project-level graphify plugin prepends a reminder `echo` to a session's first bash
 * call. Testing the whole string with an anchored regex therefore misses the real `graphify update`
 * hiding behind that echo, so each segment is judged on its own.
 */
const segments = (command: string): string[] =>
  command.split(/\s*(?:&&|\|\||;|\n)\s*/).filter((segment) => segment.length > 0)

const isActionable = (command: string): boolean =>
  segments(command).some((segment) => TRIGGER.test(segment) && !HELP.test(segment))

/** `cd <path> && graphify update .` — the root the command actually ran in. */
const cdTarget = (command: string): string | null => {
  const match = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/.exec(command)

  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null
}

const resolveRoot = (command: string, directory: string): string | null => {
  const target = cdTarget(command)
  const candidates = target ? [resolve(directory, target), directory] : [directory]

  return candidates.find((candidate) => existsSync(join(candidate, GRAPH_REL))) ?? null
}

/** Mirrors okf-bridge `linker._resolve_ast_source_file`. */
const resolvesToFile = (root: string, sourceFile: string): boolean => existsSync(resolve(root, sourceFile))

const isUnresolvableCodeNode = (root: string, node: GraphNode): boolean => {
  if (node.file_type !== 'code' || node._origin !== 'ast' || !node.source_file) {
    return false
  }

  return !resolvesToFile(root, node.source_file)
}

/** Drops unresolvable code nodes and every edge referencing them. Returns what changed. */
const pruneGraph = (root: string): { nodes: number; links: number } => {
  const graphPath = join(root, GRAPH_REL)
  const graph = readJson<GraphJson>(graphPath)
  const doomed = new Set(graph.nodes.filter((node) => isUnresolvableCodeNode(root, node)).map((node) => node.id))

  if (doomed.size === 0) {
    return { nodes: 0, links: 0 }
  }

  const linksBefore = graph.links.length
  graph.nodes = graph.nodes.filter((node) => !doomed.has(node.id))
  graph.links = graph.links.filter((edge) => !doomed.has(edge.source ?? '') && !doomed.has(edge.target ?? ''))
  writeJson(graphPath, graph)

  return { nodes: doomed.size, links: linksBefore - graph.links.length }
}

/** Keeps only nodes whose id is absent from `existingIds`, dropping the edges they orphan. */
const subtractNodes = (graph: GraphJson, existingIds: Set<string>): GraphJson => {
  const nodes = graph.nodes.filter((node) => !existingIds.has(node.id))
  const kept = new Set(nodes.map((node) => node.id))
  const links = graph.links.filter((edge) => kept.has(edge.source ?? '') && kept.has(edge.target ?? ''))

  return { ...graph, nodes, links }
}

const okfBridgeAvailable = (root: string): boolean => !sh('okf-bridge', ['--version'], root).failed

interface ConnectResult {
  nodes: number
  links: number
  linked: boolean
  /** `merged.json` came out byte-identical — the merge was a no-op, so there is nothing to report. */
  unchanged: boolean
}

const connectBundle = (
  root: string,
  bundleDir: string,
): ConnectResult | { error: string } | { skipped: string } | null => {
  const bundle = join(root, bundleDir)

  if (!existsSync(join(bundle, OKF_INDEX))) {
    return null
  }

  if (!okfBridgeAvailable(root)) {
    return { skipped: 'okf-bridge not installed' }
  }

  const tmp = join(root, TMP_REL)
  mkdirSync(tmp, { recursive: true })
  const importedPath = join(tmp, 'okf-graph.json')

  const imported = sh('okf-bridge', ['import', bundleDir, '-o', importedPath], root)

  if (imported.failed) {
    return { error: `okf-bridge import failed: ${imported.stderr}` }
  }

  const hasTables = existsSync(join(bundle, TABLES_DIR))
  let base = GRAPH_REL

  if (hasTables) {
    const linkedPath = join(tmp, 'linked.json')
    const linked = sh('okf-bridge', ['link', GRAPH_REL, bundleDir, '-o', linkedPath, '--repo-root', '.'], root)

    if (linked.failed) {
      return { error: `okf-bridge link failed: ${linked.stderr}` }
    }

    // `link`'s output already holds the code graph plus the table concepts it referenced, and
    // `graphify merge-graphs` prefixes ids per input instead of deduping — so it is the merge BASE,
    // never an extra input alongside `graph.json`.
    base = linkedPath
    const seen = new Set(readJson<GraphJson>(linkedPath).nodes.map((node) => node.id))
    writeJson(importedPath, subtractNodes(readJson<GraphJson>(importedPath), seen))
  }

  const mergedPath = join(root, MERGED_REL)
  const before = existsSync(mergedPath) ? readFileSync(mergedPath, 'utf8') : null

  const merged = sh('graphify', ['merge-graphs', base, importedPath, '--out', MERGED_REL], root)

  if (merged.failed) {
    return { error: `graphify merge-graphs failed: ${merged.stderr}` }
  }

  const after = existsSync(mergedPath) ? readFileSync(mergedPath, 'utf8') : null
  const out = readJson<GraphJson>(mergedPath)

  return {
    nodes: out.nodes.length,
    links: out.links.length,
    linked: hasTables,
    unchanged: before !== null && before === after,
  }
}

const IGNORE_FILES = ['.graphifyignore', '.gitignore']

/** True when the bundle directory is ignored, so graphify will not index the same markdown twice. */
const isBundleIgnored = (root: string, bundleDir: string): boolean => {
  const escaped = bundleDir.replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const exact = new RegExp(`^/?${escaped}/?$`)

  return IGNORE_FILES.some((file) => {
    const path = join(root, file)

    if (!existsSync(path)) {
      return false
    }

    return readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim().replace(/\/+$/, ''))
      .some((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('!') && exact.test(line))
  })
}

/**
 * Bundle health. Reported only when the refresh actually changed something: `okf-bridge validate`
 * always prints, so running it on every no-op update would break the promise that a graph with
 * nothing to do stays quiet.
 */
const bundleHealth = (root: string, bundleDir: string): string[] => {
  const notes: string[] = []
  const validation = sh('okf-bridge', ['validate', '--strict', bundleDir], root)

  if (validation.failed) {
    const detail = (validation.stdout || validation.stderr).split('\n').filter(Boolean).slice(-3).join(' ')
    notes.push(`okf-bridge validate: ${detail || 'bundle does not conform'}`)
  }

  if (!isBundleIgnored(root, bundleDir)) {
    notes.push(`${bundleDir}/ is not in .graphifyignore — graphify will index the bundle twice`)
  }

  return notes
}

const refresh = (root: string, config: Required<GraphifyRefreshOptions>): string[] => {
  const notes: string[] = []

  if (config.prune) {
    const pruned = pruneGraph(root)

    if (pruned.nodes > 0) {
      notes.push(`pruned ${pruned.nodes} node(s) + ${pruned.links} edge(s)`)
    }
  }

  if (config.connect) {
    const connected = connectBundle(root, config.bundleDir)

    if (connected && 'error' in connected) {
      notes.push(connected.error)
    } else if (connected && 'skipped' in connected) {
      notes.push(connected.skipped)
    } else if (connected && !connected.unchanged) {
      const suffix = connected.linked ? ' (incl. link)' : ''
      notes.push(`merged.json ${connected.nodes} node(s) + ${connected.links} edge(s)${suffix}`)

      if (config.validate) {
        notes.push(...bundleHealth(root, config.bundleDir))
      }
    }
  }

  return notes
}

/**
 * Graphify Refresh
 *
 * After any `graphify update` / `graphify extract` / `graphify add` run through opencode's bash tool
 * it:
 *  1. prunes graph nodes whose `source_file` does not resolve to a real file — graphify's
 *     dynamic-import rescue mints them from type-only `typeof import(...)` text, and `okf-bridge`
 *     aborts its whole run when it tries to read one; and
 *  2. connects the repo's OKF bundle (`okf/`) into `graphify-out/merged.json` via `okf-bridge
 *     import`, adding `okf-bridge link`'s code→table edges when the bundle has a `tables/` section;
 *     and
 *  3. when that work changed something, checks the bundle — OKF conformance and whether the bundle
 *     directory is ignored.
 *
 * A hook must never break a session: every failure is reported in the tool output, never thrown.
 *
 * IMPORTANT: opencode calls *every* export of a plugin module as a plugin factory, so this module
 * must keep exactly one runtime export.
 */
export const GraphifyRefresh: Plugin = async ({ directory }, options?: GraphifyRefreshOptions) => {
  const config: Required<GraphifyRefreshOptions> = { ...DEFAULTS, ...(options ?? {}) }

  return {
    'tool.execute.after': async (input, output) => {
      if (input?.tool !== 'bash') {
        return
      }

      const command = input?.args?.command ?? ''

      if (!isActionable(command)) {
        return
      }

      let notes: string[]

      try {
        const root = resolveRoot(command, directory)

        if (!root) {
          return
        }

        notes = refresh(root, config)
      } catch (error) {
        notes = [`error: ${error instanceof Error ? error.message : String(error)}`]
      }

      if (notes.length > 0) {
        output.output = `${output.output ?? ''}\n[graphify] ${notes.join(' | ')}`
      }
    },
  }
}
