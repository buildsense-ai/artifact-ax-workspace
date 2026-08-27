import type { Schema, SchemaProperty } from '@artifact-ax/contract';

/**
 * Minimal runtime validation of command args and region data against the
 * object-schema subset used by the manifest. Full JSON Schema is a later
 * concern; this slice covers types, enums, required fields, and array items.
 */
export function validateObject(value: unknown, schema: Schema | undefined): string[] {
  const errors: string[] = [];
  if (value === undefined || value === null) {
    errors.push('value is required');
    return errors;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.push('value must be an object');
    return errors;
  }
  const record = value as Record<string, unknown>;
  for (const required of schema?.required ?? []) {
    if (record[required] === undefined) {
      errors.push(`missing required property "${required}"`);
    }
  }
  for (const [key, property] of Object.entries(schema?.properties ?? {})) {
    if (record[key] === undefined) continue;
    errors.push(...validateProperty(record[key], property, key));
  }
  if (schema?.additionalProperties === false) {
    for (const key of Object.keys(record)) {
      if (!schema.properties[key]) {
        errors.push(`unknown property "${key}"`);
      }
    }
  }
  return errors;
}

function validateProperty(value: unknown, property: SchemaProperty, path: string): string[] {
  const errors: string[] = [];
  switch (property.type) {
    case 'string':
      if (typeof value !== 'string') errors.push(`${path} must be a string`);
      break;
    case 'number':
      if (typeof value !== 'number') errors.push(`${path} must be a number`);
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) errors.push(`${path} must be an integer`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path} must be a boolean`);
      break;
    case 'array':
      if (!Array.isArray(value)) {
        errors.push(`${path} must be an array`);
      } else {
        const items = property.items;
        if (items) {
          value.forEach((item, i) => {
            errors.push(...validateProperty(item, items, `${path}[${i}]`));
          });
        }
      }
      break;
    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`${path} must be an object`);
      }
      break;
    default:
      errors.push(`${path} has unsupported type "${property.type}"`);
  }
  if (property.enum !== undefined && !property.enum.includes(value)) {
    errors.push(`${path} must be one of ${JSON.stringify(property.enum)}`);
  }
  return errors;
}