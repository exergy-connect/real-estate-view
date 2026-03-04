import { CacheStatus, loadCachedData } from '../../cache';
import { loadCachedModel } from './get_model';

/**
 * Tool definition for get_entity
 */
export function getEntityToolDefinition() {
  return {
    name: 'get_entity',
    description: (
      'Get a specific entity collection. ' +
      'Depth: 0=all fields, 1=PK+counts (default), 2=all except lists, 3+=all with nested filtering.'
    ),
    inputSchema: {
      type: 'object',
      properties: {
        entity: {
          type: 'string',
          description: 'Entity type to retrieve (MUST match the model definition exactly)',
        },
        depth: {
          type: 'integer',
          description: (
            'Depth level: 0 (all fields), 1 (PK + list counts only), ' +
            '2 (all fields except entity lists), ' +
            '3 (all fields including entity lists filtered recursively)'
          ),
          default: 1,
        },
        updated_prompt: {
          type: 'string',
          description: 'The user\'s most recent prompt or query, if different from the previous prompt',
        },
        ai_reasoning: {
          type: 'string',
          description: "The AI's reasoning for why this tool is being called",
        },
        session_id: {
          type: 'string',
          description: (
            'session ID returned by get_model. ' +
            'Use this to associate entity retrieval with a session for tracking and follow-up queries.'
          ),
        },
      },
      required: ['entity', 'ai_reasoning', 'session_id'],
    },
  };
}

/**
 * Loads entity data from extracted entity files
 * Entities are stored in files like: output/data/entities/{entity_name}.json
 * Format: { pk_string: entity_data, ... }
 */
export async function loadCachedEntity(
  entityName: string,
  env: any,
  ctx: any,
  baseUrl: string
): Promise<{ entityData: Record<string, any>; ioMs: number; cpuMs: number; cacheStatus: CacheStatus }> {
  const assetUrl = new URL(`output/data/entities/${entityName}.json`, baseUrl).toString();
  
  const result = await loadCachedData(assetUrl, env, ctx, {
    initial_ttl_ms: 3600 * 1000, // 1 hour in milliseconds
    max_ttl_ms: 7200 * 1000, // 2 hours in milliseconds
    process: JSON.parse,
    timestampHistoryCount: 3,
  });
  
  // Entity files are stored as { pk_string: entity_data, ... }
  const entityData = result.data || {};
  
  return {
    entityData: entityData || {},
    ioMs: result.ioMs,
    cpuMs: 0, // No CPU time needed for formatting (already parsed)
    cacheStatus: result.cacheStatus
  };
}

/**
 * Loads the consolidated model to get entity schemas and primary keys
 * Reuses loadCachedModel from get_model.ts to avoid duplication
 */
export async function loadModelSchema(
  env: any,
  ctx: any,
  baseUrl: string
): Promise<{ schema: any; ioMs: number }> {
  // Always parse for this use case
  const result = await loadCachedModel(env, ctx, baseUrl, true);
  return {
    schema: result.model,
    ioMs: result.ioMs
  };
}

/**
 * Recursively filter entity data based on depth parameter
 */
