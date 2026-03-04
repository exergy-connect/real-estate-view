import { CacheStatus, loadCachedData } from './cache';
import { handleMCPRequest } from './mcp/index';
import { getEntityResponse, isGetEntityResponseError } from './mcp/tools/get_entity';

// TTL configuration for cached data
const INITIAL_TTL_MS = 300 * 1000; // 5 minutes
const MAX_TTL_MS = 3600 * 1000;    // 1 hour

// Define a simple type for our handlers
type Handler = (request: Request, env: any, ctx?: any) => Promise<Response>;

/**
 * Creates Server-Timing header value from performance metrics
 */
function createServerTimingHeader(ioMs: number, cpuMs: number, cacheStatus?: CacheStatus): string {
  const metrics = [
    `io;dur=${ioMs.toFixed(2)}`,
    `cpu;dur=${cpuMs.toFixed(2)}`
  ];
  if (cacheStatus !== undefined) {
    metrics.push(`cache;desc=${cacheStatus}`);
  }
  return metrics.join(', ');
}

/**
 * Creates standard CORS headers
 */
function getCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Timing-Allow-Origin': '*' // Allows cross-origin access to Server-Timing header
  };
}

/**
 * Creates response headers with Server-Timing and CORS
 */
export function createResponseHeaders(contentType: string, ioMs: number, cpuMs: number, cacheStatus?: CacheStatus): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Server-Timing': createServerTimingHeader(ioMs, cpuMs, cacheStatus),
    ...getCorsHeaders()
  };
}

/**
 * Creates a JSON error response with the specified status code
 */
export function createErrorResponse(error: string, status: number, message?: string): Response {
  return new Response(JSON.stringify({ 
    error,
    ...(message && { message })
  }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders()
    }
  });
}

/**
 * Compute a weak ETag from a string (e.g. JSON body) using SHA-256.
 * Returns W/"<base64url>" for weak comparison.
 */
