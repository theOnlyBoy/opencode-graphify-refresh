import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

/** v2 loads the package's default object; the root is the dual v1/v2 entrypoint. */
const PLUGIN = new URL('../dist/index.js', import.meta.url).href
const plugin = (await import(PLUGIN)).default

const FIXTURE = '/tmp/graphify-plugin-fixture-v2'
const GRAPH = (root) => `${root}/graphify-out/graph.json`

/** Same phantom fixture as the v1 suite: 2 bare-package nodes, 1 real, 1 concept, 1 empty-source. */
const writeFixture = (root) => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(`${root}/app/plugins`, { recursive: true })
  writeFileSync(`${root}/app/plugins/api.ts`, 'export {}\n')
  mkdirSync(`${root}/graphify-out`, { recursive: true })
  writeFileSync(
    GRAPH(root),
    JSON.stringify({
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
        },
        { id: 'ofetch', label: 'ofetch', file_type: 'code', _origin: 'ast', source_file: 'ofetch' },
        { id: 'vue_vue', label: 'vue', file_type: 'code', _origin: 'ast', source_file: 'vue' },
        { id: 'some_concept', label: 'Some Concept', file_type: 'concept', _origin: null, source_file: 'okf:some/concept' },
        { id: 'empty_source', label: 'nested', file_type: 'code', _origin: 'ast', source_file: '' },
      ],
      links: [
        { source: 'app_plugins_api_ts', target: 'ofetch' },
        { source: 'vue_vue', target: 'some_concept' },
        { source: 'some_concept', target: 'app_plugins_api_ts' },
      ],
      hyperedges: [],
    }),
  )
}

/** Capture the callback the plugin registers via `ctx.tool.hook(name, cb)`. */
const captureHook = async (options = {}) => {
  let hook
  const ctx = {
    options,
    location: { directory: FIXTURE },
    tool: { hook: async (name, cb) => name === 'execute.after' && (hook = cb) },
  }
  await plugin.setup(ctx)
  assert.equal(typeof hook, 'function', 'setup must register an execute.after hook')
  return hook
}

/** The successful `shell` `execute.after` event shape captured live on v2 2.0.22. */
const shellEvent = (command) => ({
  tool: 'shell',
  sessionID: 'ses_x',
  agent: 'build',
  messageID: 'm1',
  id: 'c1',
  status: 'completed',
  input: { command: `cd ${FIXTURE} && ${command}` },
  result: {
    output: { exit: 0, truncated: false, output: 'shell stdout\n', status: 'completed' },
    content: [{ type: 'text', text: 'shell stdout\n' }],
    metadata: { exit: 0, status: 'completed', truncated: false },
  },
})

const results = []
const check = async (name, fn) => {
  try {
    results.push([name, 'PASS', await fn()])
  } catch (error) {
    results.push([name, 'FAIL', error.message])
  }
}

await check('v2 default export is an object { id, setup }', () => {
  assert.equal(typeof plugin, 'object')
  assert.equal(plugin.id, 'graphify-refresh')
  assert.equal(typeof plugin.setup, 'function')
  return `id: ${plugin.id}`
})

await check('v2 hook prunes phantoms and appends to result.output.output + content text', async () => {
  writeFixture(FIXTURE)
  const hook = await captureHook()

  const event = shellEvent('graphify update .')
  await hook(event)

  assert.match(event.result.output.output, /shell stdout\n\[graphify\] pruned 2 node\(s\) \+ 2 edge\(s\)$/)
  assert.match(event.result.content[0].text, /\[graphify\] pruned 2 node\(s\) \+ 2 edge\(s\)$/)
  assert.equal(JSON.parse(readFileSync(GRAPH(FIXTURE), 'utf8')).nodes.length, 3)
  return event.result.content[0].text.split('\n')[1]
})

await check('v2 hook is idempotent — clean graph produces no note', async () => {
  writeFixture(FIXTURE)
  const hook = await captureHook()

  const first = shellEvent('graphify update .')
  await hook(first)
  const second = shellEvent('graphify update .')
  await hook(second)

  assert.equal(second.result.output.output, 'shell stdout\n')
  assert.equal(second.result.content[0].text, 'shell stdout\n')
  return 'second run silent'
})

await check('v2 hook ignores non-triggers and other tools', async () => {
  writeFixture(FIXTURE)
  const hook = await captureHook()

  const noTrigger = shellEvent('yarn test')
  await hook(noTrigger)
  assert.equal(noTrigger.result.output.output, 'shell stdout\n')

  const otherTool = shellEvent('graphify update .')
  otherTool.tool = 'read'
  await hook(otherTool)
  assert.equal(otherTool.result.output.output, 'shell stdout\n')

  assert.equal(JSON.parse(readFileSync(GRAPH(FIXTURE), 'utf8')).nodes.length, 5, 'fixture untouched')
  return 'untouched'
})

await check('v2 hook ignores a command that only quotes the trigger', async () => {
  writeFixture(FIXTURE)
  const hook = await captureHook()

  const event = shellEvent(`git commit -m 'graphify update . --force'`)
  await hook(event)

  assert.equal(event.result.output.output, 'shell stdout\n')
  assert.equal(JSON.parse(readFileSync(GRAPH(FIXTURE), 'utf8')).nodes.length, 5)
  return 'no note'
})

await check('v2 hook fails open — no shell tool, no throw', async () => {
  writeFixture(FIXTURE)
  const noTool = { options: {}, location: { directory: FIXTURE } }
  await plugin.setup(noTool) // must not throw when ctx.tool.hook is absent
  return 'no-op'
})

for (const [name, status, detail] of results) {
  console.log(`${status}  ${name}`)
  if (detail) console.log(`      → ${detail}`)
}

const failed = results.filter(([, status]) => status === 'FAIL').length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
