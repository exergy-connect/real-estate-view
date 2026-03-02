// GLOBAL SCOPE: Persists in warm Worker isolates RAM
// Stores either parsed JSON (any) or raw string, based on how it was first cached
// Type is inferred: string = raw JSON, object/array = parsed JSON
const L1_CACHE = new Map<string, { json: any; validatedAt: number; etag: string }>();

/**
 * Fetcher function type for getCachedEntity
 * Returns data and etag, with data being null if content hasn't changed (304 response)
 */
export type EntityFetcher = (oldEtag?: string) => Promise<{ data: string | null; etag: string }>;

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
 * Creates a "Smart" fetcher for the getCachedEntity utility.
 * Automatically handles ETag revalidation and Gzip decompression.
 */
export const createSmartFetcher = (env: any, url: string): EntityFetcher => {
  return async (oldEtag?: string): Promise<{ data: string | null; etag: string }> => {
    const headers: Record<string, string> = {};
    if (oldEtag) headers['If-None-Match'] = oldEtag;

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
  };
};

export async function getCachedJSON(
  env: any,
  ctx: any,
  cacheKey: string,
  ttl_ms: number, 
  fetcher: EntityFetcher,
  parse: boolean = true // Toggle between JSON object and raw String
): Promise<GetCachedJSONResult> {
  
  const now = Date.now();

  // 1. L1 HIT (RAM): The "Zero-Tax" path
  const warm = L1_CACHE.get(cacheKey);
  if (warm) {
    const age = now - warm.validatedAt;
    if (age < ttl_ms) {
      // Debug assert: validate cached format matches requested format
      const isCachedParsed = typeof warm.json !== 'string';
      if (parse !== isCachedParsed) {
        throw new Error(
          `Cache format mismatch for ${cacheKey}: requested ${parse ? 'parsed' : 'raw'}, but cached ${isCachedParsed ? 'parsed' : 'raw'}`
        );
      }
      // Assume cached format matches requested format
      return { 
        data: warm.json, 
        cacheStatus: CacheStatus.HIT_L1_RAM, 
        ttl_ms: ttl_ms - age 
      };
    }
  }

  // 2. L2 HIT (KV)
  const { value, metadata } = await env.CACHE_KV.getWithMetadata(cacheKey, "text");
  const meta = metadata as { cachedAt?: number; etag?: string };

  if (value) {
    const kvEtag = meta?.etag || '';
    const cachedAt = meta?.cachedAt || 0;
    const age = now - cachedAt;
    const isFresh = age < ttl_ms;
    
    // Store in L1 cache in the requested format
    const l1Data = parse ? JSON.parse(value) : value;
    
    // CRITICAL: Set L1 on BOTH paths. 
    // If fresh, we use the original 'cachedAt'. 
    // If stale, we use 'now' to lock the background fetcher.
    L1_CACHE.set(cacheKey, { 
      json: l1Data, 
      validatedAt: isFresh ? cachedAt : now, 
      etag: kvEtag
    });

    if (isFresh) {
      // Return the data in the requested format (already stored correctly)
      return { 
        data: l1Data, 
        cacheStatus: CacheStatus.HIT_L2_KV, 
        ttl_ms: ttl_ms - age 
      };
    }

    // 3. STALE: Serve old data, revalidate in background
    ctx.waitUntil((async () => {
      try {
        const { data, etag } = await fetcher(kvEtag);
        if (data !== null) {
          await updateCaches(env, cacheKey, data, etag, parse);
        }
        // If 304: The L1 lock at 'now' (set above) keeps this isolate quiet.
      } catch (e) {
        L1_CACHE.delete(cacheKey);
      }
    })());

    // Return the data in the requested format (already stored correctly)
    return { data: l1Data, cacheStatus: CacheStatus.STALE_REVALIDATING, ttl_ms: 0 };
  }

  // 4. MISS: Network fallback
  const { data, etag } = await fetcher();
  
  // Store in both caches and get formatted data
  const l1Data = await updateCaches(env, cacheKey, data!, etag, parse, now);
  
  return { data: l1Data, cacheStatus: CacheStatus.MISS, ttl_ms };
}