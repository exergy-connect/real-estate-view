import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MODEL_FILE = './docs/output/consolidated_model.json';
const DATA_FILE = './docs/output/consolidated_data.json.gz';
const OUTPUT_DIR = './docs/output/data/entities';

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

console.log(`Loading model from ${MODEL_FILE}...`);
const model = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf-8'));

// Extract entity types from the model's properties
const entityTypes = Object.keys(model.properties || {});
console.log(`Found ${entityTypes.length} entity types in model: ${entityTypes.join(', ')}`);

console.log(`Reading and decompressing ${DATA_FILE}...`);
const compressedBuffer = fs.readFileSync(DATA_FILE);
const decompressedBuffer = zlib.gunzipSync(compressedBuffer);
const data = JSON.parse(decompressedBuffer.toString('utf-8'));

if (!data.data) {
    throw new Error('Invalid data structure: missing "data" key');
}

/**
 * Get primary key field name for an entity type from the model
 */
function getPrimaryKey(entityType, model) {
    const entityDef = model.$defs?.[entityType];
    if (!entityDef) return null;
    
    const required = entityDef.required || [];
    if (required.length > 0) {
        return required[0];
    }
    return null;
}

/**
 * Find foreign key field in child that references parent
 */
function findForeignKey(childEntityType, parentEntityType, model) {
    const childDef = model.$defs?.[childEntityType];
    if (!childDef) return null;
    
    const properties = childDef.properties || {};
    for (const [fieldName, fieldDef] of Object.entries(properties)) {
        const desc = fieldDef.description || '';
        if (desc.includes(`Foreign key reference to ${parentEntityType}`)) {
            return fieldName;
        }
    }
    return null;
}

/**
 * Build map of parent entity -> array field -> child entity type
 */
function buildParentChildMap(model) {
    const map = {};
    const entityTypes = Object.keys(model.properties || {});
    
    for (const parentType of entityTypes) {
        const parentDef = model.$defs?.[parentType];
        if (!parentDef) continue;
        
        const properties = parentDef.properties || {};
        for (const [fieldName, fieldDef] of Object.entries(properties)) {
            if (fieldDef.type === 'array' && fieldDef.items?.$ref) {
                const childType = fieldDef.items.$ref.replace('#/$defs/', '');
                if (entityTypes.includes(childType)) {
                    if (!map[parentType]) map[parentType] = {};
                    map[parentType][fieldName] = childType;
                }
            }
        }
    }
    return map;
}

// Initialize entity store (flat structure)
const entityStore = {};
for (const entityType of entityTypes) {
    entityStore[entityType] = {};
}

// Build parent-child relationship map
const parentChildMap = buildParentChildMap(model);

/**
 * Flatten nested structure to entity store format, filling in parent foreign keys
 */
function flattenToEntityStore(obj, parentContext = null, visited = new WeakSet()) {
    if (!obj || typeof obj !== 'object' || visited.has(obj)) {
        return;
    }
    visited.add(obj);
    
    if (Array.isArray(obj)) {
        for (const item of obj) {
            flattenToEntityStore(item, parentContext, visited);
        }
        return;
    }
    
    // Identify entity type by checking primary keys
    let entityType = null;
    for (const type of entityTypes) {
        const pkField = getPrimaryKey(type, model);
        if (pkField && obj[pkField] !== undefined) {
            entityType = type;
            break;
        }
    }
    
    if (entityType) {
        const pkField = getPrimaryKey(entityType, model);
        const pkValue = obj[pkField];
        const pkString = String(pkValue);
        
        // Make a copy
        const entity = JSON.parse(JSON.stringify(obj));
        
        // Fill in parent foreign key if we have parent context
        if (parentContext) {
            const fkField = findForeignKey(entityType, parentContext.parentType, model);
            if (fkField && entity[fkField] === undefined) {
                entity[fkField] = parentContext.parentPk;
            }
        }
        
        // Store in entity store (deduplicate)
        if (!entityStore[entityType][pkString]) {
            entityStore[entityType][pkString] = entity;
        }
        
        // Process nested children
        const children = parentChildMap[entityType];
        if (children) {
            for (const [arrayField, childType] of Object.entries(children)) {
                if (Array.isArray(entity[arrayField])) {
                    const childContext = {
                        parentType: entityType,
                        parentPk: pkValue
                    };
                    for (const child of entity[arrayField]) {
                        flattenToEntityStore(child, childContext, visited);
                    }
                }
            }
        }
    } else {
        // Not an entity, recursively process
        for (const value of Object.values(obj)) {
            flattenToEntityStore(value, parentContext, visited);
        }
    }
}

// Flatten the data structure
console.log('Flattening nested structure to entity store format...');
for (const [entityType, entities] of Object.entries(data.data)) {
    if (entities && typeof entities === 'object' && !Array.isArray(entities)) {
        // Entity store format: { pk: entityData, ... }
        for (const entity of Object.values(entities)) {
            flattenToEntityStore(entity, null);
        }
    }
}

// Write each entity type to a JSON file
let totalEntities = 0;
for (const entityType of entityTypes) {
    const entities = entityStore[entityType];
    const count = Object.keys(entities).length;
    
    if (count === 0) {
        console.log(`  Skipping ${entityType}: no data found`);
        continue;
    }
    
    totalEntities += count;
    const outputFile = path.join(OUTPUT_DIR, `${entityType}.json`);
    fs.writeFileSync(outputFile, JSON.stringify(entities, null, 2));
    console.log(`  Extracted ${entityType}: ${count} instances -> ${outputFile}`);
}

console.log(`\nUnpack complete: ${totalEntities} total entities across ${entityTypes.length} entity types.`);
