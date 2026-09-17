# 01 — Backend build spec

Bearings · CloudSmiths · First Commit (AWS x WeMakeDevs)

Owner: Akshat. Written to be handed to Claude Code as implementation context.

## Scope and stack

This doc covers everything behind the API: indexing, storage, retrieval, generation, and the MCP server. Frontend is in `02-FRONTEND.md`. The API contract both sides build against is in `03-API.md` and is authoritative — if this doc and that one disagree, the API doc wins.

### Stack

- **Runtime:** Node.js 20, TypeScript throughout
- **Parsing:** `web-tree-sitter` with WASM grammars for TypeScript and TSX. Not the native `tree-sitter` bindings — native modules mean compiling for the Lambda runtime and that is a time sink we are not paying for.
- **Orchestration:** AWS Step Functions for the indexing pipeline
- **Compute:** Lambda for API handlers and pipeline steps; App Runner for the MCP server only
- **Storage:** S3 for repo snapshots, DynamoDB for graph, metadata, chunks and context
- **Vectors:** start with embeddings stored in DynamoDB and cosine similarity computed in the query Lambda. Only move to OpenSearch Serverless if measured retrieval time exceeds 1 second on the demo repo.
- **LLM:** Amazon Bedrock, Claude Sonnet via global cross-Region inference profile
- **IaC:** AWS SAM. One template, one deploy command.

### Non-negotiables

- Language support this weekend is TypeScript and TSX only. Do not add a second grammar.
- Every response the API returns must match the shape in `03-API.md` exactly, including null fields rather than missing keys.
- No feature lands without an error path. The frontend must never receive an unhandled exception.

### Order of work

Build in this order and do not skip ahead. Each step should be verifiable on its own before the next starts.

1. Hello-world deploy through the whole stack (Thursday night, before any real logic)
2. Clone and parse, producing a graph JSON
3. Chunk and embed, stored and retrievable
4. Query endpoint producing a structured answer
5. Context read and write
6. Git-aware suggestions
7. MCP server

## Repository layout

One repo, two deployable units (API stack and MCP service), shared types.

```
bearings/
  docs/                      # all specs, this doc included
  packages/
    shared/                  # types shared by everything
      src/types.ts           # Answer, GraphNode, GraphEdge, ContextItem
      src/schema.ts          # zod schemas, single source of validation
    indexer/                 # pipeline step handlers
      src/clone.ts
      src/parse.ts
      src/chunk.ts
      src/embed.ts
      src/persist.ts
    api/                     # Lambda handlers behind API Gateway
      src/handlers/repos.ts
      src/handlers/query.ts
      src/handlers/context.ts
      src/handlers/export.ts
      src/handlers/suggestions.ts
      src/lib/retrieval.ts
      src/lib/bedrock.ts
      src/lib/db.ts
    mcp/                     # App Runner service
      src/server.ts
  infra/
    template.yaml            # SAM template, everything
  scripts/
    seed-demo-repo.ts        # pre-index the demo repo
    eval.ts                  # run the 10 known-answer questions
```

### Rules

- **All types live in `shared`.** The frontend imports the same `Answer` type. If a field changes, it changes in one place.
- **zod schemas are the validation layer.** The same schema validates the Bedrock response and the API response. No hand-written type guards.
- **`lib/db.ts` is the only file that talks to DynamoDB.** Handlers call functions, never the SDK directly.
- **Every pipeline step is a pure function of its input plus S3/DynamoDB.** A step must be re-runnable without side effects beyond its own writes, because Step Functions will retry it.

### The eval script matters

`scripts/eval.ts` runs ten questions with known-correct answers against the demo repo and prints a pass rate. Write it on Friday, before prompt tuning starts. Without it, tuning is guesswork and every change feels like an improvement.

## Indexing pipeline

A Step Functions state machine. Five states, each a Lambda. Every state reads from and writes to S3 or DynamoDB, so any step can be retried independently.

```
RegisterJob -> Clone -> Parse (Map) -> Embed (Map) -> Persist -> Done
```

### 1. RegisterJob

**In:** `{ repoUrl, teamId }` **Out:** `{ repoId, jobId }`

Generates `repoId` as a hash of the normalised repo URL, so re-indexing the same repo overwrites rather than duplicates. Writes a job record with status `queued`. Returns immediately; the API responds while the pipeline runs.

### 2. Clone

