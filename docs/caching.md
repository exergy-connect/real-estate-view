# Caching Architecture

## Overview

This document describes the sophisticated multi-layer caching system implemented in the real-estate-view Cloudflare Worker. The system provides optimal performance through a three-tier caching strategy with intelligent revalidation, ETag support, and stale-while-revalidate patterns.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Request Flow                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  L1 Cache Check │  ← Memory (RAM)
                    │  (Warm Isolate) │     ~0.1ms
                    └─────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │                   │
              HIT   │                   │  MISS/STALE
                    ▼                   ▼
            ┌──────────────┐    ┌─────────────────┐
            │ Return Data  │    │  L2 Cache Check │  ← Workers KV
            │  (0ms I/O)   │    │  (Persistent)   │     ~1-5ms
            └──────────────┘    └─────────────────┘
                                        │
                              ┌─────────┴─────────┐
                              │                   │
                        FRESH │                   │  STALE
                              ▼                   ▼
                    ┌──────────────┐    ┌──────────────────────┐
                    │ Return Data  │    │     Serve Stale +    │
                    │  (~1-5ms)    │    │ Revalidate Background│
                    └──────────────┘    └──────────────────────┘
                                                │
                                                ▼
                                    ┌──────────────────────┐
                                    │  Network/Asset Fetch │  ← Origin
                                    │  (with ETag check)   │     ~50-200ms
                                    │  (stale data param)  │
                                    └──────────────────────┘
                                                │
                                    ┌───────────┴───────────┐
                                    │                       │
                              304   │                       │  200/Error
                                    ▼                       ▼
                            ┌───────────┐    ┌──────────────────────────┐
                            │ No Change │    │ Update Caches OR Return  │
                            │ (0 bytes) │    │ Stale Data (if error)    │
                            └───────────┘    └──────────────────────────┘
