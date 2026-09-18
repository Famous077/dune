# 00 — Product requirements: Dune

First Commit · WeMakeDevs x AWS · Ship It track · Sept 17–20, 2026

2026-09-17 · @Someone

## The problem

Two things break in the same place, and both cost real time.

**AI agents forget.** You work with one agent, then switch tools or start a new session, and the new one has no idea what happened. It doesn't know why JWT was picked over sessions, what was already tried and thrown away, which files were changed on purpose, or what is left to do. So you re-explain your own project to an AI, every single time. On a multi-day feature this happens over and over.

**New people are lost.** Open an unfamiliar repo: 500 files, 80,000 lines, 12 services. Someone says "add rate limiting to the auth API." Now you spend an hour or two just finding where authentication actually happens, before writing a single line.

These look like two problems but they are one: **context about a codebase lives in people's heads, and nothing keeps it.** Every new session, every new joiner, every new agent starts from zero.

The cost is concrete. A new engineer's first weeks go mostly into understanding the codebase, not shipping. The same questions get asked in team chat again and again. And every AI session spends its first few thousand tokens re-learning what the last one already knew.

## Who it is for

**Primary: small engineering teams, 3 to 30 people.** The ones where nobody has time to write docs, where the person who built the auth layer has moved on, and where every new joiner asks the same five questions in Slack.

**Secondary:**

- New joiners and interns, whose first month goes into reading code instead of writing it
- Open source contributors landing in a repo they have never seen, trying to find where a fix belongs
- The AI agents these people run, which need the same context and currently get none

The person on the other side of this is the developer who stops losing hours to "where does this even happen" and the team that stops answering the same question a fifth time. The unit of value is hours not spent re-discovering things the team already knows.

## Competition and the gap

We researched this before building. Both halves of the problem already have tools. Being honest about that is how we answer the judges' first question.

### Repo understanding

| Tool | What it does | Where it stops |
| --- | --- | --- |
| DeepWiki (Cognition) | Pre-indexed architecture wikis for 50,000+ popular public repos | Read-only wiki, nothing about your team's own decisions, public repos only |
| Sourcegraph Cody | Cross-repo search and comprehension on Sourcegraph's code graph | Enterprise infrastructure, heavy setup, priced for large orgs |
| Greptile | Semantic graph across repos, multi-hop investigation for code review | Review-focused, paid per seat, code indexed on their servers |
| Cursor / Augment | IDE-native indexing for generation | Context stays inside that one editor and that one machine |

### Context persistence

This side is even more crowded. On GitHub and PyPI today: codebase-memory (MCP server storing architecture, patterns, conventions, decisions), handoff-mcp (saves tasks, decisions, blockers to a local .handoff directory), memory-mcp, promem-mcp / ContextMCP, DevContext, Cursor10x, A/MCL.

### The gap we are attacking

Three things none of them do together:

1. **Everything is local and single-player.** codebase-memory runs on local SQLite, handoff-mcp writes to a local folder. The context is trapped on one machine. Your teammate gets nothing. We are hosted, so one person saves a decision and the whole team's agents have it.
2. **They trust the agent to remember on its own.** Memory only gets saved if the agent decides to call a save tool, which is unreliable. We read the git diff, draft the decision, and ask the human to confirm in one click.
3. **They are invisible.** These are MCP servers with no interface. Nothing to look at, nothing to audit, nothing to hand a new joiner on day one. We have a visible map and a readable decision log, and the MCP server on top of it.

One line: **existing tools give one developer a private memory of code. We give a team a shared brain for a repo, readable by humans and agents both.**

## What we are building

**Dune is a shared brain for a repo. Point it at your codebase and it answers two questions for everyone on the team: where does this change belong, and what have we already figured out about this code.**

It is not a code generator and not another chat window. It sits one step before those. It gives you, or your agent, the engineering context needed to make a change correctly, and it keeps that context after you make it.

The loop:

1. Connect a repo. It is parsed into a structure map.
2. Ask where a change belongs. You get a specific file, a reason, the blast radius, and the tests to update.
3. As work happens, decisions, dead ends and constraints get captured with one click.
4. All of it is available to the next person and the next agent, through the UI or through MCP.

Team is CloudSmiths. Track is Ship It, deployed on AWS with a live URL.

## Features

### Committed for this weekend

**1. Repo connect and index** Paste a GitHub repo URL. It clones, parses, and builds the structure. Tree-sitter extracts files, imports, exports and function calls. Code chunks are embedded and stored. Live progress while it runs.

**2. Architecture map** A visual graph of the repo: which module depends on what. Entry points highlighted (routes, main files, where things start). Click a node to see that file's role and who uses it.

**3. "Where do I change this" query** The heart of the product. Ask a question, get a structured answer: the recommended file and exact spot, why there, what else is affected, which tests to update, and the source files the conclusion came from so you can verify it.

**4. Team knowledge layer** The differentiator. Three things get stored and shared across the whole team: decisions ("JWT not sessions, because X"), failed attempts ("tried Passport.js, removed, conflicted with existing auth"), and constraints ("cannot go above Node 18"). One person saves it, everyone gets it.

**5. Git-aware drafting** The system reads the diff and proposes: "looks like Passport.js was removed, want to record why?" The human approves or edits in one click. Suggested, never silently auto-detected.

**6. Context export** One button, full context as markdown. Repo state, decisions, failed attempts, next steps. Paste into any agent: Claude, Cursor, Copilot, anything.

**7. MCP server** The same context delivered straight to agents, no copy-paste. Three tools: get\_context, find\_where\_to\_change, save\_decision. Built only once 1 to 6 are solid.

### Extended, if time allows

These are deliberately out of scope for the 4 days and go on the roadmap. We pick them up in this order only if the committed set is finished and stable:

- More languages beyond TypeScript and JS (Python first, its grammar is the cheapest to add)
- Multiple repos in one brain
- Auth, accounts and real team management
- Code generation, not just locating the change
- Real-time collaboration
- Interactive draggable graph instead of static rendering

### Why we are cutting

The judging criteria say it directly: one feature that runs beats five that almost do, and working matters more than polished. A demo where the judge touches anything and it holds up is worth more than a feature list where everything is at seventy percent.

## Architecture

Ship It is scored partly on architecture and cost decisions, so each choice below has a reason attached.

### Flow

Repo URL comes in through API Gateway, a Lambda registers the job and drops it on Step Functions. The indexing pipeline clones the repo to S3, parses it with tree-sitter into a symbol and import graph, chunks the code, embeds the chunks, and writes the graph and metadata to DynamoDB with vectors to the search store. Query time: API Gateway to Lambda, retrieve relevant chunks and graph neighbours, send to Bedrock with the team's saved decisions injected, get structured JSON back. Frontend on Amplify Hosting. MCP server on App Runner, calling the same query API.

### Services and why

| Layer | Choice | Reason |
| --- | --- | --- |
| API | API Gateway + Lambda | Scales to zero, nothing running between demos, cheapest possible idle cost |
| Indexing | Step Functions | Clone, parse, chunk, embed are distinct steps that each fail differently; retries and visible state for free |
| Repo storage | S3 | Snapshots, cheap, nothing to manage |
| Graph and metadata | DynamoDB | Single-digit ms lookups on file and symbol keys, on-demand billing |
| Vectors | Start in-memory / DynamoDB, move to OpenSearch Serverless only if needed | For a single mid-size repo the OpenSearch setup cost may outweigh the benefit; we measure before adding it |
| Embeddings and generation | Embeddings run locally (all-MiniLM-L6-v2); generation sits behind a provider interface | Bedrock is optional for this hackathon and our model access is still pending, so nothing waits on it. Bedrock with Claude via Global cross-Region inference, for example global.anthropic.claude-sonnet-4-6, is the intended path once access is granted; its large context window helps when feeding graph plus chunks |
| Frontend | Amplify Hosting | URL in minutes, which is the Ship It requirement |
| MCP server | App Runner | MCP remote transport holds long-lived SSE connections, which fits App Runner better than Lambda |