**In:** `{ repoId, repoUrl }` **Out:** `{ repoId, s3Prefix, fileList[] }`

Shallow clone (`--depth 1`) into `/tmp`, then upload the working tree to `s3://bearings-repos/{repoId}/`. Pin to a commit SHA and record it.

Filters applied while walking the tree, in this order:

- Skip anything matched by `.gitignore`
- Skip `node_modules`, `dist`, `build`, `.next`, `coverage`, `vendor`
- Skip any `.env*` file. Never read, never upload.
- Skip files over 500 KB
- Keep only `.ts`, `.tsx`, `.js`, `.jsx` for parsing; record the existence of other files for the file count but do not parse them

If the file count exceeds the cap (1,000), keep all files but mark the overflow so Parse can prioritise. Record `truncated: true` on the repo record so the UI can show the banner.

Lambda has limited `/tmp` (512 MB by default, configurable to 10 GB). Set it to 2 GB and fail loudly if a clone exceeds it rather than silently truncating.

### 3. Parse (Map state)

**In:** `{ repoId, fileList[] }` **Out:** graph nodes and edges written to DynamoDB

Runs as a Step Functions Map with concurrency around 10. Each invocation handles a batch of files. Details of what to extract are in the next section.

A parse failure on one file does not fail the batch. Log the path and the error, skip it, continue. Track `parseFailures[]` on the repo record.

### 4. Embed (Map state)

**In:** chunks produced during Parse **Out:** vectors written alongside chunks

Batch chunks (roughly 50 per call) into Bedrock's embedding model. Same failure rule: one bad batch does not fail the index.

### 5. Persist

Computes the derived data the UI needs, so the frontend never computes it:

- Entry point detection (see below)
- Graph layout coordinates, pre-computed server side
- Per-file summary counts: imports in, imports out, exported symbols
- Repo summary: file count, line count, detected frameworks

Sets repo status to `ready`.

### Entry point detection

A node is an entry point if any of these hold. This is heuristic and that is fine:

- Path matches `**/routes/**`, `**/api/**`, `**/pages/**`, `**/app/**`
- Filename is `index.ts`, `main.ts`, `server.ts`, `app.ts`
- File has imports out but zero imports in (nothing depends on it, so something external calls it)
- File registers handlers: contains calls matching `app.get`, `app.post`, `router.use`, `createServer`

### Progress reporting

Each state updates the job record with a stage name and a count. The `GET /repos/:repoId` endpoint reads it. Stages, in order: `queued`, `cloning`, `parsing`, `embedding`, `finalising`, `ready`, `failed`. On `failed`, record which stage failed and a human-readable reason.

## Tree-sitter extraction

The goal is a **module-level graph**, not full semantic analysis. Resist the urge to build a type checker. Imports, exports and call sites are enough to answer "where does this belong".

### Setup

```ts
import Parser from 'web-tree-sitter';

await Parser.init();
const parser = new Parser();
const TS = await Parser.Language.load('tree-sitter-typescript.wasm');
const TSX = await Parser.Language.load('tree-sitter-tsx.wasm');
// .ts -> TS grammar, .tsx/.jsx -> TSX grammar, .js -> TSX grammar (handles flow-ish syntax)
```

Bundle the `.wasm` files into the Lambda package. Do not fetch them at runtime.

### What to extract per file

**Imports.** From `import_statement` nodes: the module specifier and the imported names. Resolve relative specifiers to repo-relative paths, applying the usual resolution order (`.ts`, `.tsx`, `.js`, `/index.ts`). Record bare specifiers as external dependencies without resolving them.

**Exports.** From `export_statement` nodes: exported symbol names and whether the export is default.

**Declarations.** `function_declaration`, `class_declaration`, `method_definition`, `variable_declarator` holding an arrow function. For each: name, kind, start line, end line.

**Call sites.** From `call_expression` nodes: the callee text and the line. Do not resolve the callee to a declaration — too expensive and error-prone. Store the raw text; retrieval can match on it.

**Route registrations.** Call expressions whose callee matches `app.get|post|put|delete|use` or `router.get|post|put|delete|use`. Capture the first string argument as the route path. These matter disproportionately, because most "where do I add X" questions are about request paths.

### Output shape

```ts
interface ParsedFile {
  path: string;
  language: 'ts' | 'tsx' | 'js' | 'jsx';
  lineCount: number;
  imports: { specifier: string; resolved: string | null; names: string[] }[];
  exports: { name: string; isDefault: boolean }[];
  declarations: { name: string; kind: string; startLine: number; endLine: number }[];
  calls: { callee: string; line: number }[];
  routes: { method: string; path: string; line: number }[];
}
```

