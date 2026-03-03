import { CacheStatus, getCurrentCacheStats, mergeStatsFromMetadata } from '../../cache';

/**
 * Tool definition for get_cache_stats
 */
export function getCacheStatsToolDefinition() {
  return {
    name: 'get_cache_stats',
    description: 'Get cache statistics including effective TTL per entity class and global cache hit/miss counters (snapshot)',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  };
}

/**
 * Extract entity class from cache key
 * Examples:
 *   "consolidated_model.json" -> "model"
 *   "consolidated_data.json" -> "data"
 *   "entity_school.json" -> "school"
 */
function extractEntityClass(cacheKey: string): string {
  if (cacheKey.startsWith('entity_')) {
    // Extract entity name from "entity_{name}.json"
    const match = cacheKey.match(/^entity_(.+)\.json$/);
    return match ? match[1] : cacheKey;
  }
  if (cacheKey === 'consolidated_model.json') {
    return 'model';
  }
  if (cacheKey === 'consolidated_data.json') {
    return 'data';
  }
  return cacheKey;
}

/**
 * Handler for get_cache_stats tool calls
 */
export async function handleGetCacheStats(
  args: any,
  context: { env: any; ctx: any; origin: string }
): Promise<{ content: Array<{ type: string; text: string }>; ioMs: number; cpuMs: number; cacheStatus: any }> {
  let cpuStart: number | undefined;
  let ioStart: number | undefined;
  try {
    const kv = context.env.CACHE_KV;
    if (!kv) {
      throw new Error('CACHE_KV namespace not available');
    }

    // Start I/O timing for key operations
    ioStart = performance.now();

    // List all keys in the KV namespace
    const keys: string[] = [];
    let cursor: string | undefined;
    
    do {
      const listResult = await kv.list({ cursor });
      keys.push(...listResult.keys.map((k: any) => k.name));
      cursor = listResult.list_complete ? undefined : listResult.cursor;
    } while (cursor);

    // Fetch metadata for each key
    const metadataPromises = keys.map(async (key) => {
      try {
        const { metadata } = await kv.getWithMetadata(key, 'text');
        return { key, metadata };
      } catch (error) {
        console.error(`Error fetching metadata for key ${key}:`, error);
        return { key, metadata: null };
      }
    });

    const metadataResults = await Promise.all(metadataPromises);

    // Start CPU timing after all I/O operations are complete
    cpuStart = performance.now();

    // Group keys by entity class for effective TTL reporting
    // There's at most 1 key per entity class
    const statsByEntity: Record<string, {
      key: string | null;
      effectiveTTLMinutes: number | null;
    }> = {};

    // Track global cache stats (snapshots from metadata)
    // We'll find the snapshot with the maximum value in any category
    const allSnapshots: Array<{
      key: string;
      timestamp: number;
      stats: Record<CacheStatus, number>;
      maxValue: number;
    }> = [];

    // Process metadata
    for (const { key, metadata } of metadataResults) {
      if (!metadata) continue;

      const entityClass = extractEntityClass(key);
      if (!statsByEntity[entityClass]) {
        statsByEntity[entityClass] = {
          key: null,
          effectiveTTLMinutes: null
        };
      }
      const entityStats = statsByEntity[entityClass];

      // Store the key (there's at most 1 per entity class)
      entityStats.key = key;

      // Extract effective_ttl_minutes (single value per entity class)
      const effectiveTTLMinutes = (metadata as any)?.effective_ttl_minutes;
      if (effectiveTTLMinutes !== undefined) {
        entityStats.effectiveTTLMinutes = effectiveTTLMinutes;
      }

      // Extract global cacheStats snapshot (simple array of numbers)
      const cacheStatsArray = (metadata as any)?.cacheStats;
      const cachedAt = (metadata as any)?.cachedAt || 0;
      
      if (Array.isArray(cacheStatsArray) && cacheStatsArray.every((v: any) => typeof v === 'number')) {
        // Convert simple number array to Record for easier handling
        // Array contains only final states (order matches Object.keys(CACHE_STATS) in cache.ts)
        // Initialize all CacheStatus values to 0, then populate final states from array
        const stats: Record<CacheStatus, number> = {
          [CacheStatus.MISS_L1]: 0,
          [CacheStatus.STALE_L1]: 0,
          [CacheStatus.HIT_L1_RAM]: 0,
          [CacheStatus.MISS_L1_HIT_L2]: 0,
          [CacheStatus.MISS_L1_STALE_L2]: 0,
          [CacheStatus.MISS_L1_MISS_L2]: 0,
          [CacheStatus.STALE_L1_HIT_L2]: 0,
          [CacheStatus.STALE_L1_STALE_L2]: 0,
          [CacheStatus.STALE_L1_MISS_L2]: 0,
          [CacheStatus.STALE_REVALIDATING]: 0,
          [CacheStatus.ERROR]: 0
        };
        
        // Final states in the order they appear in CACHE_STATS (excludes intermediate states)
        const finalStates: CacheStatus[] = [
          CacheStatus.HIT_L1_RAM,
          CacheStatus.MISS_L1_HIT_L2,
          CacheStatus.MISS_L1_STALE_L2,
          CacheStatus.MISS_L1_MISS_L2,
          CacheStatus.STALE_L1_HIT_L2,
          CacheStatus.STALE_L1_STALE_L2,
          CacheStatus.STALE_L1_MISS_L2,
          CacheStatus.STALE_REVALIDATING,
          CacheStatus.ERROR
        ];
        
        let maxValue = 0;
        for (let i = 0; i < cacheStatsArray.length && i < finalStates.length; i++) {
          const status = finalStates[i];
          const value = cacheStatsArray[i] || 0;
          stats[status] = value;
          maxValue = Math.max(maxValue, value);
        }
        allSnapshots.push({
          key,
          timestamp: cachedAt,
          stats,
          maxValue
        });
      }
    }

    // Build effective TTL report for each entity class
    const byEntityClass: Record<string, any> = {};
    
    for (const [entityClass, stats] of Object.entries(statsByEntity)) {
      byEntityClass[entityClass] = {
        key: stats.key,
        effective_ttl_minutes: stats.effectiveTTLMinutes
      };
    }

    // Find the snapshot with the maximum value in any category from KV
    let selectedSnapshot: typeof allSnapshots[0] | null = null;
    if (allSnapshots.length > 0) {
      selectedSnapshot = allSnapshots.reduce((max, snapshot) => 
        snapshot.maxValue > max.maxValue ? snapshot : max
      );
    }

    // Merge selected snapshot into global stats using mergeStatsFromMetadata
    if (selectedSnapshot) {
      // Convert selected snapshot stats to simple number array for mergeStatsFromMetadata
      // Order matches Object.keys(CACHE_STATS) in cache.ts - only final states
      const finalStates: CacheStatus[] = [
        CacheStatus.HIT_L1_RAM,
        CacheStatus.MISS_L1_HIT_L2,
        CacheStatus.MISS_L1_STALE_L2,
        CacheStatus.MISS_L1_MISS_L2,
        CacheStatus.STALE_L1_HIT_L2,
        CacheStatus.STALE_L1_STALE_L2,
        CacheStatus.STALE_L1_MISS_L2,
        CacheStatus.STALE_REVALIDATING,
        CacheStatus.ERROR
      ];
      const statsArray: number[] = finalStates.map(status => selectedSnapshot.stats[status] || 0);
      mergeStatsFromMetadata(statsArray);
    }

    // Get the merged stats from global CACHE_STATS
    const mergedStats = getCurrentCacheStats();
    const maxValue = Math.max(...Object.values(mergedStats));

    // Calculate global cache statistics from the merged stats
    let globalCacheStats: any = null;
    {
      // Initialize all status counters for display
      const allStats: Record<CacheStatus, number> = {} as Record<CacheStatus, number>;
      for (const status of Object.values(CacheStatus)) {
        allStats[status as CacheStatus] = mergedStats[status as CacheStatus] || 0;
      }

      // Calculate total cache operations
      const totalOps = Object.values(allStats).reduce((sum, count) => sum + count, 0);
      
      // Calculate hit rate (HIT_L1_RAM + MISS_L1_HIT_L2 + STALE_L1_HIT_L2)
      const hits = 
        (allStats[CacheStatus.HIT_L1_RAM] || 0) +
        (allStats[CacheStatus.MISS_L1_HIT_L2] || 0) +
        (allStats[CacheStatus.STALE_L1_HIT_L2] || 0);
      const hitRate = totalOps > 0 ? (hits / totalOps) * 100 : 0;

      globalCacheStats = {
        snapshot_from_key: selectedSnapshot ? selectedSnapshot.key : 'current',
        snapshot_timestamp: selectedSnapshot ? selectedSnapshot.timestamp : Date.now(),
        snapshot_max_value: maxValue,
        cache_stats: allStats,
        total_operations: totalOps,
        hit_rate_percent: Math.round(hitRate * 100) / 100
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          summary: {
            total_keys: keys.length,
            entity_classes: Object.keys(statsByEntity).length
          },
          effective_ttl_by_entity_class: byEntityClass,
          global_cache_stats: globalCacheStats
        }, null, 2)
      }],
      ioMs: performance.now() - ioStart!,
      cpuMs: performance.now() - cpuStart!,
      cacheStatus: CacheStatus.HIT_L1_RAM // This tool doesn't use the cache itself
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Failed to retrieve cache statistics',
          message: error instanceof Error ? error.message : String(error)
        }, null, 2)
      }],
      ioMs: ioStart !== undefined ? performance.now() - ioStart : 0,
      cpuMs: cpuStart !== undefined ? performance.now() - cpuStart : 0,
      cacheStatus: CacheStatus.ERROR
    };
  }
}
