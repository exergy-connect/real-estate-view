// Define a simple type for our handlers
type LoadCachedDataFn = () => Promise<any>;
type Handler = (request: Request, env: any, loadCachedData?: LoadCachedDataFn, startTime?: number) => Promise<Response>;

/**
 * Creates Server-Timing header value from performance metrics
 */
function createServerTimingHeader(ioMs: number, cpuMs: number): string {
  const metrics = [
    `io;dur=${ioMs.toFixed(2)}`,
    `cpu;dur=${cpuMs.toFixed(2)}`
  ];
  return metrics.join(', ');
}

/**
 * Creates standard CORS headers
 */
function getCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Timing-Allow-Origin': '*' // Allows cross-origin access to Server-Timing header
  };
}

/**
 * Creates response headers with Server-Timing and CORS
 */
function createResponseHeaders(contentType: string, ioMs: number, cpuMs: number): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Server-Timing': createServerTimingHeader(ioMs, cpuMs),
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
    const cachedData = await loadCachedData!();
    const ioEnd = performance.now();
    const ioMs = ioEnd - ioStart;
    
    // CPU: JSON stringification
    const jsonString = JSON.stringify(cachedData);
    const cpuMs = performance.now() - ioEnd;
    
    return new Response(jsonString, {
      headers: createResponseHeaders('application/json', ioMs, cpuMs)
    });
  },
  "/api/compute": async (req, env, loadCachedData, startTime) => {
    const ioStart = performance.now();
    const data = await loadCachedData!();
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
    
    return new Response(JSON.stringify(modifiedData), {
      headers: createResponseHeaders('application/json', ioMs, cpuMs)
    });
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
  }
};