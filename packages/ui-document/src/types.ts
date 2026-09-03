import type { SchemaProperty } from '@artifact-ax/contract';

/**
 * Versioned declarative UI-document contract.
 *
 * The document is a bounded, JSON-shaped description of an Artifact's visible
 * business surfaces. It references a *fixed, approved component catalog* (never
 * arbitrary HTML/JS/CSS), binds named data paths from a projection-derived view
 * model, and binds semantic events to allowlisted application actions. A
 * builder may propose a validated patch; it cannot emit raw presentation code,
 * access browser secrets, or bypass command/permission policy.
 */

export const UI_DOCUMENT_CONTRACT_VERSION = 'artifact-ax.ui-document.v1' as const;
export const UI_DOCUMENT_PATCH_CONTRACT_VERSION = 'artifact-ax.ui-document-patch.v1' as const;

/** Primitive values allowed as document props. No functions, no DOM nodes. */
export type UiPrimitive = string | number | boolean;

/** A per-prop schema that defines the allowlist of an approved component prop. */
export type PropSchema =
  | { type: 'string'; maxLength?: number; enum?: string[] }
  | { type: 'number'; integer?: boolean; min?: number; max?: number }
  | { type: 'boolean' };

/** The observable shape a binding name may resolve to. */
export type BindingKind = 'scalar' | 'record' | 'list';

/** An "approved component catalog" entry. */
export interface CatalogComponent<Kind extends string = string> {
  kind: Kind;
  description: string;
  /**
   * Allowlist of properties this component accepts. Any prop not listed here is
   * rejected. Values are primitives only; no `on*` handlers, `style`,
   * `innerHTML`, `className`, `href`, `src`, or `dangerouslySetInnerHTML`.
   */
  props: Record<string, PropSchema>;
  /** Allowlist of binding names this component may resolve, with declared shape. */
  bindings: Record<string, BindingKind>;
  /** Allowlist of semantic event names → allowed action names. */
  events: Record<string, readonly string[]>;
  /** When true the node may carry child nodes. */
  children?: boolean;
}

/** A catalog is a fixed map of component kind → definition. */
export type Catalog = Record<string, CatalogComponent>;

/**
 * A composable node in the document tree. `id` is the stable anchor (rendered as
 * `data-node-id`); `props`/`bindings`/`events` are all allowlisted by the
 * component's catalog entry.
 */
export interface UiNode {
  id: string;
  kind: string;
  placement?: 'main' | 'side' | 'full';
  props?: Record<string, UiPrimitive>;
  /** binding name → dot-path into the view model. */
  bindings?: Record<string, string>;
  /** semantic event name → allowlisted action name. */
  events?: Record<string, string>;
  /** Child nodes, allowed only when the catalog entry declares `children`. */
  children?: UiNode[];
}

/**
 * A versioned UI document: the single declarative description of the Artifact's
 * visible business surfaces.
 */
export interface UiDocument {
  contract_version: typeof UI_DOCUMENT_CONTRACT_VERSION;
  id: string;
  title?: string;
  revision: number;
  layout?: { template: 'main-side' };
  nodes: UiNode[];
}

/** Partial, validated update to a single node. */
export interface UiNodeUpdate {
  props?: Record<string, UiPrimitive>;
  bindings?: Record<string, string>;
  events?: Record<string, string>;
}

/** A patch operation. All operations re-validate against the catalog. */
export type UiPatchOp =
  | { op: 'insert'; index: number; node: UiNode }
  | { op: 'update'; id: string; update: UiNodeUpdate }
  | { op: 'remove'; id: string };

/**
 * A patch is target-tagged to a base document revision so a stale builder draft
 * cannot silently land on a moved document.
 */
export interface UiDocumentPatch {
  contract_version: typeof UI_DOCUMENT_PATCH_CONTRACT_VERSION;
  document_id: string;
  base_revision: number;
  ops: UiPatchOp[];
}

/** Reuse the schema-property shape so the catalog can describe prop docs. */
export type { SchemaProperty };
