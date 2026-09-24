# 🔄 OpenCode Graphify Refresh

**Your knowledge graph, refreshed before you ask for it.**

Run `graphify update` — this plugin prunes what's broken and folds your OKF bundle in. No extra commands.

---

## Why this exists

We hit this building a **Vue 3 / Nuxt 4** app with graphify. The graph looked fine. It wasn't —
two silent failures:

**1. It grew nodes that point at nothing.**

Nuxt auto-imports and Vue type-only imports read like dynamic imports to graphify —
`typeof import('vue')`, text inside type positions, even docstring prose. graphify's dynamic-import
rescue turns each into a `code` node whose `source_file` is the **bare package name** (`vue`,
`ofetch`), not a repo file. That node can never be linked, queried or explained — pure noise.

It stops being harmless the moment you connect an OKF bundle: `okf-bridge link` resolves every
node's `source_file` and **aborts its entire run on the first one it cannot read.** One phantom node,
and you get zero code→table edges.

**2. It got doubled when merging.**

`graphify merge-graphs` treats every input as a separate repo and prefixes ids per input instead of
deduping. Merge `graphify-out/graph.json` with `okf-bridge link`'s output — which already embeds a
copy of that same graph — and you get two of everything: **1,136 nodes became 2,242.** A committed
`merged.json` elsewhere held 14,779 nodes where 7,473 was correct.

Neither failure is loud. The graph just goes quietly wrong, and every query built on it inherits
that.

This plugin runs right after the update and fixes both.

### Who it's for

Any project that runs `graphify update`.

- **Phantom nodes** bite hardest in TypeScript codebases with heavy dynamic / type-only imports —
  Vue, Nuxt, Svelte, Node + TS. In a Nuxt app this is not an edge case; it's every auto-imported
  composable.
- **Merge doubling** applies wherever an OKF bundle is connected.
- **No OKF bundle?** You still get the prune — the bundle step no-ops.

## ✨ How it works

1. You (or the agent) run `graphify update .` — or `graphify extract` / `graphify add` — through opencode's bash tool.
2. **Prune**: nodes whose `source_file` does not resolve to a real file are dropped, along with every edge referencing them.
3. **Connect**: if the repo has an `okf/` bundle, it is imported (`okf-bridge import`) and merged into `graphify-out/merged.json`. When the bundle has a `tables/` section, `okf-bridge link`'s output becomes the merge **base** and only the concepts whose ids it lacks are merged in — so ids are never duplicated.
4. **Check**: when that work changed something, the bundle is validated (`okf-bridge validate --strict`) and you are told if `okf/` is missing from `.graphifyignore`. Skipped on a no-op, so silence still means "nothing to do".
5. If nothing changed, it says nothing. Otherwise it appends one line to the tool output:

```
[graphify] pruned 3 node(s) + 4 edge(s) | merged.json 1164 node(s) + 1466 edge(s) | okf/ is not in .graphifyignore — graphify will index the bundle twice
```

## 📦 Installation

