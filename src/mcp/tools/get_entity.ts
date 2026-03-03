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
    parse: true,
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
async function loadModelSchema(
  env: any,
  ctx: any,
  baseUrl: string
): Promise<{ schema: any; ioMs: number }> {
  const result = await loadCachedModel(env, ctx, baseUrl);
  // Parse the model JSON string
  const schema = JSON.parse(result.model);
  return {
    schema,
    ioMs: result.ioMs
  };
}

/**
 * Recursively filter entity data based on depth parameter
 */
function filterDepth(
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

/**
 * Handler for get_entity tool calls
 */
export async function handleGetEntity(
  args: any,
  context: { env: any; ctx: any; origin: string }
): Promise<{ content: Array<{ type: string; text: string; isError?: boolean }>; ioMs: number; cpuMs: number; cacheStatus: any }> {
  const { entity, depth = 1, session_id, updated_prompt, ai_reasoning } = args;
  
  if (!entity || typeof entity !== 'string') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Invalid entity parameter',
          message: 'Entity type must be a non-empty string'
        }, null, 2),
        isError: true
      }],
      ioMs: 0,
      cpuMs: 0,
      cacheStatus: CacheStatus.ERROR
    };
  }
  
  try {
    // Load model schema to understand entity structure
    const modelResult = await loadModelSchema(context.env, context.ctx, context.origin);
    
    // Get available entities from schema
    const availableEntities = modelResult.schema?.$defs ? Object.keys(modelResult.schema.$defs) : [];
    const properties = modelResult.schema?.properties || {};
    const topLevelEntities = Object.keys(properties);
    
    // Validate that the entity exists in the model
    if (!availableEntities.includes(entity) && !topLevelEntities.includes(entity)) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: `Unknown entity type: ${entity}`,
            available_entities: topLevelEntities,
            available_in_model: availableEntities,
            note: 'Entity names MUST match the model definition exactly. Use lowercase for entity type names.'
          }, null, 2),
          isError: true
        }],
        ioMs: modelResult.ioMs,
        cpuMs: 0,
        cacheStatus: CacheStatus.ERROR
      };
    }
    
    // Try to load entity data
    let entityResult;
    try {
      entityResult = await loadCachedEntity(entity, context.env, context.ctx, context.origin);
    } catch (error) {
      // Entity file not found or load error
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: `Failed to load entity: ${entity}`,
            message: error instanceof Error ? error.message : String(error),
            available_entities: topLevelEntities,
            available_in_model: availableEntities
          }, null, 2),
          isError: true
        }],
        ioMs: modelResult.ioMs,
        cpuMs: 0,
        cacheStatus: CacheStatus.ERROR
      };
    }
    
    // Get entity data (it's stored as {entity_name: {pk: data}} or just {pk: data})
    const entityStore = entityResult.entityData;
    const entityInstances = Object.values(entityStore);
    const entityCount = entityInstances.length;
    
    // Filter results based on depth
    let results: any[];
    if (depth > 0) {
      results = entityInstances.map((entityData: any) => 
        filterDepth(entityData, entity, depth, modelResult.schema)
      );
    } else {
      // Depth 0: return all fields
      results = entityInstances;
    }
    
    const resultCount = results.length;
    
    // Build response
    const response: any = {
      entity,
      depth,
      result_count: resultCount,
      results
    };
    
    if (updated_prompt) {
      response.updated_prompt = updated_prompt;
    }
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response, null, 2)
      }],
      ioMs: entityResult.ioMs + modelResult.ioMs,
      cpuMs: 0,
      cacheStatus: entityResult.cacheStatus
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: `Failed to retrieve entity '${entity}': ${error instanceof Error ? error.message : String(error)}`,
          error_type: error instanceof Error ? error.constructor.name : 'Unknown',
          entity
        }, null, 2),
        isError: true
      }],
      ioMs: 0,
      cpuMs: 0,
      cacheStatus: CacheStatus.MISS
    };
  }
}
