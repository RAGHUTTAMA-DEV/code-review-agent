import { Octokit } from "octokit";

export async function fetchDiff(octokit: Octokit, owner: string, repo: string, pull_number: number) {
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: {
      format: "diff",
    },
  });
  return data as unknown as string;
}

export async function fetchFileContent(octokit: Octokit, owner: string, repo: string, path: string, ref: string) {
  const { data } = await octokit.rest.repos.getContent({
    owner,
    repo,
    path,
    ref,
  });
  
  if (Array.isArray(data) || data.type !== "file") {
    throw new Error("Path is not a file");
  }
  
  return Buffer.from(data.content, "base64").toString("utf-8");
}
