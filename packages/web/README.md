# @dune/web

The Dune console: connect a repo, watch it index, ask where a change belongs, and keep the
team's context. React, Vite, TanStack Query and React Flow. Screen design is in
`docs/02-FRONTEND.md`; every request and response shape is `docs/03-API.md`, with the types
imported from `@dune/shared`.

## Run

From the repo root, once:

```bash
npm install
cp packages/web/.env.example packages/web/.env.local   # then set VITE_API_URL
```

Then:

```bash
npm run dev -w @dune/web        # http://localhost:3000
npm run build -w @dune/web      # dist/
npm run typecheck -w @dune/web
```

## Environment

| Variable | Meaning |
| --- | --- |
| `VITE_API_URL` | The stack's `ApiUrl` output, e.g. `https://<id>.execute-api.ap-south-1.amazonaws.com`. `/v1` is added by the client. |
| `VITE_USE_MOCKS` | `true` serves the fixtures in `src/mocks` instead of calling the API. Off by default. |
| `VITE_MCP_URL` | The MCP endpoint shown in the context panel. Unset hides that section. |

`?teamId=<id>` on the page URL selects the team; it defaults to `demo`, as in the contract.

## Mock mode

A development fixture. `npm run dev` shows a MOCK toggle in the top bar that overrides
`VITE_USE_MOCKS` per browser; production builds never show it and ignore any stored value.
In mock mode, a repo URL containing `fail` fails during parsing, and a question containing
`fail` or `uncertain` returns an error or the low-confidence answer.
