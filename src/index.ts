import { apiRoutes } from './api';

// This stays "warm" in the Worker's RAM across multiple requests
let CACHED_DATA: any = null;

async function loadCachedData(env: any): Promise<any> {
  // If we've already parsed the JSON, return it from RAM (Zero Latency)
  if (!CACHED_DATA) {
    const response = await env.ASSETS.fetch(new Request("/consolidated_data.json.gz"));
    const text = await new Response(
      response.body?.pipeThrough(new DecompressionStream("gzip"))
    ).text();
    CACHED_DATA = JSON.parse(text);
  }
  return CACHED_DATA;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Use the native platform's pattern matcher
    const handler = apiRoutes[url.pathname];

    if (handler) {
      try {
        // Load cached data and pass it to handler
        const cachedData = await loadCachedData(env);
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