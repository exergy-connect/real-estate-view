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
  baseUrl: string,
  parse: boolean = false
): Promise<{ model: string | any; ioMs: number; cpuMs: number; cacheStatus: CacheStatus }> {
  const assetUrl = new URL("output/consolidated_model.json", baseUrl).toString();
  const result = await loadCachedData(assetUrl, env, ctx, {
    initial_ttl_ms: 3600 * 1000, // 1 hour in milliseconds
    max_ttl_ms: 8 * 3600 * 1000, // 8 hours
    process: parse ? JSON.parse : undefined, // Parse JSON when needed, otherwise keep as string
  });
  
  return {
    model: result.data,
    ioMs: result.ioMs,
    cpuMs: 0, // No CPU time needed for formatting
    cacheStatus: result.cacheStatus
  };
}

/**
 * Extract primary keys from entity schema
 */
function extractPrimaryKeys(entitySchema: any): string[] {
  if (entitySchema.properties) {
    const primaryKeyFields: string[] = [];
    for (const [fieldName, fieldSchema] of Object.entries(entitySchema.properties)) {
      if (typeof fieldSchema === 'object' && fieldSchema !== null) {
        if ((fieldSchema as any)['x-primaryKey'] === true) {
          primaryKeyFields.push(fieldName);
        }
      }
    }
    if (primaryKeyFields.length > 0) {
      return primaryKeyFields;
    }
  }
  
  // Fallback: use required fields
  if (entitySchema.required && Array.isArray(entitySchema.required) && entitySchema.required.length > 0) {
    return entitySchema.required;
  }
  
  return [];
}

/**
 * Extract parent relationships from entity schema
 */
function extractParents(entitySchema: any): Array<{ child_fk: string; parent_array: string }> {
  const parents: Array<{ child_fk: string; parent_array: string }> = [];
  if (!entitySchema.properties) return parents;
  
  for (const [fieldName, fieldSchema] of Object.entries(entitySchema.properties)) {
    if (typeof fieldSchema === 'object' && fieldSchema !== null) {
      const xParents = (fieldSchema as any)['x-parents'];
      if (Array.isArray(xParents)) {
        for (const parent of xParents) {
          if (parent && typeof parent === 'object' && parent.parent_array) {
            parents.push({
              child_fk: fieldName,
              parent_array: parent.parent_array
            });
          }
        }
      }
    }
  }
  
  return parents;
}

/**
 * Extract children from entity schema (array fields with $ref)
 */
function extractChildren(entitySchema: any, allEntityNames: string[]): string[] {
  const children: string[] = [];
  if (!entitySchema.properties) return children;
  
  for (const [fieldName, fieldSchema] of Object.entries(entitySchema.properties)) {
    if (typeof fieldSchema === 'object' && fieldSchema !== null) {
      const field = fieldSchema as any;
      if (field.type === 'array' && field.items?.$ref) {
        const childType = field.items.$ref.replace('#/$defs/', '');
        if (allEntityNames.includes(childType)) {
          children.push(childType);
        }
      }
    }
  }
  
  return children;
}

/**
 * Build entity map (depth=0): lightweight entity info
 */
function buildEntityMap(entitySchema: any, entityName: string, allEntityNames: string[]): any {
  const result: any = {
    primary_key: extractPrimaryKeys(entitySchema)
  };
  
  const requiredFields = entitySchema.required || [];
  if (requiredFields.length > 0) {
    result.required_fields = requiredFields;
  }
  
  const parents = extractParents(entitySchema);
  if (parents.length > 0) {
    result.parents = parents;
  }
  
  if (entitySchema['x-brief']) {
    result.brief = entitySchema['x-brief'];
  }
  
  const children = extractChildren(entitySchema, allEntityNames);
  if (children.length > 0) {
    result.children = children;
  }
  
  return result;
}

/**
 * Filter entity schema by depth
 */