### Notes from feasibility research

- Bedrock in India is not a blocker. Claude Opus 4.6, Sonnet 4.6 and Haiku 4.5 are reachable from Mumbai through Global cross-Region inference profiles.
- Tree-sitter for TypeScript and TSX is a solved path. The tree-sitter npm package plus the tree-sitter-typescript grammar gives imports, calls, inheritance and symbol nodes. An existing open source project does exactly this extraction for TS, TSX, JS and Python, so the approach is proven and we are implementing, not researching.
- Use the WASM grammars rather than native bindings. Avoids compiling native modules for the Lambda runtime.
- Force structured JSON out of Bedrock rather than parsing prose. The answer shape is fixed, so the model should fill a schema.

### Cost posture

Everything above is serverless and scales to zero. Between demo runs the standing cost is effectively storage only. The $100 team credits plus new-account free tier cover the weekend with room to spare.

## API contract

Freeze this first, before anyone writes code. Frontend builds against dummy JSON in this shape and never waits on the backend.

### Endpoints

```
POST /repos            { repoUrl, teamId }        -> { repoId, jobId }
GET  /repos/:repoId                                -> { status, progress, graph }
POST /query            { repoId, question }        -> Answer
GET  /context/:repoId                              -> { decisions[], failures[], constraints[], nextSteps[] }
POST /decisions        { repoId, type, title, body, files[] } -> { id }
GET  /export/:repoId                               -> { markdown }
GET  /suggestions/:repoId                          -> { drafts[] }
```

### Answer shape

This is the object the whole UI is built around, so it does not change after Thursday.

```json
{
  "recommendedFile": "src/middleware/rateLimiter.ts",
  "attachTo": "src/routes/auth.ts",
  "reason": "All auth endpoints pass through this router.",
  "affected": ["/login", "/register", "/forgot-password"],
  "testsToUpdate": ["auth.test.ts", "rateLimit.test.ts"],
  "sources": [{ "file": "src/routes/auth.ts", "lines": [12, 48] }],
  "confidence": "high"
}
```

### Graph shape

```json
{
  "nodes": [{ "id": "src/routes/auth.ts", "kind": "route", "entryPoint": true }],
  "edges": [{ "from": "src/routes/auth.ts", "to": "src/services/authService.ts", "kind": "import" }]
}
```

Every field above is required. If the backend cannot fill one, it returns null rather than dropping the key, so the frontend never breaks mid-demo.

## User flows

Three journeys the product must support end to end. Everything built this weekend serves one of these.

### Flow 1 — First contact with an unfamiliar repo

1. User lands on the home screen, pastes a GitHub repo URL, submits.
2. Indexing starts. Progress is visible: cloning, parsing, embedding, done. Each stage shows a count where it has one (files parsed, chunks embedded).
3. On completion the user lands on the map view. Entry points are highlighted, so the eye has somewhere to start.
4. User clicks a node. A side panel shows that file's role, what it imports, and who imports it.

**Success:** within 60 seconds of landing, the user can name the repo's entry points without opening the code.

### Flow 2 — Locating a change

1. From the map view, user types a question in the query box: "where do I add rate limiting to the auth API?"
2. Loading state while retrieval and generation run.
3. Answer card renders: recommended file, attach point, reason, affected paths, tests to update.
4. Each cited source is clickable. Clicking opens that file at the cited lines, so the user can verify rather than trust.
5. User can save the answer to the team context if it settles something.

**Success:** the user goes from question to a verified location in under a minute, without opening the repo tree.

### Flow 3 — Capturing and carrying context

1. User opens the context panel. Existing decisions, failed attempts and constraints are listed, most recent first.
2. A suggestion appears, drafted from the git diff: "Passport.js was removed from auth.ts. Record why?"
3. User edits the draft text and approves, or dismisses it.
4. User hits export. Markdown appears, copyable in one click.
5. Alternatively the user's agent calls the MCP server and receives the same context directly.

