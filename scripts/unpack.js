import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib'; // 1. Import the compression module

const MASTER_FILE = './docs/consolidated_data.json.gz'; // Point to your .gz file
const OUTPUT_DIR = './docs/data/entities';

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

console.log(`Reading and decompressing ${MASTER_FILE}...`);

// 2. Read the raw compressed buffer
const compressedBuffer = fs.readFileSync(MASTER_FILE);

// 3. Decompress to a UTF-8 string
const decompressedBuffer = zlib.gunzipSync(compressedBuffer);
const data = JSON.parse(decompressedBuffer.toString('utf-8'));

// 4. Shred it
const propertyIds = Object.keys(data.properties);
console.log(`Unpacking ${propertyIds.length} entities...`);

for (const [id, content] of Object.entries(data.properties)) {
    // We write these as plain JSON for the Worker to fetch easily
    fs.writeFileSync(
        path.join(OUTPUT_DIR, `${id}.json`), 
        JSON.stringify(content)
    );
}

// 5. Save the index
fs.writeFileSync(path.join(OUTPUT_DIR, '../index.json'), JSON.stringify(propertyIds));

console.log("Unpack complete.");