```

## Cache Layers

### L1 Cache: Memory (RAM)

**Location**: Worker isolate memory  
**Persistence**: Survives across requests within the same warm isolate  
**Lifetime**: Until worker restart or eviction  
**Access Time**: ~0.1ms (essentially zero)

#### Characteristics

- **Global Scope**: Stored in module-level `Map` that persists across requests
- **Format Flexibility**: Stores data in the format requested (parsed JSON object or raw string)
- **Type Inference**: Format is inferred from the stored value type (`string` = raw, `object/array` = parsed)
- **Validation Tracking**: Tracks `validatedAt` timestamp and ETag for each entry
- **Zero-Tax Path**: When data is in L1 and fresh, response is instant with no I/O or CPU

#### Implementation

```typescript
const L1_CACHE = new Map<string, { 
  json: any;              // Parsed object or raw string
  validatedAt: number;    // Timestamp when validated
  etag: string           // ETag for revalidation
}>();
```

#### Cache Key Strategy

- Keys are consistent across layers (e.g., `"consolidated_data.json"`)
- Format is determined by first request and maintained for consistency
- Debug assertion validates format matches on retrieval

### L2 Cache: Workers KV

**Location**: Cloudflare's distributed edge storage  
**Persistence**: Survives worker restarts and evictions  
**Lifetime**: Until TTL expires or manual invalidation  
**Access Time**: ~1-5ms (edge network latency)

#### Characteristics

- **Persistent Storage**: Survives across all worker restarts
- **Raw Format**: Always stores JSON as raw strings (never parsed)
- **Metadata Storage**: Stores `cachedAt` timestamp and `etag` in KV metadata
- **Background Updates**: Stale data can be served while revalidation happens in background
- **Cross-Isolate**: Shared across all worker isolates in the same zone

#### Implementation

```typescript
await env.CACHE_KV.put(cacheKey, rawData, { 
  metadata: { 
    cachedAt: timestamp,  // When cached
    etag: etag            // For conditional requests
  } 
});
```

#### Freshness Check

- Compares `age = now - cachedAt` against `ttl_ms`
- If `age < ttl_ms`: Data is fresh, return immediately
- If `age >= ttl_ms`: Data is stale, serve it but revalidate in background

### L3: Network/Asset Layer

**Location**: Cloudflare Pages assets or origin server  
**Persistence**: Source of truth  
**Lifetime**: Until asset is updated  
**Access Time**: ~50-200ms (network (HTTPS) + decompression)

#### Characteristics

- **Source of Truth**: Always authoritative
- **ETag Support**: Uses HTTP ETags for conditional requests
- **Gzip Handling**: Automatically decompresses `.gz` files
- **Stream Processing**: Uses `DecompressionStream` for efficient processing
- **304 Responses**: Returns `null` data when content unchanged (zero bytes transferred)

#### Data Sizes

- **Uncompressed**: 560 kB (raw JSON)
- **Compressed**: 46.7 kB (gzipped, ~92% reduction)
- **Transfer Savings**: ~513 kB per request when using gzip
- **ETag 304**: 0 bytes transferred when content unchanged

## Smart Fetcher

The `createSmartFetcher` function provides intelligent network fetching with automatic optimization and graceful degradation:

### Features

1. **ETag Revalidation**
   - Sends `If-None-Match` header with previous ETag
   - Receives `304 Not Modified` if content unchanged
   - Zero bytes transferred on cache hits

2. **Automatic Gzip Detection**
   - Detects compression from URL pattern (`.gz` extension)
   - Checks `Content-Encoding` header as fallback
   - Uses `DecompressionStream` for efficient decompression
   - Achieves 92% size reduction (560 kB → 46.7 kB)

3. **Context Preservation**
   - Calls `env.ASSETS.fetch` directly to preserve `this` binding
   - Falls back to global `fetch` if `ASSETS` unavailable
   - Prevents "Illegal invocation" errors

4. **Stale Data Fallback**
   - Accepts stale data from cache (L1 or L2) as fallback parameter
   - Returns stale data with `isStale: true` flag on network errors
   - Converts parsed objects to strings when needed
   - Provides graceful degradation when network fails

### Implementation

```typescript
export const createSmartFetcher = (env: any, url: string): EntityFetcher => {
  return async (
    oldEtag?: string,
    staleData?: { data: any; age_ms: number }
  ): Promise<{ data: string | null; etag: string; isStale?: boolean }> => {
    const headers: Record<string, string> = {};
    if (oldEtag) headers['If-None-Match'] = oldEtag;

    try {
      const response = env.ASSETS?.fetch 
        ? await env.ASSETS.fetch(new Request(url, { headers }))
        : await fetch(new Request(url, { headers }));

      // Handle 304 (Not Modified) - Zero CPU/Network Waste
      if (response.status === 304) {
        return { data: null, etag: oldEtag! };
      }

      if (!response.ok) {
        // Network error - return stale data if available
        if (staleData) {
          const staleDataString = typeof staleData.data === 'string' 
            ? staleData.data 
            : JSON.stringify(staleData.data);
          return { data: staleDataString, etag: oldEtag || '', isStale: true };
        }
        throw new Error(`Fetch failed for ${url}: ${response.status}`);
      }

      // Automatic gzip decompression
      let body = response.body;
      const isGzipped = url.match(/\.gz(\?|$)/i) || 
                       response.headers.get('Content-Encoding') === 'gzip';
      if (isGzipped && body) {
        body = body.pipeThrough(new DecompressionStream("gzip"));
      }

      const data = await new Response(body).text();
      return { data, etag: response.headers.get('ETag') || '' };
    } catch (error) {
      // Network error - return stale data if available
      if (staleData) {
        const staleDataString = typeof staleData.data === 'string' 
          ? staleData.data 
          : JSON.stringify(staleData.data);
        return { data: staleDataString, etag: oldEtag || '', isStale: true };
      }
      throw error;
    }
  };
};
```

## Stale-While-Revalidate Pattern

One of the most sophisticated aspects of this caching system is the stale-while-revalidate pattern:

### How It Works

1. **Stale Detection**: When L2 cache data exists but `age >= ttl_ms`
2. **Immediate Response**: Serve stale data immediately to user
3. **Background Revalidation**: Use `ctx.waitUntil()` to revalidate asynchronously
4. **L1 Lock**: Set L1 cache `validatedAt` to `now` to prevent duplicate fetches
5. **Silent Update**: Update caches when fresh data arrives

### Benefits

- **Zero Latency**: Users never wait for network requests
- **Always Fresh**: Background updates ensure data stays current
- **Efficient**: Multiple requests during revalidation share the same background fetch
- **Resilient**: If revalidation fails, stale data remains available

### Implementation

```typescript
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

