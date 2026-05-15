# Code Review Agent — Full Project Reference

> **Stack:** LangGraph + pgvector + BullMQ + GitHub API + Node.js  
> **Timeline:** 2–3 weeks  
> **Goal:** A webhook-driven agent that reviews every PR with repo-aware context and gets smarter across PRs.

---

## What This System Does

- GitHub fires a webhook on every PR open/update
- A Node.js endpoint validates and enqueues an async job (BullMQ)
- A worker picks up the job, fetches the diff from GitHub API
- A LangGraph agent parses the diff → retrieves relevant codebase context via pgvector (RAG) → calls an LLM → returns structured JSON output
- The agent posts a formatted review comment directly on the PR
- What it learns (bugs found, conventions enforced) gets embedded back into pgvector — so PR #50 benefits from everything learned in PRs #1–49

---

## Prerequisites — Understand These First

### 1. Node.js Async Fundamentals
The webhook handler must never block. If your agent call blocks the event loop, you miss subsequent webhooks. Know: async/await, event loop, why CPU-bound work belongs in a queue worker, not the HTTP handler.

### 2. How LangGraph Works
LangGraph is a state machine, not just "LLM + tools." Core concepts:

- **StateGraph** — defines the graph. Each node gets the current state and returns an updated state.
- **Nodes** — async functions: `parseDiff`, `retrieveContext`, `generateReview`, `postComment`, `updateMemory`
- **Edges** — wired between nodes. Can be conditional (e.g. skip comment if no issues found)
- **Checkpointers** — persist state between invocations. This is how memory crosses PR boundaries.

```js
const graph = new StateGraph(ReviewState)
  .addNode("parseDiff", parseDiffNode)
  .addNode("retrieveContext", retrieveContextNode)
  .addNode("generateReview", generateReviewNode)
  .addNode("postComment", postCommentNode)
  .addNode("updateMemory", updateMemoryNode)
  .addEdge("parseDiff", "retrieveContext")
  .addEdge("retrieveContext", "generateReview")
  .addEdge("generateReview", "postComment")
  .addEdge("postComment", "updateMemory")
  .compile();
```

### 3. pgvector — How Embeddings Work
pgvector is a Postgres extension that adds a `vector` column type and similarity search.

An embedding model takes a string and returns a float array (e.g. 1536 dimensions for OpenAI `text-embedding-3-small`). Semantically similar strings produce vectors that are "close" in that space.

```sql
-- Install extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Store chunks with embeddings
CREATE TABLE chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  embedding VECTOR(1536),
  file_path TEXT,
  repo TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Retrieve similar chunks (cosine similarity)
SELECT content, file_path, 1 - (embedding <=> $1) AS similarity
FROM chunks
WHERE repo = $2
ORDER BY embedding <=> $1
LIMIT 5;
```

### 4. BullMQ Mental Model
- **Producer** (webhook handler) — enqueues a job (just a JSON object)
- **Worker** (agent runner) — picks up jobs, processes them, marks done or failed
- **Redis** — the message broker between them
- Jobs survive restarts, can retry on failure, can be delayed

```js
// Producer (webhook handler)
const queue = new Queue('pr-reviews', { connection: redis });
await queue.add('review', { prNumber, repo, headSha });

// Worker (agent runner)
const worker = new Worker('pr-reviews', async (job) => {
  await runReviewAgent(job.data);
}, { connection: redis });
```

### 5. GitHub API — Key Endpoints

| Purpose | Method | Endpoint |
|---|---|---|
| Get changed files + diff | GET | `/repos/{owner}/{repo}/pulls/{pull_number}/files` |
| Get full file content | GET | `/repos/{owner}/{repo}/contents/{path}?ref={sha}` |
| Post PR comment | POST | `/repos/{owner}/{repo}/issues/{number}/comments` |
| Verify webhook | — | `x-hub-signature-256` header, HMAC-SHA256 |

The `patch` field on each file object is the raw unified diff. It only includes ~3 lines of context around each change — often not enough for a meaningful review. Fetch the full file separately when you need the complete function.

### 6. Structured LLM Output
Instead of freeform text, force the model to return a specific JSON schema. Use Zod to validate.

