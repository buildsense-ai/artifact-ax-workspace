import type {
  Catalog,
  CatalogComponent,
  PropSchema,
  UiDocument,
  UiNode,
} from './types.js';
import { CATALOG as catalogDef } from './catalog.js';
import { validateNodeStructure } from './patch-structure.js';

/**
 * Validation for the UI-document contract. This is the security-critical
 * boundary: it enforces the catalog/prop/binding/event allowlists and rejects
 * unknown or raw executable presentation inputs before any renderer touches a
 * document.
 */

/** Regex for a documented, safe region id (matches the AX region-id pattern). */
const REGION_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** Regex for a stable node id used as a `data-node-id` anchor. */
const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
/** A safe binding path is a dot-path of identifier segments, no brackets. */
const BINDING_SEGMENT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const BINDING_MAX_LENGTH = 200;
const PROP_MAX_STRING_LENGTH = 2000;

/** Props that could smuggle executable presentation if ever treated as markup. */
const BLOCKED_PROP_KEYS = new Set([
  'html',
  'innerHtml',
  'innerHTML',
  'dangerouslySetInnerHTML',
  'style',
  'className',
  'class',
  'href',
  'src',
  'srcdoc',
  'script',
  'stylesheet',
  'url',
  'hrefTemplate',
]);

/** Inline executable markers that must never appear in a text prop. */
const EXECUTABLE_TEXT_PATTERN = /<(?:script|iframe|object|embed|svg|math|style)\b|javascript:|vbscript:|data:text\/html|srcdoc\s*=|on(?:error|load|click|mouseover|mouseup|mousedown|focus|blur|pointerover|pointerdown|submit)\s*=/i;

