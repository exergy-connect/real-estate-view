import * as jmespath from 'jmespath';
import { CacheStatus, loadCachedData } from '../../cache';

// TTL configuration for cached data (same as in index.ts)
const INITIAL_TTL_MS = 300 * 1000; // 5 minutes
const MAX_TTL_MS = 3600 * 1000;    // 1 hour

/**
 * Validate JMESPath query syntax
 * @param query The query string to validate
 * @returns Error response object if invalid, null if valid
 */
function validateJmespathQuery(query: string): { content: Array<{ type: string; text: string; isError?: boolean }>; ioMs: number; cpuMs: number; cacheStatus: CacheStatus } | null {
  // Check if query uses array projection [*] for entity projections (not allowed)
  // Note: [*] is incorrect for entity projections (entities are dict-indexed, not arrays)
  // But [*] is valid for array/composite fields (e.g., *.tags[*], *.field_name[*])
  // Allow | [] which is correct (converts object projection to array)
  // Patterns to reject:
  //   - entity[*] (entity name followed by [*])
  //   - .*[*] (object projection followed by [*], unless it's part of a field access pattern)
  // Patterns to allow:
  //   - *.field[*] or .field[*] (field access followed by [*])
  //   - | [] (pipe to array conversion)
  if (query.includes('[*]')) {
    // Check for pipe to array conversion (always allowed)
    if (/\|\s*\[\]/.test(query)) {
      // This is allowed, skip validation
    } else {
      // Find all [*] occurrences and check their context
      const arrayProjectionMatches = query.matchAll(/\[\*/g);
      let hasInvalidProjection = false;
      
      for (const match of arrayProjectionMatches) {
        const index = match.index!;
        const before = query.substring(Math.max(0, index - 20), index);
        
        // Check if this [*] follows a field access pattern (allowed)
        // Pattern: .field[*] or *.field[*] where field is a word
        const fieldArrayPattern = /\.\w+\[\*\]$/;
        if (fieldArrayPattern.test(before + '[*]')) {
          continue; // This is a field array access, allowed
        }
        
        // Check if this [*] follows an entity name (reject)
        // Pattern: entity[*] where entity is a word not preceded by .
        const entityArrayPattern = /(?:^|[^.])\w+\[\*\]$/;
        if (entityArrayPattern.test(before + '[*]')) {
          hasInvalidProjection = true;
          break;
        }
        
        // Check if this [*] follows object projection .* (reject unless it's part of field access)
        // Pattern: .*[*] that is not immediately preceded by a field name
        const objectProjectionArrayPattern = /\.\*\[\*\]$/;
        if (objectProjectionArrayPattern.test(before + '[*]')) {
          hasInvalidProjection = true;
          break;
        }
      }
      
      if (hasInvalidProjection) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Invalid query syntax',
              message: (
                'Entities are stored as dictionaries indexed by primary keys, not arrays. ' +
                'Use object projection `.*` instead of array projection `[*]` for entities.\n\n' +
                `Your query: ${query}\n` +
                'Example: Change `datacenter[*].name` to `datacenter.*.name`\n' +
                'Example: Change `datacenter[*].clusters[*].servers[?name==\'srv4\']` ' +
                'to `datacenter.*.clusters.*.servers[?name==\'srv4\']`\n\n' +
                'Note: `| []` is correct (converts object projection to array). ' +
                'Note: `*.field[*]` or `.field[*]` is correct for array/composite fields. ' +
                'Use query_examples tool to see correct syntax for your data model.'
              ),
              error_type: 'SyntaxError',
            }, null, 2),
            isError: true,
          }],
          ioMs: 0,
          cpuMs: 0,
          cacheStatus: CacheStatus.ERROR,
        };
      }
    }
  }

  // Check if query uses object projection without parentheses before filter
  // Pattern: entity.*[?filter] should be (entity.*)[?filter]
  const objectProjectionPattern = /\w+\.\*\[/;
  const parenthesesPattern = /\(\w+\.\*\)\[/;
  if (objectProjectionPattern.test(query) && !parenthesesPattern.test(query)) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Invalid query syntax',
          message: (
            'JMESPath requires parentheses around object projections before applying filters. ' +
            'Wrap the projection in parentheses before the filter.\n\n' +
            `Your query: ${query}\n` +
            'Example: Change `vm.*[?contains(name, \'emqx\')]` ' +
            'to `(vm.*)[?contains(name, \'emqx\')]`\n\n' +
            'The pattern `entity.*[?filter]` doesn\'t work. Use `(entity.*)[?filter]` instead.'
          ),
          error_type: 'SyntaxError',
        }, null, 2),
        isError: true,
      }],
      ioMs: 0,
      cpuMs: 0,
      cacheStatus: CacheStatus.ERROR,
    };
  }

  return null; // Query is valid
}

/**
 * Tool definition for jmespath_query
 */
export function jmespathQueryToolDefinition() {
  return {
    name: 'jmespath_query',
    description: (
      'Execute JMESPath queries against the data. See query_examples for syntax.'
    ),
    inputSchema: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description: (
            'Entity class to use as the root of the query. ' +
            'Queries are executed against the set of all those entities, indexed by their primary key. ' +
            'Entity names MUST match the model definition exactly.'
          ),
        },
        query: {
          type: 'string',
          description: (
            'JMESPath query expression, relative to the root. ' +
            'Syntax: Use object projection `.*` for entities (not `[*]`). ' +
            'Wrap projections in parentheses before filters: `(entity.*)[?filter]`. ' +
            'For entity trees (with root): `(*)[?level == \`High\`]`. ' +
            'For consolidated data: `data.state.*.cities[*].zipcodes[*].properties[*]`. ' +
            'Use lowercase for primary key values. Entity names MUST match the model definition exactly.'
          ),
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
            'Use this to associate queries with a session for tracking and follow-up queries.'
          ),
        },
      },
      required: ['root', 'query', 'ai_reasoning', 'session_id'],
    },
  };
}