```js
// Define schema
const ReviewSchema = z.object({
  issues: z.array(z.object({
    type: z.enum(['bug', 'style', 'security', 'performance']),
    severity: z.enum(['critical', 'major', 'minor']),
    file: z.string(),
    line: z.number(),
    message: z.string(),
    suggestion: z.string()
  })),
  summary: z.string(),
  conventions_learned: z.array(z.string())
});

// With OpenAI structured outputs
const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  response_format: { type: 'json_schema', json_schema: ReviewSchema },
  messages: [...]
});
```

---

## Full Architecture

```
GitHub PR (opened / updated)
        │
        ▼
Webhook endpoint  ──────────────────────────────────── validate HMAC-SHA256
(Node.js / Express)
        │
        ▼ enqueue job
  ┌─────────────┐
  │   BullMQ    │  ← Redis-backed async queue
  └─────────────┘
        │
        ▼ worker picks up job
  ┌─────────────────────────────────────────────────┐
  │                LangGraph Agent                  │
  │                                                 │
  │  parseDiff → retrieveContext → generateReview   │
  │                    ↑                  │         │
  │               pgvector RAG       JSON schema    │
  └─────────────────────────────────────────────────┘
        │                    │
        ▼                    ▼
  updateMemory        postComment
  (embed + store)     (GitHub API)
        │
        ▼
  pgvector store
  ┌─────────────┐  ┌──────────────────┐  ┌──────────────────┐
  │  Codebase   │  │ Convention store │  │  Pattern memory  │
  │  embeddings │  │ repo rules, past │  │  PR #1 → PR #50  │
  │             │  │ reviews          │  │                  │
  └─────────────┘  └──────────────────┘  └──────────────────┘
```

---

## Database Schema

```sql
-- Codebase chunks (embed on initial index, re-index on main merge)
CREATE TABLE chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  embedding VECTOR(1536),
  file_path TEXT NOT NULL,
  repo TEXT NOT NULL,
  chunk_type TEXT, -- 'function', 'class', 'module'
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Learned conventions (written after each review)
CREATE TABLE conventions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo TEXT NOT NULL,
  description TEXT NOT NULL,
  embedding VECTOR(1536),
  source_pr INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Review history (for tracking what was posted)
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  issues JSONB,
  summary TEXT,
  posted_at TIMESTAMPTZ DEFAULT NOW(),
  pr_outcome TEXT -- 'merged', 'closed', 'open'
);

-- Indexes for fast similarity search
CREATE INDEX ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX ON conventions USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

---

## Build Order (Week by Week)

### Week 1 — Foundation

**Days 1–2: Webhook + Queue**
1. Express server with `/webhook` POST endpoint
2. Verify `x-hub-signature-256` header using HMAC-SHA256
3. Parse payload → extract `pr_number`, `repo`, `head_sha`, `action`
4. Enqueue BullMQ job with that data
5. Worker skeleton that just logs "got job"
6. Test end-to-end with `ngrok` — make GitHub actually send events

```js
// Webhook signature verification
import { createHmac, timingSafeEqual } from 'crypto';