**Success:** a teammate opening the same repo tomorrow sees the decision without asking anyone.

## Success metrics

What good looks like. These are the numbers we tune against on Sunday morning and quote in the demo video.

| Metric | Target | How we measure |
| --- | --- | --- |
| Answer correctness | 8 of 10 questions point at the right file | Write 10 questions for the demo repo with known answers, score manually |
| Answer verifiability | 100% of answers cite at least one real source file with line numbers | Automated check on the response object |
| Index time | Under 3 minutes for a repo of \~500 files | Timed on the demo repo |
| Query latency | Under 8 seconds end to end | Measured from the frontend |
| Graph coverage | Over 90% of TS/TSX files appear as nodes | Count nodes against file count |
| Context round trip | A decision saved by one user appears for another within 5 seconds | Two browser sessions side by side |

### The one that matters most

Answer correctness. Everything else can be respectable and the product still fails if it confidently names the wrong file. This is why 10 known-answer questions get written early and re-run after every prompt change, rather than eyeballing one answer at a time.

### What we are not measuring

No user testing, no retention, no cohort analysis. Four days is not enough to generate that data honestly, and inventing it would be worse than leaving it out.

## Non-functional requirements

Hard limits the implementation must respect. Claude Code should treat these as constraints, not suggestions.

**Scale**

- Repo size supported: up to 1,000 files, 150,000 lines. Above that, index the top N files by graph centrality and say so in the UI rather than failing.
- One repo per brain. No multi-repo joins.
- Concurrent users: 10. This is a demo, not production.

**Performance**

- Index: under 3 minutes for 500 files. If parsing exceeds this, parallelise at the file level in the Step Functions map state.
- Query: under 8 seconds. Budget it as retrieval under 1s, Bedrock under 6s, overhead under 1s.
- Map render: under 1 second for 500 nodes. Pre-compute layout server side and ship coordinates; do not run force-directed layout in the browser.
- Context read: under 500ms. It is a DynamoDB query, nothing more.

**Reliability**

- Indexing is resumable. If a step fails, Step Functions retries that step, not the whole pipeline.
- A failed embed on one file does not fail the index. Log it, skip it, continue.
- The UI never shows a raw error string. Every failure has a human sentence and a retry action.

**Cost**

- Everything scales to zero between demos. No provisioned capacity, no always-on instances except App Runner for MCP, which is the single exception and is justified by SSE. (As deployed, not even that: App Runner is unavailable to our account, so MCP runs on Lambda over Streamable HTTP.)
- Stay inside the $100 team credits plus free tier for the full weekend.

**Browser support**

- Latest Chrome only. State it, do not test anything else. Recording happens in Chrome.

## Edge cases and failure handling

These are where a live demo breaks. Each needs a defined behaviour before Sunday.

| Case | Behaviour |
| --- | --- |
| Private or non-existent repo | Clear message: repo not reachable, check the URL or make it public. No stack trace. |
| Repo with no TypeScript | Index completes, map shows what it found, banner says only TS and TSX are supported today and lists the languages detected |
| Repo too large | Index the highest-centrality files up to the cap, show a banner naming how many files were covered |
| Empty or near-empty repo | Say so plainly, offer the demo repo as a sample |
| Question the answer engine cannot place | Return confidence: low, say which areas were searched, name the two or three most likely files rather than inventing one |
| Model returns malformed JSON | Retry once with a stricter instruction; on second failure show a retry button, never a half-rendered card |
| Bedrock throttling | Exponential backoff, then a message saying the service is busy with a retry action |
| Indexing fails midway | Step Functions retries the failed step. If it fails again, the repo is marked failed with the stage named, and a reindex button |
| No decisions saved yet | Empty state with an example, not a blank panel |
| Two users save a conflicting decision | Both are stored, both shown, newest first. No merge logic this weekend |
| Export with nothing in context | Export the repo structure summary anyway, so the button never produces an empty file |
| MCP client calls before indexing finishes | Return a status response saying indexing is in progress, not an error |

