View at https://exergy-connect.github.io/real-estate-view/

## Build Process and Cloudflare Structure

### Build Process

The Cloudflare Worker uses a custom build step defined in `wrangler.jsonc` that runs `scripts/unpack.js` before deployment:

1. **Data Unpacking**: The `unpack.js` script:
   - Reads `docs/output/consolidated_data.json.gz` (compressed master data file)
   - Decompresses the gzipped JSON
   - Extracts individual entities from the nested structure: `{ data: { entity_type: { id: {...} } } }`
   - Sanitizes entity IDs to create valid filenames (replaces special characters like `()`, `/`, spaces with `_`)
   - Writes each entity as a separate JSON file to `docs/output/data/entities/` with format: `<entityType>_<entityId>.json`
   - Creates an index file at `docs/output/data/index.json` listing all entity IDs
   - Stores original ID and entity type in each file as `_originalId` and `_entityType` for reference

2. **Build Hook**: The `wrangler.jsonc` configuration automatically runs the unpack script during build:
   ```jsonc
   "build": {
     "command": "node scripts/unpack.js",
     "watch_dir": "docs"  // Re-runs if master JSON changes
   }
   ```

### Cloudflare Worker Structure

```
real-estate-view/
├── src/
│   ├── index.ts          # Main worker entry point - handles routing and asset serving
│   └── api.ts            # API route handlers and getEntity utility
├── scripts/
│   └── unpack.js         # Build script to unpack entities from master file
├── docs/                 # Static assets directory (served by Cloudflare)
│   ├── index.html        # Main HTML page
│   ├── output/
│   │   ├── consolidated_data.json.gz    # Compressed master data (2.3MB)
│   │   ├── consolidated_data.js         # JavaScript version
│   │   └── data/
│   │       ├── entities/                 # Individual entity JSON files (~2KB each)
│   │       │   └── <entityType>_<entityId>.json
│   │       └── index.json                # Entity index listing all IDs
│   └── crime/            # Crime heatmap assets
└── wrangler.jsonc        # Cloudflare Worker configuration
```

### Multi-Layer Caching Strategy

The worker implements a three-tier caching system for optimal performance:

1. **Memory Layer (RAM)**: 
   - Cached data persists in worker memory across requests
   - Fastest access (< 0.1ms)
   - Lost on worker restart/eviction

2. **Cache API (Persistent Disk)**:
   - Survives worker restarts and evictions
   - Background caching via `ctx.waitUntil()` - doesn't block requests
   - Uses Cloudflare's Cache API for persistent storage

3. **Asset Layer (Source)**:
   - Fetches from `docs/output/consolidated_data.json.gz`
   - Decompresses using `DecompressionStream("gzip")`
   - Stream-to-JSON parsing avoids 2.3MB string allocation

### API Endpoints

- **`/api`**: Returns the full consolidated dataset
  - Lazy-loaded via `loadCachedData()` function handle
  - Only loads when handler calls the function

- **`/api/compute`**: Computes aggregations and filters
  - Query params: `?filter=<entity_type>` - filter by entity type
  - Request body: `{ "compute": "count" }` - get entity counts per type
  - Supports POST/PUT with JSON body

- **`/api/entity?id=<entity_id>`**: Fetches a single entity
  - Uses sanitized entity ID format: `<entityType>_<entityId>`
  - Fetches from `docs/output/data/entities/<id>.json`
  - Fast lookup (~2KB file, <0.1ms parse time)
  - Returns 404 if entity not found
  - Example: `https://real-estate-view.jvb127.workers.dev/api/entity?id=fault_system_Clinton_Fault`

- **`/api/status`**: Health check endpoint
  - Returns "Kernel Online" status
  - Does not load cached data (lightweight)

### Data Loading Patterns

- **Full Dataset**: Handlers receive a `loadCachedData()` function handle that they can call when needed. This ensures data is only loaded for handlers that actually need it.

- **Individual Entities**: The `getEntity()` function constructs an absolute URL from the request origin and fetches individual entity files directly from assets. This avoids loading the entire dataset for single-entity lookups.

- **Stream-to-JSON Optimization**: Uses `DecompressionStream` with `.json()` directly on the stream, allowing V8 to parse tokens as they're unzipped, avoiding large string allocations.

### Configuration

The worker is configured via `wrangler.jsonc`:
- **Main Entry**: `src/index.ts`
- **Assets Directory**: `docs/` (served via `env.ASSETS`)
- **Compatibility Date**: `2026-02-28`
- **Compatibility Flags**: `nodejs_compat` (for Node.js APIs in build script)
- **Observability**: Enabled for monitoring and debugging