function verifySignature(payload, signature, secret) {
  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

**Days 3–4: GitHub Diff Fetching**
1. In the worker, call `GET /pulls/{pr}/files` using Octokit
2. Parse raw unified diff with `parse-diff` npm package
3. For each changed file, also fetch full file content via contents API
4. Extract function boundaries using tree-sitter (map changed lines → enclosing function)
5. Structure into `DiffChunk[]` objects: `{ file, functionName, patch, fullFunction, lineStart, lineEnd }`

**Days 5–7: pgvector + Embeddings Setup**
1. `CREATE EXTENSION vector` in Postgres
2. Create `chunks` and `conventions` tables (schema above)
3. Write `embedText(text: string): Promise<number[]>` using OpenAI embeddings API
4. Write `storeChunk(chunk)` and `retrieveSimilar(embedding, repo, limit)` functions
5. **Seed it**: embed 20–30 real files from a repo, insert them, run a manual similarity query
6. The moment you see the right files come back — that's when RAG clicks

---

### Week 2 — The Agent Brain

**Days 8–10: LangGraph Agent**

Define state and wire the graph:

```js
const ReviewState = Annotation.Root({
  repo: Annotation<string>(),
  prNumber: Annotation<number>(),
  diffChunks: Annotation<DiffChunk[]>(),
  retrievedContext: Annotation<ContextChunk[]>(),
  reviewOutput: Annotation<ReviewOutput>(),
  posted: Annotation<boolean>()
});

// parseDiff node
async function parseDiffNode(state) {
  const files = await fetchPRFiles(state.repo, state.prNumber);
  const chunks = parseAndChunk(files);
  return { diffChunks: chunks };
}

// retrieveContext node
async function retrieveContextNode(state) {
  const contexts = [];
  for (const chunk of state.diffChunks) {
    const embedding = await embedText(chunk.patch);
    const similar = await retrieveSimilar(embedding, state.repo, 5);
    contexts.push({ chunk, similar });
  }
  return { retrievedContext: contexts };
}
```

**Days 11–12: Structured Review Output**

Full JSON schema for review output:

```js
const ReviewSchema = z.object({
  issues: z.array(z.object({
    type: z.enum(['bug', 'style', 'security', 'performance']),
    severity: z.enum(['critical', 'major', 'minor']),
    file: z.string(),
    line: z.number(),
    message: z.string(),
    suggestion: z.string(),
    context: z.string().optional() // why this is an issue given the codebase
  })),
  summary: z.string(),
  conventions_learned: z.array(z.string()),
  approved: z.boolean()
});
```

Build the prompt with retrieved context:

```js
function buildReviewPrompt(chunks, context, conventions) {
  return `
You are a senior code reviewer for this specific repository.

## Known conventions for this repo:
${conventions.map(c => `- ${c.description}`).join('\n')}

## Relevant codebase context:
${context.map(c => `### ${c.file_path}\n\`\`\`\n${c.content}\n\`\`\``).join('\n\n')}

## Changed code to review:
${chunks.map(c => `### ${c.file} (${c.functionName})\n\`\`\`diff\n${c.patch}\n\`\`\``).join('\n\n')}

Review this diff. Be specific to this codebase. Reference actual patterns you see in the context above.
Return structured JSON only.
  `;
}
```

**Days 13–14: Memory Persistence**

After each review, embed `conventions_learned` and store them:

```js
async function updateMemoryNode(state) {
  const { reviewOutput, repo, prNumber } = state;

  // Store new conventions
  for (const convention of reviewOutput.conventions_learned) {
    const embedding = await embedText(convention);
    await db.query(
      'INSERT INTO conventions (repo, description, embedding, source_pr) VALUES ($1, $2, $3, $4)',
      [repo, convention, JSON.stringify(embedding), prNumber]
    );
  }

  // Store review record
  await db.query(
    'INSERT INTO reviews (repo, pr_number, issues, summary) VALUES ($1, $2, $3, $4)',
    [repo, prNumber, JSON.stringify(reviewOutput.issues), reviewOutput.summary]
  );
}
```

---

### Week 3 — Making It Real

**Days 15–17: GitHub Comment Formatting**

Format the JSON output as a clean GitHub markdown comment:

```js
function formatReviewComment(review) {
  const bySeverity = {
    critical: review.issues.filter(i => i.severity === 'critical'),
    major: review.issues.filter(i => i.severity === 'major'),
    minor: review.issues.filter(i => i.severity === 'minor'),
  };

  let comment = `## 🤖 AI Code Review\n\n${review.summary}\n\n`;

  if (bySeverity.critical.length) {
    comment += `<details open>\n<summary>🚨 Critical Issues (${bySeverity.critical.length})</summary>\n\n`;
    for (const issue of bySeverity.critical) {
      comment += `**${issue.file}:${issue.line}** — \`${issue.type}\`\n`;
      comment += `> ${issue.message}\n\n`;
      comment += `**Suggestion:** ${issue.suggestion}\n\n---\n`;
    }
    comment += `</details>\n\n`;
  }

  // repeat for major, minor...
  return comment;
}
```

**Days 18–19: Codebase Indexing Pipeline**

One-time script to seed pgvector with the full repo:

```js
async function indexRepository(repoPath, repoName) {
  const files = await walkDirectory(repoPath, ['.ts', '.js', '.py']);

  for (const filePath of files) {
    const content = await fs.readFile(filePath, 'utf-8');
    // Use tree-sitter to extract functions
    const functions = extractFunctions(content, filePath);

    for (const fn of functions) {
      const embedding = await embedText(fn.content);
      await storeChunk({
        content: fn.content,
        embedding,
        file_path: fn.filePath,
        repo: repoName,
        chunk_type: 'function',
        metadata: { name: fn.name, lines: fn.lines }
      });
    }
  }
}
```

Re-index trigger: add a BullMQ job when a PR is merged into main.

**Days 20–21: Robustness**
- BullMQ retry config: 3 attempts, exponential backoff
- Idempotency: store `{repo}:{pr_number}:{head_sha}` in Redis, skip if already processed
- Rate limiting: GitHub allows 5000 API req/hr — add a simple counter
- Structured logging: log retrieved context count, issue count, tokens used per review

---

## Key Design Decisions

**Chunking strategy** matters more than which LLM you pick. Chunk by function using tree-sitter, not by line count. A 200-line function is one unit of meaning. An arbitrary 200-line slice is not.

**Two separate memory tables** — `chunks` (what the codebase looks like) and `conventions` (what the team enforces). Different retrieval logic, different update triggers. Don't mix them.

**Full file > patch only** — the 3-line context in a diff patch is rarely enough. Always fetch the full enclosing function via the contents API. The extra API call is worth it.

**Webhook idempotency** — GitHub can send the same event twice (network retries, etc.). Cache `{repo}:{pr}:{sha}` in Redis with a 24-hour TTL, skip if already seen.

**Structured output validation** — never trust raw LLM JSON. Always parse with Zod. If it fails validation, retry the LLM call once with an error message asking it to fix the schema.

---

## GitHub Diff API — Full Reference

### Endpoint
```
GET /repos/{owner}/{repo}/pulls/{pull_number}/files
```

### Response per file
```json
{
  "filename": "src/auth/middleware.ts",
  "status": "modified",
  "additions": 12,
  "deletions": 3,
  "changes": 15,
  "sha": "abc123",
  "patch": "@@ -12,7 +12,10 @@ export async function authenticate...\n-  const token = ...\n+  const token = req.headers['authorization']?.split(' ')[1];",
  "blob_url": "https://github.com/...",
  "raw_url": "https://raw.githubusercontent.com/...",
  "contents_url": "https://api.github.com/repos/.../contents/src/auth/middleware.ts?ref=abc123"
}
```

### What it does NOT give you
- Full file content — only changed hunks + ~3 lines of context
- Binary files — no `patch` field
- Renamed identical files — no `patch`, just `previous_filename`

### Getting the full function (required for good reviews)
```js
// 1. Parse patch to get changed line numbers
const changedLines = parseHunkLines(file.patch);

