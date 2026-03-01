import { apiRoutes } from './api';

// This stays "warm" in the Worker's RAM across multiple requests
let CACHED_DATA: any = null;

async function loadCachedData(env: any, ctx: any, baseUrl: string): Promise<{ data: any; cacheLevel: number }> {
  // 1. Memory Layer (The fastest) - cache level 0
  // This is the parsed JSON object, ready to use
  if (CACHED_DATA) return { data: CACHED_DATA, cacheLevel: 0 };

  const assetUrl = new URL("output/consolidated_data.json.gz", baseUrl).toString();
  const cacheKey = "consolidated_data.json";
  
  // 2. Persistent Disk Layer (Workers KV) - cache level 1
  // Check for parsed JSON string in KV store
  // Workers KV persists across worker restarts and is available on free tier
  let parsedData: any = null;
  let cacheLevel = 1; // Default to KV level
  
  if (env.CACHE_KV) {
    try {
      const kvData = await env.CACHE_KV.get(cacheKey, "text");
      if (kvData) {
        // Parse the JSON string from KV
        parsedData = JSON.parse(kvData);
      }
    } catch (error) {
      console.error("Error reading from KV:", error);
      parsedData = null;
    }
  }
  
  if (!parsedData) {
    // 3. Network/Asset Layer (The source) - cache level 2
    cacheLevel = 2;
    const response = await env.ASSETS.fetch(new Request(assetUrl));
    
    if (!response.ok) {
      throw new Error(`Failed to load data: ${response.status} ${response.statusText}`);
    }
    
    // Check body before processing
    if (!response.body) {
      throw new Error("Response body is null");
    }
    
    // OPTIMIZATION: Stream-to-JSON
    // Using .json() directly on the DecompressionStream is the 2026 standard.
    // V8 parses the tokens as they are unzipped, avoiding the 2.3MB string allocation.
    // Note: brotli is not supported by the DecompressionStream API.
    const decompressionStream = new DecompressionStream("gzip");
    const decompressedBody = response.body.pipeThrough(decompressionStream);
    const decompressedResponse = new Response(decompressedBody);
    
    // Parse the JSON object
    parsedData = await decompressedResponse.json();
    
    // Cache the parsed JSON as a string in KV for next time (background task)
    if (env.CACHE_KV) {
      const jsonString = JSON.stringify(parsedData);
      ctx.waitUntil(env.CACHE_KV.put(cacheKey, jsonString));
    }
  }
  
  // Store in memory for future requests
  CACHED_DATA = parsedData;
  
  // The parsed JSON object (CACHED_DATA) is now in memory for future requests
  // Workers KV stores the parsed JSON string, memory stores the parsed object
  
  return { data: CACHED_DATA, cacheLevel };
}

export default {
  async fetch(request: Request, env: any, ctx: any) {
    const url = new URL(request.url);

    // Use the native platform's pattern matcher
    const handler = apiRoutes[url.pathname];

    if (handler) {
      try {
        const startTime = performance.now();
        // Create a lazy-loading function for handlers that need cached data
        const loadCachedDataFn = async () => await loadCachedData(env, ctx, url.origin);
        return await handler(request, env, loadCachedDataFn, startTime);
      } catch (error) {
        console.error('Error handling API route:', error);
        const errorDetails = {
          error: 'Internal server error',
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          type: error instanceof Error ? error.constructor.name : typeof error
        };
        return new Response(JSON.stringify(errorDetails), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // Default to Assets for HTML/Data
    try {
      const response = await env.ASSETS.fetch(request);
      return response;
    } catch (error) {
      console.error('Error fetching asset:', error);
      return new Response('Not Found', { status: 404 });
    }
  }
};