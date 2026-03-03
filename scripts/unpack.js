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
 * Uses parent-child map from consolidated model to determine the relationship
 * No description checking - purely based on model structure
 */
function findForeignKey(childEntityType, parentEntityType, model, arrayFieldName = null) {
    const childDef = model.$defs?.[childEntityType];
    if (!childDef) return null;
    
    const parentDef = model.$defs?.[parentEntityType];
    const parentPkField = getPrimaryKey(parentEntityType, model);
    if (!parentPkField) return null;
    
    const parentPkDef = parentDef?.properties?.[parentPkField];
    const parentPkType = parentPkDef?.type;
    
    // Verify this is a valid parent-child relationship from the model
    if (arrayFieldName) {
        // Check if parent has this array field pointing to child
        if (!parentChildMap[parentEntityType] || 
            parentChildMap[parentEntityType][arrayFieldName] !== childEntityType) {
            return null; // Not a valid relationship
        }
    } else {
        // Without arrayFieldName, check if parent has any array field pointing to child
        const parentChildren = parentChildMap[parentEntityType];
        if (!parentChildren) return null;
        const hasChild = Object.values(parentChildren).includes(childEntityType);
        if (!hasChild) return null; // Not a valid relationship
    }
    
    // Find the FK field in child that matches parent's PK type
    const properties = childDef.properties || {};
    for (const [fieldName, fieldDef] of Object.entries(properties)) {
        // Type must match parent PK type
        if (fieldDef.type === parentPkType) {
            // Check if field name matches parent PK field name or common FK patterns
            const fieldNameLower = fieldName.toLowerCase();
            const parentPkFieldLower = parentPkField.toLowerCase();
            const parentNameLower = parentEntityType.toLowerCase();
            
            if (fieldNameLower === parentPkFieldLower ||
                fieldNameLower === `${parentNameLower}_id` ||
                fieldNameLower === `${parentNameLower}_${parentPkFieldLower}`) {
                return fieldName;
            }
        }
    }
    
    // If no exact name match, return first field with matching type
    // (This handles cases where FK field name doesn't follow standard patterns)
    for (const [fieldName, fieldDef] of Object.entries(properties)) {
        if (fieldDef.type === parentPkType) {
            return fieldName;
        }
    }
    
    return null;
}

/**
 * Build map of parent entity -> array field -> child entity type
 * Also build map of child entity -> field name -> { parentType, parentArray, parentPkField }
 * by checking foreignKeys with parent_array in each entity's fields
 */
function buildParentChildMaps(model) {
    const parentChildMap = {};
    const childParentFkMap = {}; // { childType: { fieldName: { parentType, parentArray, parentPkField }, ... } }
    const entityTypes = Object.keys(model.properties || {});
    
    // First, build parent-child map from array fields (as before)
    for (const parentType of entityTypes) {
        const parentDef = model.$defs?.[parentType];
        if (!parentDef) continue;
        
        const properties = parentDef.properties || {};
        for (const [fieldName, fieldDef] of Object.entries(properties)) {
            if (fieldDef.type === 'array' && fieldDef.items?.$ref) {
                const childType = fieldDef.items.$ref.replace('#/$defs/', '');
                if (entityTypes.includes(childType)) {
                    if (!parentChildMap[parentType]) parentChildMap[parentType] = {};
                    parentChildMap[parentType][fieldName] = childType;
                }
            }
        }
    }
    
    // Now, for each entity, iterate over its fields and check for x-parents
    for (const entityType of entityTypes) {
        const entityDef = model.$defs?.[entityType];
        if (!entityDef) continue;
        
        const properties = entityDef.properties || {};
        for (const [fieldName, fieldDef] of Object.entries(properties)) {
            // Check if this field has x-parents (foreignKeys with parent_array)
            const xParents = fieldDef['x-parents'];
            if (xParents && Array.isArray(xParents)) {
                // Iterate over x-parents
                for (const parent of xParents) {
                    if (parent && typeof parent === 'object' && parent.parent_array) {
                        // Found a parent relationship - remember it
                        const parentType = parent.entity;
                        const parentArray = parent.parent_array;
                        
                        if (parentType && parentArray && entityTypes.includes(parentType)) {
                            const parentPkField = getPrimaryKey(parentType, model);
                            
                            if (parentPkField) {
                                if (!childParentFkMap[entityType]) {
                                    childParentFkMap[entityType] = {};
                                }
                                childParentFkMap[entityType][fieldName] = {
                                    parentType: parentType,
                                    parentArray: parentArray,
                                    parentPkField: parentPkField
                                };
                            }
                        }
                    }
                }
            }
        }
    }
    
    return { parentChildMap, childParentFkMap };
}