// 2. Fetch full file
const { data } = await octokit.repos.getContent({
  owner, repo, path: file.filename, ref: headSha
});
const fullContent = Buffer.from(data.content, 'base64').toString();

// 3. Use tree-sitter to find the function containing those lines
const enclosingFunction = findEnclosingFunction(fullContent, changedLines, file.filename);
```

---

## npm Packages You'll Need

```json
{
  "dependencies": {
    "@langchain/langgraph": "latest",
    "@octokit/rest": "latest",
    "bullmq": "latest",
    "ioredis": "latest",
    "pg": "latest",
    "pgvector": "latest",
    "openai": "latest",
    "parse-diff": "latest",
    "tree-sitter": "latest",
    "zod": "latest",
    "express": "latest"
  }
}
```

---

## Environment Variables

```env
GITHUB_WEBHOOK_SECRET=your_webhook_secret
GITHUB_TOKEN=ghp_yourtoken
OPENAI_API_KEY=sk-...
DATABASE_URL=postgresql://user:pass@localhost:5432/codereview
REDIS_URL=redis://localhost:6379
```

---

## Testing Checklist

- [ ] Webhook receives event and enqueues job
- [ ] Duplicate events are skipped (idempotency)
- [ ] Diff is fetched and parsed into chunks
- [ ] Embeddings are generated and stored
- [ ] Similarity retrieval returns relevant files
- [ ] LLM returns valid JSON matching schema
- [ ] Comment is posted on the actual PR
- [ ] Conventions are stored after review
- [ ] PR #2 retrieves conventions from PR #1
- [ ] Worker retries on transient failures
- [ ] Re-index triggers on main merge