export function filterDepth(
  entityData: Record<string, any>,
  entityType: string,
  depth: number,
  schema: any
): Record<string, any> {
  if (depth === 0) {
    // Return all fields
    return entityData;
  }
  
  const result: Record<string, any> = {};
  const entityDef = schema?.$defs?.[entityType];
  
  // Get primary key fields from schema
  const primaryKeys = entityDef?.required || ['name'];
  
  if (depth >= 1) {
    // Return only primary key fields
    for (const pkField of primaryKeys) {
      if (pkField in entityData) {
        result[pkField] = entityData[pkField];
      }
    }
  }
  
  if (depth >= 2) {
    // Include regular fields (not entity lists)
    const properties = entityDef?.properties || {};
    for (const [fieldName, fieldDef] of Object.entries(properties)) {
      const field = fieldDef as any;
      // Skip if it's a primary key (already added) or an array/entity list
      if (primaryKeys.includes(fieldName)) {
        continue;
      }
      // Skip arrays (entity lists) - those are handled at depth 3+
      if (field.type === 'array' && field.items?.$ref) {
        continue;
      }
      if (fieldName in entityData) {
        result[fieldName] = entityData[fieldName];
      }
    }
  }
  
  // Process entity lists (arrays with $ref)
  if (depth >= 3) {
    const properties = entityDef?.properties || {};
    for (const [fieldName, fieldDef] of Object.entries(properties)) {
      const field = fieldDef as any;
      if (field.type === 'array' && field.items?.$ref) {
        if (fieldName in entityData) {
          const fieldValue = entityData[fieldName];
          if (Array.isArray(fieldValue)) {
            // Extract nested entity type from $ref (e.g., "#/$defs/zipcode" -> "zipcode")
            const refMatch = field.items.$ref.match(/#\/\$defs\/(.+)/);
            const nestedEntityType = refMatch ? refMatch[1] : null;
            
            // Recursively filter each item with depth-2
            result[fieldName] = fieldValue.map((item: any) => {
              if (nestedEntityType) {
                return filterDepth(item, nestedEntityType, depth - 2, schema);
              }
              return item;
            });
          } else {
            result[fieldName] = fieldValue;
          }
        }
      } else if (depth >= 2 && fieldName in entityData) {
        // For depth 2, include count fields if they exist
        const countFieldName = fieldName + '_count';
        if (countFieldName in entityData) {
          result[countFieldName] = entityData[countFieldName];
        }
      }
    }
  } else {
    // For depth < 3, include count fields for entity lists
    const properties = entityDef?.properties || {};
    for (const [fieldName, fieldDef] of Object.entries(properties)) {
      const field = fieldDef as any;
      if (field.type === 'array' && field.items?.$ref) {
        const countFieldName = fieldName + '_count';
        if (countFieldName in entityData) {
          result[countFieldName] = entityData[countFieldName];
        }
      }
    }
  }
  
  return result;
}

export interface GetEntityResponseResult {
  response: { entity: string; depth: number; result_count: number; results: any[]; updated_prompt?: string };
  ioMs: number;
  cpuMs: number;
  cacheStatus: CacheStatus;
}

export interface GetEntityResponseError {
  error: true;
  status: number;
  body: any;
  ioMs: number;
  cpuMs: number;
  cacheStatus: CacheStatus;
}

export function isGetEntityResponseError(
  r: GetEntityResponseResult | GetEntityResponseError
): r is GetEntityResponseError {
  return (r as GetEntityResponseError).error === true;
}

function entityError(
  status: number,
  body: any,
  ioMs: number = 0,
  cpuMs: number = 0
): GetEntityResponseError {
  return {
    error: true,
    status,
    body,
    ioMs,
    cpuMs,
    cacheStatus: CacheStatus.ERROR
  };
}

/**
 * Shared get_entity logic: load entity + schema, filter by depth, return response object and timing.
 * Used by both the MCP tool handler and the /api/entity HTTP route.
 */
export async function getEntityResponse(
  entity: string,
  depth: number,
  context: { env: any; ctx: any; origin: string }
): Promise<GetEntityResponseResult | GetEntityResponseError> {
  if (!entity || typeof entity !== 'string') {
    return entityError(400, {
      error: 'Invalid entity parameter',
      message: 'Entity type must be a non-empty string'
    });
  }

  try {
    const modelResult = await loadModelSchema(context.env, context.ctx, context.origin);
    const availableEntities = modelResult.schema?.$defs ? Object.keys(modelResult.schema.$defs) : [];
    const properties = modelResult.schema?.properties || {};
    const topLevelEntities = Object.keys(properties);

    if (!availableEntities.includes(entity) && !topLevelEntities.includes(entity)) {
      return entityError(404, {
        error: `Unknown entity type: ${entity}`,
        available_entities: topLevelEntities,
        available_in_model: availableEntities,
        note: 'Entity names MUST match the model definition exactly. Use lowercase for entity type names.'
      }, modelResult.ioMs);
    }

    let entityResult: Awaited<ReturnType<typeof loadCachedEntity>>;
    try {
      entityResult = await loadCachedEntity(entity, context.env, context.ctx, context.origin);
    } catch (err) {
      return entityError(404, {
        error: `Failed to load entity: ${entity}`,
        message: err instanceof Error ? err.message : String(err),
        available_entities: topLevelEntities,
        available_in_model: availableEntities
      }, modelResult.ioMs);
    }

    const entityStore = entityResult.entityData;
    const entityInstances = Object.values(entityStore);

    let results: any[];
    if (depth > 0) {
      results = entityInstances.map((entityData: any) =>
        filterDepth(entityData, entity, depth, modelResult.schema)
      );
    } else {
      results = entityInstances;
    }

    const response = {
      entity,
      depth,
      result_count: results.length,
      results
    };

    return {
      response,
      ioMs: entityResult.ioMs + modelResult.ioMs,
      cpuMs: 0,
      cacheStatus: entityResult.cacheStatus
    };
  } catch (err) {
    return entityError(500, {
      error: `Failed to retrieve entity '${entity}': ${err instanceof Error ? err.message : String(err)}`,
      error_type: err instanceof Error ? err.constructor.name : 'Unknown',
      entity
    });
  }
}

/**
 * Handler for get_entity tool calls
 */
export async function handleGetEntity(
  args: any,
  context: { env: any; ctx: any; origin: string }
): Promise<{ content: Array<{ type: string; text: string; isError?: boolean }>; ioMs: number; cpuMs: number; cacheStatus: any }> {
  const { entity, depth = 1, session_id, updated_prompt, ai_reasoning } = args;

  const result = await getEntityResponse(entity, depth, context);

  if (isGetEntityResponseError(result)) {
    const response = { ...result.body, updated_prompt: args.updated_prompt };
    return {
      content: [{ type: 'text', text: JSON.stringify(response, null, 2), isError: true }],
      ioMs: result.ioMs,
      cpuMs: result.cpuMs,
      cacheStatus: result.cacheStatus
    };
  }

  const response: any = { ...result.response };
  if (updated_prompt) response.updated_prompt = updated_prompt;

  return {
    content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
    ioMs: result.ioMs,
    cpuMs: result.cpuMs,
    cacheStatus: result.cacheStatus
  };
}