### Rule for all of them

Every failure state gets a human sentence and a next action. "Something went wrong" is not acceptable in a demo a judge will watch.

## Risks and fallbacks

Each risk has a trigger point and a decision already made, so nobody is deciding under pressure on Saturday night.

| Risk | Likelihood | Fallback |
| --- | --- | --- |
| Answer quality stays poor after tuning | Medium | Narrow the question types accepted. A tool that answers three kinds of question well beats one that answers anything badly. Say so in the demo. |
| First AWS deploy eats a day | Medium | Deploy a hello-world through the full stack on Thursday night, before any real feature exists. Find the IAM and region problems early. |
| Indexing too slow on the demo repo | Medium | Pre-index the demo repo and cache it. The video shows indexing on a small repo, the query demo runs on the cached large one. |
| Bedrock access not enabled on the account | High, and already the case | Not fatal. Bedrock is optional for this hackathon, embeddings run locally and generation sits behind a provider interface, so nothing waits on access. Swap Bedrock in if the support case clears. |
| Frontend and backend integrate late and break | High | The frozen API contract exists for this. Frontend works on dummy JSON from hour one and never blocks on the backend. |
| MCP server eats Sunday | Medium | It is explicitly last. If core is not solid by Saturday night, it is dropped without discussion. |
| Demo repo changes behaviour between tests | Low | Pin a commit SHA. Do not track the default branch. |
| Nobody has time to record the video | Medium | Sunday midday is blocked for recording. Feature work stops then regardless of state. |
| Team member blocked and idle | Medium | The contract and the dummy data mean each person can work alone for a full day if needed. |

### The two that would actually sink us

Answer quality and the video. The first is why the ten known-answer questions get written before prompt tuning starts: everything else can be respectable and the product still fails if it confidently names the wrong file, and without the eval every change merely feels like an improvement. The second is protected by stopping all feature work Sunday midday. Everything else has a workable fallback, Bedrock access included.

## Data handling

Worth stating, because a judge may ask and because it is a real objection for any tool that ingests a company's code.

**What we store**

- Repo snapshot in S3, and only for public repos this weekend
- Extracted graph: file paths, symbol names, import and call edges, in DynamoDB
- Code chunks and their embeddings, for retrieval
- Team context: decisions, failed attempts, constraints, written by users

**What we do not store**

- Credentials, tokens, or anything from a .env file. The parser skips env files and anything gitignored.
- No user accounts this weekend, so no personal data beyond a team ID.

**Where it goes**

Code chunks are sent to Bedrock at query time as retrieval context. Nothing is used for training. Inference runs through Bedrock's global cross-Region inference, so requests may be served outside ap-south-1, which is worth saying plainly rather than glossing over.

**The honest limitation**

A team that cannot send its code to a third party cannot use the hosted version. Self-hosted deployment is on the roadmap for exactly this reason, and it is where several existing tools in this space lose enterprise deals.

## Timeline and owners

Three people. Akshat on backend, indexing and AI. Two on frontend and the map. Submission closes Sunday.

### Thursday, first hour, everyone together

Freeze the API contract above. Hand the frontend pair dummy JSON in the exact answer and graph shapes. Pick the demo repo and lock it, one mid-size TypeScript repo that gets used for the entire weekend. Testing on a different repo each time makes it impossible to tell whether an answer is wrong or the repo is just different.

### Thursday night to Friday night, backend

In priority order, top first:

1. Clone and parse. TypeScript and TSX only. Imports, exports and calls via tree-sitter WASM. Module graph is enough, no full AST semantics.
2. Chunk and embed. Start simple. Only add OpenSearch if simple search measurably falls over.
3. Query endpoint. Retrieval plus graph neighbours plus Bedrock, structured JSON enforced.
4. Answer quality tuning. This takes the longest and cannot be rushed, which is why the buffer runs to Friday night.

