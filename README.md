# Dune

Know where you are in any codebase.

A shared brain for a repo. Point it at your codebase and it answers two questions for
everyone on the team: **where does this change belong**, and **what have we already
figured out about this code**.

Built by **CloudSmiths** for [First Commit](https://www.wemakedevs.org/aws/first-commit)
(WeMakeDevs x AWS, Bharat Builds Tour), Sept 17–20, 2026. Ship It track.

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

## Stack

TypeScript everywhere. tree-sitter for parsing, AWS Lambda + API Gateway + Step Functions +
DynamoDB + S3, Amazon Bedrock for embeddings and generation, React + Vite on Amplify Hosting,
MCP server on App Runner.

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

- **Backend:** `04-INFRA.md` hour-one checklist first (Bedrock model access blocks everything),
  then `01-BACKEND.md` "Order of work", step 1.
- **Frontend:** `02-FRONTEND.md` design tokens, then build against the mocks in
  `03-API.md` shapes. Do not wait on the backend.
- **Handing this to an agent:** give it the whole `docs/` folder, then point it at one
  numbered step of `01-BACKEND.md` "Order of work". Not all of it at once.

---

## Scope

**Committed this weekend:** repo indexing, architecture map, "where do I change this"
queries, team knowledge layer, git-aware suggestion drafting, context export, MCP server.

**Deliberately out of scope:** languages beyond TypeScript and JS, multiple repos, auth
and accounts, code generation, real-time collaboration. See the roadmap in `00-PRD.md`.

## Demo repo

Split-it-Wise, pinned at `07aeab28ff5ee49cc7fc948c8cc076a1930945bd`.
167 JS/JSX/TS/TSX files. Used for all development and the demo video.

## Team

CloudSmiths.