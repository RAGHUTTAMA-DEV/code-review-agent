import { StateGraph,START,END , }  from "@langchain/langgraph"
import { Ollama } from "@langchain/ollama"
import * as z from "zod";
import { getQwenEmbedding, searchDocuments } from "../embeddings";
import prisma from "../../prismaClient";
import { Octokit } from "@octokit/rest";
import {Annotation} from "@langchain/langgraph"
import { DiffChunk } from "../github/processPR";

// ─── LangGraph State (Annotation, NOT Zod schema) ──────────────────────────
const ReviewState = Annotation.Root({
    prNumber: Annotation<number>(),
    repo: Annotation<string>(),   // "owner/reponame"
    headSha: Annotation<string>(),
    diffChunks: Annotation<DiffChunk[]>({ value: (_, n) => n, default: () => [] }),
    retrievedContext: Annotation<string>({ value: (_, n) => n, default: () => "" }),
    conventions: Annotation<ConventionRow[]>({ value: (_, n) => n, default: () => [] }),
    reviewOutput: Annotation<ReviewOutput | null>({ value: (_, n) => n, default: () => null }),
    posted: Annotation<boolean>({ value: (_, n) => n, default: () => false }),
});

type ReviewStateType = typeof ReviewState.State;

// ─── Domain types ───────────────────────────────────────────────────────────
// DiffChunk is now imported from ../github/processPR

interface ConventionRow {
    description: string;
}

// ─── Structured output schema ────────────────────────────────────────────────
const ReviewSchema = z.object({
    issues: z.array(z.object({
        type: z.enum(["bug", "style", "security", "performance"]),
        severity: z.enum(["critical", "major", "minor"]),
        file: z.string(),
        line: z.number(),
        message: z.string(),
        suggestion: z.string(),
    })),
    summary: z.string(),
    conventions_learned: z.array(z.string()),
});

type ReviewOutput = z.infer<typeof ReviewSchema>;

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_CONTEXT_CHARS = 12000;   // max chars for the context window
const MAX_FUNCTION_CHARS = 3000;   // max chars per full function body
const MAX_PATCH_CHARS = 2000;      // max chars per diff patch
const MAX_RETRIEVED_CHARS = 3000;  // max chars for retrieved similar code

/**
 * Truncates text to a max character count, appending a notice if truncated.
 */
function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + "\n... [truncated]";
}

// ─── LLM setup ───────────────────────────────────────────────────────────────
const llm = new Ollama({
    model: "mistral",
    baseUrl: "http://127.0.0.1:11434",
    numCtx: 16384,  // increase context window from default 4096
});

// ─── GitHub client ────────────────────────────────────────────────────────────
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Splits "owner/repo" into { owner, repo }
 */
function parseRepo(repoFullName: string) {
    const [owner, repo] = repoFullName.split("/");
    return { owner, repo };
}

/**
 * Calls the LLM and parses the structured output.
 * Retries once if the JSON is invalid.
 */
async function callLLMWithRetry(prompt: string, retries = 1): Promise<ReviewOutput> {
    for (let attempt = 0; attempt <= retries; attempt++) {
        const raw = await llm.invoke(prompt);
        const text = typeof raw === "string" ? raw : (raw as any).content ?? "";

        // Strip markdown fences if the model wrapped it
        const clean = text.replace(/```json|```/g, "").trim();

        // Find the JSON object — some models add preamble text
        const jsonStart = clean.indexOf("{");
        const jsonEnd = clean.lastIndexOf("}");
        if (jsonStart === -1 || jsonEnd === -1) {
            if (attempt < retries) continue;
            throw new Error("LLM did not return valid JSON after retries");
        }

        const parsed = JSON.parse(clean.slice(jsonStart, jsonEnd + 1));
        const result = ReviewSchema.safeParse(parsed);
        if (result.success) return result.data;

        if (attempt < retries) {
            // Feed the validation error back so the model can fix it
            prompt += `\n\nYour last response failed validation: ${result.error.message}\nReturn corrected JSON only.`;
        } else {
            throw new Error(`LLM output schema mismatch: ${result.error.message}`);
        }
    }
    throw new Error("Unreachable");
}

