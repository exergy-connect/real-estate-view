import { CacheStatus, getCachedJSON, createSmartFetcher } from './cache';

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
 * Returns the list of available MCP tools
 */
export function listMCPTools() {
  return [getModelToolDefinition()];
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

/**
 * Creates a JSON error response with the specified status code
 */
function createErrorResponse(error: string, status: number, message?: string): Response {
  return new Response(JSON.stringify({ 
    error,
    ...(message && { message })
  }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders()
    }
  });
}

/**
 * Handles MCP tool calls
 */
async function handleToolCall(
  toolName: string,
  env: any,
  ctx: any,
  origin: string
): Promise<{ content: Array<{ type: string; text: string }>; ioMs: number; cpuMs: number; cacheStatus: CacheStatus }> {
  if (toolName === 'get_model') {
    const result = await loadCachedModel(env, ctx, origin);
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
  
  throw new Error(`Unknown tool: ${toolName}`);
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

  // Handle GET requests for tool listing (MCP protocol)
  if (req.method === 'GET') {
    const tools = listMCPTools();
    return new Response(JSON.stringify({ tools }), {
      headers: {
        'Content-Type': 'application/json',
        ...getCorsHeaders()
      }
    });
  }

  // Handle POST requests for MCP tool calls
  if (req.method !== 'POST') {
    return createErrorResponse('Method not allowed. Use GET for tool listing or POST for tool calls.', 405);
  }
  
  try {
    // Parse MCP tool call request
    const requestData = await req.json();
    
    // Handle MCP protocol format
    if (requestData.method === 'tools/list') {
      const tools = listMCPTools();
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: requestData.id || null,
        result: { tools }
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...getCorsHeaders()
        }
      });
    }

    // Handle tool call
    if (requestData.method === 'tools/call') {
      const toolName = requestData.params?.name || requestData.tool || requestData.name;
      
      if (!toolName) {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: requestData.id || null,
          error: { code: -32602, message: 'Missing tool name' }
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...getCorsHeaders()
          }
        });
      }

      const { origin } = new URL(req.url);
      const context = ctx || { waitUntil: (p: Promise<any>) => p };
      
      try {
        const toolResult = await handleToolCall(toolName, env, context, origin);
        
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: requestData.id || null,
          result: {
            content: toolResult.content,
            isError: false
          }
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Server-Timing': createServerTimingHeader(toolResult.ioMs, toolResult.cpuMs, toolResult.cacheStatus),
            ...getCorsHeaders()
          }
        });
      } catch (error) {
        // Unknown tool
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: requestData.id || null,
          error: { 
            code: -32601, 
            message: error instanceof Error ? error.message : String(error),
            data: { availableTools: ['get_model'] } 
          }
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...getCorsHeaders()
          }
        });
      }
    }

    // Fallback: handle simple tool call format (for backward compatibility)
    const toolName = requestData.tool || requestData.name;
    if (toolName) {
      const { origin } = new URL(req.url);
      const context = ctx || { waitUntil: (p: Promise<any>) => p };
      
      try {
        const toolResult = await handleToolCall(toolName, env, context, origin);
        
        const response = {
          type: 'tool_response',
          tool: 'get_model',
          content: toolResult.content
        };
        
        return new Response(JSON.stringify(response), {
          headers: {
            'Content-Type': 'application/json',
            'Server-Timing': createServerTimingHeader(toolResult.ioMs, toolResult.cpuMs, toolResult.cacheStatus),
            ...getCorsHeaders()
          }
        });
      } catch (error) {
        return createErrorResponse(
          error instanceof Error ? error.message : String(error),
          400
        );
      }
    }

    return createErrorResponse('Invalid MCP request format', 400);
  } catch (error) {
    return createErrorResponse(
      'Failed to process MCP tool call',
      500,
      error instanceof Error ? error.message : String(error)
    );
  }
}