function filterEntityByDepth(entitySchema: any, depth: number, allEntityNames: string[]): any {
  const result: any = {};
  
  // Always include primary key
  const primaryKeys = extractPrimaryKeys(entitySchema);
  if (primaryKeys.length > 0) {
    result.primary_key = primaryKeys;
  }
  
  const requiredFields = entitySchema.required || [];
  if (requiredFields.length > 0) {
    result.required_fields = requiredFields;
  }
  
  // Extract parent relationships
  const parents = extractParents(entitySchema);
  if (parents.length > 0) {
    result.parents = parents;
  }
  
  // Handle description/brief based on depth
  if (entitySchema['x-brief'] && depth === 1) {
    result.brief = entitySchema['x-brief'];
  } else if (entitySchema.description) {
    result.description = entitySchema.description;
  }
  
  // Handle fields based on depth
  const properties = entitySchema.properties || {};
  
  if (depth === 1) {
    // depth=1: just field names
    result.fields = Object.keys(properties);
  } else if (depth === 2) {
    // depth=2: field names and types
    result.fields = Object.entries(properties).map(([name, fieldSchema]: [string, any]) => {
      const fieldInfo: any = {
        name,
        type: fieldSchema.type
      };
      if (fieldSchema.items) {
        fieldInfo.item_type = fieldSchema.items.type || (fieldSchema.items.$ref ? fieldSchema.items.$ref.replace('#/$defs/', '') : undefined);
      }
      if (fieldSchema['x-brief']) {
        fieldInfo.brief = fieldSchema['x-brief'];
      }
      return fieldInfo;
    });
  } else if (depth >= 3) {
    // depth >= 3: include all fields with full details
    result.fields = Object.entries(properties).map(([name, fieldSchema]: [string, any]) => {
      const fieldInfo: any = { ...fieldSchema };
      fieldInfo.name = name;
      return fieldInfo;
    });
    
    // Include children with their fields
    const children = extractChildren(entitySchema, allEntityNames);
    if (children.length > 0) {
      result.children = children;
    }
  }
  
  return result;
}

/**
 * Handler for get_model tool calls
 */