async function weakEtagFromString(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  const base64 = btoa(String.fromCharCode(...hashArray)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `W/"${base64}"`;
}

/**
 * Weak ETag comparison: strip optional W/ prefix and compare case-insensitively.
 */
function etagMatches(ifNoneMatch: string | null, currentEtag: string): boolean {
  if (!ifNoneMatch) return false;
  const normalize = (s: string) => s.replace(/^\s*W\//i, '').replace(/"|'\s*$/g, '').trim().toLowerCase();
  const current = normalize(currentEtag);
  return ifNoneMatch.split(',').some((v) => normalize(v.trim()) === current);
}



export const apiRoutes: Record<string, Handler> = {
  "/api": async (req, env, ctx) => {
    const url = new URL(req.url);
    const assetUrl = new URL("output/consolidated_data.json.gz", url.origin).toString();
    const ioStart = performance.now();
    const { data: cachedData, cacheStatus } = await loadCachedData(assetUrl, env, ctx, {
      initial_ttl_ms: INITIAL_TTL_MS,
      max_ttl_ms: MAX_TTL_MS,
      process: JSON.parse,
    });
    const ioEnd = performance.now();
    const ioMs = ioEnd - ioStart;
    
    // CPU: JSON stringification
    const jsonString = JSON.stringify(cachedData);
    const cpuMs = performance.now() - ioEnd;
    
    const headers = createResponseHeaders('application/json', ioMs, cpuMs, cacheStatus);
    headers['X-Cache-Status'] = cacheStatus;
    
    return new Response(jsonString, { headers });
  },
  "/api/compute": async (req, env, ctx) => {
    const url = new URL(req.url);
    const assetUrl = new URL("output/consolidated_data.json.gz", url.origin).toString();
    const ioStart = performance.now();
    const { data, cacheStatus } = await loadCachedData(assetUrl, env, ctx, {
      initial_ttl_ms: INITIAL_TTL_MS,
      max_ttl_ms: MAX_TTL_MS,
      process: JSON.parse,
    });
    const ioMs = performance.now() - ioStart;
    
    // Get request body if present (for POST/PUT requests)
    const cpuStart = performance.now();
    let requestData: any = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try {
        requestData = await req.json();
      } catch (e) {
        // No JSON body or invalid JSON
      }
    }
    
    // Get query parameters
    const queryParams = Object.fromEntries(url.searchParams);
    
    // Modify response based on request
    let modifiedData = data;
    
    // Apply query parameter filters if present
    if (queryParams.filter) {
      // Example: filter by entity type
      const filterType = queryParams.filter;
      if (data.data && data.data[filterType]) {
        modifiedData = {
          ...data,
          data: {
            [filterType]: data.data[filterType]
          }
        };
      }
    }
    
    // Apply request body modifications if present
    if (requestData && requestData.compute) {
      // Example computation: count entities
      if (requestData.compute === 'count') {
        const counts: Record<string, number> = {};
        if (modifiedData.data) {
          Object.keys(modifiedData.data).forEach(key => {
            counts[key] = Object.keys(modifiedData.data[key] || {}).length;
          });
        }
        modifiedData = { ...modifiedData, counts };
      }
    }
    
    const cpuMs = performance.now() - cpuStart;
    
    const headers = createResponseHeaders('application/json', ioMs, cpuMs, cacheStatus);
    headers['X-Cache-Status'] = cacheStatus;
    
    return new Response(JSON.stringify(modifiedData), { headers });
  },
  "/api/status": async (req, env, ctx) => {
    const cpuStart = performance.now();
    // Minimal CPU work
    const cpuMs = performance.now() - cpuStart;
    
    return new Response("Kernel Online", {
      status: 200,
      headers: createResponseHeaders('text/plain', 0, cpuMs)
    });
  },
  "/api/entity": async (req, env, ctx) => {
    const url = new URL(req.url);
    const entityName = url.searchParams.get("entity") ?? url.searchParams.get("id");
    const depthParam = url.searchParams.get("depth");
    const depth = depthParam !== null ? parseInt(depthParam, 10) : 1;
    const ifNoneMatch = req.headers.get("If-None-Match");

    if (!entityName) {
      return createErrorResponse("Missing 'entity' or 'id' parameter", 400);
    }
    if (Number.isNaN(depth) || depth < 0 || depth > 10) {
      return createErrorResponse("Invalid 'depth' (0-10)", 400);
    }

    const origin = new URL(req.url).origin;
    const result = await getEntityResponse(entityName, depth, { env, ctx, origin });

    if (isGetEntityResponseError(result)) {
      return createErrorResponse(
        result.body?.error ?? "Entity not found",
        result.status,
        result.body?.message
      );
    }

    const body = JSON.stringify(result.response);
    const etag = await weakEtagFromString(body);

    if (etagMatches(ifNoneMatch, etag)) {
      const headers: Record<string, string> = {
        ETag: etag,
        "Cache-Control": "private, max-age=0, must-revalidate",
        ...getCorsHeaders()
      };
      return new Response(null, { status: 304, headers });
    }

    const headers = createResponseHeaders("application/json", result.ioMs, result.cpuMs, result.cacheStatus);
    headers["ETag"] = etag;
    headers["Cache-Control"] = "private, max-age=0, must-revalidate";
    headers["X-Cache-Status"] = result.cacheStatus;

    return new Response(body, { headers });
  },
  "/api/github/pr": async (req, env, ctx) => {
    // Only allow POST requests
    if (req.method !== 'POST') {
      return createErrorResponse('Method not allowed. Use POST.', 405);
    }

    const cpuStart = performance.now();
    
    try {
      // Get request body
      const requestData = await req.json();
      
      const GITHUB_TOKEN = env.GH_TOKEN;
      if (!GITHUB_TOKEN) {
        return createErrorResponse(
          'GITHUB_TOKEN not configured',
          500,
          'GH_TOKEN environment variable is required'
        );
      }

      const REPO = requestData.repository || "exergy-connect/real-estate-view";
      const branchName = requestData.branch_name || `update-zone-${Date.now()}`;
      const filePath = requestData.file_path || "data/update.json";
      const fileContent = requestData.file_content || { status: "updated", timestamp: new Date().toISOString() };
      const commitMessage = requestData.commit_message || "Automated update from Houston Kernel";
      const prTitle = requestData.pr_title || "Automated update from Houston Kernel";
      const prBody = requestData.pr_body || `Automated PR created via API.\n\n${commitMessage}`;

      const apiBase = `https://api.github.com/repos/${REPO}`;

      // 1. Fetch the latest commit SHA from the main branch
      const mainRefResponse = await fetch(`${apiBase}/git/refs/heads/main`, {
        headers: { 
          'Authorization': `token ${GITHUB_TOKEN}`, 
          'User-Agent': 'Cloudflare-Worker',
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      if (!mainRefResponse.ok) {
        const errorText = await mainRefResponse.text();
        throw new Error(`Failed to fetch main branch: ${mainRefResponse.status} ${errorText}`);
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
          ref: `refs/heads/${branchName}`,
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
        const getFileResponse = await fetch(`${apiBase}/contents/${filePath}?ref=${branchName}`, {
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
      const content = btoa(JSON.stringify(fileContent, null, 2));
      const updateFileResponse = await fetch(`${apiBase}/contents/${filePath}`, {
        method: 'PUT',
        headers: { 
          'Authorization': `token ${GITHUB_TOKEN}`, 
          'User-Agent': 'Cloudflare-Worker',
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: commitMessage,
          content: content,
          branch: branchName,
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
          title: prTitle,
          body: prBody,
          head: branchName,
          base: 'main'
        })
      });

      if (!createPRResponse.ok) {
        const errorText = await createPRResponse.text();
        // If PR already exists, try to find it
        if (createPRResponse.status === 422) {
          const existingPRsResponse = await fetch(`${apiBase}/pulls?head=${REPO.split('/')[0]}:${branchName}&state=open`, {
            headers: {
              'Authorization': `token ${GITHUB_TOKEN}`,
              'User-Agent': 'Cloudflare-Worker',
              'Accept': 'application/vnd.github.v3+json'
            }
          });
          if (existingPRsResponse.ok) {
            const existingPRs = await existingPRsResponse.json();
            if (existingPRs.length > 0) {
              const cpuMs = performance.now() - cpuStart;
              return new Response(JSON.stringify({
                success: true,
                message: 'PR already exists',
                branch: branchName,
                pr_url: existingPRs[0].html_url,
                pr_number: existingPRs[0].number
              }), {
                headers: createResponseHeaders('application/json', 0, cpuMs)
              });
            }
          }
        }
        throw new Error(`Failed to create PR: ${createPRResponse.status} ${errorText}`);
      }

      const prResult = await createPRResponse.json();
      const cpuMs = performance.now() - cpuStart;

      return new Response(JSON.stringify({
        success: true,
        message: 'PR created successfully',
        branch: branchName,
        file_path: filePath,
        commit_sha: fileUpdateResult.commit.sha,
        pr_url: prResult.html_url,
        pr_number: prResult.number
      }), {
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
  },
  "/api/mcp/sse": async (req, env, ctx) => {
    return handleMCPRequest(req, env, ctx);
  }
};