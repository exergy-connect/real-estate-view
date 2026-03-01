// Define a simple type for our handlers
type LoadCachedDataFn = () => Promise<any>;
type Handler = (request: Request, env: any, loadCachedData?: LoadCachedDataFn) => Promise<Response>;

export async function getEntity(env: any, id: string) {
  // Directly fetch the specific small asset
  const response = await env.ASSETS.fetch(new Request(`/data/entities/${id}.json`));
  
  if (!response.ok) return null;
  
  // This JSON is only 2KB - parsing takes < 0.1ms
  return await response.json();
}

export const apiRoutes: Record<string, Handler> = {
  "/api": async (req, env, loadCachedData) => {
    const cachedData = await loadCachedData!();
    return new Response(JSON.stringify(cachedData), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  },
  "/api/compute": async (req, env, loadCachedData) => {
    const data = await loadCachedData!();
    
    // Get request body if present (for POST/PUT requests)
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
        const counts = {};
        if (modifiedData.data) {
          Object.keys(modifiedData.data).forEach(key => {
            counts[key] = Object.keys(modifiedData.data[key] || {}).length;
          });
        }
        modifiedData = { ...modifiedData, counts };
      }
    }
    
    return new Response(JSON.stringify(modifiedData), {
      headers: { 
        "Content-Type": "application/json", 
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  },
  "/api/status": async () => {
    return new Response("Kernel Online", { status: 200 });
  },
  "/api/entity": async (req, env) => {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    
    if (!id) {
      return new Response(JSON.stringify({ error: "Missing 'id' parameter" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
    
    const entity = await getEntity(env, id);
    
    if (!entity) {
      return new Response(JSON.stringify({ error: "Entity not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }
    
    return new Response(JSON.stringify(entity), {
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
};