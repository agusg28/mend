# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/agusg28/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/agusg28/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats — unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON — and mend reads each one, finds the lines each edit names at the first of three matching tiers, and writes every change or none.

Built for the [make.fun bounty "Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

## Run

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

Node 22, standard library only. The working directory is the root of the tree; PATCH is read from the named file, or from standard input when absent or `-`. `--format` is `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, which detects the format). `--check` reports what would change without writing anything, and `--strict` matches lines exactly.

See [SPEC.md](SPEC.md) for the full contract.
