import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CacheStatus, getCachedJSON, createSmartFetcher } from './cache';

// Initialize the MCP Server
const server = new McpServer(
  { name: "har-model", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

/**
 * Tool definition for get_model
 */
function getModelToolDefinition() {
  return {
    name: 'get_model',
    description: '⚠️ START HERE: Get the data model definition. Use this FIRST before making any queries.',
    inputSchema: {
      type: 'object',
      properties: {
        initial_prompt: {
          type: 'string',
          description: "The user's initial prompt or query that started this session",
        },
        ai_reasoning: {
          type: 'string',
          description: "The AI's reasoning for why get_model is being called",
        },
        llm_model_version: {
          type: 'string',
          description: "Specific version identifier for the AI agent making this call, NOT 'Auto'. Example: 'gpt-4o-mini'",
        },
        depth: {
          type: 'integer',
          description: 'Depth level (default: 0 for entity map). 0 = entity map only (lightweight: entity names, relationships, primary keys, brief descriptions). 1 = top-level entities with field names. 2 = same + field types and constraints. 3+ = add direct children with fields. -1 = complete model definition (expensive: ALL entities, ALL fields, ALL relationships).',
          default: 0,
        },
        session_id: {
          type: 'string',
          description: 'Optional session ID from a previous get_model call. If omitted, starts a new session.',
        },
        entity: {
          type: 'string',
          description: 'Optional entity name to filter model SCHEMA to a specific entity and its children.',
        },
      },
      required: ['ai_reasoning', 'llm_model_version', 'initial_prompt'],
    },
  };
}

/**
 * Loads model JSON using getCachedJSON
 * Uses the new cache functions with ETag support and multi-layer caching
 */
async function loadCachedModel(
  env: any,
  ctx: any,
  baseUrl: string
): Promise<{ model: string; ioMs: number; cpuMs: number; cacheStatus: CacheStatus }> {
  const cacheKey = "consolidated_model.json";
  const ttl_ms = 3600 * 1000; // 1 hour in milliseconds
  const assetUrl = new URL("output/consolidated_model.json", baseUrl).toString();
  
  // Create a smart fetcher that handles ETag revalidation and Gzip decompression
  const fetcher = createSmartFetcher(env, assetUrl);
  
  const ioStart = performance.now();
  const result = await getCachedJSON({ env, ctx, cacheKey, ttl_ms, fetcher, parse: false }); // Don't parse JSON
  const ioMs = performance.now() - ioStart;
  
  return {
    model: result.data as string,
    ioMs,
    cpuMs: 0, // No CPU time needed for formatting
    cacheStatus: result.cacheStatus
  };
}

/**
 * Creates Server-Timing header value from performance metrics
 */
function createServerTimingHeader(ioMs: number, cpuMs: number, cacheStatus?: CacheStatus): string {
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
function getCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Timing-Allow-Origin': '*' // Allows cross-origin access to Server-Timing header
  };
}

// Set up MCP server handlers using the underlying Server instance
server.server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [getModelToolDefinition()]
  };
});

// Create a tool handler that uses context
async function handleToolCallWithContext(
  name: string,
  args: any,
  context: { env: any; ctx: any; origin: string }
): Promise<{ content: Array<{ type: string; text: string }>; ioMs: number; cpuMs: number; cacheStatus: CacheStatus }> {
  if (name === 'get_model') {
    const result = await loadCachedModel(context.env, context.ctx, context.origin);
    return {
      content: [
        {
          type: 'text',
          text: result.model
        }
      ],
      ioMs: result.ioMs,
      cpuMs: result.cpuMs,
      cacheStatus: result.cacheStatus
    };
  }
  
  throw new Error(`Unknown tool: ${name}`);
}

// Set up tool call handler (will be called with context via manual routing)
server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // This handler won't have access to Workers context directly
  // We'll handle tool calls manually in the HTTP handler
  const { name } = request.params;
  throw new Error(`Tool calls must be handled with context. Tool: ${name}`);
});

// Store active SSE sessions (in production, use Durable Objects or KV)
const activeSessions = new Map<string, {
  controller: ReadableStreamDefaultController;
  lastActivity: number;
}>();

// Clean up old sessions periodically
function cleanupSessions() {
  const now = Date.now();
  const maxAge = 5 * 60 * 1000; // 5 minutes
  for (const [sessionId, session] of activeSessions.entries()) {
    if (now - session.lastActivity > maxAge) {
      try {
        session.controller.close();
      } catch (e) {
        // Ignore errors when closing
      }
      activeSessions.delete(sessionId);
    }
  }
}

/**
 * Creates an SSE stream for MCP communication
 */
function createSSEStream(sessionId: string, messagesUrl: string): ReadableStream {
  let controller: ReadableStreamDefaultController;
  
  const stream = new ReadableStream({
    start(ctrl) {
      controller = ctrl;
      activeSessions.set(sessionId, {
        controller: ctrl,
        lastActivity: Date.now()
      });
      
      // Send the endpoint event (required by MCP SSE protocol)
      const encoder = new TextEncoder();
      const endpointEvent = `event: endpoint\ndata: ${messagesUrl}\n\n`;
      ctrl.enqueue(encoder.encode(endpointEvent));
    },
    cancel() {
      activeSessions.delete(sessionId);
    }
  });
  
  return stream;
}

