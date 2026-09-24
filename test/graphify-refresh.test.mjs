import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

/** Tests run against the built artifact — the same file the package publishes. */
const PLUGIN = new URL('../dist/index.js', import.meta.url).href

/** The bundle-connect case needs `okf-bridge` on PATH; it is skipped when absent. */
const hasOkfBridge = (() => {
  try {
    return spawnSync('okf-bridge', ['--version']).status === 0
  } catch {
    return false
  }
})()

const FIXTURE = '/tmp/graphify-plugin-fixture'
const BUNDLE_FIXTURE = '/tmp/graphify-plugin-fixture-bundle'
const GRAPH = (root) => `${root}/graphify-out/graph.json`
const MERGED = (root) => `${root}/graphify-out/merged.json`

const plugin = await import(PLUGIN)
const factory = plugin.default

/** 2 phantom nodes (bare-package source_file), 1 real file node, 1 concept, 1 empty-source node. */
const writeFixture = (root) => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(`${root}/app/plugins`, { recursive: true })
  writeFileSync(`${root}/app/plugins/api.ts`, 'export {}\n')
  mkdirSync(`${root}/graphify-out`, { recursive: true })
  writeFileSync(
    GRAPH(root),
    JSON.stringify(
      {
        directed: false,
        multigraph: false,
        graph: {},
        nodes: [
          {
            id: 'app_plugins_api_ts',
            label: 'api.ts',
            file_type: 'code',
            _origin: 'ast',
            source_file: 'app/plugins/api.ts',
            source_location: 'L1',
          },
          { id: 'ofetch', label: 'ofetch', file_type: 'code', _origin: 'ast', source_file: 'ofetch' },
          { id: 'vue_vue', label: 'vue', file_type: 'code', _origin: 'ast', source_file: 'vue' },
          {
            id: 'some_concept',
            label: 'Some Concept',
            file_type: 'concept',
            _origin: null,
            source_file: 'okf:some/concept',
          },
          { id: 'empty_source', label: 'nested', file_type: 'code', _origin: 'ast', source_file: '' },
        ],
        links: [
          {
            source: 'app_plugins_api_ts',
            target: 'ofetch',
            relation: 'dynamic_import',
            confidence: 'EXTRACTED',
            confidence_score: 1.0,
            source_file: 'tests/plugins/api.spec.ts',
          },
          {
            source: 'vue_vue',
            target: 'some_concept',
            relation: 'dynamic_import',
            confidence: 'EXTRACTED',
            confidence_score: 1.0,
            source_file: 'tests/plugins/urql.spec.ts',
          },
          {
            source: 'some_concept',
            target: 'app_plugins_api_ts',
            relation: 'references',
            confidence: 'EXTRACTED',
            confidence_score: 1.0,
            source_file: 'okf/some/concept.md',
          },
        ],
        hyperedges: [],
      },
      null,
      2,
    ),
  )
}

/** Phantom fixture plus a minimal `okf/` bundle with a `tables/` section — the link path. */
const writeBundleFixture = (root, { ignored = false } = {}) => {
  writeFixture(root)
  mkdirSync(`${root}/okf/tables`, { recursive: true })
  writeFileSync(
    `${root}/okf/index.md`,
    '---\nokf_version: "0.2"\n---\n\n# Fixture bundle\n\n* [Note](/tables/note.md) - one table concept.\n',
  )
  writeFileSync(
    `${root}/okf/tables/note.md`,
    '---\ntype: Table\ntitle: Note\ndescription: Fixture table concept.\n---\n\n# Schema\n\n| Column | Type |\n|---|---|\n| `id` | Integer PK |\n',
  )

  if (ignored) {
    writeFileSync(`${root}/.graphifyignore`, 'okf/\n')
  }
}

const runHook = async (root, command) => {
  const hooks = await factory({ directory: root }, {})
  const output = { output: 'raw tool output' }
  await hooks['tool.execute.after']({ tool: 'bash', args: { command: `cd ${root} && ${command}` } }, output)
  return output.output
}

const results = []
const check = async (name, fn) => {
  try {
    results.push([name, 'PASS', await fn()])
  } catch (error) {
    results.push([name, 'FAIL', error.message])
  }
}

await check('module exports one unique plugin factory (opencode calls every export as a plugin)', () => {
  const values = Object.values(plugin)
  assert.ok(values.length > 0, 'the module must export the plugin')
  assert.equal(
    new Set(values).size,
    1,
    'every export must be the same function reference — opencode invokes each export as a plugin factory',
  )
  assert.equal(typeof factory, 'function')
  return `exports: ${Object.keys(plugin).join(', ')}`
})

