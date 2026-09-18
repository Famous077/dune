# 04 — Infra and deployment

Dune · CloudSmiths · First Commit (AWS x WeMakeDevs)

Ship It track. The architecture is part of the score, so this is not just plumbing.

## Thursday, hour one

Do these before writing any feature code. Every item here is something that can block the whole weekend if discovered late.

### 1. Request Bedrock model access

**Bedrock is optional for this hackathon.** The organizers have confirmed that model access can take a long time to come through, that projects should not wait on it, and that using other AI tools or open source models puts a project at no disadvantage for prizes. The only requirement is deploying on AWS. Our account is blocked on Anthropic model access with a support case pending, so embeddings run locally and generation sits behind a provider interface — see `01-BACKEND.md`.

Request access anyway, and early: it is requested per account in the Bedrock console, it is not instant, and it is worth having if it arrives.

- Console, ap-south-1, Bedrock, Model access
- Request access to Anthropic Claude models and Amazon Titan Embeddings
- Verify with a real inference call before moving on, not by looking at the console showing green

Claude in India runs through Global cross-Region inference profiles, so the model id is prefixed:

```
global.anthropic.claude-sonnet-4-6
amazon.titan-embed-text-v2:0
```

If a plain regional model id is used, the call fails. This has eaten hours for people who did not know about the prefix.

### 2. Claim the hackathon AWS credits

One form per team, filled by the team lead only. $100 on top of the new-account free tier. For a new AWS account, debit cards and RuPay are accepted and the verification charge is about ₹2.

### 3. Verify student status

AWS Builder Center profile with university enrollment verified. Required to compete, separate from the WeMakeDevs account. If verification is still processing, enter anyway.

### 4. Deploy hello-world through the entire stack

Before any real logic. A SAM template with one Lambda behind API Gateway, deployed, returning a response from the real URL. Then add DynamoDB and confirm a write.

This finds the IAM, region and permission problems on Thursday when there is time, instead of Saturday night when there is not.

### 5. Pin the demo repo

Pick one mid-size TypeScript repo. Record the exact commit SHA in the repo README. Do not track a moving branch — an answer that was correct on Friday should still be correct in Sunday's recording.

### 6. Freeze the API contract

All three people read `03-API.md` together, agree, and the frontend gets its mock files. After this, changes need both sides to agree.

## AWS resources

One SAM template at `infra/template.yaml`. One deploy command. Region ap-south-1 throughout.

### Resources

| Resource | Type | Notes |
| --- | --- | --- |
| `DuneTable` | DynamoDB | Single table, on-demand billing, TTL on `expiresAt` |
| `RepoBucket` | S3 | Repo snapshots, lifecycle rule deleting objects after 7 days |
| `IndexStateMachine` | Step Functions | Standard workflow, the indexing pipeline |
| `CloneFn` | Lambda | 2 GB ephemeral storage, 3 GB memory, 5 min timeout |
| `ParseFn` | Lambda | 2 GB memory, 5 min timeout, WASM grammars bundled |
| `EmbedFn` | Lambda | 1 GB memory, 5 min timeout |
| `PersistFn` | Lambda | 1 GB memory, 2 min timeout |
| `ApiFn` | Lambda | 1 GB memory, 30 s timeout, all HTTP handlers |
| `Api` | API Gateway HTTP API | Cheaper and simpler than REST API; CORS open for the demo |
| `McpService` | App Runner | The only always-on component, for SSE |

**Deployed this weekend:** `IndexStateMachine` and the four pipeline functions were dropped for one `IndexFn` (3 GB memory, 15-minute timeout, 2 GB ephemeral storage) that runs the whole pipeline in a single invocation, started asynchronously by `ApiFn`. The reasons and trade-offs are in `01-BACKEND.md`, "Indexing pipeline". The sizing notes below apply to `IndexFn` as they would have to `CloneFn`.

### Lambda sizing notes

**CloneFn needs ephemeral storage raised.** Default `/tmp` is 512 MB, which a mid-size repo with history will exceed. Set `EphemeralStorage: 2048`. Fail loudly if a clone exceeds it rather than silently truncating.

