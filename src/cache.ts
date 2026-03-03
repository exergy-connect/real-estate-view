// GLOBAL SCOPE: Persists in warm Worker isolates RAM
// Stores either parsed JSON (any) or raw string, based on how it was first cached
// Type is inferred: string = raw JSON, object/array = parsed JSON
const L1_CACHE = new Map<string, { json: any; validatedAt: number; etag: string }>();

/**
 * Fetcher function type for getCachedEntity
 * Returns data and etag, with data being null if content hasn't changed (304 response)
 * Can optionally return stale data when network fetch fails (only in MISS case)
 */
export type EntityFetcher = (
  oldEtag?: string,
  staleData?: any
) => Promise<{ data: string | null | any; etag: string; isStale?: boolean }>;

/**
 * Cache status enum for getCachedEntity results
 * Represents all possible combinations of L1 (RAM) and L2 (KV) cache states
 */
export enum CacheStatus {
  /** L1 hit (fresh) - fastest path */
  HIT_L1_RAM = 'HIT_L1_RAM',
  
  /** L1 cache miss (not in memory) - intermediate state */
  MISS_L1 = 'MISS_L1',
  /** L1 cache stale (in memory but expired) - intermediate state */
  STALE_L1 = 'STALE_L1',
  
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
 * Return type for getCachedJSON
 */
export interface GetCachedJSONResult {
  /** Cache status */
  cacheStatus: CacheStatus;
  /** Remaining TTL in milliseconds */
  ttl_ms: number;
  /** L1 cache entry (present when L1 cache has data) */
  l1Entry?: { json: any; validatedAt: number; etag: string };
  /** The cached JSON data (parsed object or raw string depending on parse parameter) */
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
  parse: boolean;
  fetcher: EntityFetcher;
}

/**
 * Calculate effective TTL based on update timestamp history
 * Uses median interval between updates, clamped between initial_ttl_ms and max_ttl_ms
 */
function calculateEffectiveTTL(
  timestamps: number[],
  initial_ttl_ms: number,
  max_ttl_ms: number
): number {
  if (timestamps.length < 2) {
    // Not enough history, use initial TTL
    return initial_ttl_ms;
  }

  // Calculate intervals between consecutive timestamps
  const intervals: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    intervals.push(timestamps[i] - timestamps[i - 1]);
  }

  // Use median interval as the effective TTL
  intervals.sort((a, b) => a - b);
  const medianInterval = intervals[Math.floor(intervals.length / 2)];

  // Clamp between initial and max TTL
  return Math.max(initial_ttl_ms, Math.min(max_ttl_ms, medianInterval));
}

/**
 * Helper to update both L1 (memory) and L2 (KV) caches
 * @param params Cache parameters
 * @param rawData Raw JSON string from network/fetcher
 * @param etag ETag value
 * @param timestamp Optional timestamp (defaults to Date.now())
 * @param existingMetadata Optional existing metadata to update write count and timestamps
 * @returns The formatted data (parsed if parse=true, raw string if parse=false)
 */
async function updateCaches(
  params: CacheParams,
  rawData: string,
  etag: string,
  timestamp: number = Date.now(),
  existingMetadata?: { cachedAt?: number; etag?: string; writeCount?: number; updateTimestamps?: number[]; effective_ttl_ms?: number } | null
): Promise<any> {
  // Store in L1 cache in the requested format
  const l1Data = params.parse ? JSON.parse(rawData) : rawData;
  L1_CACHE.set(params.cacheKey, { 
    json: l1Data, 
    validatedAt: timestamp, 
    etag
  });
  
  // Initialize or update counter and timestamps from provided metadata
  const writeCount = (existingMetadata?.writeCount || 0) + 1;
  const updateTimestamps = existingMetadata?.updateTimestamps || [];
  updateTimestamps.push(Math.floor(timestamp)); // Add current timestamp as int
  // Keep only the last N timestamps
  const lastTimestamps = updateTimestamps.slice(-params.timestampHistoryCount);
  
  // Calculate effective TTL
  let effective_ttl_ms: number | undefined;
  effective_ttl_ms = calculateEffectiveTTL(lastTimestamps, params.initial_ttl_ms, params.max_ttl_ms);
  
  // Store raw data in KV (always store as string)
  await params.env.CACHE_KV.put(params.cacheKey, rawData, { 
    metadata: { 
      cachedAt: timestamp, 
      etag,
      writeCount,
      updateTimestamps: lastTimestamps,
      effective_ttl_ms
    }
  });
  
  return l1Data;
}

