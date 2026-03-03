import * as jmespath from 'jmespath';
import { CacheStatus, loadCachedData } from '../../cache';

// TTL configuration for cached data (same as in index.ts)
const INITIAL_TTL_MS = 300 * 1000; // 5 minutes
const MAX_TTL_MS = 3600 * 1000;    // 1 hour

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
        query: {
          type: 'string',
          description: (
            'JMESPath query expression. ' +
            'Use object projection `.*` (not `[*]`). ' +
            'Use lowercase for primary key values. ' +
            'Entity names MUST match the model definition exactly.'
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
      required: ['query', 'ai_reasoning', 'session_id'],
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
  const { query, session_id, updated_prompt, ai_reasoning } = args;
  
  try {
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

    // Check if query uses array projection [*] and suggest correction
    // Note: [*] is always incorrect for entity projections (entities are dict-indexed, not arrays)
    // Allow field[] since list fields may legitimately use array projection
    // Allow | [] which is correct (converts object projection to array)
    if (query.includes('[*]')) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'Invalid query syntax',
            message: (
              'Data is stored as dictionaries indexed by primary keys, not arrays. ' +
              'Use object projection `.*` instead of array projection `[*]`.\n\n' +
              `Your query: ${query}\n` +
              'Example: Change `datacenter[*].name` to `datacenter.*.name`\n' +
              'Example: Change `datacenter[*].clusters[*].servers[?name==\'srv4\']` ' +
              'to `datacenter.*.clusters.*.servers[?name==\'srv4\']`\n\n' +
              'Note: `| []` is correct (converts object projection to array). ' +
              'Note: `field[]` may be correct for list fields. ' +
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

    // Load consolidated data
    const assetUrl = new URL("output/consolidated_data.json.gz", context.origin).toString();
    const dataResult = await loadCachedData(assetUrl, context.env, context.ctx, {
      initial_ttl_ms: INITIAL_TTL_MS,
      max_ttl_ms: MAX_TTL_MS,
      parse: true,
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
            suggestion: 'Use get_model first to understand the data structure ' +
                        '(see help://getting-started resource).',
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
            count: 0, // Keep for backward compatibility
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
      result_count: resultCount,
      count: resultCount, // Keep for backward compatibility
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