await check('hook prunes phantoms and reports it', async () => {
  writeFixture(FIXTURE)

  const output = await runHook(FIXTURE, 'graphify update .')
  assert.match(output, /^raw tool output\n\[graphify\] pruned 2 node\(s\) \+ 2 edge\(s\)$/)
  return output.replace('\n', ' ⏎ ')
})

await check('hook is idempotent — clean graph produces no note', async () => {
  const output = await runHook(FIXTURE, 'graphify update .')
  assert.equal(output, 'raw tool output')
  return 'no note'
})

await check('survivors are exactly the non-phantom nodes, orphaned edges dropped', () => {
  const graph = JSON.parse(readFileSync(GRAPH(FIXTURE), 'utf8'))

  assert.deepEqual(graph.nodes.map((n) => n.id).sort(), ['app_plugins_api_ts', 'empty_source', 'some_concept'])
  assert.deepEqual(
    graph.links.map((l) => `${l.source}->${l.target}`),
    ['some_concept->app_plugins_api_ts'],
  )
  return `${graph.nodes.length} nodes / ${graph.links.length} links`
})

await check('hook ignores non-triggers, read-only commands, and other tools', async () => {
  writeFixture(FIXTURE)

  const hooks = await factory({ directory: FIXTURE }, {})
  const untouched = { output: 'x' }
  await hooks['tool.execute.after']({ tool: 'bash', args: { command: 'yarn test' } }, untouched)
  await hooks['tool.execute.after'](
    { tool: 'bash', args: { command: 'grep -rn "graphify update" AGENTS.md' } },
    untouched,
  )

  await hooks['tool.execute.after']({ tool: 'read', args: {} }, untouched)
  assert.equal(untouched.output, 'x')
  assert.equal(JSON.parse(readFileSync(GRAPH(FIXTURE), 'utf8')).nodes.length, 5, 'fixture must be untouched')

  return 'output untouched, fixture untouched'
})

await check('hook ignores a command that merely quotes the trigger in prose', async () => {
  writeFixture(FIXTURE)

  const hooks = await factory({ directory: FIXTURE }, {})
  const untouched = { output: 'x' }

  // A commit message quoting the trigger used to fire a refresh (observed live): the trigger text
  // is present, but no command in the chain actually invokes graphify.
  await hooks['tool.execute.after'](
    {
      tool: 'bash',
      args: { command: `cd ${FIXTURE} && git commit -m 'refresh the graph after graphify update . --force'` },
    },
    untouched,
  )

  assert.equal(untouched.output, 'x')
  assert.equal(JSON.parse(readFileSync(GRAPH(FIXTURE), 'utf8')).nodes.length, 5, 'fixture must be untouched')
  return 'no note, fixture untouched'
})

await check('hook still fires behind VAR=value assignments', async () => {
  writeFixture(FIXTURE)

  const output = await runHook(FIXTURE, 'GRAPHIFY_DEBUG=1 graphify update .')
  assert.match(output, /pruned 2 node\(s\)/)

  return output.replace('\n', ' ⏎ ')
})

await check('hook fires when another plugin prepends an echo to the same command', async () => {
  writeFixture(FIXTURE)

  const hooks = await factory({ directory: FIXTURE }, {})
  const output = { output: 'reminder line' }

  // This is exactly what the project-level graphify plugin produces on a session's first bash call:
  // its reminder echo is prepended to whatever the agent asked for. A whole-string READ_ONLY test
  // (anchored at ^) would mask the update behind it and silently skip the refresh.
  await hooks['tool.execute.after'](
    {
      tool: 'bash',
      args: { command: `echo "[graphify] knowledge graph at graphify-out/." ; cd ${FIXTURE} && graphify update .` },
    },
    output,
  )

  assert.match(output.output, /pruned 2 node\(s\)/, 'the update behind the echo must still fire')
  return output.output.replace('\n', ' ⏎ ')
})