### Building the graph

Nodes are files. Edges are resolved imports, direction from importer to imported. Drop edges whose target did not resolve to a file in the repo — external packages are recorded on the node, not as graph edges, or the graph becomes noise.

Compute, in the Persist step:

- `importedByCount` per node, which is a decent proxy for importance
- Simple centrality: nodes with many inbound edges are structural, nodes with many outbound edges and no inbound are entry points
- Cluster label per node from its directory path, used for colour grouping in the map

### What to deliberately skip

- Type resolution and inference
- Cross-file call graph resolution
- Dynamic imports and re-export chains beyond one hop
- Monorepo package boundary resolution

Each of these is a day of work and none of them changes the answer to a "where does this belong" question.

## Chunking and embedding

### Chunking strategy

Chunk on **declaration boundaries**, not fixed character windows. A function split across two chunks retrieves badly.

For each file, produce:

1. **One file-summary chunk.** Path, exported symbols, imports, route registrations, declaration names. This is a synthetic chunk, roughly 200 tokens, that describes the file's role. These retrieve extremely well for "where does X happen" questions because they read like an index.
2. **One chunk per declaration** over 5 lines, containing the declaration's source. If a declaration exceeds 1,500 tokens, split it and mark the parts.
3. **One chunk for module-level code** outside any declaration, if it is more than 5 lines.

Every chunk carries metadata:

```ts
interface Chunk {
  chunkId: string;        // `${repoId}#${path}#${startLine}`
  repoId: string;
  path: string;
  kind: 'file-summary' | 'declaration' | 'module';
  symbolName: string | null;
  startLine: number;
  endLine: number;
  content: string;
  vector: number[];
}
```

The metadata matters as much as the vector. Retrieval filters and re-ranks on it.

### Embedding

Use Bedrock's Titan embeddings (`amazon.titan-embed-text-v2:0`) — cheap, fast, available in region, and good enough at this scale. Batch roughly 50 chunks per call.

Embed the chunk content **prefixed with its path and symbol name**. `src/routes/auth.ts :: loginHandler` followed by the source retrieves noticeably better than bare source, because path tokens carry real signal for these questions.

### Storage

Store vectors in DynamoDB alongside the chunk. At demo scale (roughly 2,000 to 5,000 chunks) loading the vectors for one repo and computing cosine similarity in the query Lambda takes well under a second.

**Measure this on Friday.** If retrieval exceeds 1 second, then move to OpenSearch Serverless and not before. The setup cost of OpenSearch is real and this is a two-day build.

To keep the load cheap, store vectors in a single item per repo as a packed binary blob (Float32Array to base64), not one item per chunk. One read, not thousands.

## DynamoDB design

Single table, `bearings`. Single-table design because every access pattern here is keyed by `repoId` and we do not want five tables to provision and clean up.

### Keys

| Entity | PK | SK |
| --- | --- | --- |
| Repo record | `REPO#{repoId}` | `META` |
| Job status | `REPO#{repoId}` | `JOB#{jobId}` |
| File node | `REPO#{repoId}` | `FILE#{path}` |
| Graph (packed) | `REPO#{repoId}` | `GRAPH` |
| Vectors (packed) | `REPO#{repoId}` | `VECTORS#{shard}` |
| Chunk | `REPO#{repoId}` | `CHUNK#{path}#{startLine}` |
| Context item | `TEAM#{teamId}` | `CTX#{repoId}#{timestamp}#{id}` |
| Suggestion draft | `TEAM#{teamId}` | `SUGG#{repoId}#{id}` |

### Access patterns and how they are served

| Pattern | Query |
| --- | --- |
| Get repo status | GetItem on `REPO#{repoId}` / `META` |
| Get full graph for the map | GetItem on `GRAPH` — one read, pre-computed in Persist |
| Load vectors for retrieval | Query on `VECTORS#` prefix, typically 1 to 3 shards |
| Fetch chunks by id after ranking | BatchGetItem, up to 100 keys |
| Get file detail on node click | GetItem on `FILE#{path}` |
| List team context for a repo | Query `TEAM#{teamId}` with SK prefix `CTX#{repoId}#`, ScanIndexForward false for newest first |
| List pending suggestions | Query `TEAM#{teamId}` with SK prefix `SUGG#{repoId}#` |

