import { apiRoutes } from './api';

// This stays "warm" in the Worker's RAM across multiple requests
let CACHED_DATA: any = null;

async function loadCachedData(env: any, ctx: any, baseUrl: string): Promise<{ data: any; cacheLevel: number }> {
  // 1. Memory Layer (The fastest) - cache level 0
  // This is the parsed JSON object, ready to use
  if (CACHED_DATA) return { data: CACHED_DATA, cacheLevel: 0 };

  const assetUrl = new URL("output/consolidated_data.json.gz", baseUrl).toString();
  const cache = (caches as any).default;
  const cacheRequest = new Request(assetUrl);
  
  // 2. Persistent Disk Layer (Cache API) - cache level 1
  // Check for compressed data in cache using a Request object as the cache key
  // The Cache API persists across worker restarts and is shared across all worker instances
  let response = await cache.match(cacheRequest);
  let cacheLevel = 1; // Default to cache API level
  
  if (!response) {
    // 3. Network/Asset Layer (The source) - cache level 2
    cacheLevel = 2;
    response = await env.ASSETS.fetch(cacheRequest);
    
    if (!response.ok) {
      throw new Error(`Failed to load data: ${response.status} ${response.statusText}`);
    }
    
    // Check body before caching
    if (!response.body) {
      throw new Error("Response body is null");
    }
    
    // Cache the compressed response for next time
    // Use waitUntil to ensure caching happens in background, but we need to clone
    // the response since we'll read the body for decompression
    const responseToCache = response.clone();
    ctx.waitUntil(cache.put(cacheRequest, responseToCache));
  }

  // OPTIMIZATION: Stream-to-JSON
  // Using .json() directly on the DecompressionStream is the 2026 standard.
  // V8 parses the tokens as they are unzipped, avoiding the 2.3MB string allocation.
  // Note: brotli is not supported by the DecompressionStream API.
  if (!response.body) {
    throw new Error("Response body is null");
  }
  
  const decompressionStream = new DecompressionStream("gzip");
  const decompressedBody = response.body.pipeThrough(decompressionStream);
  const decompressedResponse = new Response(decompressedBody);
  
  // Parse the JSON object - this is the parsed object we'll use
  CACHED_DATA = await decompressedResponse.json();
  
  // The parsed JSON object (CACHED_DATA) is now in memory for future requests
  // Cache API stores the compressed response, memory stores the parsed object
  
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