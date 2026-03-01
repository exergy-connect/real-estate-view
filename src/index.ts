import { apiRoutes } from './api';

// This stays "warm" in the Worker's RAM across multiple requests
let CACHED_DATA: any = null;

async function loadCachedData(env: any, ctx: any, baseUrl: string): Promise<any> {
  // 1. Memory Layer (The fastest)
  if (CACHED_DATA) return CACHED_DATA;

  const assetUrl = new URL("output/consolidated_data.json.br", baseUrl).toString();
  const cache = (caches as any).default;
  
  // 2. Persistent Disk Layer (Cache API)
  // This survives Worker restarts/evictions
  let response = await cache.match(assetUrl);

  if (!response) {
    // 3. Network/Asset Layer (The source)
    response = await env.ASSETS.fetch(new Request(assetUrl));
    
    // Cache it for next time (Background task so we don't block)
    // We clone because the body can only be read once
    ctx.waitUntil(cache.put(assetUrl, response.clone()));
  }

  // OPTIMIZATION: Stream-to-JSON
  // Using .json() directly on the DecompressionStream is the 2026 standard.
  // V8 parses the tokens as they are unzipped, avoiding the 2.3MB string allocation.
  const decompressionStream = new DecompressionStream("br" as any);
  const decompressedBody = response.body?.pipeThrough(decompressionStream);

  if (!decompressedBody) throw new Error("Failed to initialize data stream");

  CACHED_DATA = await new Response(decompressedBody).json();
  
  return CACHED_DATA;
}

export default {
  async fetch(request: Request, env: any, ctx: any) {
    const url = new URL(request.url);

    // Use the native platform's pattern matcher
    const handler = apiRoutes[url.pathname];

    if (handler) {
      try {
        // Load cached data and pass it to handler
        const cachedData = await loadCachedData(env, ctx, url.origin);
        return await handler(request, env, cachedData);
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