export async function handleGetModel(
  args: any,
  context: { env: any; ctx: any; origin: string }
): Promise<{ content: Array<{ type: string; text: string; isError?: boolean }>; ioMs: number; cpuMs: number; cacheStatus: CacheStatus }> {
  // Get depth parameter (default: 0)
  const depth = args.depth !== undefined && args.depth !== null ? args.depth : 0;
  const isFullModel = depth === -1;
  const isMapMode = depth === 0;
  const depthInt = depth;
  
  // Generate or reuse session_id
  const providedSessionId = args.session_id;
  const isNewSession = !providedSessionId;
  const sessionId = providedSessionId || crypto.randomUUID();
  
  // Determine if we need to parse JSON
  // We need to parse if:
  // 1. Depth is not -1 (need to filter/process)
  // 2. Entity filter is specified (need to filter)
  const entityFilter = args.entity;
  const needsProcessing = !isFullModel || !!entityFilter;
  
  // Load model with conditional parsing
  const result = await loadCachedModel(context.env, context.ctx, context.origin, needsProcessing);
  
  // Special case: depth=-1 - just return the raw string
  // The string already includes all metadata, so we can return it directly
  if (isFullModel) {
    return {
      content: [
        {
          type: 'text',
          text: result.model as string
        }
      ],
      ioMs: result.ioMs,
      cpuMs: 0,
      cacheStatus: result.cacheStatus
    };
  }
  
  // Build response structure
  const response: any = {
    session_id: sessionId
  };
  
  // Get model schema (already parsed if needsProcessing was true, otherwise parse now)
  let modelSchema: any = result.model;
  if (typeof result.model === 'string') {
    modelSchema = JSON.parse(result.model);
  }
  
  let entitiesToProcess: string[] = [];
  
  if (!isFullModel) {
    // modelSchema should already be parsed if needsProcessing was true
    
    const allEntityNames = Object.keys(modelSchema.$defs || {});
    const topLevelEntities = Object.keys(modelSchema.properties || {});
    
    // Determine which entities to include
    if (entityFilter) {
      // Filter to specific entity and its children (simplified - just include the entity for now)
      if (allEntityNames.includes(entityFilter) || topLevelEntities.includes(entityFilter)) {
        entitiesToProcess = [entityFilter];
        // TODO: Add recursive child collection if needed
      } else {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: `Entity '${entityFilter}' not found in model. Available entities: ${topLevelEntities.sort()}`,
              error_type: 'EntityNotFound'
            }, null, 2),
            isError: true
          }],
          ioMs: result.ioMs,
          cpuMs: 0,
          cacheStatus: result.cacheStatus
        };
      }
    } else {
      // Include all entities based on depth
      if (isMapMode || isFullModel) {
        entitiesToProcess = allEntityNames;
      } else {
        entitiesToProcess = topLevelEntities;
        // For depth >= 3, include all child entities recursively
        if (depthInt >= 3) {
          // TODO: Add recursive child collection
        }
      }
    }
    
    // Build entities dictionary based on depth
    const entities: Record<string, any> = {};
    
    if (isMapMode) {
      // depth=0: return entity map (lightweight)
      for (const entityName of entitiesToProcess.sort()) {
        const entityDef = modelSchema.$defs?.[entityName];
        if (entityDef) {
          entities[entityName] = buildEntityMap(entityDef, entityName, allEntityNames);
        }
      }
    } else if (isFullModel) {
      // depth=-1: return complete model
      for (const entityName of entitiesToProcess.sort()) {
        const entityDef = modelSchema.$defs?.[entityName];
        if (entityDef) {
          entities[entityName] = {
            primary_key: extractPrimaryKeys(entityDef),
            parents: extractParents(entityDef),
            description: entityDef.description,
            brief: entityDef['x-brief'],
            fields: Object.entries(entityDef.properties || {}).map(([name, schema]: [string, any]) => ({
              name,
              ...schema
            })),
            children: extractChildren(entityDef, allEntityNames)
          };
        }
      }
    } else {
      // depth >= 1: apply depth filtering
      for (const entityName of entitiesToProcess.sort()) {
        const entityDef = modelSchema.$defs?.[entityName];
        if (entityDef) {
          entities[entityName] = filterEntityByDepth(entityDef, depthInt, allEntityNames);
        }
      }
    }
    
    response.entities = entities;
    response.top_level_entities = topLevelEntities.filter(e => entitiesToProcess.includes(e));
    
    // Build hierarchy (include for map mode, full model, or depth >= 3)
    if (isMapMode || isFullModel || depthInt >= 3) {
      const hierarchy: Record<string, string[]> = {};
      for (const entityName of entitiesToProcess) {
        const entityDef = modelSchema.$defs?.[entityName];
        if (entityDef) {
          const children = extractChildren(entityDef, allEntityNames);
          if (children.length > 0) {
            hierarchy[entityName] = children.sort();
          }
        }
      }
      if (Object.keys(hierarchy).length > 0) {
        response.hierarchy = hierarchy;
      }
    }
    
    response.result_count = Object.keys(entities).length;
  } else {
    // depth=-1: return full schema as-is
    // modelSchema should already be parsed if needsProcessing was true (entity filter case)
    
    response.$schema = modelSchema.$schema;
    response.title = modelSchema.title;
    response.description = modelSchema.description;
    response.$defs = modelSchema.$defs;
    response.type = modelSchema.type;
    response.properties = modelSchema.properties;
    response.additionalProperties = modelSchema.additionalProperties;
    
    // Apply entity filter if specified
    if (entityFilter) {
      const allEntityNames = Object.keys(modelSchema.$defs || {});
      const topLevelEntities = Object.keys(modelSchema.properties || {});
      
      if (!allEntityNames.includes(entityFilter) && !topLevelEntities.includes(entityFilter)) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: `Entity '${entityFilter}' not found in model. Available entities: ${topLevelEntities.sort()}`,
              error_type: 'EntityNotFound'
            }, null, 2),
            isError: true
          }],
          ioMs: result.ioMs,
          cpuMs: 0,
          cacheStatus: result.cacheStatus
        };
      }
      
      // Filter $defs to only include the specified entity and its children
      // For now, just include the entity itself
      if (modelSchema.$defs && modelSchema.$defs[entityFilter]) {
        response.$defs = {
          [entityFilter]: modelSchema.$defs[entityFilter]
        };
      }
      
      // Filter properties to only include the specified entity
      if (modelSchema.properties && modelSchema.properties[entityFilter]) {
        response.properties = {
          [entityFilter]: modelSchema.properties[entityFilter]
        };
      }
    }
  }
  
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(response, null, 2)
      }
    ],
    ioMs: result.ioMs,
    cpuMs: 0,
    cacheStatus: result.cacheStatus
  };
}
