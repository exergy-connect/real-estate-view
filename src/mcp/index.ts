import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createErrorResponse } from '../api';
import { getModelToolDefinition, handleGetModel } from './tools/get_model';
import { getEntityToolDefinition, handleGetEntity } from './tools/get_entity';
import { getCacheStatsToolDefinition, handleGetCacheStats } from './tools/get_cache_stats';
import { jmespathQueryToolDefinition, handleJmespathQuery } from './tools/jmespath_query';
import { createEntitiesToolDefinition, handleCreateEntities } from './tools/create_entities';
import { getCorsHeaders, normalizeRequestId, sendJSONRPCResponse, createServerTimingHeader } from './utils';
import { createSSEStream, cleanupSessions, sendSSEMessage } from './sse';

/**
 * Creates aggressive cache-busting headers to prevent any caching
 */
function getNoCacheHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Surrogate-Control': 'no-store'
  };
}

// Helper to pass sendSSEMessage to sendJSONRPCResponse
const sendJSONRPCWithSSE = (
  id: string | number,
  sessionId: string | null,
  options?: {
    result?: any;
    error?: { code: number; message: string };
    additionalHeaders?: Record<string, string>;
  }
) => {
  return sendJSONRPCResponse(id, sessionId, options, sendSSEMessage);
};

// Get deployment version from environment or use default
// This can be set via wrangler secrets or environment variables
function getDeploymentVersion(env: any): string {
  // Try to get from Workers environment variable
  if (env?.DEPLOYMENT_VERSION) {
    return env.DEPLOYMENT_VERSION;
  }
  // Try Cloudflare Pages commit SHA
  if (env?.CF_PAGES_COMMIT_SHA) {
    return env.CF_PAGES_COMMIT_SHA.substring(0, 7);
  }
  // Fallback: use build date
  return new Date().toISOString().split('T')[0].replace(/-/g, '');
}

// Initialize the MCP Server
const server = new McpServer(
  { name: "har-model", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Set up MCP server handlers using the underlying Server instance
server.server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [getModelToolDefinition(), getEntityToolDefinition(), getCacheStatsToolDefinition(), jmespathQueryToolDefinition(), createEntitiesToolDefinition()]
  };
});

// Create a tool handler that uses context
async function handleToolCallWithContext(
  name: string,
  args: any,
  context: { env: any; ctx: any; origin: string }
): Promise<{ content: Array<{ type: string; text: string }>; ioMs: number; cpuMs: number; cacheStatus: any }> {
  if (name === 'get_model') {
    return await handleGetModel(args, context);
  }
  
  if (name === 'get_entity') {
    return await handleGetEntity(args, context);
  }
  
  if (name === 'get_cache_stats') {
    return await handleGetCacheStats(args, context);
  }
  
  if (name === 'jmespath_query') {
    return await handleJmespathQuery(args, context);
  }
  
  if (name === 'create_entities') {
    return await handleCreateEntities(args, context);
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
          'Connection': 'keep-alive',
          ...getNoCacheHeaders(),
          ...getCorsHeaders()
        }
      });
    } else {
      // Simple tool listing
      const tools = [getModelToolDefinition(), getEntityToolDefinition(), getCacheStatsToolDefinition(), jmespathQueryToolDefinition()];
      const deploymentVersion = getDeploymentVersion(env);
      return new Response(JSON.stringify({ 
        tools,
        serverInfo: {
          deploymentVersion: deploymentVersion
        }
      }), {
        headers: {
          'Content-Type': 'application/json',
          'X-Deployment-Version': deploymentVersion,
          ...getNoCacheHeaders(),
          ...getCorsHeaders()
        }
      });
    }
  }

  // Handle POST requests for MCP protocol messages
  if (req.method === 'POST') {
    // Check if this is an SSE message (has sessionId in query params)
    const sessionId = url.searchParams.get('sessionId');
    
    try {
      // Parse the JSON-RPC request
      const requestData = await req.json();
      const requestId = normalizeRequestId(requestData.id);
      
      // For tool calls, we need to handle them with context
      if (requestData.method === 'tools/call') {
        const { name, arguments: args } = requestData.params || {};
        
        if (!name) {
          return sendJSONRPCWithSSE(requestId, sessionId, {
            error: {
              code: -32602,
              message: 'Missing tool name'
            }
          });
        }
        
        try {
          const toolResult = await handleToolCallWithContext(name, args, requestContext);
          
          // Add Server-Timing header (works for both HTTP and SSE fallback)
          return sendJSONRPCWithSSE(requestId, sessionId, {
            result: {
              content: toolResult.content,
              isError: false
            },
            additionalHeaders: {
              'Server-Timing': createServerTimingHeader(
                toolResult.ioMs,
                toolResult.cpuMs,
                toolResult.cacheStatus
              )
            }
          });
        } catch (error) {
          return sendJSONRPCWithSSE(requestId, sessionId, {
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error)
            }
          });
        }
      }
      
      // For other requests (initialize, tools/list), handle manually
      if (requestData.method === 'initialize') {
        const deploymentVersion = getDeploymentVersion(env);
        return sendJSONRPCWithSSE(requestId, sessionId, {
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {}
            },
            serverInfo: {
              name: 'har-model',
              version: '1.0.0',
              deploymentVersion: deploymentVersion
            }
          }
        });
      }
      
      if (requestData.method === 'tools/list') {
        const tools = [getModelToolDefinition(), getEntityToolDefinition(), getCacheStatsToolDefinition(), jmespathQueryToolDefinition(), createEntitiesToolDefinition()];
        const deploymentVersion = getDeploymentVersion(env);
        return sendJSONRPCWithSSE(requestId, sessionId, {
          result: { 
            tools,
            serverInfo: {
              deploymentVersion: deploymentVersion
            }
          },
          additionalHeaders: {
            'X-Deployment-Version': deploymentVersion
          }
        });
      }
      
      // Unknown method
      return sendJSONRPCWithSSE(requestId, sessionId, {
        error: {
          code: -32601,
          message: `Unknown method: ${requestData.method}`
        }
      });
    } catch (error) {
      console.error('MCP handler error:', error);
      
      // Try to extract request ID from the error context if possible
      // If we can't parse the request, use a default ID
      let requestId: string | number = 0;
      try {
        const body = await req.clone().json().catch(() => null);
        if (body && body.id !== undefined) {
          requestId = normalizeRequestId(body.id);
        }
      } catch {
        // Ignore parsing errors
      }
      
      return sendJSONRPCWithSSE(requestId, sessionId, {
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  return createErrorResponse('Method not allowed', 405);
}
