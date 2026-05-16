import { StateGraph,START,END , }  from "@langchain/langgraph"
import { Ollama } from "@langchain/ollama"
import * as z from "zod";
import { getQwenEmbedding, searchDocuments } from "../embeddings";
import prisma from "../../prismaClient";
import { Octokit } from "@octokit/rest";
import {Annotation} from "@langchain/langgraph"

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
interface DiffChunk {
    file: string;
    patch: string;
    fullFunction: string;   // fetched separately via contents API
    functionName: string;
    lineStart: number;
}

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

// ─── LLM setup ───────────────────────────────────────────────────────────────
const llm = new Ollama({
    model: "mistral",
    baseUrl: "http://127.0.0.1:11434",
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
 * Parses a unified diff patch string and returns the changed line numbers.
 * e.g. "@@ -12,7 +12,10 @@" → lines 12–21 in the new file
 */
function parseChangedLines(patch: string): number[] {
    const lines: number[] = [];
    let currentLine = 0;
    for (const line of patch.split("\n")) {
        const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
        if (hunk) {
            currentLine = parseInt(hunk[1], 10);
            continue;
        }
        if (line.startsWith("-")) continue; // deleted line, no new-file number
        if (line.startsWith("+") || !line.startsWith("\\")) {
            lines.push(currentLine++);
        }
    }
    return lines;
}

/**
 * Fetches the full file content at headSha and extracts the function that
 * contains the changed lines. Falls back to the raw patch if tree-sitter
 * isn't available yet.
 */
async function fetchFullFunction(
    owner: string,
    repo: string,
    filePath: string,
    headSha: string,
    changedLines: number[]
): Promise<{ fullFunction: string; functionName: string; lineStart: number }> {
    try {
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: filePath,
            ref: headSha,
        }) as { data: { content: string } };

        const content = Buffer.from(data.content, "base64").toString("utf-8");
        const allLines = content.split("\n");
        const targetLine = changedLines[0] ?? 1;

        // Simple heuristic: walk backwards from first changed line to find
        // the function signature, walk forwards to find closing brace.
        // Replace with tree-sitter for production accuracy.
        let start = Math.max(0, targetLine - 1);
        while (start > 0 && !/^\s*(async\s+)?function|^\s*(export\s+)?(async\s+)?(function|\w+\s*[=(])/.test(allLines[start])) {
            start--;
        }
        let end = targetLine;
        let depth = 0;
        for (let i = start; i < allLines.length; i++) {
            depth += (allLines[i].match(/{/g) || []).length;
            depth -= (allLines[i].match(/}/g) || []).length;
            if (depth <= 0 && i >= targetLine) { end = i; break; }
        }

        const slice = allLines.slice(start, end + 1).join("\n");
        const nameMatch = slice.match(/function\s+(\w+)|(\w+)\s*[=(]/);
        return {
            fullFunction: slice,
            functionName: nameMatch?.[1] ?? nameMatch?.[2] ?? "unknown",
            lineStart: start + 1,
        };
    } catch {
        // Fallback — just return the patch itself
        return { fullFunction: "", functionName: "unknown", lineStart: changedLines[0] ?? 0 };
    }
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

    const chunksBlock = chunks.map(c =>
        `### ${c.file}${c.functionName !== "unknown" ? ` — ${c.functionName}` : ""}` +
        (c.fullFunction ? `\nFull function:\n\`\`\`\n${c.fullFunction}\n\`\`\`` : "") +
        `\nDiff:\n\`\`\`diff\n${c.patch}\n\`\`\``
    ).join("\n\n");

    return `
You are a senior code reviewer with deep knowledge of this specific repository.

## Known conventions for this repo:
${conventionBlock}

## Relevant codebase context (similar existing code):
${context || "No context retrieved."}

## Changed code to review:
${chunksBlock}

Review the diff above. Be specific — reference actual patterns from the context.
Your response must be a single JSON object matching this schema exactly (no extra text, no markdown fences):
{
  "issues": [
    {
      "type": "bug" | "style" | "security" | "performance",
      "severity": "critical" | "major" | "minor",
      "file": "<filename>",
      "line": <number>,
      "message": "<what is wrong>",
      "suggestion": "<how to fix it>"
    }
  ],
  "summary": "<overall review summary>",
  "conventions_learned": ["<new pattern observed>"]
}
`.trim();
}

// ─── Node 1: parseDiff ────────────────────────────────────────────────────────
async function parseDiffNode(state: ReviewStateType) {
    const { owner, repo } = parseRepo(state.repo);

    // Fetch list of changed files for this PR
    const { data: files } = await octokit.pulls.listFiles({
        owner,
        repo,
        pull_number: state.prNumber,
    });

    const diffChunks: DiffChunk[] = [];

    for (const file of files) {
        // Skip binary files and deletions with no patch
        if (!file.patch) continue;

        const changedLines = parseChangedLines(file.patch);
        const { fullFunction, functionName, lineStart } = await fetchFullFunction(
            owner,
            repo,
            file.filename,
            state.headSha,
            changedLines
        );

        diffChunks.push({
            file: file.filename,
            patch: file.patch,
            fullFunction,
            functionName,
            lineStart,
        });
    }

    return { diffChunks };
}

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

// ─── Node 3: generateReview ───────────────────────────────────────────────────
async function generateReviewNode(state: ReviewStateType) {
    const prompt = buildReviewPrompt(
        state.diffChunks,
        state.retrievedContext,
        state.conventions
    );

    const reviewOutput = await callLLMWithRetry(prompt);
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
    .addNode("parseDiff", parseDiffNode)
    .addNode("retrieveContext", retrieveContextNode)
    .addNode("generateReview", generateReviewNode)
    .addNode("postComment", postCommentNode)
    .addNode("updateMemory", updateMemoryNode)
    .addEdge(START, "parseDiff")
    .addEdge("parseDiff", "retrieveContext")
    .addEdge("retrieveContext", "generateReview")
    .addEdge("generateReview", "postComment")
    .addEdge("postComment", "updateMemory")
    .addEdge("updateMemory", END)
    .compile();

// ─── Export: call this from your BullMQ worker ────────────────────────────────
export async function runReviewAgent(params: {
    prNumber: number;
    repo: string;   // "owner/reponame"
    headSha: string;
}) {
    const result = await graph.invoke({
        prNumber: params.prNumber,
        repo: params.repo,
        headSha: params.headSha,
    });

    return result;
}