### Thursday to Saturday, frontend

Three screens, nothing more:

- Repo input and indexing progress
- Map plus query box plus answer card
- Context panel: decisions, failures, constraints, export button

Use a ready component library. Best UI is a separate ₹1,00,000 prize on the same submission, and it is won on layout and clarity, not animation.

### Saturday

Morning: integration, everything wired by afternoon. Decisions, git-aware drafting and export land here, they are small once the core works.

The in-person day is at Polaris in Bangalore, 8 AM to 8 PM. Workshops, project feedback and the Amazon team are there. Optional and adds nothing to the score, but the feedback is free and worth taking.

Saturday evening: deploy. First AWS deploy always takes longer than expected. IAM, Bedrock model access, region mismatches. Do not push this to Sunday.

### Sunday

- Morning: tune answers on the demo repo. What the judge sees is what matters.
- Midday: record the 3 minute demo video.
- Afternoon: write the AWS Builder Center blog. Top 5 blogs win a Logitech keyboard and it is a separate, cheap prize.
- Evening: submit early, not at the deadline.

MCP server slots in Saturday night or Sunday morning, only if the committed core is solid. If it is not, drop it. The product stands without it.

## Demo video script

Three minutes, recorded. There is no live demo, so this video is the entire thing the judges see. Write the script before recording and do the retakes.

**0:00 to 0:25 — the problem, shown not told** Open an unfamiliar repo, scroll the file tree, show the scale. Voiceover: someone asks you to add rate limiting to the auth API. Where does that even go? Then: and when you ask an AI, it has no idea either, because it has never seen this repo before and forgets everything the moment the session ends.

**0:25 to 0:50 — connect and index** Paste the repo URL. Show indexing progress. Land on the architecture map, entry points highlighted.

**0:50 to 1:35 — the core query** Ask where rate limiting belongs. The structured answer appears: file, attach point, reason, blast radius, tests to update. Open one of the cited source files to show the answer is verifiable, not invented. This is the moment the judge decides, so give it room.

**1:35 to 2:10 — the team layer** Save a decision and a failed attempt. Then show the git-aware draft appearing on its own and getting approved in a click. Say the part that matters: this is shared, so the next person and the next agent both start from here.

**2:10 to 2:40 — it travels** Hit export, show the markdown. Then show the same context reaching an agent directly over MCP, no copy-paste.

**2:40 to 3:00 — AWS and what we learned** Thirty seconds on the architecture: serverless, scales to zero, Bedrock through global inference from Mumbai, Step Functions for the pipeline. Close on what the team learned in four days, since learning is scored separately.

### Rules for the recording

- Everything runs against the locked demo repo, already indexed. No live indexing of a cold repo on camera.
- Never show a loading state longer than two seconds. Cut it.
- Say what the product does not do. Judges trust a team that knows its own scope.

## Roadmap

What comes after the weekend, in the order it is worth building. Showing this is a strength, not an admission: it says the scope cut was deliberate.

**Near term**

- Python, then Go. Each is a grammar plus its own import resolution.
- Multiple repos in one brain, for teams whose services are split across repos.
- Real accounts and team management, replacing the demo team ID.

**Medium term**

- Pull request awareness. When a PR lands, propose the decisions it implies and ask for confirmation.
- Onboarding mode. Generate a guided path through a repo for someone on day one, ordered by what to read first.
- Slack or Discord surface, so the answer arrives where the question was actually asked.

**Longer term**

- Propose the change, not just its location.
- Staleness detection, flagging recorded decisions the code has since moved away from.
- Self-hosted deployment for teams that cannot send code to a third party, which is where several existing tools lose enterprise deals.

### Open questions

- Name is Dune. Check GitHub and npm availability before registering anything.
- Demo repo, to be locked Thursday night.
- Whether simple vector search holds for a mid-size repo or OpenSearch Serverless becomes necessary. Decided by measurement on Friday, not by guessing now.
