import { Octokit } from "octokit";
import parseDiff from "parse-diff";
import { getEnclosingFunctions } from "./treeSitter";
import { fetchDiff, fetchFileContent } from "./fetchDiff";

export interface DiffChunk {
  file: string;
  functionName: string;
  patch: string;
  fullFunction: string;
  lineStart: number;
  lineEnd: number;
}

export async function processPRDiff(octokit: Octokit, owner: string, repo: string, prNumber: number, headSha: string): Promise<DiffChunk[]> {
    const rawDiff = await fetchDiff(octokit, owner, repo, prNumber);
    const files = parseDiff(rawDiff);
    
    const chunks: DiffChunk[] = [];
    
    for (const file of files) {
        if (file.deleted || file.from !== file.to && !file.to) continue;
        const filePath = file.to;
        if (!filePath) continue;
        
        // Find changed line numbers and gather patches
        const changedLines: number[] = [];
        let patchSnippet = "";
        
        for (const chunk of file.chunks) {
            for (const change of chunk.changes) {
                if (change.type === "add") changedLines.push(change.ln);
                if (change.type === "del") changedLines.push(change.ln);
            }
            patchSnippet += chunk.content + "\n";
            for (const change of chunk.changes) {
                patchSnippet += change.content + "\n";
            }
        }
        
        if (changedLines.length === 0) continue;
        
        // Fetch full file content
        let content = "";
        try {
            content = await fetchFileContent(octokit, owner, repo, filePath, headSha);
        } catch (e) {
            console.error(`Failed to fetch content for ${filePath}`, e);
            continue;
        }
        
        const functions = getEnclosingFunctions(content, filePath, changedLines);
        
        if (functions && functions.length > 0) {
            for (const func of functions) {
                chunks.push({
                    file: filePath,
                    functionName: func.name,
                    patch: patchSnippet,
                    fullFunction: func.content,
                    lineStart: func.startLine,
                    lineEnd: func.endLine
                });
            }
        } else {
            // Fallback if no function matched or tree-sitter couldn't parse
            chunks.push({
                file: filePath,
                functionName: "unknown",
                patch: patchSnippet,
                fullFunction: content, // fallback to whole file
                lineStart: 1,
                lineEnd: content.split("\n").length
            });
        }
    }
    
    return chunks;
}