/**
 * Sends a message through an SSE stream
 */
function sendSSEMessage(sessionId: string, message: any): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return false;
  }
  
  try {
    const encoder = new TextEncoder();
    const data = JSON.stringify(message);
    const sseMessage = `data: ${data}\n\n`;
    session.controller.enqueue(encoder.encode(sseMessage));
    session.lastActivity = Date.now();
    return true;
  } catch (error) {
    console.error('Error sending SSE message:', error);
    activeSessions.delete(sessionId);
    return false;
  }
}

/**
 * Main MCP handler for the /api/mcp/sse endpoint
 */
export async function handleMCPRequest(
  req: Request,
  env: any,
  ctx: any
): Promise<Response> {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: getCorsHeaders()
    });
  }

  const url = new URL(req.url);
  const { origin } = url;
  const context = ctx || { waitUntil: (p: Promise<any>) => p };
  const requestContext = { env, ctx: context, origin };
  
  // Check if this is an SSE request (GET with Accept: text/event-stream or query param)
  const acceptHeader = req.headers.get('Accept') || '';
  const isSSERequest = req.method === 'GET' && (
    acceptHeader.includes('text/event-stream') || 
    url.searchParams.has('sse')
  );
  
  // Handle GET requests - SSE stream or tool listing
  if (req.method === 'GET') {
    if (isSSERequest) {
      // Generate session ID
      const sessionId = crypto.randomUUID();
      const messagesUrl = `${url.pathname}?sessionId=${sessionId}`;
      
      // Create SSE stream
      const stream = createSSEStream(sessionId, messagesUrl);
      
      // Clean up old sessions
      cleanupSessions();
      
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          ...getCorsHeaders()
        }
      });
    } else {
      // Simple tool listing
      const tools = [getModelToolDefinition()];
      return new Response(JSON.stringify({ tools }), {
        headers: {
          'Content-Type': 'application/json',
          ...getCorsHeaders()
        }
      });
    }
  }

  // Handle POST requests for MCP protocol messages
  if (req.method === 'POST') {
    // Check if this is an SSE message (has sessionId in query params)
    const sessionId = url.searchParams.get('sessionId');
    const isSSEMessage = sessionId !== null;
    
    try {
      // Parse the JSON-RPC request
      const requestData = await req.json();
      
      // Helper to send response (either via SSE or HTTP)
      // Falls back to HTTP if SSE session not found (e.g., different isolate)
      const sendResponse = (response: any, additionalHeaders?: Record<string, string>): Response => {
        if (isSSEMessage) {
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
          ...(additionalHeaders || {})
        };
        return new Response(JSON.stringify(response), { headers });
      };
      
      // For tool calls, we need to handle them with context
      if (requestData.method === 'tools/call') {
        const { name, arguments: args } = requestData.params || {};
        
        if (!name) {
          return sendResponse({
            jsonrpc: '2.0',
            id: requestData.id || null,
            error: {
              code: -32602,
              message: 'Missing tool name'
            }
          });
        }
        
        try {
          const toolResult = await handleToolCallWithContext(name, args, requestContext);
          
          const response: any = {
            jsonrpc: '2.0',
            id: requestData.id || null,
            result: {
              content: toolResult.content,
              isError: false
            }
          };
          
          // Add Server-Timing header (works for both HTTP and SSE fallback)
          return sendResponse(response, {
            'Server-Timing': createServerTimingHeader(
              toolResult.ioMs,
              toolResult.cpuMs,
              toolResult.cacheStatus
            )
          });
        } catch (error) {
          return sendResponse({
            jsonrpc: '2.0',
            id: requestData.id || null,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error)
            }
          });
        }
      }
      
      // For other requests (initialize, tools/list), handle manually
      if (requestData.method === 'initialize') {
        return sendResponse({
          jsonrpc: '2.0',
          id: requestData.id || null,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {}
            },
            serverInfo: {
              name: 'har-model',
              version: '1.0.0'
            }
          }
        });
      }
      
      if (requestData.method === 'tools/list') {
        const tools = [getModelToolDefinition()];
        return sendResponse({
          jsonrpc: '2.0',
          id: requestData.id || null,
          result: { tools }
        });
      }
      
      // Unknown method
      return sendResponse({
        jsonrpc: '2.0',
        id: requestData.id || null,
        error: {
          code: -32601,
          message: `Unknown method: ${requestData.method}`
        }
      });
    } catch (error) {
      console.error('MCP handler error:', error);
      
      const errorResponse = {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error)
        }
      };
      
      // Helper to send error response (falls back to HTTP if SSE fails)
      const sendErrorResponse = (response: any): Response => {
        if (isSSEMessage && sendSSEMessage(sessionId, response)) {
          return new Response('Accepted', {
            status: 202,
            headers: getCorsHeaders()
          });
        }
        // Fall back to HTTP (SSE session not found or not an SSE message)
        return new Response(JSON.stringify(response), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...getCorsHeaders()
          }
        });
      };
      
      return sendErrorResponse(errorResponse);
    }
  }

  return new Response(JSON.stringify({
    error: 'Method not allowed'
  }), {
    status: 405,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders()
    }
  });
}