No GSIs needed. If one becomes necessary the design is wrong; revisit the key layout instead.

### Notes

- **Billing mode on-demand.** No capacity planning, scales to zero.
- **Item size limit is 400 KB.** The graph and the vector blobs will exceed it on a large repo. Shard them: `GRAPH#0`, `GRAPH#1`, and so on, with a count on the META record. Write the sharding logic on day one rather than discovering the limit on Saturday with a large repo.
- **TTL attribute on job records**, 7 days. Keeps the table clean without a cleanup job.
- **Context items are never hard-deleted.** Dismissing a suggestion sets `dismissed: true`. History is the point of the product.

### Team ID this weekend

No auth, so `teamId` comes from a URL path or query param and defaults to a demo value. Everyone with the link shares a team. Say this plainly in the demo rather than implying auth exists.

## Retrieval

This is where answer quality is won or lost. Pure vector search is not enough on its own — the graph is the advantage over a generic RAG demo, so use it.

### Pipeline

**1. Embed the question.** Same model as the chunks.

**2. Vector search.** Cosine similarity over the repo's vectors, take top 20.

**3. Keyword boost.** Extract identifier-like tokens from the question (`rate limiting`, `auth`, `login`). Boost chunks whose path or symbol name contains them. A question mentioning "auth" should surface `src/routes/auth.ts` even if the vector score is middling. Weight it around 0.3 against the vector score.

**4. Graph expansion.** For the top 5 chunks after re-ranking, pull their graph neighbours — files they import and files that import them — and include those files' summary chunks. This is the step generic RAG does not have. "Where do I add rate limiting" needs the router that sits above the handlers, and the router is a graph neighbour, not a semantic match.

**5. Route table.** Always include the repo's full route registration list if it has one, under 50 entries. It is small and disproportionately useful.

**6. Team context.** Always include the team's saved decisions, failed attempts and constraints for this repo. If someone recorded "we tried Passport.js and removed it", the answer must not suggest Passport.js. This is the whole point of the product and it is an injection into every prompt, not an optional extra.

**7. Assemble and cap.** Cap total context around 30,000 tokens. Order: team context, route table, file summaries, then declaration bodies. If the cap is hit, drop declaration bodies from the bottom of the ranking, never the team context.

### Ordering rationale

Put team context first in the prompt, not last. It is the highest-value, lowest-volume input and it should not compete for attention with thousands of tokens of source code.

### Tuning loop

Friday evening is for this. Run `scripts/eval.ts`, look at which of the ten questions fail, and inspect what was retrieved rather than what was generated. Almost every wrong answer this weekend will be a retrieval failure, not a generation failure. Fix retrieval first; change the prompt only when the right context was present and the model still got it wrong.

## Bedrock call

### Model and region

Use the global cross-Region inference profile, which is how Claude models are reachable from India:

```
modelId: 'global.anthropic.claude-sonnet-4-6'
region:  'ap-south-1'
```

Check model access in the Bedrock console on Thursday, first hour. Access is requested per account and is not instant. This is the one blocker that cannot be worked around late.

Fall back to Haiku 4.5 if latency is a problem. Test both against the eval set before deciding — cheaper and faster may be good enough here, since the reasoning load is modest once retrieval is right.

### Prompt structure

System prompt, fixed:

> You help engineers locate where a change belongs in a codebase you have been given context for. You never invent file paths. Every file you name must appear in the provided context. If the context does not support a confident answer, say so and name the most likely candidates instead of guessing. You are not writing code; you are locating work.

User message, assembled in this order:

1. Team context block (decisions, failed attempts, constraints) — first, because it is the highest-signal input
2. Repo summary (name, framework, file count)
3. Route table
4. Retrieved file summaries
5. Retrieved declaration bodies
6. The question

### Schema enforcement

Do not parse prose. Use tool calling to force the shape: define a single tool whose input schema is the `Answer` object from `03-API.md`, and require the model to call it.

Validate the result with the same zod schema the API uses. On validation failure, retry once with the error appended. On a second failure, return `confidence: "low"` with whatever fields did validate, and let the UI show a retry.

### Anti-hallucination check

After validation, verify every path in `recommendedFile`, `attachTo` and `sources` exists in the repo's file list. Any that does not: drop it and downgrade confidence. This is a five-line check that prevents the single worst demo failure — a confident answer pointing at a file that does not exist.

