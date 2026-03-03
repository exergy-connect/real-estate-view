import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MODEL_FILE = './docs/output/consolidated_model.json';
const DATA_FILE = './docs/output/consolidated_data.json.gz';
const OUTPUT_DIR = './docs/output/data/entities';

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

console.log(`Loading model from ${MODEL_FILE}...`);
const model = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf-8'));

// Extract entity types from the model's properties (top-level entities)
const entityTypes = Object.keys(model.properties || {});
console.log(`Found ${entityTypes.length} entity types in model: ${entityTypes.join(', ')}`);

console.log(`Reading and decompressing ${DATA_FILE}...`);
const compressedBuffer = fs.readFileSync(DATA_FILE);
const decompressedBuffer = zlib.gunzipSync(compressedBuffer);
const data = JSON.parse(decompressedBuffer.toString('utf-8'));

if (!data.data) {
    throw new Error('Invalid data structure: missing "data" key');
}

// Initialize collections for each entity type
const entityCollections = {};
for (const entityType of entityTypes) {
    entityCollections[entityType] = {};
}

/**
 * Build a map of field names to entity types from the model
 * This helps identify which fields contain arrays of entities
 */
function buildFieldToEntityMap(model) {
    const fieldMap = {};
    const entityTypes = Object.keys(model.properties || {});
    
    for (const entityType of entityTypes) {
        const entityDef = model.$defs?.[entityType];
        if (!entityDef) continue;
        
        const properties = entityDef.properties || {};
        for (const [fieldName, fieldDef] of Object.entries(properties)) {
            if (fieldDef.type === 'array' && fieldDef.items?.$ref) {
                // Extract entity type from $ref (e.g., "#/$defs/city" -> "city")
                const ref = fieldDef.items.$ref;
                const refEntityType = ref.replace('#/$defs/', '');
                if (entityTypes.includes(refEntityType)) {
                    fieldMap[fieldName] = refEntityType;
                }
            }
        }
    }
    
    return fieldMap;
}

/**
 * Get primary key field name for an entity type from the model
 */
function getPrimaryKey(entityType, model) {
    const entityDef = model.$defs?.[entityType];
    if (!entityDef) return null;
    
    const required = entityDef.required || [];
    const properties = entityDef.properties || {};
    
    // Primary key is typically the first required field, or a field ending in _id
    for (const field of required) {
        if (field.endsWith('_id') || field === entityType || field === 'id') {
            return field;
        }
    }
    // Fallback: first required field
    if (required.length > 0) {
        return required[0];
    }
    // Last resort: look for common patterns
    for (const [field, _] of Object.entries(properties)) {
        if (field.endsWith('_id') || field === entityType || field === 'id') {
            return field;
        }
    }
    return null;
}

/**
 * Recursively walk through nested data structure and collect all entities
 */
function collectEntities(obj, entityCollections, entityTypes, model, fieldToEntityMap, visited = new WeakSet()) {
    if (!obj || typeof obj !== 'object') {
        return;
    }
    
    // Prevent infinite loops with circular references
    if (visited.has(obj)) {
        return;
    }
    visited.add(obj);
    
    // If this is an array, process each element
    if (Array.isArray(obj)) {
        for (const item of obj) {
            collectEntities(item, entityCollections, entityTypes, model, fieldToEntityMap, visited);
        }
        return;
    }
    
    // Recursively process all properties
    for (const [key, value] of Object.entries(obj)) {
        // Check if this field contains an array of entities (using field map from model)
        const entityType = fieldToEntityMap[key];
        if (entityType && Array.isArray(value)) {
            const pkField = getPrimaryKey(entityType, model);
            for (const entity of value) {
                if (entity && typeof entity === 'object') {
                    // Determine the primary key value
                    let entityId;
                    if (pkField && entity[pkField] !== undefined) {
                        entityId = String(entity[pkField]);
                    } else {
                        // Fallback: try common patterns
                        entityId = entity.id || 
                                  entity[`${entityType}_id`] || 
                                  entity[`${entityType.slice(0, -1)}_id`] ||
                                  JSON.stringify(entity);
                    }
                    
                    // Only add if we don't already have this entity (deduplicate)
                    if (!entityCollections[entityType][entityId]) {
                        entityCollections[entityType][entityId] = entity;
                    }
                }
            }
        }
        // Recursively process nested objects
        collectEntities(value, entityCollections, entityTypes, model, fieldToEntityMap, visited);
    }
}

// Build field-to-entity map from model
const fieldToEntityMap = buildFieldToEntityMap(model);

// First, collect top-level entities
for (const entityType of entityTypes) {
    const entities = data.data[entityType];
    if (entities && typeof entities === 'object' && !Array.isArray(entities)) {
        // Merge top-level entities into collections
        for (const [id, entity] of Object.entries(entities)) {
            if (!entityCollections[entityType][id]) {
                entityCollections[entityType][id] = entity;
            }
        }
    }
}

// Then, recursively collect nested entities
collectEntities(data.data, entityCollections, entityTypes, model, fieldToEntityMap);

// Extract one JSON file per entity class (both top-level and nested)
let totalEntities = 0;
for (const entityType of entityTypes) {
    const entities = entityCollections[entityType];
    const entityCount = Object.keys(entities).length;
    
    if (entityCount === 0) {
        console.log(`  Skipping ${entityType}: no data found`);
        continue;
    }
    
    totalEntities += entityCount;
    
    // Write all entities of this type to a single file
    const outputFile = path.join(OUTPUT_DIR, `${entityType}.json`);
    fs.writeFileSync(
        outputFile,
        JSON.stringify(entities, null, 2)
    );
    
    console.log(`  Extracted ${entityType}: ${entityCount} instances -> ${outputFile}`);
}

console.log(`\nUnpack complete: ${totalEntities} total entities across ${entityTypes.length} entity types.`);