/**
 * Handler for jmespath_query tool calls
 */
export async function handleJmespathQuery(
  args: any,
  context: { env: any; ctx: any; origin: string }
): Promise<{ content: Array<{ type: string; text: string; isError?: boolean }>; ioMs: number; cpuMs: number; cacheStatus: any }> {
  let { query, session_id, updated_prompt, ai_reasoning, root } = args;
  
  try {
    // Validate root parameter
    if (!root || typeof root !== 'string' || root.trim() === '') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'Invalid root parameter',
            message: 'Root must be a non-empty string specifying the entity class',
          }, null, 2),
          isError: true,
        }],
        ioMs: 0,
        cpuMs: 0,
        cacheStatus: CacheStatus.ERROR,
      };
    }

    // Validate query parameter
    if (!query || typeof query !== 'string') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'Invalid query parameter',
            message: 'Query must be a non-empty string',
          }, null, 2),
          isError: true,
        }],
        ioMs: 0,
        cpuMs: 0,
        cacheStatus: CacheStatus.ERROR,
      };
    }

    // Auto-fix common syntax error: *[ should be (*)[
    // Parentheses are required around object projection before applying filters
    if (query.startsWith('*[')) {
      query = '(*)' + query.substring(1);
    }

    // Validate query syntax, skip for now
    // const validationError = validateJmespathQuery(query);
    // if (validationError) {
    //   return validationError;
    // }

    // Load data from entity file (root is mandatory and non-empty)
    const assetPath = `output/data/entities/${root}.json`;
    const assetUrl = new URL(assetPath, context.origin).toString();
    
    const dataResult = await loadCachedData(assetUrl, context.env, context.ctx, {
      initial_ttl_ms: INITIAL_TTL_MS,
      max_ttl_ms: MAX_TTL_MS,
      process: JSON.parse,
    });
    const data = dataResult.data;

    // Execute JMESPath query
    const cpuStart = performance.now();
    let result: any;
    try {
      result = jmespath.search(data, query);
    } catch (error: any) {
      // Handle JMESPath parse/execution errors
      const errorType = error.name === 'SyntaxError' ? 'ParseError' : 'JMESPathError';
      const errorMsg = errorType === 'ParseError' 
        ? `JMESPath syntax error: ${error.message}` 
        : `JMESPath error: ${error.message}`;
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            query,
            error: errorMsg,
            error_type: errorType,
            help: 'See JMESPath documentation: https://jmespath.org/',
            suggestion: 'Use get_model first to understand the data structure',
          }, null, 2),
          isError: true,
        }],
        ioMs: dataResult.ioMs,
        cpuMs: performance.now() - cpuStart,
        cacheStatus: dataResult.cacheStatus,
      };
    }
    const cpuMs = performance.now() - cpuStart;

    // If result is null, provide diagnostic information
    if (result === null || result === undefined) {
      // Extract entity type from query for diagnostics
      const entityMatch = query.match(/[\(]?(\w+)\.\*/);
      if (entityMatch) {
        const entityType = entityMatch[1];
        if (data && data[entityType]) {
          const entityData = data[entityType];
          const sampleCount = typeof entityData === 'object' && !Array.isArray(entityData)
            ? Object.keys(entityData).length
            : 0;
          
          // Get a sample entity to show available fields
          const sampleEntity = sampleCount > 0 && typeof entityData === 'object' && !Array.isArray(entityData)
            ? Object.values(entityData)[0]
            : null;
          const sampleFields = sampleEntity && typeof sampleEntity === 'object'
            ? Object.keys(sampleEntity)
            : [];

          const response: any = {
            query,
            result: null,
            result_type: 'NoneType',
            result_count: 0,
            diagnostics: {
              entity_type: entityType,
              entity_exists: true,
              total_entities: sampleCount,
              sample_fields: sampleFields,
              sample_entity: sampleEntity,
              note: 'Query returned null. This usually means no records ' +
                    'matched the filter, or the data structure doesn\'t ' +
                    'match the query.',
            },
          };
          
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(response, null, 2),
            }],
            ioMs: dataResult.ioMs,
            cpuMs,
            cacheStatus: dataResult.cacheStatus,
          };
        }
      }
    }

    // Calculate result_count: 0 for None, 0 for numeric 0, length for list/dict, 1 for other scalars
    let resultCount: number;
    if (result === null || result === undefined) {
      resultCount = 0;
    } else if (Array.isArray(result)) {
      resultCount = result.length;
    } else if (typeof result === 'object') {
      resultCount = Object.keys(result).length;
    } else if (typeof result === 'number' && result === 0) {
      // Numeric 0 (e.g., from length() function) represents 0 results
      resultCount = 0;
    } else {
      // Scalar result (non-zero number, string, bool, etc.)
      resultCount = 1;
    }

    const response: any = {
      query,
      result,
      result_type: result === null || result === undefined 
        ? 'NoneType' 
        : Array.isArray(result) 
          ? 'Array' 
          : typeof result === 'object' 
            ? 'Object' 
            : typeof result,
      result_count: resultCount
    };

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response, null, 2),
      }],
      ioMs: dataResult.ioMs,
      cpuMs,
      cacheStatus: dataResult.cacheStatus,
    };
  } catch (error: any) {
    // Handle unexpected errors
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          query: args.query || '',
          error: `Unexpected error: ${error.message || String(error)}`,
          error_type: error.constructor?.name || 'Error',
        }, null, 2),
        isError: true,
      }],
      ioMs: 0,
      cpuMs: 0,
      cacheStatus: CacheStatus.ERROR,
    };
  }
}