await check('hook ignores --help invocations', async () => {
  writeFixture(FIXTURE)

  const hooks = await factory({ directory: FIXTURE }, {})
  const untouched = { output: 'x' }
  await hooks['tool.execute.after'](
    { tool: 'bash', args: { command: `cd ${FIXTURE} && graphify update --help` } },
    untouched,
  )
  await hooks['tool.execute.after'](
    { tool: 'bash', args: { command: `cd ${FIXTURE} && graphify extract --help` } },
    untouched,
  )

  assert.equal(untouched.output, 'x')
  assert.equal(JSON.parse(readFileSync(GRAPH(FIXTURE), 'utf8')).nodes.length, 5, 'fixture must be untouched')

  return 'no note, fixture untouched'
})

await check('hook never throws when the graph is missing', async () => {
  const output = await runHook('/nonexistent-dir-xyz', 'graphify update .')
  assert.equal(output, 'raw tool output')
  return 'no-op, no throw'
})

await check('hook connects an okf/ bundle into merged.json without duplication', async () => {
  if (!hasOkfBridge) {
    return 'skipped — okf-bridge not on PATH'
  }

  writeBundleFixture(BUNDLE_FIXTURE)

  const output = await runHook(BUNDLE_FIXTURE, 'graphify update .')
  assert.match(output, /\[graphify\] pruned 2 node\(s\) \+ 2 edge\(s\) \| merged\.json \d+ node\(s\) \+ \d+ edge\(s\)/)

  const graph = JSON.parse(readFileSync(GRAPH(BUNDLE_FIXTURE), 'utf8'))
  const merged = JSON.parse(readFileSync(MERGED(BUNDLE_FIXTURE), 'utf8'))
  const okfNodes = merged.nodes.filter((node) => String(node.id).includes('okf:')).length

  assert.equal(graph.nodes.length, 3)
  assert.ok(merged.nodes.length > graph.nodes.length, 'merged must contain the bundle')
  assert.equal(okfNodes, 1, 'the single fixture concept must appear exactly once')

  return output.split('[graphify] ')[1]
})

await check('hook fires for `graphify add`, which rebuilds the graph too', async () => {
  writeFixture(FIXTURE)

  const output = await runHook(FIXTURE, 'graphify add https://example.com/post')
  assert.match(output, /pruned 2 node\(s\)/)

  return output.replace('\n', ' ⏎ ')
})

await check('okf/ connect is silent when merged.json comes out unchanged', async () => {
  if (!hasOkfBridge) {
    return 'skipped — okf-bridge not on PATH'
  }

  writeBundleFixture(BUNDLE_FIXTURE)
  await runHook(BUNDLE_FIXTURE, 'graphify update .')
  const second = await runHook(BUNDLE_FIXTURE, 'graphify update .')

  assert.equal(second, 'raw tool output', 'a refresh with nothing to do must print nothing')

  return 'second run silent'
})

await check('hook surfaces a failing bundle validation and an unignored okf/', async () => {
  if (!hasOkfBridge) {
    return 'skipped — okf-bridge not on PATH'
  }

  writeBundleFixture(BUNDLE_FIXTURE)
  const output = await runHook(BUNDLE_FIXTURE, 'graphify update .')

  assert.match(output, /okf-bridge validate: WARNING tables\/index\.md/)
  assert.match(output, /okf\/ is not in \.graphifyignore/)

  return 'validation + ignore hint surfaced'
})

await check('hook drops the ignore hint once okf/ is ignored', async () => {
  if (!hasOkfBridge) {
    return 'skipped — okf-bridge not on PATH'
  }

  writeBundleFixture(BUNDLE_FIXTURE, { ignored: true })
  const output = await runHook(BUNDLE_FIXTURE, 'graphify update .')

  assert.doesNotMatch(output, /graphifyignore/)

  return 'no ignore hint'
})

await check('validate: false skips the bundle health checks', async () => {
  if (!hasOkfBridge) {
    return 'skipped — okf-bridge not on PATH'
  }

  writeBundleFixture(BUNDLE_FIXTURE)
  const hooks = await factory({ directory: BUNDLE_FIXTURE }, { validate: false })
  const output = { output: 'x' }
  await hooks['tool.execute.after'](
    { tool: 'bash', args: { command: `cd ${BUNDLE_FIXTURE} && graphify update .` } },
    output,
  )

  assert.match(output.output, /merged\.json \d+ node\(s\)/)
  assert.doesNotMatch(output.output, /okf-bridge validate/)

  return 'health checks skipped'
})

for (const [name, status, detail] of results) {
  console.log(`${status}  ${name}`)
  if (detail) console.log(`      → ${detail}`)
}

const failed = results.filter(([, status]) => status === 'FAIL').length

console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