Add it to your [opencode.json](https://opencode.ai/docs/config/) — see OpenCode's
[plugin docs](https://opencode.ai/docs/plugins/) for the entry format:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-graphify-refresh"]
}
```

Restart OpenCode.

## 🚀 Full setup — graphify + OKF + this plugin

End to end, from nothing to a queryable graph. Nothing here needs an API key, a network call or an LLM.

**1. Install graphify** ([repo](https://github.com/Graphify-Labs/graphify) · [docs](https://graphify.com/docs)):

```bash
uv tool install graphifyy     # the package is `graphifyy`; the command it provides is `graphify`
uv tool update-shell          # only if `graphify` isn't found right after — then open a new terminal
```

**2. Register graphify's skill with OpenCode:**

```bash
graphify install --platform opencode     # or plain `graphify install` to auto-detect
```

**3. (Optional) add an `okf/` bundle and its bridge** — skip this and the plugin still prunes.

An OKF bundle is just markdown concepts with frontmatter ([what OKF is](https://github.com/GoogleCloudPlatform/knowledge-catalog)). `okf-bridge` provides `validate` / `import` / `export` / `link` ([PyPI](https://pypi.org/project/graphify-okf-bridge/)). Minimal shape:

```text
okf/
├── index.md            # bundle index — links every concept
└── tables/
    ├── index.md        # every directory needs one — `okf-bridge validate` warns without it
    └── sessions.md     # a concept; the `tables/` section is what code→table links read
```

```bash
uv tool install graphify-okf-bridge       # provides `okf-bridge`
okf-bridge validate --strict okf/         # conformance check on your bundle
printf 'okf/\n' >> .graphifyignore        # the bundle is imported as okf:<id> nodes — don't index it twice
```

**4. Add this plugin** (see **Installation** above).

**5. Build the graph:**

```bash
graphify update .        # or `graphify extract`
```

From then on, every `graphify update` run through OpenCode also prunes the graph and — when `okf/` exists — refreshes `graphify-out/merged.json`.

**6. Query it:**

```bash
graphify query "where is the session cookie set?"                                   # code graph
graphify query "which tables back the auth flow?" --graph graphify-out/merged.json   # code + OKF
```

### What you end up with

| Path | What it is |
|---|---|
| `graphify-out/graph.json` | the code graph — pruned in place by this plugin |
| `graphify-out/merged.json` | code graph + your OKF bundle (only when `okf/` exists) |
| `.tmp/okf-graph.json`, `.tmp/linked.json` | scratch inputs to the merge; safe to ignore or delete |

## 🔗 What each piece is

| Piece | What it does | Install | Docs |
|---|---|---|---|
| **graphify** | builds and queries the code knowledge graph | `uv tool install graphifyy` | [docs](https://graphify.com/docs) · [repo](https://github.com/Graphify-Labs/graphify) · [PyPI](https://pypi.org/project/graphifyy/) |
| **OKF** | Google's Open Knowledge Format — markdown concepts with frontmatter, optional `tables/` | — | [spec repo](https://github.com/GoogleCloudPlatform/knowledge-catalog) |
| **okf-bridge** | imports an `okf/` bundle into the graph, links code→table edges, validates a bundle | `uv tool install graphify-okf-bridge` | [PyPI](https://pypi.org/project/graphify-okf-bridge/) |
| **this plugin** | runs the prune + merge automatically after `graphify update` | `"plugin": ["opencode-graphify-refresh"]` | you're reading it |

> The PyPI package is `graphifyy` (double-y) and the command is `graphify` — other `graphify*` packages on PyPI are unrelated.

## 📋 Requirements

- **`graphify` on your PATH** — the plugin only reacts to `graphify update` / `graphify extract`, and does nothing in a repo without `graphify-out/graph.json`. Install: `uv tool install graphifyy` ([docs](https://graphify.com/docs) · [repo](https://github.com/Graphify-Labs/graphify)).
- **`okf-bridge` on your PATH** for the bundle step. Absent, the plugin reports `okf-bridge not installed` and the prune still runs. Install: `uv tool install graphify-okf-bridge` ([PyPI](https://pypi.org/project/graphify-okf-bridge/)).
- An **`okf/` bundle** is optional — without one the plugin only prunes.

Nothing else is required: no API key, no network, no LLM.

## ⚙️ Options

Pass them as the second element of a tuple entry:

```json
{
  "plugin": [["opencode-graphify-refresh", { "connect": false }]]
}
```

| Option      | Default | Meaning                                                                                  |
| ----------- | ------- | ---------------------------------------------------------------------------------------- |
| `bundleDir` | `"okf"` | Bundle directory to import, relative to the project root.                                 |
| `prune`     | `true`  | Drop graph nodes whose `source_file` does not resolve.                                    |
| `connect`   | `true`  | Import the bundle and refresh `graphify-out/merged.json`.                                 |
| `validate`  | `true`  | After a change: OKF conformance check + a `.graphifyignore` hint. Both skipped on a no-op. |

## 🧠 Notes

- **It fires per segment, not per string.** Several opencode plugins rewrite the same bash command; the project-level graphify plugin prepends a reminder `echo` to your session's first call. The plugin splits the command on `&&`, `||`, `;` and newlines and judges each segment, so a real `graphify update` is never masked by that echo.
- **It ignores `--help`** and read-only commands (`grep`, `cat`, `echo`, …).
- **It never throws.** A failure is reported in the tool output, never propagated into your session.
- **It resolves the project root** from a leading `cd <path> &&`, falling back to the session directory.
- **Your `okf/` should be in `.graphifyignore`.** The bundle is already imported as `okf:<concept-id>` nodes; letting graphify index the same markdown as document nodes represents that knowledge twice.
- **It only sees graphify run through OpenCode's bash tool.** `graphify hook install` (git post-commit) and `graphify watch` rebuild the graph elsewhere, so no refresh fires for those.
- **`--out` moves the graph.** `graphify extract . --out DIR` writes to `DIR/graphify-out/`; the plugin only looks at the repo root, so it will not find that graph.

## 🛠️ Development

```bash
git clone https://github.com/theOnlyBoy/opencode-graphify-refresh.git
cd opencode-graphify-refresh
```

```bash
npm install        # or yarn / pnpm install
npm run build      # or yarn build / pnpm build
```

```bash
opencode           # run OpenCode from the project dir to test the plugin
```

The plugin is registered in `./opencode.json` as `"./dist/index.js"`, so after rebuilding you can test changes right away — just restart OpenCode.

## 🤝 Contributing

Found a bug? Have an idea? PRs and issues are welcome.

Open an [issue](https://github.com/theOnlyBoy/opencode-graphify-refresh/issues) or submit a pull request — happy to take a look.

## License

MIT
