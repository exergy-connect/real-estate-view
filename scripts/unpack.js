// scripts/unpack.js
import fs from 'node:fs';
import path from 'node:path';

const MASTER_FILE = './docs/consolidated_data.json';
const OUTPUT_DIR = './docs/data/entities';

// 1. Ensure output dir exists
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// 2. Load the beast one last time (locally, where RAM is cheap)
const data = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf-8'));

// 3. Shred it
console.log(`Unpacking ${Object.keys(data.properties).length} entities...`);

for (const [id, content] of Object.entries(data.properties)) {
    fs.writeFileSync(
        path.join(OUTPUT_DIR, `${id}.json`), 
        JSON.stringify(content)
    );
}

// 4. Save a tiny index for "List" views
const index = Object.keys(data.properties);
fs.writeFileSync(path.join(OUTPUT_DIR, '../index.json'), JSON.stringify(index));

console.log("Unpack complete.");