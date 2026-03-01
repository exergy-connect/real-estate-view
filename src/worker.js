export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. THE DATA BRIDGE: When the browser asks for /api
    if (url.pathname === "/api") {
      const dataUrl = "https://real-estate-view.jvb127.workers.dev/output/consolidated_data.js";
      const response = await fetch(dataUrl);
      
      // We return the raw data so your HTML can use it
      return new Response(response.body, {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // 2. THE HTML FALLBACK: For everything else, show the welcome.html
    // env.ASSETS is a built-in helper that talks to your /public folder
    return env.ASSETS.fetch(request);
  }
};
