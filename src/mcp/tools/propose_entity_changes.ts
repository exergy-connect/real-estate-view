import { Validator } from '@cfworker/json-schema';
import { stringify } from 'yaml';
import { CacheStatus } from '../../cache';
import { createGitHubPR } from '../../github_pr';
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
 * Tool definition for propose_entity_changes
 */
export function proposeEntityChangesToolDefinition() {
  return {
    name: 'propose_entity_changes',
    description: (
      'Propose entity changes by creating a GitHub PR. Validates all entities against the consolidated schema ' +
      'and creates a pull request with the proposed changes. Supports both creating new entities and updating existing ones.'
    ),
    inputSchema: {
      type: 'object',
      properties: {
        entities: {
          type: 'object',
          description: (
            'Entities to propose, structured as the consolidated schema format: ' +
            '{ entity_name: [entity_data, ...], ... }. Each entity_name must match the model definition exactly.'
          ),
        },
        ai_reasoning: {
          type: 'string',
          description: "The AI's reasoning for why these entity changes are being proposed",
        },
        session_id: {
          type: 'string',
          description: (
            'session ID returned by get_model. ' +
            'Use this to associate entity changes with a session for tracking.'
          ),
        },
        operation: {
          type: 'string',
          enum: ['create', 'update'],
          description: (
            "Operation mode: 'create' (default) to propose new entities, or 'update' to propose changes to existing entities. " +
            "In 'create' mode, entities must not already exist. In 'update' mode, entities must already exist."
          ),
          default: 'create',
        },
      },
      required: ['entities', 'ai_reasoning', 'session_id'],
    },
  };
}

/**
 * Handler for propose_entity_changes tool calls
 */
export async function handleProposeEntityChanges(
  args: any,
  context: { env: any; ctx: any; origin: string }
): Promise<{ content: Array<{ type: string; text: string; isError?: boolean }>; ioMs: number; cpuMs: number; cacheStatus: CacheStatus }> {
  const ioStart = performance.now();
  const { entities, ai_reasoning, session_id, operation = 'create' } = args;

  try {
    // Load model to get consolidated schema (always parse for this use case)
    const modelResult = await loadCachedModel(context.env, context.ctx, context.origin, true);
    const modelSchema = modelResult.model;
    const ioMs = performance.now() - ioStart;

    const cpuStart = performance.now();

    // Validate against the consolidated schema as-is
    // The schema already contains $defs, so $ref resolution should work automatically
    const validator = new Validator(modelSchema);

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

    // Process all entities and propose changes via GitHub PR
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

      // Process entities: normalize and generate primary keys
      // Entity store format is {pk_string: entity_data}, so duplicates would overwrite
      // We'll check for conflicts with existing data
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
      
      // Check for conflicts with existing entities based on operation mode
      const entitiesToProcess: any[] = [];
      const isUpdate = operation === 'update';
      
      for (const [pkString, normalizedData] of processedEntities.entries()) {
        const exists = pkString in existingData;
        
        if (isUpdate) {
          // update mode: entity MUST exist
          if (!exists) {
            errors.push({
              entity: entityType,
              primary_key: pkString,
              message: `Entity of type '${entityType}' with this primary key does not exist (update operation requires existing entities)`,
            });
            continue;
          }
        } else {
          // create mode: entity must NOT exist
          if (exists) {
            errors.push({
              entity: entityType,
              primary_key: pkString,
              message: `An entity of type '${entityType}' with this primary key already exists`,
            });
            continue;
          }
        }
        
        entitiesToProcess.push(normalizedData);
        created.push({ entity: entityType, primary_key: pkString });
      }

      // Only create PR if there are entities to process
      if (entitiesToProcess.length === 0) {
        continue;
      }

      // Get GitHub repository and base path from environment variables
      const githubRepo = context.env.GITHUB_REPO || 'exergy-connect/real-estate';
      const githubDataBasePath = context.env.GITHUB_DATA_BASE_PATH || 'har_model/data';

      // Create a GitHub PR with only the entities being processed (not existing ones)
      const branchName = `${isUpdate ? 'update' : 'create'}-entities-${entityType}-${Date.now()}`;
      const filePath = `${githubDataBasePath}/entities/${entityType}.yaml`;
      const commitMessage = `${isUpdate ? 'Update' : 'Create'} ${entityType} entities`;
      const prTitle = `${isUpdate ? 'Update' : 'Create'} ${entityType} entities`;
      const action = isUpdate ? 'updates' : 'adds';
      const prBody = `This PR ${action} ${created.length} ${entityType} entity/entities.\n\n${isUpdate ? 'Updated' : 'Created'} entities:\n${created.map(c => `- ${c.primary_key}`).join('\n')}\n\n## AI Reasoning\n\n${ai_reasoning}`;

      // Convert only entities being processed to YAML format (not existing ones)
      const yamlObject = { [entityType]: entitiesToProcess };
      const yamlContent = stringify(yamlObject, {
        indent: 2,
        lineWidth: 0,
        minContentWidth: 0
      });

      // Create PR in the specified repository
      const prResult = await createGitHubPR(context.env, {
        repository: githubRepo,
        branchName,
        filePath,
        fileContent: yamlContent,
        commitMessage,
        prTitle,
        prBody
      });

      if (!prResult.success) {
        errors.push({
          entity: entityType,
          primary_key: '',
          message: `Failed to create PR: ${prResult.message || 'Unknown error'}`,
        });
      }
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

    response.message = `Proposed changes for ${created.length} entity/entities${errors.length > 0 ? `, ${errors.length} error(s)` : ''}`;

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
          error: `Failed to propose entity changes: ${error.message || String(error)}`,
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
