import { apiRoutes } from './api';
import { getCachedJSON, CacheStatus, createSmartFetcher, createCacheParams } from './cache';

// TTL configuration for cached data
const INITIAL_TTL_MS = 300 * 1000; // 5 minutes
const MAX_TTL_MS = 3600 * 1000;    // 1 hour

async function loadCachedData(env: any, ctx: any, baseUrl: string): Promise<{ data: any; cacheStatus: CacheStatus }> {
  const cacheKey = "consolidated_data.json";
  const assetUrl = new URL("output/consolidated_data.json.gz", baseUrl).toString();
  
  // Create a smart fetcher that handles ETag revalidation and Gzip decompression
  const fetcher = createSmartFetcher(env, assetUrl);
  
  const params = createCacheParams(
    {
      env,
      ctx,
      cacheKey,
      fetcher,
      parse: true
    },
    {
      initial_ttl_ms: INITIAL_TTL_MS,
      max_ttl_ms: MAX_TTL_MS
    }
  );
  
  const result = await getCachedJSON(params);
  
  return { data: result.data, cacheStatus: result.cacheStatus };
}

export default {
  async fetch(request: Request, env: any, ctx: any) {
    const url = new URL(request.url);

    // Handle OPTIONS requests for CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // RFC8414: OAuth 2.0 Authorization Server Metadata
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return new Response(JSON.stringify({
        issuer: `https://${url.hostname}`,
        authorization_endpoint: `https://${url.hostname}/auth`,
        token_endpoint: `https://${url.hostname}/token`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"]
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Use the native platform's pattern matcher
    const handler = apiRoutes[url.pathname];

    if (handler) {
      try {
        const startTime = performance.now();
        // Create a lazy-loading function for handlers that need cached data
        const loadCachedDataFn = async () => await loadCachedData(env, ctx, url.origin);
        return await handler(request, env, loadCachedDataFn, startTime, ctx);
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
      
      // Add cache-busting headers for HTML files to prevent stale content
      if (url.pathname === '/' || url.pathname.endsWith('.html')) {
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        newHeaders.set('Pragma', 'no-cache');
        newHeaders.set('Expires', '0');
        
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
        });
      }
      
      return response;
    } catch (error) {
      console.error('Error fetching asset:', error);
      return new Response('Not Found', { status: 404 });
    }
  }
};