/**
 * Creates a "Smart" fetcher for the getCachedEntity utility.
 * Automatically handles ETag revalidation and Gzip decompression.
 */
export const createSmartFetcher = (env: any, url: string): EntityFetcher => {
  return async (
    oldEtag?: string,
    staleData?: { data: any }
  ): Promise<{ data: string | null | any; etag: string; isStale?: boolean }> => {
    const headers: Record<string, string> = {};
    if (oldEtag) headers['If-None-Match'] = oldEtag;

    try {
      // Use env.ASSETS if available (Cloudflare Pages), otherwise global fetch
      // Call directly to preserve 'this' binding for env.ASSETS.fetch
      const response = env.ASSETS?.fetch 
        ? await env.ASSETS.fetch(new Request(url, { headers }))
        : await fetch(new Request(url, { headers }));

      // 1. Handle 304 (Not Modified) - Zero CPU/Network Waste
      if (response.status === 304) {
        return { data: null, etag: oldEtag! };
      }

      if (!response.ok) {
        // Network error - return stale data as-is if available
        if (staleData !== undefined) {
          return { data: staleData, etag: oldEtag || '', isStale: true };
        }
        throw new Error(`Fetch failed for ${url}: ${response.status}`);
      }

      const newEtag = response.headers.get('ETag') || '';
      let body = response.body;

      // 2. Derive Gzip usage from URL or Content-Encoding header
      const isGzipped = url.match(/\.gz(\?|$)/i) || 
                       response.headers.get('Content-Encoding') === 'gzip';

      if (isGzipped && body) {
        body = body.pipeThrough(new DecompressionStream("gzip"));
      }

      // 3. Convert stream to string
      const data = await new Response(body).text();

      return { data, etag: newEtag };
    } catch (error) {
      // Network error (connection failure, timeout, etc.) - return stale data as-is if available
      if (staleData !== undefined) {
        return { data: staleData, etag: oldEtag || '', isStale: true };
      }
      // No stale data available, rethrow the error
      throw error;
    }
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
  const warm = L1_CACHE.get(params.cacheKey);
  if (!warm) {
    return {
      cacheStatus: CacheStatus.MISS_L1,
      ttl_ms: 0
    };
  }

  // Debug assert: validate cached format matches requested format
  const isCachedParsed = typeof warm.json !== 'string';
  if (params.parse !== isCachedParsed) {
    throw new Error(
      `Cache format mismatch for ${params.cacheKey}: requested ${params.parse ? 'parsed' : 'raw'}, but cached ${isCachedParsed ? 'parsed' : 'raw'}`
    );
  }

  const age = now - warm.validatedAt;
  // Use initial_ttl_ms for L1 cache checks (L1 doesn't have metadata)
  if (age >= params.initial_ttl_ms) {
    return {
      cacheStatus: CacheStatus.STALE_L1,
      ttl_ms: 0,
      l1Entry: warm
    };
  }

  return {
    cacheStatus: CacheStatus.HIT_L1_RAM,
    ttl_ms: params.initial_ttl_ms - age,
    l1Entry: warm
  };
}

/**
 * Check L2 cache (KV) for a hit
 * @param l1Status The L1 cache status (MISS_L1 or STALE_L1)
 * @returns GetCachedJSONResult if L2 has data, null if L2 miss
 */
async function checkL2Cache(
  params: CacheParams,
  now: number,
  l1Status: CacheStatus.MISS_L1 | CacheStatus.STALE_L1
): Promise<GetCachedJSONResult | null> {
  // Get L2 cache data from KV
  const { value, metadata } = await params.env.CACHE_KV.getWithMetadata(params.cacheKey, "text");
  if (!value) {
    return null;
  }

  const existingMetadata = metadata as { cachedAt?: number; etag?: string; writeCount?: number; updateTimestamps?: number[]; effective_ttl_ms?: number } | null;
  
  // Store in L1 cache in the requested format
  const l1Data = params.parse ? JSON.parse(value) : value;

  // Calculate cache metadata
  const cachedAt = Number(existingMetadata?.cachedAt) || 0;
  const age = now - cachedAt;
  // Use effective_ttl_ms from metadata if available, otherwise fall back to initial_ttl_ms
  const effectiveTTL = existingMetadata?.effective_ttl_ms ?? params.initial_ttl_ms;
  const isFresh = age < effectiveTTL;
  const kvEtag = existingMetadata?.etag || '';

  // CRITICAL: Set L1 on BOTH paths.
  // If fresh, we use the original 'cachedAt'.
  // If stale, we use 'now' to lock the background fetcher.
  L1_CACHE.set(params.cacheKey, {
    json: l1Data,
    validatedAt: isFresh ? cachedAt : now,
    etag: kvEtag
  });

  if (isFresh) {
    // Return combined state based on L1 status
    const combinedStatus = l1Status === CacheStatus.MISS_L1 
      ? CacheStatus.MISS_L1_HIT_L2 
      : CacheStatus.STALE_L1_HIT_L2;
    return {
      cacheStatus: combinedStatus,
      ttl_ms: effectiveTTL - age,
      data: l1Data
    };
  }

  // STALE: Serve old data, revalidate in background
  params.ctx.waitUntil((async () => {
    try {
      const { data, etag } = await params.fetcher(kvEtag);
      if (data !== null) {
        await updateCaches(
          params,
          data,
          etag,
          Date.now(),
          existingMetadata
        );
      }
      // If 304: The L1 lock at 'now' (set above) keeps this isolate quiet.
    } catch (e) {
      L1_CACHE.delete(params.cacheKey);
    }
  })());

  // Return combined state for stale L2
  const combinedStatus = l1Status === CacheStatus.MISS_L1 
    ? CacheStatus.MISS_L1_STALE_L2 
    : CacheStatus.STALE_L1_STALE_L2;
  return { cacheStatus: combinedStatus, ttl_ms: 0, data: l1Data };
}

/**
 * Handle cache MISS case with network fallback
 * @param l1Status The L1 cache status (MISS_L1 or STALE_L1)
 * @returns GetCachedJSONResult
 */
async function handleMiss(
  params: CacheParams,
  l1: { json: any; validatedAt: number; etag: string } | undefined,
  now: number,
  l1Status: CacheStatus.MISS_L1 | CacheStatus.STALE_L1
): Promise<GetCachedJSONResult> {
  // Check for stale data from L1 (if available and stale)
  let staleDataParam: any;
  let oldEtag: string | undefined;

  // Use L1 value if available (already checked above, but was stale)
  if (l1) {
    staleDataParam = l1.json;
    oldEtag = l1.etag;
  }

  let fetchResult: { data: string | null | any; etag: string; isStale?: boolean } | null = null;
  let fetchError: Error | null = null;

  try {
    fetchResult = await params.fetcher(oldEtag, staleDataParam);

    // Only return fresh data if not stale
    if (!fetchResult.isStale) {
      // Fetcher returned fresh data (must be string) - store in caches
      // Get existing metadata to calculate effective TTL
      const { metadata: existingMetadata } = await params.env.CACHE_KV.getWithMetadata(params.cacheKey, "text");
      const metadata = existingMetadata as { cachedAt?: number; etag?: string; writeCount?: number; updateTimestamps?: number[]; effective_ttl_ms?: number } | null;
      const l1Data = await updateCaches(
        params,
        fetchResult.data as string,
        fetchResult.etag,
        now,
        metadata
      );
      // Calculate effective TTL for return value
      const timestamps = metadata?.updateTimestamps || [];
      const updatedTimestamps = [...timestamps, Math.floor(now)].slice(-params.timestampHistoryCount);
      const effectiveTTL = calculateEffectiveTTL(updatedTimestamps, params.initial_ttl_ms, params.max_ttl_ms);
      // Return combined state: both L1 and L2 missed, fetched from network
      const combinedStatus = l1Status === CacheStatus.MISS_L1 
        ? CacheStatus.MISS_L1_MISS_L2 
        : CacheStatus.STALE_L1_MISS_L2;
      return { cacheStatus: combinedStatus, ttl_ms: effectiveTTL, data: l1Data };
    }
  } catch (error) {
    fetchError = error instanceof Error ? error : new Error(String(error));
  } finally {
    // Return stale data if fetcher returned it or if there was an error
    if ((fetchResult?.isStale || fetchError) && staleDataParam) {
      return {
        cacheStatus: CacheStatus.STALE_REVALIDATING,
        ttl_ms: 0,
        data: staleDataParam.data
      };
    }
  }

  // If there was an error and no stale data, rethrow
  if (fetchError) {
    throw fetchError;
  }

  // This should never be reached, but TypeScript needs it
  throw new Error('Unexpected state in getCachedJSON');
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
  const l2Result = await checkL2Cache(params, now, l1Status);
  if (l2Result) {
    return l2Result;
  }

  // 3. MISS: Network fallback (both L1 and L2 missed)
  // Use L1 entry from result if available (for stale L1 case)
  return handleMiss(params, l1Result.l1Entry, now, l1Status);
}