// ─── Prompt builder ───────────────────────────────────────────────────────────
function buildReviewPrompt(
    chunks: DiffChunk[],
    context: string,
    conventions: ConventionRow[]
): string {
    const conventionBlock = conventions.length
        ? conventions.map(c => `- ${c.description}`).join("\n")
        : "No conventions recorded yet.";

    // Build a list of all valid file paths for the LLM to reference
    const validFiles = [...new Set(chunks.map(c => c.file))];
    const validFilesBlock = validFiles.map(f => `- ${f}`).join("\n");

    const chunksBlock = chunks.map(c =>
        `### ${c.file} (lines ${c.lineStart}–${c.lineEnd})${c.functionName !== "unknown" ? ` — function: ${c.functionName}` : ""}` +
        (c.fullFunction ? `\nFull function context:\n\`\`\`\n${truncate(c.fullFunction, MAX_FUNCTION_CHARS)}\n\`\`\`` : "") +
        `\nDiff patch:\n\`\`\`diff\n${truncate(c.patch, MAX_PATCH_CHARS)}\n\`\`\``
    ).join("\n\n");

    return `
You are a senior code reviewer. You MUST only review the actual code shown below.

CRITICAL RULES:
1. ONLY reference files that appear in the "Changed code" section below. The ONLY valid files are:
${validFilesBlock}
2. ONLY reference line numbers that exist in the diff patches shown below.
3. Do NOT invent or hallucinate filenames, line numbers, or issues.
4. Do NOT generate generic advice. Every issue MUST point to a specific line in the actual diff.
5. If the code looks fine and has no real issues, return an empty issues array — that is perfectly acceptable.
6. Focus on bugs, security issues, and performance problems. Minor style nitpicks are NOT useful unless they clearly violate the repo's conventions listed below.

## Known conventions for this repo:
${conventionBlock}

## Relevant codebase context (similar existing code):
${truncate(context, MAX_RETRIEVED_CHARS) || "No context retrieved."}

## Changed code to review:
${chunksBlock}

Respond with a SINGLE JSON object (no markdown fences, no extra text):
{
  "issues": [
    {
      "type": "bug" | "style" | "security" | "performance",
      "severity": "critical" | "major" | "minor",
      "file": "<must be one of the files listed above>",
      "line": <must be a line number from the diff above>,
      "message": "<specific description of the problem>",
      "suggestion": "<concrete fix with code if possible>"
    }
  ],
  "summary": "<brief summary of review findings>",
  "conventions_learned": ["<new patterns observed in THIS code, if any>"]
}
`.trim();
}

// ─── Node 1 was parseDiff — REMOVED (chunks are now passed in from worker) ──

// ─── Node 2: retrieveContext ──────────────────────────────────────────────────
async function retrieveContextNode(state: ReviewStateType) {
    const contextParts: string[] = [];

    for (const chunk of state.diffChunks) {
        // Embed the patch (not the full function — patch captures what changed)
        const embedding = await getQwenEmbedding(chunk.patch);
        const similar = await searchDocuments(embedding, 5);

        if (similar.length) {
            contextParts.push(
                ...similar.map((doc: any) =>
                    `### ${doc.file_path}\n\`\`\`\n${doc.content}\n\`\`\``
                )
            );
        }
    }

    const conventions = await prisma.convention.findMany({
        where: { repo: state.repo },
        orderBy: { createdAt: "desc" },
        take: 20,
    });

    return {
        retrievedContext: contextParts.join("\n\n"),
        conventions,
    };
}

// ─── Node 2: generateReview ───────────────────────────────────────────────────
async function generateReviewNode(state: ReviewStateType) {
    // Short-circuit: if there are no diff chunks, skip the LLM call entirely
    if (state.diffChunks.length === 0) {
        console.log("No diff chunks to review — skipping LLM call.");
        return {
            reviewOutput: {
                issues: [],
                summary: "No reviewable code changes found in this PR.",
                conventions_learned: [],
            },
        };
    }

    const prompt = buildReviewPrompt(
        state.diffChunks,
        state.retrievedContext,
        state.conventions
    );

    console.log("=== REVIEW PROMPT (first 500 chars) ===");
    console.log(prompt.slice(0, 500));
    console.log("========================================");

    const reviewOutput = await callLLMWithRetry(prompt);

    // Post-process: filter out any hallucinated files the LLM might still sneak in
    const validFiles = new Set(state.diffChunks.map(c => c.file));
    reviewOutput.issues = reviewOutput.issues.filter(issue => {
        if (!validFiles.has(issue.file)) {
            console.warn(`Filtered out hallucinated file reference: ${issue.file}`);
            return false;
        }
        return true;
    });

    return { reviewOutput };
}