// Initialize entity store (flat structure)
const entityStore = {};
for (const entityType of entityTypes) {
    entityStore[entityType] = {};
}

// Build parent-child relationship maps
const { parentChildMap, childParentFkMap } = buildParentChildMaps(model);

/**
 * Build reverse map: for each entity type, what parent entity types it can have
 * and what their PK fields are. Format: { childType: { parentType: pkField, ... } }
 * Uses both parentChildMap (from array fields) and childParentFkMap (from foreignKeys with parent_array)
 */
function buildChildParentMap(model, parentChildMap, childParentFkMap) {
    const childParentMap = {};
    
    // First, add relationships from parentChildMap (array fields)
    for (const [parentType, children] of Object.entries(parentChildMap)) {
        const parentPkField = getPrimaryKey(parentType, model);
        if (!parentPkField) continue;
        
        for (const [arrayField, childType] of Object.entries(children)) {
            if (!childParentMap[childType]) {
                childParentMap[childType] = {};
            }
            childParentMap[childType][parentType] = parentPkField;
        }
    }
    
    // Also add relationships from childParentFkMap (foreignKeys with parent_array)
    for (const [childType, fkFields] of Object.entries(childParentFkMap)) {
        if (!childParentMap[childType]) {
            childParentMap[childType] = {};
        }
        for (const fkInfo of Object.values(fkFields)) {
            childParentMap[childType][fkInfo.parentType] = fkInfo.parentPkField;
        }
    }
    
    return childParentMap;
}

// Build child-parent map (which parents can each child have)
const childParentMap = buildChildParentMap(model, parentChildMap, childParentFkMap);

/**
 * Flatten nested structure to entity store format, filling in parent foreign keys
 * Follows recursive pattern: process entity, fill parent FK, then recurse to children with parent PK
 */
