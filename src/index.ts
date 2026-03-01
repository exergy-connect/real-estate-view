import { apiRoutes } from './api';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Use the native platform's pattern matcher
    const handler = apiRoutes[url.pathname];

    if (handler) {
      try {
        return await handler(request, env);
      } catch (error) {
        console.error('Error handling API route:', error);
        return new Response(JSON.stringify({ error: 'Internal server error' }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // Default to Assets for HTML/Data
    try {
      const response = await env.ASSETS.fetch(request);
      
      // Simple cache-control for the data file
      // if (url.pathname.endsWith("consolidated_data.js")) {
      //   const cachedResponse = new Response(response.body, response);
      //   cachedResponse.headers.set("Cache-Control", "public, max-age=3600");
      //   return cachedResponse;
      // }

      return response;
    } catch (error) {
      console.error('Error fetching asset:', error);
      return new Response('Not Found', { status: 404 });
    }
  }
};