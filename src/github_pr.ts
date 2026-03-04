/**
 * GitHub PR creation handler
 * Creates a branch, updates a file, and opens a pull request via GitHub API
 */

import { createErrorResponse, createResponseHeaders } from './api';

type Handler = (request: Request, env: any, ctx?: any) => Promise<Response>;

export interface CreatePROptions {
  repository?: string;
  branchName: string;
  filePath: string;
  fileContent: any;
  commitMessage: string;
  prTitle: string;
  prBody: string;
}

export interface CreatePRResult {
  success: boolean;
  branch: string;
  file_path: string;
  commit_sha?: string;
  pr_url?: string;
  pr_number?: number;
  message?: string;
}

/**
 * Create a GitHub PR programmatically
 */
export async function createGitHubPR(
  env: any,
  options: CreatePROptions
): Promise<CreatePRResult> {
  const GITHUB_TOKEN = env.GH_TOKEN;
  if (!GITHUB_TOKEN) {
    throw new Error('GH_TOKEN environment variable is required');
  }

  const REPO = options.repository || "exergy-connect/real-estate-view";
  const apiBase = `https://api.github.com/repos/${REPO}`;

  // Get base branch from environment variable (default: main)
  const baseBranch = (env as any).GITHUB_BASE_BRANCH || 'main';

  // 1. Fetch the latest commit SHA from the base branch
  const mainRefResponse = await fetch(`${apiBase}/git/refs/heads/${baseBranch}`, {
    headers: { 
      'Authorization': `token ${GITHUB_TOKEN}`, 
      'User-Agent': 'Cloudflare-Worker',
      'Accept': 'application/vnd.github.v3+json'
    }
  });

  if (!mainRefResponse.ok) {
    const errorText = await mainRefResponse.text();
    throw new Error(`Failed to fetch base branch '${baseBranch}': ${mainRefResponse.status} ${errorText}`);
  }

  const mainRef = await mainRefResponse.json();
  const baseSha = mainRef.object.sha;

  // 2. Create a new branch
  const createBranchResponse = await fetch(`${apiBase}/git/refs`, {
    method: 'POST',
    headers: { 
      'Authorization': `token ${GITHUB_TOKEN}`, 
      'User-Agent': 'Cloudflare-Worker',
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      ref: `refs/heads/${options.branchName}`,
      sha: baseSha
    })
  });

  if (!createBranchResponse.ok) {
    const errorText = await createBranchResponse.text();
    // If branch already exists, try to use it
    if (createBranchResponse.status !== 422) {
      throw new Error(`Failed to create branch: ${createBranchResponse.status} ${errorText}`);
    }
  }

  // 3. Get the current file SHA if it exists (for updating)
  let currentFileSha: string | null = null;
  try {
    const getFileResponse = await fetch(`${apiBase}/contents/${options.filePath}?ref=${options.branchName}`, {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent': 'Cloudflare-Worker',
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    if (getFileResponse.ok) {
      const fileData = await getFileResponse.json();
      currentFileSha = fileData.sha;
    }
  } catch (e) {
    // File doesn't exist, will create new
  }

  // 4. Create or update the file
  const content = typeof options.fileContent === 'string' 
    ? btoa(options.fileContent)
    : btoa(JSON.stringify(options.fileContent, null, 2));
  
  const updateFileResponse = await fetch(`${apiBase}/contents/${options.filePath}`, {
    method: 'PUT',
    headers: { 
      'Authorization': `token ${GITHUB_TOKEN}`, 
      'User-Agent': 'Cloudflare-Worker',
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: options.commitMessage,
      content: content,
      branch: options.branchName,
      ...(currentFileSha ? { sha: currentFileSha } : {})
    })
  });

  if (!updateFileResponse.ok) {
    const errorText = await updateFileResponse.text();
    throw new Error(`Failed to create/update file: ${updateFileResponse.status} ${errorText}`);
  }

  const fileUpdateResult = await updateFileResponse.json();

  // 5. Create the Pull Request
  const createPRResponse = await fetch(`${apiBase}/pulls`, {
    method: 'POST',
    headers: { 
      'Authorization': `token ${GITHUB_TOKEN}`, 
      'User-Agent': 'Cloudflare-Worker',
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      title: options.prTitle,
      body: options.prBody,
          head: options.branchName,
          base: baseBranch
    })
  });

  if (!createPRResponse.ok) {
    const errorText = await createPRResponse.text();
    // If PR already exists, try to find it
    if (createPRResponse.status === 422) {
      const existingPRsResponse = await fetch(`${apiBase}/pulls?head=${REPO.split('/')[0]}:${options.branchName}&state=open`, {
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'User-Agent': 'Cloudflare-Worker',
          'Accept': 'application/vnd.github.v3+json'
        }
      });
      if (existingPRsResponse.ok) {
        const existingPRs = await existingPRsResponse.json();
        if (existingPRs.length > 0) {
          return {
            success: true,
            message: 'PR already exists',
            branch: options.branchName,
            file_path: options.filePath,
            pr_url: existingPRs[0].html_url,
            pr_number: existingPRs[0].number
          };
        }
      }
    }
    throw new Error(`Failed to create PR: ${createPRResponse.status} ${errorText}`);
  }

  const prResult = await createPRResponse.json();

  return {
    success: true,
    message: 'PR created successfully',
    branch: options.branchName,
    file_path: options.filePath,
    commit_sha: fileUpdateResult.commit.sha,
    pr_url: prResult.html_url,
    pr_number: prResult.number
  };
}

/**
 * Handler for creating GitHub PRs
 */
export const handleGitHubPR: Handler = async (req, env, ctx) => {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return createErrorResponse('Method not allowed. Use POST.', 405);
  }

  const cpuStart = performance.now();
  
  try {
    // Get request body
    const requestData = await req.json();
    
    const branchName = requestData.branch_name || `update-zone-${Date.now()}`;
    const filePath = requestData.file_path || "data/update.json";
    const fileContent = requestData.file_content || { status: "updated", timestamp: new Date().toISOString() };
    const commitMessage = requestData.commit_message || "Automated update from Houston Kernel";
    const prTitle = requestData.pr_title || "Automated update from Houston Kernel";
    const prBody = requestData.pr_body || `Automated PR created via API.\n\n${commitMessage}`;

    const result = await createGitHubPR(env, {
      repository: requestData.repository,
      branchName,
      filePath,
      fileContent,
      commitMessage,
      prTitle,
      prBody
    });

    const cpuMs = performance.now() - cpuStart;
    return new Response(JSON.stringify(result), {
      headers: createResponseHeaders('application/json', 0, cpuMs)
    });

  } catch (error) {
    const cpuMs = performance.now() - cpuStart;
    return createErrorResponse(
      'Failed to create GitHub PR',
      500,
      error instanceof Error ? error.message : String(error)
    );
  }
};
