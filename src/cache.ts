// GLOBAL SCOPE: Persists in warm Worker isolates RAM
// Stores either parsed JSON (any) or raw string, based on how it was first cached
// Type is inferred: string = raw JSON, object/array = parsed JSON
const L1_CACHE = new Map<string, { json: any; validatedAt: number; etag: string }>();

/**
 * Maximum number of timestamps to keep in cache metadata
 * Limited to 16 due to Cloudflare Workers KV metadata size constraint of 1kB
 * Each timestamp is stored as an integer (minutes since epoch), so 16 timestamps
 * plus other metadata fields (cachedAt, etag, writeCount, effective_ttl_minutes) must fit within 1kB
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
 * Helper to create CacheParams with reasonable defaults
 * @param required Required parameters (env, ctx, cacheKey, fetcher, parse)
 * @param options Optional TTL and history count overrides
 * @returns CacheParams with defaults applied
 */
export function createCacheParams(
  required: {
    env: any;
    ctx: any;
    cacheKey: string;
    fetcher: EntityFetcher;
    parse: boolean;
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
  existingMetadata?: { cachedAt?: number; etag?: string; writeCount?: number; updateTimestamps?: number[]; effective_ttl_minutes?: number } | null
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
  // Store timestamp in minutes (reduce storage size)
  const timestampMinutes = Math.floor(timestamp / (60 * 1000));
  updateTimestamps.push(timestampMinutes);
  // Keep only the last N timestamps (limited by MAX_TIMESTAMP_HISTORY)
  const maxTimestamps = Math.min(params.timestampHistoryCount, MAX_TIMESTAMP_HISTORY);
  const lastTimestamps = updateTimestamps.slice(-maxTimestamps);
  
  // Calculate new effective TTL (in minutes) - don't clamp by max_ttl when storing
  const newEffectiveTTLMinutes = calculateEffectiveTTL(lastTimestamps, params.initial_ttl_ms, params.max_ttl_ms, false);
  
  // Initialize to initial TTL, or average with existing value when updating
  const initial_ttl_minutes = Math.floor(params.initial_ttl_ms / (60 * 1000));
  let effective_ttl_minutes: number;
  if (existingMetadata?.effective_ttl_minutes !== undefined) {
    // Average of new and old value when updating
    effective_ttl_minutes = Math.floor((newEffectiveTTLMinutes + existingMetadata.effective_ttl_minutes) / 2);
  } else {
    // Initialize to initial TTL
    effective_ttl_minutes = initial_ttl_minutes;
  }
  
  // Store raw data in KV (always store as string)
  await params.env.CACHE_KV.put(params.cacheKey, rawData, { 
    metadata: { 
      cachedAt: timestamp, 
      etag,
      writeCount,
      updateTimestamps: lastTimestamps,
      effective_ttl_minutes
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
 * Trigger background cache refresh
 * @param params Cache parameters
 * @param etag ETag to use for If-None-Match header
 * @param existingMetadata Optional existing metadata for updateCaches
 */
function triggerBackgroundRefresh(
  params: CacheParams,
  etag: string,
  existingMetadata?: { cachedAt?: number; etag?: string; writeCount?: number; updateTimestamps?: number[]; effective_ttl_minutes?: number } | null
): void {
  params.ctx.waitUntil((async () => {
    try {
      const { data, etag: newEtag } = await params.fetcher(etag);
      if (data !== null) {
        await updateCaches(params, data, newEtag, Date.now(), existingMetadata);
      }
      // If 304: The L1 lock keeps this isolate quiet.
    } catch (e) {
      L1_CACHE.delete(params.cacheKey);
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
      return {
        cacheStatus: CacheStatus.STALE_L1_MISS_L2,
        ttl_ms: 0,
        data: l1Entry.json
      };
    }
    return null;
  }

  const existingMetadata = metadata as { cachedAt?: number; etag?: string; writeCount?: number; updateTimestamps?: number[]; effective_ttl_minutes?: number } | null;
  
  // Store in L1 cache in the requested format
  const l1Data = params.parse ? JSON.parse(value) : value;

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
  triggerBackgroundRefresh(params, kvEtag, existingMetadata);

  // Return combined state for stale L2
  const combinedStatus = l1Status === CacheStatus.MISS_L1 
    ? CacheStatus.MISS_L1_STALE_L2 
    : CacheStatus.STALE_L1_STALE_L2;
  return { cacheStatus: combinedStatus, ttl_ms: 0, data: l1Data };
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
    return {
      cacheStatus: CacheStatus.STALE_L1_MISS_L2,
      ttl_ms: 0,
      data: l1.json
    };
  }

  // Wait for network response (MISS_L1_MISS_L2 case)
  // Note: L1 is MISS, so no ETag available
  // The fetcher will throw on network errors
  const fetchResult = await params.fetcher();

  // Fetcher returned fresh data (must be string) - store in caches
  // Get existing metadata to calculate effective TTL
  const { metadata: existingMetadata } = await params.env.CACHE_KV.getWithMetadata(params.cacheKey, "text");
  const metadata = existingMetadata as { cachedAt?: number; etag?: string; writeCount?: number; updateTimestamps?: number[]; effective_ttl_minutes?: number } | null;
  const l1Data = await updateCaches(
    params,
    fetchResult.data as string,
    fetchResult.etag,
    now,
    metadata
  );
  
  // Calculate effective TTL for return value (convert minutes to milliseconds)
  const timestamps = metadata?.updateTimestamps || [];
  // Convert current timestamp to minutes
  const nowMinutes = Math.floor(now / (60 * 1000));
  // Limit to MAX_TIMESTAMP_HISTORY due to 1kB metadata size constraint
  const maxTimestamps = Math.min(params.timestampHistoryCount, MAX_TIMESTAMP_HISTORY);
  const updatedTimestamps = [...timestamps, nowMinutes].slice(-maxTimestamps);
  const effectiveTTLMinutes = calculateEffectiveTTL(updatedTimestamps, params.initial_ttl_ms, params.max_ttl_ms, true);
  let effectiveTTL = effectiveTTLMinutes * 60 * 1000; // Convert to milliseconds for return value
  // Clamp by max_ttl_ms when applying (stored value can exceed max_ttl)
  effectiveTTL = Math.min(effectiveTTL, params.max_ttl_ms);
  
  // Return combined state: both L1 and L2 missed, fetched from network
  const combinedStatus = l1Status === CacheStatus.MISS_L1 
    ? CacheStatus.MISS_L1_MISS_L2 
    : CacheStatus.STALE_L1_MISS_L2;
  return { cacheStatus: combinedStatus, ttl_ms: effectiveTTL, data: l1Data };
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
