import { CacheStatus, loadCachedData } from '../../cache';

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
  const assetUrl = new URL("output/consolidated_model.json", baseUrl).toString();
  const result = await loadCachedData(assetUrl, env, ctx, {
    initial_ttl_ms: 3600 * 1000, // 1 hour in milliseconds
    max_ttl_ms: 8 * 3600 * 1000, // 8 hours
    process: (s) => s, // Keep as string (identity function)
  });
  
  return {
    model: result.data as string,
    ioMs: result.ioMs,
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
  
  // Parse the model JSON
  const modelSchema = JSON.parse(result.model);
  
  // Generate or reuse session_id
  const providedSessionId = args.session_id;
  const isNewSession = !providedSessionId;
  const sessionId = providedSessionId || crypto.randomUUID();
  
  // Build response structure like Python version
  const response: any = {
    session_id: sessionId
  };
  
  // For new sessions, include model metadata and data_format
  if (isNewSession) {
    response.model = {
      name: modelSchema.title || "Consolidated Data Model",
      version: modelSchema.version || "1.0.0",
      description: modelSchema.description || "Consolidated entity schemas from data model files"
    };
    response.data_format = {
      primary_key_normalization: (
        "CRITICAL: Primary key values in the stored data are ALREADY normalized to lowercase. " +
        "When querying, use lowercase values directly (e.g., 'acme corp' not 'Acme Corp'). " +
        "Do NOT apply to_lower() to primary keys in queries - the data is already normalized."
      ),
      field_name_normalization: (
        "Foreign key field names use underscores instead of dots " +
        "(e.g., 'server_name' instead of 'server.name')"
      )
    };
  }
  
  // Include the model schema ($defs and properties)
  // For depth=0 (default), we could filter to just entity map, but for simplicity
  // we'll return the full schema structure
  response.$schema = modelSchema.$schema;
  response.title = modelSchema.title;
  response.description = modelSchema.description;
  response.$defs = modelSchema.$defs;
  response.type = modelSchema.type;
  response.properties = modelSchema.properties;
  response.additionalProperties = modelSchema.additionalProperties;
  
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(response, null, 2)
      }
    ],
    ioMs: result.ioMs,
    cpuMs: result.cpuMs,
    cacheStatus: result.cacheStatus
  };
}
