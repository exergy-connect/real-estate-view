import { apiRoutes } from './api';

// This stays "warm" in the Worker's RAM across multiple requests
let CACHED_DATA: any = null;

// Maximum TTL for cached data in seconds (default: 1 hour)
const MAX_TTL_SECONDS = 300;

async function loadCachedData(env: any, ctx: any, baseUrl: string): Promise<{ data: any; cacheCode: number }> {
  // 1. Memory Layer (The fastest) - cache code 0
  // This is the parsed JSON object, ready to use
  if (CACHED_DATA) return { data: CACHED_DATA, cacheCode: 0 };

  const assetUrl = new URL("output/consolidated_data.json.gz", baseUrl).toString();
  const cacheKey = "consolidated_data.json";
  
  // 2. Persistent Disk Layer (Workers KV) - cache code 1
  // Check for parsed JSON string in KV store with TTL validation using metadata
  // Workers KV persists across worker restarts and is available on free tier
  let parsedData: any = null;
  let cacheCode = 1; // Default to KV code
  let cachedMetadata: { cachedAt?: number; dataTimestamp?: number } | null = null;
  let ttlExpired = false;
  
  if (env.CACHE_KV) {
    try {
      const kvResult = await env.CACHE_KV.getWithMetadata(cacheKey, "text");
      if (kvResult && kvResult.value) {
        // Check metadata for TTL
        const metadata = kvResult.metadata as { cachedAt?: number; dataTimestamp?: number } | null;
        if (metadata && metadata.cachedAt) {
          const ageSeconds = (Date.now() - metadata.cachedAt) / 1000;
          
          if (ageSeconds < MAX_TTL_SECONDS) {
            // Cache is valid - parse the JSON string
            parsedData = JSON.parse(kvResult.value);
            cachedMetadata = metadata;
          } else {
            // Cache expired - mark as expired but still have the data for comparison
            ttlExpired = true;
            parsedData = null;
            cachedMetadata = metadata;
          }
        }
        // If no metadata, treat as cache miss (legacy entries are no longer supported)
      }
    } catch (error) {
      console.error("Error reading from KV:", error);
      parsedData = null;
    }
  }
  
  if (!parsedData) {
    // 3. Network/Asset Layer (The source) - cache code 2 (cache miss) or 3 (TTL expired)
    cacheCode = ttlExpired ? 3 : 2;
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
    
    // Extract timestamp from consolidated_data.json structure
    // The timestamp field is at the root level: { "timestamp": "2026-02-28T19:28:08.799870+00:00", ... }
    if (!parsedData.timestamp) {
      throw new Error("consolidated_data.json is missing required 'timestamp' field");
    }
    const dataTimestamp = new Date(parsedData.timestamp).getTime();
    
    // Only update cache if:
    // 1. Cache was empty (cache miss), OR
    // 2. The new data timestamp is newer than what's in cache
    const shouldUpdateCache = !cachedMetadata || 
      (cachedMetadata.dataTimestamp && dataTimestamp > cachedMetadata.dataTimestamp);
    
    if (shouldUpdateCache && env.CACHE_KV) {
      // Cache the parsed JSON with metadata (including timestamp) in KV for next time (background task)
      const jsonString = JSON.stringify(parsedData);
      const metadata = {
        cachedAt: Date.now(),
        dataTimestamp: dataTimestamp
      };
      ctx.waitUntil(env.CACHE_KV.put(cacheKey, jsonString, { metadata }));
    }
  }
  
  // Store in memory for future requests
  CACHED_DATA = parsedData;
  
  // The parsed JSON object (CACHED_DATA) is now in memory for future requests
  // Workers KV stores the parsed JSON string, memory stores the parsed object
  
  // Cache codes:
  // 0 = Memory cache (fastest)
  // 1 = Workers KV cache (persistent)
  // 2 = Network/Asset fetch (cache miss)
  // 3 = Network/Asset fetch (TTL expired)
  
  return { data: CACHED_DATA, cacheCode };
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