// GLOBAL SCOPE: Persists in warm Worker isolates RAM
// Separate caches for string and parsed JSON data
const L1_CACHE_STRING = new Map<string, { json: string; validatedAt: number; etag: string }>();
const L1_CACHE_PARSED = new Map<string, { json: any; validatedAt: number; etag: string }>();


/**
 * Maximum number of timestamps to keep in cache metadata
 * Limited to 16 due to Cloudflare Workers KV metadata size constraint of 1kB
 * Each timestamp is stored as an integer (minutes since epoch), so 16 timestamps
 * plus other metadata fields (cachedAt, etag, writeCount, effective_ttl_minutes, cacheStats) must fit within 1kB
 */
const MAX_TIMESTAMP_HISTORY = 16;

/**
 * Fetcher function type for getCachedEntity
 * Returns data and etag, with data being null if content hasn't changed (304 response)
 */
export type EntityFetcher = (
  oldEtag?: string
) => Promise<{ data: string | null; etag: string }>;

/**
 * Cache status enum for getCachedEntity results
 * Represents all possible combinations of L1 (RAM) and L2 (KV) cache states
 */
export enum CacheStatus {
  /** L1 cache miss (not in memory) - intermediate state */
  MISS_L1 = 'MISS_L1',
  /** L1 cache stale (in memory but expired) - intermediate state */
  STALE_L1 = 'STALE_L1',
  
  /** L1 hit (fresh) - fastest path */
  HIT_L1_RAM = 'HIT_L1_RAM',
  
  /** L1 miss, L2 hit (fresh) */
  MISS_L1_HIT_L2 = 'MISS_L1_HIT_L2',
  /** L1 miss, L2 stale (revalidating in background) */
  MISS_L1_STALE_L2 = 'MISS_L1_STALE_L2',
  /** L1 miss, L2 miss, fetched fresh from network */
  MISS_L1_MISS_L2 = 'MISS_L1_MISS_L2',
  
  /** L1 stale, L2 hit (fresh) */
  STALE_L1_HIT_L2 = 'STALE_L1_HIT_L2',
  /** L1 stale, L2 stale (revalidating in background) */
  STALE_L1_STALE_L2 = 'STALE_L1_STALE_L2',
  /** L1 stale, L2 miss, fetched fresh from network */
  STALE_L1_MISS_L2 = 'STALE_L1_MISS_L2',
  
  /** Serving stale data while revalidating (network fallback with stale data) */
  STALE_REVALIDATING = 'STALE_REVALIDATING',
  
  /** Error occurred during cache operation */
  ERROR = 'ERROR'
}

/**
 * Type for final cache statuses (excludes intermediate states)
 * Intermediate states (MISS_L1, STALE_L1) are not stored in L2 metadata to optimize storage
 */
export type FinalCacheStatus = Exclude<CacheStatus, CacheStatus.MISS_L1 | CacheStatus.STALE_L1>;

/**
 * Global cache statistics - tracks counters for final cache statuses only
 * Intermediate states (MISS_L1, STALE_L1) are not counted to optimize L2 metadata storage
 * Persists in warm Worker isolates RAM
 */