return { data: l1Data, cacheStatus: CacheStatus.STALE_REVALIDATING, ttl_ms: 0 };
```

### L1 Lock Mechanism

When data is stale:
- L1 cache is set with `validatedAt = now` (not the original `cachedAt`)
- This "locks" the cache entry, preventing other requests in the same isolate from triggering duplicate fetches
- Once revalidation completes, L1 is updated with fresh data and correct timestamp

## Cache Status Tracking

The system provides detailed cache status information through the `CacheStatus` enum:

### Status Values

- **`HIT_L1_RAM`**: Data served from memory cache (fastest, ~0.1ms)
- **`HIT_L2_KV`**: Data served from Workers KV (fast, ~1-5ms)
- **`STALE_REVALIDATING`**: Stale data served while background revalidation occurs
- **`MISS`**: Data fetched from network/asset layer (slowest, ~50-200ms)

### Usage

Cache status is exposed in:
- API responses via `X-Cache-Status` header
- Server-Timing headers for performance monitoring
- Return values for programmatic access

## Performance Characteristics

### Typical Latencies

| Cache Layer | Latency | Scenario |
|------------|---------|----------|
| L1 RAM | ~0.1ms | Warm isolate, fresh data |
| L2 KV | ~1-5ms | Cold isolate, fresh data |
| L2 KV (stale) | ~1-5ms | Stale data served immediately |
| Network (304) | ~10-50ms | ETag match, no data transfer |
| Network (200) | ~50-200ms | Full fetch with decompression |

### Cache Hit Rates

Expected hit rates in production:
- **L1**: 80-95% (warm isolates handle most traffic)
- **L2**: 5-15% (cold starts and new data)
- **Network**: <5% (only on cache misses or TTL expiration)

### Bandwidth Savings

- **ETag 304 responses**: Zero bytes transferred (vs 46.7 kB gzipped or 560 kB uncompressed)
- **Gzip compression**: 92% reduction (560 kB → 46.7 kB)
- **Stale-while-revalidate**: Eliminates user-facing latency while saving ~46.7 kB per background revalidation
- **Total savings per cache hit**: ~513 kB (uncompressed) or ~46.7 kB (compressed) not transferred

## Design Decisions

### Why Three Layers?

1. **L1 (Memory)**  : Fastest possible access for hot data
2. **L2 (KV)**      : Persistence across restarts, shared across isolates
3. **L3 (Network)** : Source of truth, always available

### Why Store Raw Strings in L2?

- **Consistency** : L2 always stores raw JSON strings
- **Flexibility** : L1 can store parsed or raw based on usage
- **Efficiency**  : Avoids double parsing (parse once, store in L1)
- **Simplicity**  : Single format in persistent storage

### Why Stale-While-Revalidate?

- **User Experience** : Zero latency for users
- **Freshness**       : Background updates keep data current
- **Efficiency**      : Multiple requests share single background fetch
- **Resilience**      : Stale data better than errors

### Why ETag Revalidation?

- **Bandwidth** : Zero bytes on cache hits
- **CPU**       : No parsing needed for unchanged content
- **Network**   : Minimal round-trip time
- **Accuracy**  : HTTP-standard conditional requests

## Cache Architecture

The caching system is organized into modular helper functions for maintainability:

### Helper Functions

1. **`checkL1Cache`**: Checks L1 (RAM) cache for fresh data
   - Returns result if hit and fresh
   - Validates format matches requested format (parsed vs raw)
   - Returns null if miss or stale

2. **`checkL2Cache`**: Checks L2 (KV) cache for data
   - Returns fresh data if available
   - Handles stale data with background revalidation
   - Populates L1 cache for future requests
   - Returns null if miss

3. **`handleMiss`**: Handles cache MISS case with network fallback
   - Attempts network fetch
   - Falls back to stale data (L1 or L2) on network errors
   - Uses `finally` block to ensure stale data is returned when available
   - Updates caches on successful fetch

4. **`updateCaches`**: Updates both L1 and L2 caches atomically
   - Stores data in requested format in L1
   - Always stores raw string in L2
   - Updates metadata (timestamp, ETag)

### Main Flow

```typescript
export async function getCachedJSON(...): Promise<GetCachedJSONResult> {
  const now = Date.now();

  // 1. Check L1 cache
  const l1Result = checkL1Cache(cacheKey, ttl_ms, parse, now);
  if (l1Result) return l1Result;

  // 2. Check L2 cache
  const l2Result = await checkL2Cache(env, ctx, cacheKey, ttl_ms, parse, fetcher, now);
  if (l2Result) return l2Result;

  // 3. Handle MISS with network fallback
  return handleMiss(env, ctx, cacheKey, ttl_ms, parse, fetcher, warm, value, meta, now);
}
```

## Cache Update Strategy

### Update Triggers

1. **Cache Miss**    : Always fetch and cache
2. **TTL Expired**   : Serve stale, revalidate in background
3. **ETag Mismatch** : Content changed, update immediately
4. **304 Response**  : Content unchanged, no update needed
5. **Network Error** : Return stale data if available (graceful degradation)

### Update Process

```typescript
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
```

## Usage Examples

### Basic Usage

```typescript
const fetcher = createSmartFetcher(env, assetUrl);
const result = await getCachedJSON(env, ctx, cacheKey, ttl_ms, fetcher, true);

// result.data: Parsed JSON object
// result.cacheStatus: CacheStatus enum value
// result.ttl_ms: Remaining TTL in milliseconds
```

### Raw String Mode

```typescript
const result = await getCachedJSON(env, ctx, cacheKey, ttl_ms, fetcher, false);

// result.data: Raw JSON string (no parsing overhead)
```

### Cache Status Monitoring

```typescript
const { data, cacheStatus } = await getCachedJSON(...);

