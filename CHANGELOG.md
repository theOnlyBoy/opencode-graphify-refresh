# Changelog

## 0.2.0

- Follows `GRAPHIFY_OUT` for the graph directory, so a graph kept outside the repo root — for
  example `.ai/graphify-out`, as `opencode-graphify-init` uses — is pruned and merged in place. New
  `graphDir` option overrides the environment variable; paths are resolved with `resolve`, so an
  absolute `GRAPHIFY_OUT` works too.

## 0.1.0

- Initial release.
- Prunes graphify nodes whose `source_file` does not resolve to a real file — together with the edges
  referencing them — after any `graphify update` / `graphify extract` / `graphify add` run through
  opencode's bash tool.
- Imports the repository's OKF bundle (`okf/`) and merges it into `graphify-out/merged.json`, using
  `okf-bridge link`'s output as the merge base when the bundle has a `tables/` section so ids are
  never duplicated. A merge that leaves `merged.json` byte-identical is reported as nothing at all.
- After a refresh that changed something, validates the bundle (`okf-bridge validate --strict`) and
  warns when the bundle directory is missing from `.graphifyignore`.
- Anchors the trigger to the start of a command, so a commit message or comment that merely quotes
  `graphify update` no longer fires a refresh.
