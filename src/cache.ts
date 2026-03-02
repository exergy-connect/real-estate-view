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
 */
export enum CacheStatus {
  /** Cache hit from L1 RAM (warm isolate) */
  HIT_L1_RAM = 'HIT_L1_RAM',
  /** Cache hit from L2 KV (persistent edge storage) */
  HIT_L2_KV = 'HIT_L2_KV',
  /** Cache is stale, serving old data while revalidating in background */
  STALE_REVALIDATING = 'STALE_REVALIDATING',
  /** Cache miss, fetched from source */
  MISS = 'MISS'
}

/**
 * Return type for getCachedJSON
 */
export interface GetCachedJSONResult {
  /** The cached JSON data (parsed object or raw string depending on parse parameter) */
  data: any;
  /** Cache status */
  cacheStatus: CacheStatus;
  /** Remaining TTL in milliseconds */
  ttl_ms: number;
}

/**
 * Helper to update both L1 (memory) and L2 (KV) caches
 * @param env Cloudflare Workers environment
 * @param cacheKey Cache key
 * @param rawData Raw JSON string from network/fetcher
 * @param etag ETag value
 * @param parse Whether to parse JSON for L1 cache (L2 always stores raw)
 * @param timestamp Optional timestamp (defaults to Date.now())
 * @returns The formatted data (parsed if parse=true, raw string if parse=false)
 */
async function updateCaches(
  env: any,
  cacheKey: string,
  rawData: string,
  etag: string,
  parse: boolean,
  timestamp: number = Date.now()
): Promise<any> {
  // Store in L1 cache in the requested format
  const l1Data = parse ? JSON.parse(rawData) : rawData;
  L1_CACHE.set(cacheKey, { 
    json: l1Data, 
    validatedAt: timestamp, 
    etag
  });
  
  // Store raw data in KV (always store as string)
  await env.CACHE_KV.put(cacheKey, rawData, { 
    metadata: { cachedAt: timestamp, etag }
  });
  
  return l1Data;
}


/**
 * Common parameters for cache operations
 */
export interface CacheParams {
  env: any;
  ctx: any;
  cacheKey: string;
  ttl_ms: number;
  parse: boolean;
  fetcher: EntityFetcher;
}

/**
 * Check L1 cache (RAM) for a hit
 * @returns GetCachedJSONResult if hit, null if miss
 */
function checkL1Cache(
  params: CacheParams,
  now: number
): GetCachedJSONResult | null {
  const warm = L1_CACHE.get(params.cacheKey);
  if (!warm) {
    return null;
  }

  const age = now - warm.validatedAt;
  if (age >= params.ttl_ms) {
    return null; // Stale
  }

  // Debug assert: validate cached format matches requested format
  const isCachedParsed = typeof warm.json !== 'string';
  if (params.parse !== isCachedParsed) {
    throw new Error(
      `Cache format mismatch for ${params.cacheKey}: requested ${params.parse ? 'parsed' : 'raw'}, but cached ${isCachedParsed ? 'parsed' : 'raw'}`
    );
  }

  return {
    data: warm.json,
    cacheStatus: CacheStatus.HIT_L1_RAM,
    ttl_ms: params.ttl_ms - age
  };
}

/**
 * Check L2 cache (KV) for a hit
 * @returns GetCachedJSONResult if hit (fresh or stale), null if miss
 */
async function checkL2Cache(
  params: CacheParams,
  l2: { value: string; cachedAt?: number; etag?: string },
  now: number
): Promise<GetCachedJSONResult | null> {
  // Store in L1 cache in the requested format
  const l1Data = params.parse ? JSON.parse(l2.value) : l2.value;

  // Calculate cache metadata
  const cachedAt = Number(l2.cachedAt) || 0;
  const age = now - cachedAt;
  const isFresh = age < params.ttl_ms;
  const kvEtag = l2.etag || '';

  // CRITICAL: Set L1 on BOTH paths.
  // If fresh, we use the original 'cachedAt'.
  // If stale, we use 'now' to lock the background fetcher.
  L1_CACHE.set(params.cacheKey, {
    json: l1Data,
    validatedAt: isFresh ? cachedAt : now,
    etag: kvEtag
  });

  if (isFresh) {
    return {
      data: l1Data,
      cacheStatus: CacheStatus.HIT_L2_KV,
      ttl_ms: params.ttl_ms - age
    };
  }

  // STALE: Serve old data, revalidate in background
  params.ctx.waitUntil((async () => {
    try {
      const { data, etag } = await params.fetcher(kvEtag);
      if (data !== null) {
        await updateCaches(params.env, params.cacheKey, data, etag, params.parse);
      }
      // If 304: The L1 lock at 'now' (set above) keeps this isolate quiet.
    } catch (e) {
      L1_CACHE.delete(params.cacheKey);
    }
  })());

  return { data: l1Data, cacheStatus: CacheStatus.STALE_REVALIDATING, ttl_ms: 0 };
}

/**
 * Handle cache MISS case with network fallback
 * @returns GetCachedJSONResult
 */
async function handleMiss(
  params: CacheParams,
  l1: { json: any; validatedAt: number; etag: string } | undefined,
  l2: { value: string; etag?: string } | null,
  now: number
): Promise<GetCachedJSONResult> {
  // Check for stale data from already-looked-up sources
  let staleDataParam: any;
  let oldEtag: string | undefined;

  // Use L1 value if available (already checked above, but was stale)
  if (l1) {
    staleDataParam = l1.json;
    oldEtag = l1.etag;
  }
  // Use L2 value if available (already checked above, always a string)
  else if (l2) {
    staleDataParam = l2.value;
    oldEtag = l2.etag;
  }

  let fetchResult: { data: string | null | any; etag: string; isStale?: boolean } | null = null;
  let fetchError: Error | null = null;

  try {
    fetchResult = await params.fetcher(oldEtag, staleDataParam);

    // Only return fresh data if not stale
    if (!fetchResult.isStale) {
      // Fetcher returned fresh data (must be string) - store in caches
      const l1Data = await updateCaches(params.env, params.cacheKey, fetchResult.data as string, fetchResult.etag, params.parse, now);
      return { data: l1Data, cacheStatus: CacheStatus.MISS, ttl_ms: params.ttl_ms };
    }
  } catch (error) {
    fetchError = error instanceof Error ? error : new Error(String(error));
  } finally {
    // Return stale data if fetcher returned it or if there was an error
    if ((fetchResult?.isStale || fetchError) && staleDataParam) {
      return {
        data: staleDataParam.data,
        cacheStatus: CacheStatus.STALE_REVALIDATING,
        ttl_ms: 0
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

export async function getCachedJSON(
  params: CacheParams
): Promise<GetCachedJSONResult> {
  const now = Date.now();

  // 1. L1 HIT (RAM): The "Zero-Tax" path
  const warm = L1_CACHE.get(params.cacheKey);
  const l1Result = checkL1Cache(params, now);
  if (l1Result) {
    return l1Result;
  }

  // 2. L2 HIT (KV)
  const { value, metadata } = await params.env.CACHE_KV.getWithMetadata(params.cacheKey, "text");
  if (value) {
    const meta = metadata as { cachedAt?: number; etag?: string } | null;
    const l2Result = await checkL2Cache(params, { value, cachedAt: meta?.cachedAt, etag: meta?.etag }, now);
    if (l2Result) {
      return l2Result;
    }
  }

  // 3. MISS: Network fallback
  return handleMiss(params, warm, value ? { value, etag: (metadata as { etag?: string } | null)?.etag } : null, now);
}