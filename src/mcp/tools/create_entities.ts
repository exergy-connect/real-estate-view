import { Validator } from '@cfworker/json-schema';
import { CacheStatus, updateCachedString } from '../../cache';
import { loadCachedModel } from './get_model';
import { loadCachedEntity } from './get_entity';

/**
 * Convert primary key values to sortable string format
 * Similar to Python's pk_values_to_sortable_string
 */
function pkValuesToSortableString(values: (string | number)[]): string {
  return values.map(v => {
    if (typeof v === 'string') {
      return v.toLowerCase();
    }
    return String(v);
  }).join('|');
}

/**
 * Make value hashable for primary key tuple
 * Arrays are converted to sortable string representation
 */
function makeHashable(value: any): any {
  if (Array.isArray(value)) {
    const sortedElements = [...value].map(v => String(v)).sort();
    return sortedElements.join('|');
  }
  return value;
}

/**
 * Extract primary keys from entity schema
 */
function extractPrimaryKeys(entitySchema: any): string[] {
  // Check for x-primaryKey extension in properties
  if (entitySchema.properties) {
    const primaryKeyFields: string[] = [];
    for (const [fieldName, fieldSchema] of Object.entries(entitySchema.properties)) {
      if (typeof fieldSchema === 'object' && fieldSchema !== null) {
        // Check for x-primaryKey extension
        if ((fieldSchema as any)['x-primaryKey'] === true) {
          primaryKeyFields.push(fieldName);
        }
      }
    }
    if (primaryKeyFields.length > 0) {
      return primaryKeyFields;
    }
  }
  
  // Fallback: use required fields (first required field is often the primary key)
  if (entitySchema.required && Array.isArray(entitySchema.required) && entitySchema.required.length > 0) {
    return [entitySchema.required[0]];
  }
  
  // Final fallback: check for common primary key field names
  if (entitySchema.properties) {
    const props = Object.keys(entitySchema.properties);
    if (props.includes('id')) return ['id'];
    if (props.includes('name')) return ['name'];
    if (props.includes('pk')) return ['pk'];
  }
  return [];
}

/**
 * Tool definition for create_entities
 */
export function createEntitiesToolDefinition() {
  return {
    name: 'create_entities',
    description: (
      'Create multiple entity instances. Validates all entities against the consolidated schema ' +
      'and stores them in the session. All created entities are included in the session feedback ' +
      'when finalize_session is called.'
    ),
    inputSchema: {
      type: 'object',
      properties: {
        entities: {
          type: 'object',
          description: (
            'Entities to create, structured as the consolidated schema format: ' +
            '{ entity_name: [entity_data, ...], ... }. Each entity_name must match the model definition exactly.'
          ),
        },
        ai_reasoning: {
          type: 'string',
          description: "The AI's reasoning for why these entities are being created",
        },
        session_id: {
          type: 'string',
          description: (
            'session ID returned by get_model. ' +
            'Use this to associate entity creation with a session for tracking.'
          ),
        },
      },
      required: ['entities', 'ai_reasoning', 'session_id'],
    },
  };
}

/**
 * Handler for create_entities tool calls
 */
