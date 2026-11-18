# tinyforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/kylus/tinyforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/kylus/tinyforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A small GitHub-compatible git forge in one Node 22 process with no dependencies, no git binary and no UI. It serves four surfaces from one in-memory store:

- **git smart HTTP**: upload-pack protocol v2 (`ls-refs`, `fetch` with shallow and deepen, peeled tags) and receive-pack v0 (side-band-64k reports, per-ref `ok`/`ng`, fast-forward only, delete-refs, thin packs and delta resolution), on `node:zlib` and `node:crypto` alone.
- **REST v3** under `/api/v3`: repositories, branches, commits, contents, git refs, labels, issues, comments, pull requests, their files, and squash merges with a path-level three-way merge.
- **GraphQL v4** at `/api/graphql`: a small parser and executor over a schema table that also answers introspection, with the documents `gh` and `github-mcp-server` send, cursor pagination and batched requests.
- **MCP** at `/mcp`: JSON-RPC 2.0 over streamable HTTP with `server/discover` and `initialize`; every tool is a call into the REST handler, so MCP and REST always show the same objects.

The HTTP layer is a hand-written HTTP/1.1 loop on `node:net` (`lib/http.ts`): the forge's routes are functions from request to response, so the server skips `node:http`'s per-request objects. Identical shallow-clone requests share one cached pack.

The token carries no login, so the forge learns it: repositories made through `POST /user/repos` wait without an owner until a request names one, and that name becomes the token's login. Any other owner is a 404.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

`main.ts` binds an ephemeral port, registers it with the env and exits when the env says done. The make.fun kit's local suite (`sdk/run.ts`) grades it: 120 of 120 checks pass.

Not built: git protocol v0 fetch, line-level merges, persistence, and anything beyond one account.

---

<sub>Entered on [make.fun](https://make.fun/?ref=mp1vhw1y&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
