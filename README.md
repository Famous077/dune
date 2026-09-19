# Dune

Know where you are in any codebase.

A shared brain for a repo. Point it at your codebase and it answers two questions for
everyone on the team: **where does this change belong**, and **what have we already
figured out about this code**.

Built by **CloudSmiths** for [First Commit](https://www.wemakedevs.org/aws/first-commit)
(WeMakeDevs x AWS, Bharat Builds Tour), Sept 17–20, 2026. Ship It track.

**Live:** https://main.ds3vblvj49p71.amplifyapp.com — click *Load sample codebase* to open the
pre-indexed demo repo without waiting for indexing.
**API:** `https://ivaqlw3t8d.execute-api.ap-south-1.amazonaws.com/v1` (contract in [`docs/03-API.md`](docs/03-API.md)).

---

## The problem

Two things break in the same place.

**AI agents forget.** Switch tools or start a new session and the new agent knows nothing
about why JWT was picked over sessions, what was already tried and thrown away, or what is
left to do. So you re-explain your own project to an AI, every time.

**New people are lost.** Open an unfamiliar repo with 500 files and someone says "add rate
limiting to the auth API." An hour goes into finding where authentication happens, before
writing a line.

Both are the same problem: context about a codebase lives in people's heads, and nothing
keeps it.

## What it does

1. Connect a repo. It gets parsed into a structure map.
2. Ask where a change belongs. Get a file, a reason, the blast radius, and the tests to update.
3. Decisions, dead ends and constraints get captured with one click as work happens.
4. All of it is available to the next person and the next agent, through the UI or over MCP.

## Architecture

```
Browser (React + Vite, Amplify Hosting)          MCP clients (Claude, Cursor, ...)
        │                                                 │
        │  HTTPS, JSON                                    ▼
        │                                   MCP server (McpFn Lambda, /mcp) — thin
        ▼                                   wrapper, calls the same HTTP API
API Gateway (HTTP API)  ◄─────────────────────────────────┘
        │
        ▼
ApiFn (Lambda)  ── query: embed the question locally, cosine + keyword search,
        │           graph expansion, team context, then Gemini for the answer
        │  async invoke on POST /repos
        ▼
IndexFn (Lambda) ── GitHub tarball → tree-sitter parse → import graph → chunks →
                    local embeddings (all-MiniLM-L6-v2, bundled in the function)
        │
        ▼
DynamoDB (single table: graph, chunks, vectors, jobs, team context, suggestions)
S3 (repo snapshot, for the source drawer)
```

- **TypeScript everywhere**, one npm workspace: `packages/shared` (types from the contract),
  `api`, `indexer`, `web`, `mcp`. One SAM template (`infra/template.yaml`), region ap-south-1.
- **Parsing:** `web-tree-sitter` with WASM grammars: TS, TSX, JS, JSX and Python. Route detection covers Express, Next.js App Router, Flask and FastAPI, including blueprint and router prefixes.
- **Embeddings run inside the Lambda**, no external call. **Generation** is Gemini
  (`gemini-3.5-flash-lite`), with Groq as a switchable alternative; both behind one interface,
  as is Bedrock, which the hackathon made optional and our account could not get access to.
- **Indexing is one Lambda**, not the Step Functions pipeline in the design — dropped for the
  weekend; the reasons are in [`docs/01-BACKEND.md`](docs/01-BACKEND.md), "Indexing pipeline".
- **Answers are checked, not trusted:** every path the model returns must exist in the index,
  line ranges are clamped to the real file, and the model can lower confidence but never raise it.

---

## Docs

Read these before writing code. They are the source of truth; if code and docs disagree,
fix one of them deliberately.

| Doc | What it covers | Who needs it |
| --- | --- | --- |
| [`docs/00-PRD.md`](docs/00-PRD.md) | Problem, users, competition, features, scope, metrics, risks, demo script | Everyone |
| [`docs/01-BACKEND.md`](docs/01-BACKEND.md) | Indexing pipeline, tree-sitter extraction, chunking, DynamoDB design, retrieval, Bedrock, MCP | Backend |
| [`docs/02-FRONTEND.md`](docs/02-FRONTEND.md) | Design direction, tokens, all three screens, components, graph rendering, mocks | Frontend |
| [`docs/03-API.md`](docs/03-API.md) | Shared types, every endpoint, error format. **Authoritative** — wins over any other doc | Everyone |
| [`docs/04-INFRA.md`](docs/04-INFRA.md) | Thursday hour-one checklist, AWS resources, IAM, deployment, gotchas, submission checklist | Backend, whoever deploys |

### Start here

- **Backend:** `04-INFRA.md` hour-one checklist first, then `01-BACKEND.md` "Order of work".
- **Frontend:** `02-FRONTEND.md` design tokens, then build against the mocks in
  `03-API.md` shapes. Do not wait on the backend.
- **Handing this to an agent:** give it the whole `docs/` folder, then point it at one
  numbered step of `01-BACKEND.md` "Order of work". Not all of it at once.

---

## Scope

**Committed this weekend:** repo indexing, architecture map, "where do I change this"
queries, team knowledge layer, git-aware suggestion drafting, context export, MCP server.

**Deliberately out of scope:** languages beyond TypeScript, JS and Python, multiple repos, auth
and accounts, code generation, real-time collaboration. See the roadmap in `00-PRD.md`.

## Connect an agent (MCP)

The team's record and the "where does this change belong" answer are available to any MCP
client, from the same API the web app uses:

```
https://ivaqlw3t8d.execute-api.ap-south-1.amazonaws.com/mcp?repoId=255711d1
```

Streamable HTTP, no auth. `repoId` picks the repo (the web app's context panel shows the URL for
the open repo); `teamId` picks the team, default `demo`.

```bash
claude mcp add --transport http dune "https://ivaqlw3t8d.execute-api.ap-south-1.amazonaws.com/mcp?repoId=255711d1"
```

| Tool | What it does |
| --- | --- |
| `get_project_context` | The team's decisions, dead ends and constraints, plus a structure summary, as markdown |
| `find_where_to_change` | Where a change belongs: file, attach point, reason, affected routes, tests, cited lines |
| `save_decision` | Records a decision, dead end or constraint — always marked agent-written in the UI |

## Run it

Needs Node 24, the AWS SAM CLI, and AWS credentials for ap-south-1.

```bash
npm install
cp .env.example .env            # GEMINI_API_KEY; optional GROQ_API_KEY, GITHUB_TOKEN
npm run deploy                  # builds and deploys the whole stack (sam build + sam deploy)

# Index a repo from your machine, with the same pipeline IndexFn runs
REPO_BUCKET=<RepoBucketName output> npm run index -- https://github.com/owner/repo

# The web app, against the deployed API
cp packages/web/.env.example packages/web/.env.local   # set VITE_API_URL
npm run dev -w @dune/web
```

The web app deploys from `main` through Amplify Hosting using [`amplify.yml`](amplify.yml).

## Demo repo

[Split-it-Wise](https://github.com/aashu2006/split-it-wise), pinned at
`07aeab28ff5ee49cc7fc948c8cc076a1930945bd`: a Next.js expense splitter. 55 files after
exclusions, 33 source files in the graph. Used for all development and the demo video.
[RealWorld (Express)](https://github.com/gothinkster/node-express-realworld-example-app) is
also pre-indexed, for a backend with real routes.

## Team

CloudSmiths.