export const CACHE_STATS: Record<FinalCacheStatus, number> = {
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

/**
 * Global flag to track if stats have been merged from KV metadata
 * Prevents double-counting - stats are merged once when first encountered
 */
let STATS_MERGED_FROM_KV = false;

/**
 * Increment cache statistics counter for a given status
 * Only final states are counted (intermediate states are ignored to optimize L2 metadata storage)
 */
function incrementCacheStats(status: CacheStatus): void {
  // Only count final states, ignore intermediate states
  if (status !== CacheStatus.MISS_L1 && status !== CacheStatus.STALE_L1) {
    CACHE_STATS[status as FinalCacheStatus] = (CACHE_STATS[status as FinalCacheStatus] || 0) + 1;
  }
}

/**
 * Helper to increment cache stats and return a result
 * Combines the common pattern of incrementing stats and returning a GetCachedJSONResult
 */
function returnWithStats(
  status: CacheStatus,
  result: Omit<GetCachedJSONResult, 'cacheStatus'>
): GetCachedJSONResult {
  incrementCacheStats(status);
  return {
    cacheStatus: status,
    ...result
  };
}

/**
 * Get a snapshot of current cache statistics as a simple array of numbers
 * Order matches Object.keys(CACHE_STATS) - only final states (excludes intermediate states)
 * Optimized for L2 metadata storage
 */
function getCacheStatsSnapshot(): number[] {
  return Object.values(CACHE_STATS);
}

/**
 * Merge stats from metadata into global stats (only once, when first encountered)
 * @param metadataStats Simple array of numbers from metadata (as read from KV metadata)
 * Order matches Object.keys(CACHE_STATS) - only final states (excludes intermediate states)
 */
export function mergeStatsFromMetadata(
  metadataStats?: number[] | null
): void {
  if (STATS_MERGED_FROM_KV || !metadataStats) {
    return;
  }
  
  // Get the order of final CacheStatus values to map array indices
  // Order matches Object.keys(CACHE_STATS) - only final states
  const statusOrder = Object.keys(CACHE_STATS) as FinalCacheStatus[];
  
  // Merge stats from metadata array into global stats
  for (let i = 0; i < metadataStats.length && i < statusOrder.length; i++) {
    const status = statusOrder[i];
    const count = metadataStats[i] || 0;
    CACHE_STATS[status] = (CACHE_STATS[status] || 0) + count;
  }
  
  // Mark stats as merged
  STATS_MERGED_FROM_KV = true;
}

/**
 * Return type for getCachedJSON
 */
export interface GetCachedJSONResult {
  /** Cache status */
  cacheStatus: CacheStatus;
  /** Remaining TTL in milliseconds */
  ttl_ms: number;
  /** L1 cache entry (present when L1 cache has data) */
  l1Entry?: { json: any; validatedAt: number; etag: string };
  /** The cached JSON data (processed by the process function) */
  data?: any;
}

/**
 * Common parameters for cache operations
 */
export interface CacheParams {
  env: any;
  ctx: any;
  cacheKey: string;
  initial_ttl_ms: number;
  max_ttl_ms: number;
  timestampHistoryCount: number;
  process?: (raw: string) => any;
  fetcher: EntityFetcher;
}

/**
 * Helper to create CacheParams with reasonable defaults
 * @param required Required parameters (env, ctx, cacheKey, fetcher, process)
 * @param options Optional TTL and history count overrides
 * @returns CacheParams with defaults applied
 */
export function createCacheParams(
  required: {
    env: any;
    ctx: any;
    cacheKey: string;
    fetcher: EntityFetcher;
    process?: (raw: string) => any;
  },
  options?: {
    initial_ttl_ms?: number;
    max_ttl_ms?: number;
    timestampHistoryCount?: number;
  }
): CacheParams {
  const initial_ttl_ms = options?.initial_ttl_ms ?? 300 * 1000;      // Default: 5 minutes
  const max_ttl_ms = options?.max_ttl_ms ?? initial_ttl_ms * 3;      // Default: 3x initial TTL
  // Limit to MAX_TIMESTAMP_HISTORY due to 1kB metadata size constraint
  const timestampHistoryCount = Math.min(options?.timestampHistoryCount ?? 5, MAX_TIMESTAMP_HISTORY);

  return {
    ...required,
    initial_ttl_ms,
    max_ttl_ms,
    timestampHistoryCount
  };
}

/**
 * Calculate effective TTL based on update timestamp history
 * Uses median interval between updates, optionally clamped between initial_ttl_ms and max_ttl_ms
 * Returns TTL in minutes (to match storage format)
 * @param clampMax If true, clamps result to max_ttl_ms. If false, only clamps to initial_ttl_ms minimum.
 */
function calculateEffectiveTTL(
  timestampsMinutes: number[],
  initial_ttl_ms: number,
  max_ttl_ms: number,
  clampMax: boolean = true
): number {
  if (timestampsMinutes.length < 2) {
    // Not enough history, use initial TTL (convert ms to minutes)
    return Math.floor(initial_ttl_ms / (60 * 1000));
  }

  // Calculate intervals between consecutive timestamps (in minutes)
  const intervalsMinutes: number[] = [];
  for (let i = 1; i < timestampsMinutes.length; i++) {
    intervalsMinutes.push(timestampsMinutes[i] - timestampsMinutes[i - 1]);
  }

  // Use median interval as the effective TTL
  intervalsMinutes.sort((a, b) => a - b);
  const medianIntervalMinutes = intervalsMinutes[Math.floor(intervalsMinutes.length / 2)];

  // Convert TTL bounds from milliseconds to minutes for clamping
  const initial_ttl_minutes = Math.floor(initial_ttl_ms / (60 * 1000));
  const max_ttl_minutes = Math.floor(max_ttl_ms / (60 * 1000));

  // Clamp to initial TTL minimum, and optionally to max TTL maximum
  if (clampMax) {
    return Math.max(initial_ttl_minutes, Math.min(max_ttl_minutes, medianIntervalMinutes));
  } else {
    return Math.max(initial_ttl_minutes, medianIntervalMinutes);
  }
}

/**
 * Shared helper to update cache metadata and store data
 */
async function _updateCachesInternal(
  params: CacheParams,
  rawData: string,
  l1Data: any,
  etag: string,
  timestamp: number,
  existingMetadata?: { cachedAt?: number; etag?: string; writeCount?: number; updateTimestamps?: number[]; effective_ttl_minutes?: number; cacheStats?: number[] } | null
): Promise<void> {
  // Store in L1 cache - determine cache type based on whether data is a string or object
  const isString = typeof l1Data === 'string';
  const l1Cache = isString ? L1_CACHE_STRING : L1_CACHE_PARSED;
  l1Cache.set(params.cacheKey, { 
    json: l1Data, 
    validatedAt: timestamp, 
    etag
  });
  
  // Initialize or update counter and timestamps from provided metadata
  const writeCount = (existingMetadata?.writeCount || 0) + 1;
  const updateTimestamps = existingMetadata?.updateTimestamps || [];
  // Store timestamp in minutes (reduce storage size)
  const timestampMinutes = Math.floor(timestamp / (60 * 1000));
  updateTimestamps.push(timestampMinutes);
  // Keep only the last N timestamps (limited by MAX_TIMESTAMP_HISTORY)
  const maxTimestamps = Math.min(params.timestampHistoryCount, MAX_TIMESTAMP_HISTORY);
  const lastTimestamps = updateTimestamps.slice(-maxTimestamps);
  
  // Calculate new effective TTL (in minutes) - don't clamp by max_ttl when storing
  // Only calculate if we have enough history (at least 2 timestamps)
  let effective_ttl_minutes: number | undefined;
  if (lastTimestamps.length >= 2) {
    const newEffectiveTTLMinutes = calculateEffectiveTTL(lastTimestamps, params.initial_ttl_ms, params.max_ttl_ms, false);
    
    if (existingMetadata?.effective_ttl_minutes !== undefined) {
      // Average of new and old value when updating
      effective_ttl_minutes = Math.floor((newEffectiveTTLMinutes + existingMetadata.effective_ttl_minutes) / 2);
    } else {
      // First time we have enough history - use calculated value
      effective_ttl_minutes = newEffectiveTTLMinutes;
    }
  } else {
    // Not enough history yet - keep existing value if any, otherwise don't set it
    effective_ttl_minutes = existingMetadata?.effective_ttl_minutes;
  }
  
  // Get current stats snapshot to store in metadata
  const cacheStatsSnapshot = getCacheStatsSnapshot();
  
  // Build metadata object, only including effective_ttl_minutes if it's defined
  const metadata: any = {
    cachedAt: timestamp,
    etag,
    writeCount,
    updateTimestamps: lastTimestamps,
    cacheStats: cacheStatsSnapshot
  };
  if (effective_ttl_minutes !== undefined) {
    metadata.effective_ttl_minutes = effective_ttl_minutes;
  }
  
  // Store raw data in KV (always store as string)
  await params.env.CACHE_KV.put(params.cacheKey, rawData, { metadata });
}

/**
 * Update both L1 (memory) and L2 (KV) caches with a raw string
 * @param params Cache parameters
 * @param rawData Raw string data to store
 * @param etag ETag value
 * @param timestamp Optional timestamp (defaults to Date.now())
 * @param existingMetadata Optional existing metadata to update write count and timestamps
 * @returns The processed data (if params.process exists) or the string data
 */
export async function updateCachedString(
  params: CacheParams,
  rawData: string,
  etag: string,
  timestamp: number = Date.now(),
  existingMetadata?: { cachedAt?: number; etag?: string; writeCount?: number; updateTimestamps?: number[]; effective_ttl_minutes?: number; cacheStats?: number[] } | null
): Promise<any> {
  // Process data if process function is provided
  const l1Data = params.process ? params.process(rawData) : rawData;
  await _updateCachesInternal(params, rawData, l1Data, etag, timestamp, existingMetadata);
  return l1Data;
}


/**
 * Creates a "Smart" fetcher for the getCachedEntity utility.
 * Automatically handles ETag revalidation and Gzip decompression.
 */
export const createSmartFetcher = (env: any, url: string): EntityFetcher => {
  return async (
    oldEtag?: string
  ): Promise<{ data: string | null; etag: string }> => {
    const headers: Record<string, string> = {};
    if (oldEtag) headers['If-None-Match'] = oldEtag;

    // Use env.ASSETS if available (Cloudflare Pages), otherwise global fetch
    // Call directly to preserve 'this' binding for env.ASSETS.fetch
    const response = env.ASSETS?.fetch 
      ? await env.ASSETS.fetch(new Request(url, { headers }))
      : await fetch(new Request(url, { headers }));

    // Handle 304 (Not Modified) - Zero CPU/Network Waste
    if (response.status === 304) {
      return { data: null, etag: oldEtag! };
    }

    if (!response.ok) {
      throw new Error(`Fetch failed for ${url}: ${response.status}`);
    }

    const newEtag = response.headers.get('ETag') || '';
    let body = response.body;

    // Derive Gzip usage from URL or Content-Encoding header
    const isGzipped = url.match(/\.gz(\?|$)/i) || 
                     response.headers.get('Content-Encoding') === 'gzip';

    if (isGzipped && body) {
      body = body.pipeThrough(new DecompressionStream("gzip"));
    }

    // Convert stream to string
    const data = await new Response(body).text();

    return { data, etag: newEtag };
  };
};

/**
 * Check L1 cache (RAM) for a hit
 * @returns GetCachedJSONResult with status indicating hit, miss, or stale
 */
function checkL1Cache(
  params: CacheParams,
  now: number
): GetCachedJSONResult {
  const l1Cache = params.process ? L1_CACHE_PARSED : L1_CACHE_STRING;
  const warm = l1Cache.get(params.cacheKey);
  if (!warm) {
    // MISS_L1 is an intermediate state - don't count stats
    return { cacheStatus: CacheStatus.MISS_L1, ttl_ms: 0 };
  }

  const age = now - warm.validatedAt;
  // Use initial_ttl_ms for L1 cache checks (L1 doesn't have metadata)
  if (age >= params.initial_ttl_ms) {
    // STALE_L1 is an intermediate state - don't count stats
    return {
      cacheStatus: CacheStatus.STALE_L1,
      ttl_ms: 0,
      l1Entry: warm
    };
  }

  // HIT_L1_RAM is a final state - count stats
  return returnWithStats(CacheStatus.HIT_L1_RAM, {
    ttl_ms: params.initial_ttl_ms - age,
    l1Entry: warm
  });
}

/**
 * Trigger background cache refresh
 * @param params Cache parameters
 * @param etag ETag to use for If-None-Match header
 * @param existingMetadata Optional existing metadata for updateCaches
 */
function triggerBackgroundRefresh(
  params: CacheParams,
  etag: string,
  existingMetadata?: { cachedAt?: number; etag?: string; writeCount?: number; updateTimestamps?: number[]; effective_ttl_minutes?: number; cacheStats?: number[] } | null
): void {
  params.ctx.waitUntil((async () => {
    try {
      const { data, etag: newEtag } = await params.fetcher(etag);
      if (data !== null) {
        await updateCachedString(params, data, newEtag, Date.now(), existingMetadata);
      }
      // If 304: The L1 lock keeps this isolate quiet.
    } catch (e) {
      const l1Cache = params.process ? L1_CACHE_PARSED : L1_CACHE_STRING;
      l1Cache.delete(params.cacheKey);
    }
  })());
}

/**
 * Check L2 cache (KV) for a hit
 * @param l1Status The L1 cache status (MISS_L1 or STALE_L1)
 * @param l1Entry Optional L1 cache entry (for stale L1 case)
 * @returns GetCachedJSONResult if L2 has data, null if L2 miss
 */
async function checkL2Cache(
  params: CacheParams,
  now: number,
  l1Status: CacheStatus.MISS_L1 | CacheStatus.STALE_L1,
  l1Entry?: { json: any; validatedAt: number; etag: string }
): Promise<GetCachedJSONResult | null> {
  // Get L2 cache data from KV
  const { value, metadata } = await params.env.CACHE_KV.getWithMetadata(params.cacheKey, "text");
  if (!value) {
    // L2 MISS: Return stale L1 data if available, trigger background refresh
    if (l1Status === CacheStatus.STALE_L1 && l1Entry) {
      triggerBackgroundRefresh(params, l1Entry.etag, null);
      return returnWithStats(CacheStatus.STALE_L1_MISS_L2, {
        ttl_ms: 0,
        data: l1Entry.json
      });
    }
    return null;
  }

  const existingMetadata = metadata as { cachedAt?: number; etag?: string; writeCount?: number; updateTimestamps?: number[]; effective_ttl_minutes?: number; cacheStats?: number[] } | null;
  
  // Merge stats from metadata into global stats (only once, when first encountered)
  mergeStatsFromMetadata(existingMetadata?.cacheStats);
  
  // Store in L1 cache in the requested format
  const l1Data = params.process ? params.process(value) : value;

  // Calculate cache metadata
  const cachedAt = Number(existingMetadata?.cachedAt) || 0;
  const age = now - cachedAt;
  // Use effective_ttl_minutes from metadata if available, otherwise fall back to initial_ttl_ms
  // Convert minutes to milliseconds for comparison with age (which is in ms)
  // Apply max_ttl_ms limit when checking freshness (stored value may exceed max_ttl)
  let effectiveTTL = existingMetadata?.effective_ttl_minutes 
    ? existingMetadata.effective_ttl_minutes * 60 * 1000 
    : params.initial_ttl_ms;
  // Clamp by max_ttl_ms when applying (stored value can exceed max_ttl)
  effectiveTTL = Math.min(effectiveTTL, params.max_ttl_ms);
  const isFresh = age < effectiveTTL;
  const kvEtag = existingMetadata?.etag || '';

  // CRITICAL: Set L1 on BOTH paths.
  // If fresh, we use the original 'cachedAt'.
  // If stale, we use 'now' to lock the background fetcher.
  const l1Cache = params.process ? L1_CACHE_PARSED : L1_CACHE_STRING;
  l1Cache.set(params.cacheKey, {
    json: l1Data,
    validatedAt: isFresh ? cachedAt : now,
    etag: kvEtag
  });

  if (isFresh) {
    // Return combined state based on L1 status
    const combinedStatus = l1Status === CacheStatus.MISS_L1 
      ? CacheStatus.MISS_L1_HIT_L2 
      : CacheStatus.STALE_L1_HIT_L2;
    return returnWithStats(combinedStatus, {
      ttl_ms: effectiveTTL - age,
      data: l1Data
    });
  }

  // STALE: Serve old data, revalidate in background
  triggerBackgroundRefresh(params, kvEtag, existingMetadata);

  // Return combined state for stale L2
  const combinedStatus = l1Status === CacheStatus.MISS_L1 
    ? CacheStatus.MISS_L1_STALE_L2 
    : CacheStatus.STALE_L1_STALE_L2;
  return returnWithStats(combinedStatus, { ttl_ms: 0, data: l1Data });
}

/**
 * Handle cache MISS case with network fallback
 * Only handles MISS_L1_MISS_L2 (STALE_L1_MISS_L2 is handled in checkL2Cache)
 * Waits for network response (not background)
 * @param l1Status The L1 cache status (MISS_L1 or STALE_L1)
 * @returns GetCachedJSONResult
 */
async function handleMiss(
  params: CacheParams,
  l1: { json: any; validatedAt: number; etag: string } | undefined,
  now: number,
  l1Status: CacheStatus.MISS_L1 | CacheStatus.STALE_L1
): Promise<GetCachedJSONResult> {
  // Note: STALE_L1_MISS_L2 is handled in checkL2Cache, so this should only be MISS_L1_MISS_L2
  // But we keep the check for defensive programming
  if (l1Status === CacheStatus.STALE_L1 && l1) {
    return returnWithStats(CacheStatus.STALE_L1_MISS_L2, {
      ttl_ms: 0,
      data: l1.json
    });
  }

  // Wait for network response (MISS_L1_MISS_L2 case)
  // Note: L1 is MISS, so no ETag available
  // The fetcher will throw on network errors
  const fetchResult = await params.fetcher();

  // Fetcher returned fresh data (must be string) - store in caches
  // Get existing metadata to calculate effective TTL
  const { metadata: existingMetadata } = await params.env.CACHE_KV.getWithMetadata(params.cacheKey, "text");
  const metadata = existingMetadata as { cachedAt?: number; etag?: string; writeCount?: number; updateTimestamps?: number[]; effective_ttl_minutes?: number; cacheStats?: number[] } | null;
  
  // Merge stats from metadata into global stats (only once, when first encountered)
  mergeStatsFromMetadata(metadata?.cacheStats);
  
  // Calculate combined status and increment stats before updateCaches
  const combinedStatus = l1Status === CacheStatus.MISS_L1 
    ? CacheStatus.MISS_L1_MISS_L2 
    : CacheStatus.STALE_L1_MISS_L2;
  incrementCacheStats(combinedStatus);
  
  // Store in caches (updateCachedString will handle processing if params.process exists)
  const l1Data = await updateCachedString(params, fetchResult.data as string, fetchResult.etag, now, metadata);
  
  // For L2 miss, use initial_ttl_ms (effective TTL not available yet)
  // Return result (stats already incremented above)
  return { cacheStatus: combinedStatus, ttl_ms: params.initial_ttl_ms, data: l1Data };
}

/**
 * Main entry point for cached JSON retrieval
 * Implements multi-layer caching: L1 (RAM) -> L2 (KV) -> Network
 */
export async function getCachedJSON(
  params: CacheParams
): Promise<GetCachedJSONResult> {
  const now = Date.now();

  // 1. L1 HIT (RAM): The "Zero-Tax" path
  const l1Result = checkL1Cache(params, now);
  if (l1Result.cacheStatus === CacheStatus.HIT_L1_RAM) {
    return l1Result;
  }

  // Track L1 status for combined state reporting (must be MISS_L1 or STALE_L1 at this point)
  const l1Status = l1Result.cacheStatus as CacheStatus.MISS_L1 | CacheStatus.STALE_L1;

  // 2. L2 HIT (KV)
  const l2Result = await checkL2Cache(params, now, l1Status, l1Result.l1Entry);
  if (l2Result) {
    return l2Result;
  }

  // 3. MISS: Network fallback (both L1 and L2 missed)
  // Use L1 entry from result if available (for stale L1 case)
  return handleMiss(params, l1Result.l1Entry, now, l1Status);
}

/**
 * Derives cache key from URL by extracting the base filename
 * Example: "https://example.com/path/to/file.json.gz" -> "file.json"
 */
export function deriveCacheKeyFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    // Get the last segment of the path
    const filename = pathname.split('/').pop() || 'data.json';
    // Remove .gz extension if present (but keep .json)
    return filename.replace(/\.gz$/, '');
  } catch (error) {
    // If URL parsing fails, throw an error
    throw new Error(`Invalid URL: ${url}. ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Generic function to load cached data from a URL
 * Derives cacheKey automatically from the URL filename
 */
export async function loadCachedData(
  assetUrl: string | URL,
  env: any,
  ctx: any,
  options?: {
    initial_ttl_ms?: number;
    max_ttl_ms?: number;
    process?: (raw: string) => any;
    timestampHistoryCount?: number;
  }
): Promise<{ data: any; ioMs: number; cacheStatus: CacheStatus }> {
  const urlString = typeof assetUrl === 'string' ? assetUrl : assetUrl.toString();
  const cacheKey = deriveCacheKeyFromUrl(urlString);
  
  const {
    initial_ttl_ms = 300 * 1000, // 5 minutes default
    max_ttl_ms = 3600 * 1000,    // 1 hour default
    process = ((raw: string | null) => raw ? JSON.parse(raw) : null), // Default: parse JSON, return null if null
    timestampHistoryCount = 5,
  } = options || {};
  
  // Create a smart fetcher that handles ETag revalidation and Gzip decompression
  const fetcher = createSmartFetcher(env, urlString);
  
  // Wrap process function to ensure it accepts string | null
  const wrappedProcess = process || ((raw: string | null) => raw ? JSON.parse(raw) : null);
  
  const params = createCacheParams(
    { env, ctx, cacheKey, fetcher, process: wrappedProcess },
    { initial_ttl_ms, max_ttl_ms, timestampHistoryCount }
  );
  
  const ioStart = performance.now();
  const result = await getCachedJSON(params);
  const ioMs = performance.now() - ioStart;
  
  return { data: result.data, ioMs, cacheStatus: result.cacheStatus };
}