function notEmpty(value: string): boolean {
  return value.trim() !== '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** True when a string looks like executable presentation and must be rejected. */
export function isExecutableText(value: string): boolean {
  return EXECUTABLE_TEXT_PATTERN.test(value);
}

function isExecutablePropKey(key: string): boolean {
  // Any event-handler-style attribute is off-limits.
  if (/^on/i.test(key)) return true;
  return BLOCKED_PROP_KEYS.has(key);
}

function isValidNodeId(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  if (!NODE_ID_PATTERN.test(value)) return false;
  if (value.includes('__') || value.includes('..')) return false;
  return notEmpty(value);
}

function isValidRegionId(value: string): boolean {
  return value.length <= 64 && REGION_ID_PATTERN.test(value);
}

function isValidPlacement(value: undefined | string): boolean {
  return value === undefined || value === 'main' || value === 'side' || value === 'full';
}

/** Validate a primitive prop value against its schema. */
function validatePropValue(schema: PropSchema, value: unknown, path: string): string[] {
  const errors: string[] = [];
  if (schema.type === 'string') {
    if (typeof value !== 'string') {
      errors.push(`${path} must be a string`);
      return errors;
    }
    const maxLength = schema.maxLength ?? PROP_MAX_STRING_LENGTH;
    if (value.length > maxLength) errors.push(`${path} must be at most ${maxLength} characters`);
    if (schema.enum !== undefined && !schema.enum.includes(value)) {
      errors.push(`${path} must be one of: ${schema.enum.join(', ')}`);
    }
    if (isExecutableText(value)) errors.push(`${path} must not contain executable presentation markup`);
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${path} must be a number`);
      return errors;
    }
    if (schema.integer === true && !Number.isInteger(value)) errors.push(`${path} must be an integer`);
    if (schema.min !== undefined && value < schema.min) errors.push(`${path} must be >= ${schema.min}`);
    if (schema.max !== undefined && value > schema.max) errors.push(`${path} must be <= ${schema.max}`);
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') errors.push(`${path} must be a boolean`);
  }
  return errors;
}

function validateProps(node: UiNode, def: CatalogComponent): string[] {
  const errors: string[] = [];
  if (node.props === undefined) return errors;
  if (!isPlainObject(node.props)) {
    errors.push(`node ${node.id}: props must be an object`);
    return errors;
  }
  const allowed = new Set(Object.keys(def.props));
  for (const key of Object.keys(node.props)) {
    if (isExecutablePropKey(key)) {
      errors.push(`node ${node.id}: prop "${key}" is a blocked executable presentation key`);
      continue;
    }
    if (!allowed.has(key)) {
      errors.push(`node ${node.id}: unknown prop "${key}" is not allowed for ${node.kind}`);
      continue;
    }
    const schema = def.props[key]!;
    errors.push(...validatePropValue(schema, node.props[key], `node ${node.id}.props.${key}`));
  }
  return errors;
}

function validateBindings(node: UiNode, def: CatalogComponent): string[] {
  const errors: string[] = [];
  if (node.bindings === undefined) return errors;
  if (!isPlainObject(node.bindings)) {
    errors.push(`node ${node.id}: bindings must be an object`);
    return errors;
  }
  const allowed = new Set(Object.keys(def.bindings));
  for (const [name, path] of Object.entries(node.bindings)) {
    if (!allowed.has(name)) {
      errors.push(`node ${node.id}: unknown binding "${name}" is not allowed for ${node.kind}`);
      continue;
    }
    if (typeof path !== 'string' || path.length === 0 || path.length > BINDING_MAX_LENGTH) {
      errors.push(`node ${node.id}: binding "${name}" path must be a bounded string`);
      continue;
    }
    if (!isSafeBindingPath(path)) {
      errors.push(`node ${node.id}: binding "${name}" path is not a safe data path`);
      continue;
    }
  }
  return errors;
}

function isSafeBindingPath(path: string): boolean {
  const segments = path.split('.');
  if (segments.some((segment) => segment === '')) return false;
  for (const segment of segments) {
    if (!BINDING_SEGMENT_PATTERN.test(segment)) return false;
    if (segment === '__proto__' || segment === 'prototype' || segment === 'constructor') return false;
  }
  return true;
}

function validateEvents(node: UiNode, def: CatalogComponent): string[] {
  const errors: string[] = [];
  if (node.events === undefined) return errors;
  if (!isPlainObject(node.events)) {
    errors.push(`node ${node.id}: events must be an object`);
    return errors;
  }
  for (const [event, action] of Object.entries(node.events)) {
    if (!Object.prototype.hasOwnProperty.call(def.events, event)) {
      errors.push(`node ${node.id}: unknown event "${event}" is not allowed for ${node.kind}`);
      continue;
    }
    const allowedActions = def.events[event] ?? [];
    if (typeof action !== 'string' || !allowedActions.includes(action)) {
      errors.push(`node ${node.id}: event "${event}" action must be one of: ${allowedActions.join(', ')}`);
      continue;
    }
  }
  return errors;
}

export function validateNode(node: UiNode, catalog: Catalog = catalogDef): string[] {
  const shapeErrors = validateNodeStructure(node);
  if (shapeErrors.length > 0) return shapeErrors;
  const errors: string[] = [];
  const def = catalog[node.kind];
  if (!Object.prototype.hasOwnProperty.call(catalog, node.kind) || def === undefined) {
    return [`node ${node.id}: unknown catalog kind "${node.kind}"`];
  }
  if (!isValidNodeId(node.id)) {
    errors.push(`node id "${node.id}" is not a safe node id`);
  }
  if (!isValidPlacement(node.placement)) {
    errors.push(`node ${node.id}: placement must be one of main/side/full`);
  }
  if (node.props !== undefined) {
    // Ensure the catalog entry itself has an allowlist for these props.
    errors.push(...validateProps(node, def));
  }
  if (node.bindings !== undefined) errors.push(...validateBindings(node, def));
  if (node.events !== undefined) errors.push(...validateEvents(node, def));
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) {
      errors.push(`node ${node.id}: children must be an array`);
    } else if (def.children !== true) {
      errors.push(`node ${node.id}: ${node.kind} does not allow child nodes`);
    } else {
      node.children.forEach((child, index) => {
        errors.push(...validateNode(child, catalog).map((e) => `node ${node.id}.children[${index}]: ${e}`));
      });
    }
  }
  return errors;
}

export function validateDocument(document: UiDocument, catalog: Catalog = catalogDef): string[] {
  const errors: string[] = [];
  if (!isPlainObject(document)) return ['document must be an object'];
  const allowed = new Set(['contract_version', 'id', 'title', 'revision', 'layout', 'nodes']);
  if (Object.keys(document).some((key) => !allowed.has(key))) errors.push('document contains an unknown field');
  if (document.contract_version !== 'artifact-ax.ui-document.v1') {
    errors.push(`document.contract_version must be artifact-ax.ui-document.v1`);
  }
  if (typeof document.id !== 'string' || document.id.length === 0 || document.id.length > 64) {
    errors.push('document.id must be a non-empty bounded string');
  }
  if (document.title !== undefined && (typeof document.title !== 'string' || document.title.length > 64)) {
    errors.push('document.title must be a bounded string');
  }
  if (!Number.isSafeInteger(document.revision) || document.revision < 0) {
    errors.push('document.revision must be a non-negative integer');
  }
  if (document.layout !== undefined && (!isPlainObject(document.layout) || document.layout.template !== 'main-side' || Object.keys(document.layout).some((key) => key !== 'template'))) {
    errors.push('document.layout must be { template: "main-side" }');
  }
  if (!Array.isArray(document.nodes) || document.nodes.length === 0) {
    errors.push('document.nodes must be a non-empty array');
    return errors;
  }
  const nodeIds = new Set<string>();
  const regionIds = new Set<string>();
  for (const node of document.nodes) {
    const shapeErrors = validateNodeStructure(node);
    if (shapeErrors.length > 0) {
      errors.push(...shapeErrors);
      continue;
    }
    errors.push(...validateNode(node, catalog));
    if (nodeIds.has(node.id)) errors.push(`duplicate node id ${node.id}`);
    nodeIds.add(node.id);
    const regionId = node.props?.regionId;
    if (typeof regionId === 'string') {
      if (!isValidRegionId(regionId)) errors.push(`node ${node.id}: invalid region id "${regionId}"`);
      if (regionIds.has(regionId)) errors.push(`duplicate region id ${regionId}`);
      regionIds.add(regionId);
    }
  }
  return errors;
}

/** Returns a list of errors; empty means the document is valid. */
export function checkDocument(document: UiDocument, catalog: Catalog = catalogDef): string[] {
  try {
    return validateDocument(document, catalog);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/** Assert a document is valid; throws the first message else returns it. */
export function assertDocument(document: UiDocument, catalog: Catalog = catalogDef): UiDocument {
  const errors = validateDocument(document, catalog);
  if (errors.length > 0) throw new UiDocumentError(errors[0]!, errors);
  return document;
}

export class UiDocumentError extends Error {
  constructor(message: string, readonly errors: string[]) {
    super(message);
    this.name = 'UiDocumentError';
  }
}