export async function handleCreateEntities(
  args: any,
  context: { env: any; ctx: any; origin: string }
): Promise<{ content: Array<{ type: string; text: string; isError?: boolean }>; ioMs: number; cpuMs: number; cacheStatus: CacheStatus }> {
  const ioStart = performance.now();
  const { entities, ai_reasoning, session_id } = args;

  try {
    // Load model to get consolidated schema
    const modelResult = await loadCachedModel(context.env, context.ctx, context.origin, true);
    const modelSchema = modelResult.model;
    const ioMs = performance.now() - ioStart;

    const cpuStart = performance.now();

    // Validate against the consolidated schema as-is
    // The schema already contains $defs, so $ref resolution should work automatically
    const validator = new Validator(modelSchema, '2020-12', false);

    // Validate the entities structure against the consolidated schema
    const validationResult = validator.validate(entities);
    if (!validationResult.valid) {
      const errors = validationResult.errors.map((err: any) => {
        const path = err.instanceLocation || err.schemaLocation || '';
        return `${err.error} (path: ${path})`;
      }).join('; ');
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'Validation failed',
            message: errors,
            error_type: 'ValidationError',
          }, null, 2),
          isError: true,
        }],
        ioMs,
        cpuMs: performance.now() - cpuStart,
        cacheStatus: CacheStatus.ERROR,
      };
    }

    // Process all entities and add to L2 cache
    const created: Array<{ entity: string; primary_key: any }> = [];
    const errors: Array<{ entity: string; primary_key?: any; message: string }> = [];

    // Iterate over all entity types in the entities object
    for (const [entityType, entityArray] of Object.entries(entities)) {
      if (!Array.isArray(entityArray)) {
        errors.push({
          entity: entityType,
          message: `Entity type '${entityType}' must be an array`,
        });
        continue;
      }

      // Get entity schema from $defs
      // Entity type must exist in model since validation already passed
      const entitySchema = modelSchema.$defs[entityType];
      const primaryKeys = extractPrimaryKeys(entitySchema);

      // Process new entities: normalize and generate primary keys
      // Entity store format is {pk_string: entity_data}, so duplicates would overwrite
      // We'll check for conflicts with existing data in mergeEntities
      const processedEntities = new Map<string, any>(); // pkString -> normalizedData
      for (const entityData of entityArray) {
        // Normalize primary key to lowercase (as per data format requirements)
        const normalizedData = { ...entityData };
        
        // Normalize primary key fields (lowercase strings)
        for (const pkField of primaryKeys) {
          if (pkField in normalizedData) {
            const value = normalizedData[pkField];
            if (typeof value === 'string') {
              normalizedData[pkField] = value.toLowerCase();
            }
          }
        }

        // Generate primary key string for entity store format
        let pkString: string;
        if (primaryKeys.length > 0) {
          const pkValues = primaryKeys.map(pk => {
            const value = normalizedData[pk];
            return typeof value === 'string' ? value.toLowerCase() : String(value);
          });
          pkString = pkValuesToSortableString(pkValues);
        } else {
          pkString = normalizedData.name || String(Math.abs(JSON.stringify(normalizedData).split('').reduce((a, b) => {
            a = ((a << 5) - a) + b.charCodeAt(0);
            return a & a;
          }, 0)));
        }

        // In entity store format, duplicate keys overwrite (not possible to have duplicates)
        // Later duplicates will overwrite earlier ones - this is expected behavior
        processedEntities.set(pkString, normalizedData);
      }

      // Load existing entity data using full cache hierarchy (L1 -> L2 -> Network)
      const entityResult = await loadCachedEntity(entityType, context.env, context.ctx, context.origin);
      let existingData: Record<string, any> = entityResult.entityData || {};
      
      // Merge new entities, checking for conflicts
      for (const [pkString, normalizedData] of processedEntities.entries()) {
        if (pkString in existingData) {
          errors.push({
            entity: entityType,
            primary_key: pkString,
            message: `An entity of type '${entityType}' with this primary key already exists`,
          });
          continue;
        }
        existingData[pkString] = normalizedData;
        created.push({ entity: entityType, primary_key: pkString });
      }

      // Prepare for update
      const params = entityResult.params;

      // Write updated entity data back to L2 cache using updateCachedString
      const timestamp = Date.now();
      const etag = `"${timestamp}"`;
      const jsonData = JSON.stringify(existingData);
      
      await updateCachedString(params, jsonData, etag, timestamp);
    }

    const cpuMs = performance.now() - cpuStart;

    const response: any = {
      success: true,
      created_count: created.length,
      created,
    };

    if (errors.length > 0) {
      response.errors = errors;
      response.error_count = errors.length;
    }

    response.message = `Created ${created.length} entity/entities${errors.length > 0 ? `, ${errors.length} error(s)` : ''}`;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response, null, 2),
      }],
      ioMs,
      cpuMs,
      cacheStatus: CacheStatus.HIT_L1_RAM, // Created in memory
    };

  } catch (error: any) {
    const ioMs = performance.now() - ioStart;
    const cpuMs = 0;
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: `Failed to create entities: ${error.message || String(error)}`,
          error_type: error.constructor?.name || 'Error',
        }, null, 2),
        isError: true,
      }],
      ioMs,
      cpuMs,
      cacheStatus: CacheStatus.ERROR,
    };
  }
}

