// Define a simple type for our handlers
type Handler = (request: Request, env: any) => Promise<Response>;

export const apiRoutes: Record<string, Handler> = {
  "/api/compute": async (req, env) => {
    const data = { score: 92, status: "Houston-Optimized" };
    return Response.json(data);
  },
  "/api/status": async () => {
    return new Response("Kernel Online", { status: 200 });
  }
};