**Memory is also CPU.** Lambda allocates CPU proportionally to memory, so 3 GB on CloneFn is about clone and IO speed, not about memory use. Parsing is CPU-bound and benefits the same way.

**ApiFn holds all handlers.** One function with internal routing rather than seven functions. Fewer cold starts, one deploy, simpler permissions. At this scale there is no reason to split.

### Step Functions shape

```yaml
RegisterJob -> Clone -> ParseMap -> EmbedMap -> Persist
```

ParseMap and EmbedMap are Map states with `MaxConcurrency: 10`. Each has a Retry block: 2 attempts, exponential backoff, and a Catch that routes to a `MarkFailed` state recording which stage broke and why.

Use a Standard workflow, not Express. Execution history is visible in the console, which is worth a great deal when debugging at 2am, and the execution volume here is tiny.

### Frontend hosting

Amplify Hosting connected to the GitHub repo, building from `packages/web`. Auto-deploy on push to main. The live URL is the Ship It deliverable, so set this up on Thursday, not Sunday.

## IAM

SAM policy templates cover most of this. Write them in the template from the start rather than debugging AccessDenied later.

| Function | Needs |
| --- | --- |
| `CloneFn` | S3 write to RepoBucket, DynamoDB write to DuneTable |
| `ParseFn` | S3 read, DynamoDB read and write |
| `EmbedFn` | DynamoDB read and write, `bedrock:InvokeModel` on the embedding model |
| `PersistFn` | DynamoDB read and write |
| `ApiFn` | DynamoDB read and write, `bedrock:InvokeModel`, `states:StartExecution` |
| `McpService` | Nothing AWS-side; it calls the public HTTP API |
| State machine role | `lambda:InvokeFunction` on the four pipeline functions |

### The Bedrock permission that trips people up

Global cross-Region inference means the request may be served from another region. The IAM policy resource must cover the inference profile, not just a regional model ARN. Grant broadly during the hackathon:

```yaml
- Effect: Allow
  Action:
    - bedrock:InvokeModel
    - bedrock:InvokeModelWithResponseStream
  Resource: "*"
```

A wildcard is not production practice and would be wrong in a real deployment. It is the right call for a four-day build, and saying so out loud in the demo is better than pretending it is fine. Judges respect a team that knows which corners it cut and why.

### CORS

HTTP API with `AllowOrigins: "*"` for the weekend. The frontend and API are on different domains and time spent on origin configuration is time not spent on the product.

### Secrets

The generation API keys: Gemini's (the default provider) and, optionally, Groq's. They live in the gitignored `.env`, reach the stack as `NoEcho` CloudFormation parameters through `npm run deploy`, and become environment variables on `ApiFn`. Only the selected provider's key is required; a template rule refuses a deploy without it. It is never committed and never appears in the template, `samconfig.toml` or deploy output. It is visible in the Lambda console to anyone who can read the function's configuration; SSM Parameter Store with a SecureString is the stronger option if that matters. Everything else — DynamoDB, S3, Bedrock if it arrives — runs on IAM roles with no keys at all.

## Deployment

### Commands

```bash
cd infra
sam build
sam deploy --guided        # first time only, saves samconfig.toml
sam deploy                 # every time after
```

First run asks for stack name (`dune`), region (`ap-south-1`), and confirms IAM capability. Commit `samconfig.toml` so all three people deploy identically.

### Environments

One environment. There is no staging this weekend and setting one up would cost hours for no benefit at this scale.

Run locally with `sam local start-api` while building; deploy when something is ready for the team to see.

### Frontend deployment

Amplify Hosting builds from the repo on push to main. Set `VITE_API_URL` in the Amplify environment variables to the deployed API Gateway URL, and `VITE_USE_MOCKS` to false.

The API URL appears in the SAM deploy outputs. Wire it up on Thursday during the hello-world deploy so the pipeline is proven end to end before it matters.

### MCP service deployment

App Runner from the same repo, a separate service pointing at `packages/mcp`. Auto-deploy on push. Only set this up once the MCP server is actually being built; do not leave an idle service running from Thursday for no reason.

