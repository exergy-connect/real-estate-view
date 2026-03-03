import { CacheStatus, getCachedJSON, createSmartFetcher } from '../../cache';

/**
 * Tool definition for get_model
 */
export function getModelToolDefinition() {
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
export async function loadCachedModel(
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
 * Handler for get_model tool calls
 */
export async function handleGetModel(
  args: any,
  context: { env: any; ctx: any; origin: string }
): Promise<{ content: Array<{ type: string; text: string }>; ioMs: number; cpuMs: number; cacheStatus: CacheStatus }> {
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
