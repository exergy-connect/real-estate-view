import { CacheStatus } from '../cache';

/**
 * Creates Server-Timing header value from performance metrics
 */
export function createServerTimingHeader(ioMs: number, cpuMs: number, cacheStatus?: CacheStatus): string {
  const metrics = [
    `io;dur=${ioMs.toFixed(2)}`,
    `cpu;dur=${cpuMs.toFixed(2)}`
  ];
  if (cacheStatus !== undefined) {
    metrics.push(`cache;desc=${cacheStatus}`);
  }
  return metrics.join(', ');
}

/**
 * Creates standard CORS headers
 */
export function getCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Timing-Allow-Origin': '*' // Allows cross-origin access to Server-Timing header
  };
}

/**
 * Normalizes JSON-RPC request ID (ensures it's never null)
 */
export function normalizeRequestId(id: any): string | number {
  return id !== undefined ? id : 0;
}

/**
 * Sends a JSON-RPC response via SSE or HTTP
 * Falls back to HTTP if SSE session not found (e.g., different isolate)
 */
export function sendJSONRPCResponse(
  id: string | number,
  sessionId: string | null,
  options?: {
    result?: any;
    error?: { code: number; message: string };
    additionalHeaders?: Record<string, string>;
  },
  sendSSEMessage?: (sessionId: string, message: any) => boolean
): Response {
  // Construct the JSON-RPC response object
  const response: { jsonrpc: string; id: string | number; result?: any; error?: any } = {
    jsonrpc: '2.0',
    id
  };
  
  if (options?.result !== undefined) {
    response.result = options.result;
  } else if (options?.error !== undefined) {
    response.error = options.error;
  }
  
  const isSSEMessage = sessionId !== null;
  
  if (isSSEMessage && sendSSEMessage) {
    if (sendSSEMessage(sessionId, response)) {
      // Response sent via SSE, return 202 Accepted
      return new Response('Accepted', {
        status: 202,
        headers: getCorsHeaders()
      });
    }
    // SSE session not found (likely different isolate), fall back to HTTP
    // This is expected in Cloudflare Workers where requests may run in different isolates
  }
  
  // Regular HTTP response (or fallback from failed SSE)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...getCorsHeaders(),
    ...(options?.additionalHeaders || {})
  };
  return new Response(JSON.stringify(response), { headers });
}