### Confidence

Set `confidence` from real signals, not the model's self-report:

- `high` — top retrieval score above threshold, and the recommended file was in the retrieved set
- `medium` — recommended file was retrieved but scores were middling
- `low` — recommended file came from graph expansion only, or validation needed a retry

A visible, honest confidence level reads as engineering maturity to a judge. Saying "I am not sure, here are the three likely places" is better than a confident wrong answer, and it is a line worth saying out loud in the demo video.

## Suggestions and MCP

### Git-aware suggestion drafting

The feature that separates us from tools that trust an agent to remember things on its own.

**Trigger:** the user opens the context panel, or hits refresh on it. Not a background job — there is no time for one and no need.

**Input:** the diff between the indexed commit and the repo's current HEAD. For the demo this can be a diff the user pastes or a re-fetch of the default branch.

**Process:** send the diff, plus the current team context, to Bedrock with a prompt asking for candidate records in three categories:

- A decision, where the diff shows a choice was made
- A failed attempt, where the diff shows something was added and then removed, or a dependency dropped
- A constraint, where the diff shows a version pin or config limit

**Output:** drafts, each with type, title, body, and the files it came from. Stored with `status: 'pending'`.

**Critical rule:** drafts are never saved as context automatically. The user approves, edits, or dismisses. An approved draft becomes a context item; a dismissed one is marked dismissed and not re-suggested. This is a product decision, not a technical limitation — auto-detection that is sometimes wrong pollutes the context permanently, and the whole value is that the context can be trusted.

Cap at 5 drafts per refresh. More than that and nobody reviews any of them.

### MCP server

Built last. Dropped without discussion if the core is not solid by Saturday night.

**Deployment:** App Runner, not Lambda. MCP remote transport holds long-lived SSE connections, which App Runner handles naturally. This is the only always-on component and that trade-off is deliberate.

**Tools exposed:**

| Tool | Input | Returns |
| --- | --- | --- |
| `get_project_context` | `repoId` | Decisions, failed attempts, constraints, repo summary, formatted as markdown |
| `find_where_to_change` | `repoId`, `question` | The same Answer object the web app gets |
| `save_decision` | `repoId`, `type`, `title`, `body` | Confirmation and the new item id |

**Implementation:** the MCP server is a thin wrapper. It calls the same HTTP API the frontend does. No duplicated logic, no second retrieval path. If the web app works, the MCP server works.

**One safety note:** `save_decision` lets an agent write to shared team context. Mark agent-written items with their source so a human can see what came from a model versus a person. Do not let an agent silently author the team's record of its own decisions.

## Local development

### Prerequisites

- Node 20
- AWS CLI configured, SAM CLI installed
- Bedrock model access approved on the account (check this first, see the Bedrock section)

### Commands

```bash
npm install
npm run build                 # build all packages

sam local start-api          # API on localhost:3000
npm run index -- <repoUrl>   # run the pipeline locally, skips Step Functions
npm run eval                 # the ten known-answer questions

sam build && sam deploy      # deploy everything
```

### Environment

```
AWS_REGION=ap-south-1
BEDROCK_MODEL_ID=global.anthropic.claude-sonnet-4-6
BEDROCK_EMBED_MODEL_ID=amazon.titan-embed-text-v2:0
TABLE_NAME=bearings
REPO_BUCKET=bearings-repos
```

Never commit a `.env`. The parser skips them for a reason and so should the repo.

### Local pipeline shortcut

`npm run index` runs clone, parse, chunk, embed and persist in sequence in one process, hitting real DynamoDB and Bedrock but bypassing Step Functions. This is the fast loop for development. Step Functions is only exercised on deploy, which is fine — its job is retries and visibility, not logic.

### Order of verification

After each step of the build order, verify before moving on:

1. Hello-world deploy: a request reaches a Lambda and returns, through the real API Gateway URL
2. Parse: `npm run index` on the demo repo produces a graph JSON with a sane node and edge count
3. Embed: chunks exist in DynamoDB with vectors, and a manual similarity query returns plausible files
4. Query: a question returns a valid Answer object that passes zod validation
5. Context: a write from one browser appears in a read from another
6. Suggestions: a real diff produces at least one sensible draft
7. MCP: a client connects and `get_project_context` returns

If a step cannot be verified, do not build on top of it. Debugging a five-layer stack on Saturday night is how weekends get lost.