### Pre-indexing the demo repo

Run `npm run seed-demo-repo` against the deployed stack once everything is working. This means the sample repo link on screen one is instant, which is what the demo video uses and what a judge clicking around will hit first.

Re-run it after any change to the parser or chunking, or the cached index will not match the current code.

### Saturday evening deploy

Deploy is a Saturday evening task, not a Sunday one. Budget two hours and expect to use one. The failure mode this protects against is discovering an IAM or region problem at midday Sunday with a video still to record.

## Known gotchas

Things that reliably eat hours. Read this before hitting them, not after.

**Bedrock model id prefix.** Bedrock is optional this weekend and our access is blocked pending a support case, so this and the gotcha below only bite once access arrives. Claude from India goes through global inference profiles. `global.anthropic.claude-sonnet-4-6`, not `anthropic.claude-sonnet-4-6`. A plain regional id fails and the error is not obvious.

**Bedrock model access is a separate step from IAM.** Correct IAM permissions still fail if model access has not been granted in the console. Two different things, both required.

**Lambda `/tmp` default is 512 MB.** A git clone will exceed it. Raise `EphemeralStorage` in the template.

**tree-sitter native bindings do not build for Lambda easily.** Use `web-tree-sitter` with WASM grammars and bundle the `.wasm` files. This decision is already made in the backend spec; do not relitigate it at 1am.

**DynamoDB item limit is 400 KB.** The graph and vector blobs will exceed it on a real repo. Shard from day one rather than discovering this when a large repo is indexed on Saturday.

**Step Functions payload limit is 256 KB.** Pass S3 keys and DynamoDB references between states, never the data itself.

**API Gateway HTTP API timeout is 30 seconds, hard.** A query taking longer returns a gateway error regardless of the Lambda timeout. Keep queries well inside it; if generation is slow, use a faster model rather than trying to raise the limit.

**Amplify build needs the right base directory** for a monorepo. Set it to the web package explicitly or the build runs at the root and fails confusingly.

**App Runner takes several minutes per deploy.** Do not treat it as a fast iteration loop. Develop the MCP server locally, deploy once.

**CloudWatch logs are the only debugging tool** for a deployed Lambda. Log the inputs and outputs of each pipeline step from the start. Adding logging after something breaks means deploying again to see anything.

**Cold starts on a 3 GB Lambda are a few seconds.** The first query of a demo will be slower than the rest. Warm it with a request right before recording.

### The meta-gotcha

Most of these are discovered at the worst possible time, which is why Thursday hour one exists. Hitting a 512 MB `/tmp` limit on Thursday is an annoyance. Hitting it on Saturday night is a lost feature.

## Submission checklist

Sunday. Work through in order and submit early, not at the deadline.

### The build

- Live URL working, tested from a phone hotspot to confirm it is not only working on one machine
- Demo repo pre-indexed and the sample link instant
- Every error path deliberately triggered and checked: bad URL, killed network mid-query, missing file
- Lambda warmed right before recording
- Ten eval questions re-run and the pass rate recorded

### The video

- Three minutes, no longer
- Follows the script in the PRD
- Shows the architecture for about thirty seconds near the end
- States what the product does not do
- Says what the team learned, since learning is scored separately
- Uploaded and the link tested in a private window

### The blog

Published on AWS Builder Center and linked in the submission. Top 5 blogs win a Logitech keyboard, it is a separate prize, and the same work is already done: the problem, the stack, what fought back.

The gotchas section above is most of a blog post already. Write what went wrong, not a polished marketing piece; that is what gets read.

### The repo

- Public
- README explaining what it is, how to run it, and the architecture
- All five docs in `docs/`, since the specs themselves show engineering seriousness
- No AWS credentials committed, checked properly rather than assumed

### The submission form

- Project title and description
- Live URL
- Repo link
- Video link
- Blog link
- Team members listed correctly

### Last thing

Read the submission form early, Saturday at the latest. Discovering it needs something unexpected an hour before the deadline is an avoidable way to lose.
