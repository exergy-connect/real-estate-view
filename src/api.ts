// Define a simple type for our handlers
type LoadCachedDataFn = () => Promise<any>;
type Handler = (request: Request, env: any, loadCachedData?: LoadCachedDataFn, startTime?: number) => Promise<Response>;

/**
 * Creates Server-Timing header value from performance metrics
 */
function createServerTimingHeader(ioMs: number, cpuMs: number, cacheCode?: number): string {
  const metrics = [
    `io;dur=${ioMs.toFixed(2)}`,
    `cpu;dur=${cpuMs.toFixed(2)}`
  ];
  if (cacheCode !== undefined) {
    metrics.push(`cache;desc=${cacheCode}`);
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
function createResponseHeaders(contentType: string, ioMs: number, cpuMs: number, cacheCode?: number): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Server-Timing': createServerTimingHeader(ioMs, cpuMs, cacheCode),
    ...getCorsHeaders()
  };
}

async function getEntity(request: Request, env: any, id: string): Promise<{ entity: any; ioMs: number; cpuMs: number }> {
  // 1. Get the origin (e.g., https://houston-api.antonio.workers.dev)
  const { origin } = new URL(request.url);
  
  // 2. Combine the origin with your path to make it absolute
  const assetUrl = `${origin}/output/data/entities/${id}.json`;
  
  // 3. I/O: Fetch the asset
  const ioStart = performance.now();
  const response = await env.ASSETS.fetch(new Request(assetUrl));
  const ioMs = performance.now() - ioStart;
  
  if (!response.ok) throw new Error(`Entity ${id} not found at ${assetUrl}`);
  
  // 4. CPU: Parse JSON
  const cpuStart = performance.now();
  const entity = await response.json();
  const cpuMs = performance.now() - cpuStart;
  
  return { entity, ioMs, cpuMs };
}

export const apiRoutes: Record<string, Handler> = {
  "/api": async (req, env, loadCachedData, startTime) => {
    const ioStart = startTime || performance.now();
    const { data: cachedData, cacheCode } = await loadCachedData!();
    const ioEnd = performance.now();
    const ioMs = ioEnd - ioStart;
    
    // CPU: JSON stringification
    const jsonString = JSON.stringify(cachedData);
    const cpuMs = performance.now() - ioEnd;
    
    const headers = createResponseHeaders('application/json', ioMs, cpuMs, cacheCode);
    headers['X-Cache-Code'] = cacheCode.toString();
    
    return new Response(jsonString, { headers });
  },
  "/api/compute": async (req, env, loadCachedData, startTime) => {
    const ioStart = startTime || performance.now();
    const { data, cacheCode } = await loadCachedData!();
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
    const url = new URL(req.url);
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
    
    const headers = createResponseHeaders('application/json', ioMs, cpuMs, cacheCode);
    headers['X-Cache-Code'] = cacheCode.toString();
    
    return new Response(JSON.stringify(modifiedData), { headers });
  },
  "/api/status": async (req, env, loadCachedData, startTime) => {
    const cpuStart = performance.now();
    // Minimal CPU work
    const cpuMs = performance.now() - cpuStart;
    
    return new Response("Kernel Online", {
      status: 200,
      headers: createResponseHeaders('text/plain', 0, cpuMs)
    });
  },
  "/api/entity": async (req, env, loadCachedData, startTime) => {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    
    if (!id) {
      return new Response(JSON.stringify({ error: "Missing 'id' parameter" }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          ...getCorsHeaders()
        }
      });
    }
    
    try {
      const { entity, ioMs, cpuMs } = await getEntity(req, env, id);
      
      return new Response(JSON.stringify(entity), {
        headers: createResponseHeaders('application/json', ioMs, cpuMs)
      });
    } catch (error) {
      return new Response(JSON.stringify({ 
        error: error instanceof Error ? error.message : "Entity not found" 
      }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          ...getCorsHeaders()
        }
      });
    }
  },
  "/api/github/pr": async (req, env, loadCachedData, startTime) => {
    // Only allow POST requests
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed. Use POST.' }), {
        status: 405,
        headers: {
          'Content-Type': 'application/json',
          ...getCorsHeaders()
        }
      });
    }

    const cpuStart = performance.now();
    
    try {
      // Get request body
      const requestData = await req.json();
      
      const GITHUB_TOKEN = env.GH_TOKEN;
      if (!GITHUB_TOKEN) {
        return new Response(JSON.stringify({ 
          error: 'GITHUB_TOKEN not configured',
          message: 'GH_TOKEN environment variable is required'
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...getCorsHeaders()
          }
        });
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
      return new Response(JSON.stringify({
        error: 'Failed to create GitHub PR',
        message: error instanceof Error ? error.message : String(error)
      }), {
        status: 500,
        headers: createResponseHeaders('application/json', 0, cpuMs)
      });
    }
  }
};