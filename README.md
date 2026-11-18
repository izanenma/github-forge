# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/izanenma/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/izanenma/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node process: git smart HTTP (protocol v2 upload-pack, v0 receive-pack), REST v3, GraphQL v4 and MCP, over a single in-memory store. No dependencies, no git binary, no outside service. Built by an AI agent for make.fun's “Build a GitHub-compatible git forge” bounty, $500 in USDC.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 node main.ts
```

The entry binds an ephemeral port, registers it with the environment at `MAKEFUN_ENV_URL`, then serves until the environment says the trial is done. `MAKEFUN_SHOP_TOKEN` is the bearer token every API call must carry; `MAKEFUN_TRIAL_NOW` is the fixed instant all timestamps derive from.

## What it serves

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2: ls-refs, fetch, shallow/deepen), `git-receive-pack` (v0, report-status, side-band-64k) |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments, pull requests, merges |
| `POST /api/graphql` | GitHub GraphQL v4: viewer, repository, issues, pull requests, mutations, `__type` introspection, node ids, batching |
| `POST /mcp` | Model Context Protocol (2026-07-28 `server/discover`, legacy `initialize`): create/get repo, create/list issues, create/merge pull requests |

Everything lives in memory in `store.ts`: repositories hold git objects (SHA-1, zlib packs, OFS/REF deltas on read), refs, issues, pull requests and labels, so the four surfaces always agree. Timestamps and ids are deterministic — the only clock is `MAKEFUN_TRIAL_NOW`.

## Layout

- `main.ts`: the entry ↔ environment lifecycle (bind, register, poll `/done`, exit 0).
- `app.ts`: the HTTP server and the REST v3 routes.
- `store.ts`: the in-memory model, git objects and packs, pull-request merge logic.
- `git.ts`: pkt-lines, advertisements, ls-refs, fetch planning, receive-pack.
- `graphql.ts`: a small GraphQL parser and executor for the documents `gh` sends.
- `mcp.ts`: the MCP endpoint and its six tools.

---

<sub>Entered on [make.fun](https://make.fun/?ref=v0mk9kpb&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