switch (cacheStatus) {
  case CacheStatus.HIT_L1_RAM:
    console.log('Lightning fast from memory!');
    break;
  case CacheStatus.HIT_L2_KV:
    console.log('Fast from persistent cache');
    break;
  case CacheStatus.STALE_REVALIDATING:
    console.log('Served stale, updating in background');
    break;
  case CacheStatus.MISS:
    console.log('Fetched from network');
    break;
}
```

## Configuration

### TTL Settings

Different endpoints use different TTLs based on update frequency:

- **Model data**: 1 hour (3600 seconds) - changes infrequently
- **Data files**: 5 minutes (300 seconds) - may update more often

### Cache Keys

- **Model**: `"consolidated_model.json"`
- **Data**: `"consolidated_data.json"`

Keys are consistent across all cache layers for efficient lookups.

## Error Handling

### Graceful Degradation

- **L1 failure**: Falls back to L2
- **L2 failure**: Falls back to network
- **Network failure (MISS case)**: Returns stale data from L1 or L2 if available
- **Revalidation failure**: L1 cache entry deleted, next request will retry

### Network Error Fallback

In the MISS case, if a network fetch fails, the system attempts to return stale data:

1. **Stale Data Collection**: Collects stale data from already-checked L1 or L2 caches
2. **Fetcher Fallback**: Passes stale data to fetcher, which can return it on network errors
3. **Finally Block**: Ensures stale data is returned if fetcher indicates `isStale: true` or throws
4. **No Cache Pollution**: Stale data returned without updating caches (marked as `STALE_REVALIDATING`)

### Implementation

```typescript
async function handleMiss(...): Promise<GetCachedJSONResult> {
  // Collect stale data from already-looked-up sources
  let staleDataParam: { data: any; age_ms: number } | undefined;
  if (warm) {
    staleDataParam = { data: warm.json, age_ms: now - warm.validatedAt };
  } else if (value) {
    staleDataParam = { data: value, age_ms: now - (meta?.cachedAt || 0) };
  }

  let fetchResult = null;
  let fetchError = null;

  try {
    fetchResult = await fetcher(undefined, staleDataParam);
    if (!fetchResult.isStale) {
      // Fresh data - update caches
      const l1Data = await updateCaches(env, cacheKey, fetchResult.data!, fetchResult.etag, parse, now);
      return { data: l1Data, cacheStatus: CacheStatus.MISS, ttl_ms };
    }
  } catch (error) {
    fetchError = error;
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

  if (fetchError) throw fetchError;
}
```

### Error Recovery

```typescript
ctx.waitUntil((async () => {
  try {
    const { data, etag } = await fetcher(kvEtag);
    if (data !== null) {
      await updateCaches(env, cacheKey, data, etag, parse);
    }
  } catch (e) {
    // On error, remove L1 entry to force fresh fetch next time
    L1_CACHE.delete(cacheKey);
  }
})());
```

## Monitoring and Observability

### Server-Timing Headers

The system exposes detailed timing information:

```
Server-Timing: io;dur=2.45, cpu;dur=0.12, cache;desc=HIT_L1_RAM
```

- **io**: I/O time in milliseconds
- **cpu**: CPU time in milliseconds  
- **cache**: Cache status (HIT_L1_RAM, HIT_L2_KV, STALE_REVALIDATING, MISS)

### Response Headers

- **`X-Cache-Status`**: Human-readable cache status
- **`Server-Timing`**: Detailed performance metrics

## Best Practices

### When to Use Parsed vs Raw

- **Parsed (`parse: true`)**: When you need to manipulate the data
- **Raw (`parse: false`)**: When you're just passing through (e.g., SSE, streaming)

### TTL Selection

- **Short TTL (minutes)**: Frequently updated data
- **Long TTL (hours)**: Rarely updated data (models, schemas)
- **Consider**: Balance between freshness and cache efficiency

### Cache Key Design

- **Consistent**: Same key across all layers
- **Descriptive**: Include version or content type if needed
- **Unique**: Avoid collisions between different data types

## Future Enhancements

Potential improvements to consider:

1. **Cache Warming**: Pre-populate L1 cache on worker start
2. **Compression**: Compress L2 KV storage for large payloads
3. **Metrics**: Track hit rates and performance over time
4. **Invalidation**: Manual cache invalidation API
5. **Multi-Region**: Coordinate caches across Cloudflare regions

## Conclusion

This caching architecture provides:

- **Sub-millisecond responses** for cached data
- **Zero-latency stale-while-revalidate** for optimal UX
- **Bandwidth-efficient ETag revalidation** for network savings
- **Resilient error handling** with graceful degradation
- **Comprehensive observability** through status tracking

The system is designed to handle high-traffic scenarios while maintaining data freshness and optimal performance.