function flattenToEntityStore(obj, parentContext = null, visited = new WeakSet(), expectedEntityType = null) {
    if (!obj || typeof obj !== 'object') {
        return;
    }
    
    // Prevent infinite loops with circular references
    if (visited.has(obj)) {
        return;
    }
    visited.add(obj);
    
    if (Array.isArray(obj)) {
        for (const item of obj) {
            flattenToEntityStore(item, parentContext, visited, null);
        }
        return;
    }
    
    // Identify entity type by checking primary keys
    // Priority: 1) expectedEntityType (from top-level), 2) expected child from parent context, 3) all others
    let entityType = null;
    
    // First, check expectedEntityType if provided (from top-level entity store)
    if (expectedEntityType && entityTypes.includes(expectedEntityType)) {
        const pkField = getPrimaryKey(expectedEntityType, model);
        if (pkField && obj[pkField] !== undefined) {
            entityType = expectedEntityType;
        }
    }
    
    // If we have parent context with arrayFieldName, check that child type next
    if (!entityType && parentContext && parentContext.arrayFieldName) {
        const parentChildren = parentChildMap[parentContext.parentType];
        if (parentChildren) {
            const expectedChildType = parentChildren[parentContext.arrayFieldName];
            if (expectedChildType) {
                const pkField = getPrimaryKey(expectedChildType, model);
                if (pkField && obj[pkField] !== undefined) {
                    entityType = expectedChildType;
                }
            }
        }
    }
    
    // If not identified yet, check all entity types
    if (!entityType) {
        for (const type of entityTypes) {
            const pkField = getPrimaryKey(type, model);
            if (pkField && obj[pkField] !== undefined) {
                entityType = type;
                break;
            }
        }
    }
    
    // If still not identified and we have parent context, try to identify from parent-child relationship
    if (!entityType && parentContext) {
        const parentChildren = parentChildMap[parentContext.parentType];
        if (parentChildren) {
            const arrayFieldName = parentContext.arrayFieldName;
            for (const [arrayField, childType] of Object.entries(parentChildren)) {
                if (arrayFieldName && arrayField !== arrayFieldName) {
                    continue;
                }
                const pkField = getPrimaryKey(childType, model);
                if (pkField) {
                    const fkField = findForeignKey(childType, parentContext.parentType, model, arrayField);
                    if (fkField === pkField && obj[pkField] === undefined) {
                        entityType = childType;
                        break;
                    }
                }
            }
        }
    }
    
    if (entityType) {
        const pkField = getPrimaryKey(entityType, model);
        let pkValue = obj[pkField];
        
        // If primary key is missing but we have parent context, try to fill it from parent FK
        if (pkValue === undefined && parentContext) {
            const arrayFieldName = parentContext.arrayFieldName;
            const fkField = findForeignKey(entityType, parentContext.parentType, model, arrayFieldName);
            if (fkField === pkField) {
                pkValue = parentContext.parentPk;
            }
        }
        
        if (pkValue === undefined) {
            // No primary key, recursively process instead
            for (const value of Object.values(obj)) {
                flattenToEntityStore(value, parentContext, visited);
            }
            return;
        }
        
        const pkString = String(pkValue);
        
        // Get or create entity in store
        let entity = entityStore[entityType][pkString];
        if (!entity) {
            // Make a copy for new entity
            entity = JSON.parse(JSON.stringify(obj));
            entityStore[entityType][pkString] = entity;
        }
        
        // Fill in primary key if it was missing
        if (entity[pkField] === undefined) {
            entity[pkField] = pkValue;
        }
        
        // Fill in foreign keys for all parents (direct parent and ancestors)
        // A node can have multiple parents, so check all parent relationships
        if (parentContext) {
            const entityDef = model.$defs?.[entityType];
            if (entityDef) {
                const properties = entityDef.properties || {};
                
                // Get all possible parents for this entity type (from pre-built map)
                const possibleParents = childParentMap[entityType];
                if (possibleParents) {
                    // Build map of available parent PK values (direct parent + ancestors)
                    const availableParentPks = {};
                    
                    // Add direct parent
                    if (parentContext.parentType && parentContext.parentPk !== undefined) {
                        availableParentPks[parentContext.parentType] = parentContext.parentPk;
                    }
                    
                    // Add all ancestors
                    if (parentContext.ancestors && parentContext.ancestorValues) {
                        for (const ancestorKey of parentContext.ancestors) {
                            // ancestorKey is in format "<entityType>.<pkField>"
                            const [ancestorEntityType] = ancestorKey.split('.');
                            const ancestorPkValue = parentContext.ancestorValues[ancestorKey];
                            
                            if (ancestorPkValue !== undefined) {
                                availableParentPks[ancestorEntityType] = ancestorPkValue;
                            }
                        }
                    }
                    
                    // For each possible parent, if we have its PK value, fill in matching FK fields
                    for (const [parentEntityType, parentPkField] of Object.entries(possibleParents)) {
                        const parentPkValue = availableParentPks[parentEntityType];
                        
                        if (parentPkValue !== undefined) {
                            const parentPkDef = model.$defs?.[parentEntityType]?.properties?.[parentPkField];
                            const parentPkType = parentPkDef?.type;
                            
                            if (parentPkType) {
                                // Fill in all fields that match this parent's PK type
                                for (const [fieldName, fieldDef] of Object.entries(properties)) {
                                    if (fieldDef.type === parentPkType && 
                                        (entity[fieldName] === undefined || entity[fieldName] === null)) {
                                        entity[fieldName] = parentPkValue;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        
        // Process nested children - pass current entity's PK and all ancestors
        const children = parentChildMap[entityType];
        if (children) {
            for (const [arrayField, childType] of Object.entries(children)) {
                if (Array.isArray(entity[arrayField])) {
                    // Create child context with current entity's PK, array field name, and all ancestors
                    // Ancestors stored as "<entityType>.<pkField>" format
                    const pkField = getPrimaryKey(entityType, model);
                    const currentAncestorKey = pkField ? `${entityType}.${pkField}` : null;
                    
                    const childContext = {
                        parentType: entityType,
                        parentPk: pkValue,
                        arrayFieldName: arrayField,  // Pass array field name so FK can be found correctly
                        ancestors: parentContext ? [
                            ...(parentContext.ancestors || []),
                            ...(currentAncestorKey ? [currentAncestorKey] : [])
                        ] : (currentAncestorKey ? [currentAncestorKey] : []),  // Build ancestor chain
                        ancestorValues: parentContext ? {
                            ...(parentContext.ancestorValues || {}),
                            ...(currentAncestorKey ? { [currentAncestorKey]: pkValue } : {})
                        } : (currentAncestorKey ? { [currentAncestorKey]: pkValue } : {})  // Store ancestor PK values
                    };
                    // Recursively process each child, passing parent PK and ancestors
                    for (const child of entity[arrayField]) {
                        flattenToEntityStore(child, childContext, visited, null);
                    }
                }
            }
        }
    } else {
        // Not an entity, recursively process all values
        for (const value of Object.values(obj)) {
            flattenToEntityStore(value, parentContext, visited, null);
        }
    }
}

// Flatten the data structure
console.log('Flattening nested structure to entity store format...');
// Process top-level entity stores
for (const [topLevelEntityType, entities] of Object.entries(data.data)) {
    if (entities && typeof entities === 'object' && !Array.isArray(entities)) {
        // Entity store format: { pk: entityData, ... }
        // Pass the top-level entity type as context to help with identification
        for (const entity of Object.values(entities)) {
            flattenToEntityStore(entity, null, new WeakSet(), topLevelEntityType);
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
