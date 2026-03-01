import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib'; // 1. Import the compression module

const MASTER_FILE = './docs/output/consolidated_data.json.gz'; // Point to your .gz file
const OUTPUT_DIR = './docs/output/data/entities';

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

console.log(`Reading and decompressing ${MASTER_FILE}...`);

// 2. Read the raw compressed buffer
const compressedBuffer = fs.readFileSync(MASTER_FILE);

// 3. Decompress to a UTF-8 string
const decompressedBuffer = zlib.gunzipSync(compressedBuffer);
const data = JSON.parse(decompressedBuffer.toString('utf-8'));

// 4. Shred it - consolidated_data.json has structure: { data: { entity_type: { id: {...} } } }
if (!data.data) {
    throw new Error('Invalid data structure: missing "data" key');
}

// Sanitize filename by replacing invalid characters
function sanitizeFilename(str) {
    return str.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
              .replace(/\s+/g, '_')
              .replace(/_{2,}/g, '_')
              .replace(/^_+|_+$/g, '');
}

const propertyIds = [];
// Iterate through all entity types (property, school, geographic_area, etc.)
for (const [entityType, entities] of Object.entries(data.data)) {
    if (!entities || typeof entities !== 'object') continue;
    
    // Iterate through all entities of this type
    for (const [id, content] of Object.entries(entities)) {
        // Sanitize both entity type and id for filename safety
        const sanitizedType = sanitizeFilename(entityType);
        const sanitizedId = sanitizeFilename(id);
        const fullId = `${sanitizedType}_${sanitizedId}`;
        propertyIds.push(fullId);
        
        // Store original id in the content for reference
        const contentWithId = { ...content, _originalId: id, _entityType: entityType };
        
        // We write these as plain JSON for the Worker to fetch easily
        fs.writeFileSync(
            path.join(OUTPUT_DIR, `${fullId}.json`), 
            JSON.stringify(contentWithId)
        );
    }
}

console.log(`Unpacking ${propertyIds.length} entities...`);

// 5. Save the index
fs.writeFileSync(path.join(OUTPUT_DIR, '../index.json'), JSON.stringify(propertyIds));

console.log("Unpack complete.");