// ─── Node 4: postComment ──────────────────────────────────────────────────────
async function postCommentNode(state: ReviewStateType) {
    const { reviewOutput, repo, prNumber } = state;
    if (!reviewOutput) return { posted: false };

    const { owner, repo: repoName } = parseRepo(repo);

    // Group issues by severity
    const critical = reviewOutput.issues.filter(i => i.severity === "critical");
    const major = reviewOutput.issues.filter(i => i.severity === "major");
    const minor = reviewOutput.issues.filter(i => i.severity === "minor");

    const formatIssues = (issues: typeof reviewOutput.issues) =>
        issues.map(i =>
            `**\`${i.file}:${i.line}\`** · \`${i.type}\`\n` +
            `> ${i.message}\n\n` +
            `**Fix:** ${i.suggestion}`
        ).join("\n\n---\n\n");

    let body = `## 🤖 AI Code Review\n\n${reviewOutput.summary}\n\n`;

    if (critical.length) {
        body += `<details open>\n<summary>🚨 Critical (${critical.length})</summary>\n\n${formatIssues(critical)}\n\n</details>\n\n`;
    }
    if (major.length) {
        body += `<details open>\n<summary>⚠️ Major (${major.length})</summary>\n\n${formatIssues(major)}\n\n</details>\n\n`;
    }
    if (minor.length) {
        body += `<details>\n<summary>💡 Minor (${minor.length})</summary>\n\n${formatIssues(minor)}\n\n</details>\n\n`;
    }
    if (!reviewOutput.issues.length) {
        body += `✅ No issues found.\n`;
    }

    await octokit.issues.createComment({
        owner: owner,
        repo: repoName,
        issue_number: prNumber,
        body,
    });

    return { posted: true };
}

// ─── Node 5: updateMemory ─────────────────────────────────────────────────────
async function updateMemoryNode(state: ReviewStateType) {
    const { reviewOutput, repo, prNumber, headSha } = state;
    if (!reviewOutput) return {};

    // Embed and store each new convention
    for (const convention of reviewOutput.conventions_learned) {
        const embedding = await getQwenEmbedding(convention);
        await prisma.convention.create({
            data: {
                repo,
                description: convention,
                sourcePr: prNumber,
            },
        });
    }

    // Store the full review record
    await prisma.review.create({
        data: {
            repo,
            headSha,
            prNumber,
            issues: JSON.stringify(reviewOutput.issues),
            summary: reviewOutput.summary,
        },
    });

    return {};
}

// ─── Graph assembly ───────────────────────────────────────────────────────────
const graph = new StateGraph(ReviewState)
    .addNode("retrieveContext", retrieveContextNode)
    .addNode("generateReview", generateReviewNode)
    .addNode("postComment", postCommentNode)
    .addNode("updateMemory", updateMemoryNode)
    .addEdge(START, "retrieveContext")
    .addEdge("retrieveContext", "generateReview")
    .addEdge("generateReview", "postComment")
    .addEdge("postComment", "updateMemory")
    .addEdge("updateMemory", END)
    .compile();

// ─── Export: call this from your BullMQ worker ────────────────────────────────
export async function runReviewAgent(params: {
    prNumber: number;
    repo: string;       // "owner/reponame"
    headSha: string;
    diffChunks: DiffChunk[];  // pre-parsed by processPRDiff
}) {
    console.log(`Running review agent with ${params.diffChunks.length} diff chunks`);

    const result = await graph.invoke({
        prNumber: params.prNumber,
        repo: params.repo,
        headSha: params.headSha,
        diffChunks: params.diffChunks,
    });

    return result;
}