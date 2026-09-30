/**
 * Canvas anchor builders — semantic-first element anchors and drag regions.
 *
 * Selector generation follows the Codex in-app-browser annotation approach
 * (restored `element-selectors.ts`): climb at most 4 ancestors, `#id`
 * short-circuits, at most 2 charset-safe classNames, `:nth-of-type` only
 * when same-tag siblings force it — then verify the candidate resolves to
 * exactly this element. Everything else is semantics-first: stable
 * `data-node-id` / `data-region-id` beats any generated selector.
 */

export interface AnchorPick {
  kind: 'element' | 'region';
  nodeId?: string;
  regionId?: string;
  /** Unique-verified generated selector (element fallback) or enclosing anchor region (region). */
  selector?: string;
  /** Viewport rect of the picked region or element. */
  rect?: { x: number; y: number; w: number; h: number };
  /** Region only: rect offset relative to the enclosing anchor at pick time —
   *  lets the marker reproject onto the node's CURRENT rect, not dead pixels. */
  deltas?: { dx: number; dy: number; dw: number; dh: number };
  excerpt?: string;
  /**
   * Bounded context summary (pi-annotate-style): tag, role, accessible
   * name, size — agent-legible evidence, never executable.
   */
  context?: string;
}

const SAFE_CLASS = /^[a-zA-Z0-9_-]+$/;
const MAX_DEPTH = 4;
const MAX_CLASSES = 2;

function escapeIdent(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function isUniqueFor(element: Element, selector: string): boolean {
  const root = element.getRootNode();
  if (!(root instanceof Document) && !(root instanceof ShadowRoot)) return false;
  const matches = root.querySelectorAll(selector);
  return matches.length === 1 && matches[0] === element;
}

/**
 * Generate a CSS selector for `element`, Codex-style: prefer `#id`, then
 * tag + up to 2 safe classes + `:nth-of-type` when needed, climbing until
 * the selector is unique or depth budget is spent.
 */
export function uniqueSelector(element: Element): string | null {
  const path: string[] = [];
  let current: Element | null = element;
  let depth = 0;
  while (current) {
    let part = current.tagName.toLowerCase();
    if (current.id) {
      part += `#${escapeIdent(current.id)}`;
      const candidate = [part, ...path].join(' > ');
      return isUniqueFor(element, candidate) ? candidate : null;
    }
    const classes = [...current.classList].filter((c) => SAFE_CLASS.test(c)).slice(0, MAX_CLASSES);
    if (classes.length > 0) part += `.${classes.map(escapeIdent).join('.')}`;
    const parent: Element | null = current.parentElement;
    if (parent) {
      const siblings = [...parent.children].filter((c) => c.tagName === current!.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }
    path.unshift(part);
    const candidate = path.join(' > ');
    if (isUniqueFor(element, candidate)) return candidate;
    current = parent;
    depth += 1;
    if (depth >= MAX_DEPTH) break;
  }
  return null;
}

function domRect(el: Element): { x: number; y: number; w: number; h: number } {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
}

/** Bounded element context for the agent — tag, role, name, size. */
function anchorContext(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role') ?? '';
  const name = (el.getAttribute('aria-label')
    ?? el.textContent?.replace(/\s+/g, ' ').trim() ?? '').slice(0, 40);
  const r = el.getBoundingClientRect();
  const parts = [tag];
  if (role) parts.push(`role=${role}`);
  if (name) parts.push(`“${name}”`);
  parts.push(`${Math.round(r.width)}×${Math.round(r.height)}`);
  return parts.join(' ').slice(0, 160);
}

/**
 * Element click: nearest semantic anchor wins; otherwise a unique selector.
 * The excerpt is bounded flattened text of the anchored element.
 */
/**
 * Anchor-level pick: `element` is itself the anchor (`data-node-id` or
 * `data-region-id`), chosen explicitly — e.g. by ancestor cycling. Unlike
 * `pickElement` it does NOT climb to the closest anchor; the picked level
 * is exactly the element given, so the visual cycle and the semantic
 * anchor agree 1:1.
 */
export function pickAnchored(element: HTMLElement): AnchorPick {
  const excerpt = element.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120) ?? '';
  return {
    kind: 'element',
    ...(element.dataset.nodeId ? { nodeId: element.dataset.nodeId } : {}),
    ...(element.dataset.regionId ? { regionId: element.dataset.regionId } : {}),
    rect: domRect(element),
    excerpt,
    context: anchorContext(element),
  };
}

/** All anchored ancestors of `el`, innermost first — the cycle ladder. */
export function anchorChainFor(el: HTMLElement): HTMLElement[] {
  const chain: HTMLElement[] = [];
  let node: HTMLElement | null = el;
  while (node && node !== document.body && node !== document.documentElement && chain.length < 12) {
    if (node.dataset.nodeId || node.dataset.regionId) chain.push(node);
    node = node.parentElement;
  }
  return chain;
}

export function pickElement(target: HTMLElement): AnchorPick {
  const anchored = target.closest<HTMLElement>('[data-node-id]')
    ?? target.closest<HTMLElement>('[data-region-id]');
  const excerpt = (anchored ?? target).textContent?.replace(/\s+/g, ' ').trim().slice(0, 120) ?? '';
  return {
    kind: 'element',
    ...(anchored?.dataset.nodeId ? { nodeId: anchored.dataset.nodeId } : {}),
    ...(anchored?.dataset.regionId ? { regionId: anchored.dataset.regionId } : {}),
    ...(anchored ? {} : (() => {
      const selector = uniqueSelector(target);
      return selector ? { selector } : {};
    })()),
    rect: domRect(anchored ?? target),
    excerpt,
    context: anchorContext(anchored ?? target),
  };
}

/**
 * Region drag: the dragged rect plus the smallest semantic anchor whose
 * element fully contains it (so re-marking can reproject against that
 * node's current position rather than raw pixels).
 */
export function pickRegion(rect: { x: number; y: number; w: number; h: number }): AnchorPick {
  const center = document.elementFromPoint(rect.x + rect.w / 2, rect.y + rect.h / 2) as HTMLElement | null;
  let enclosing: HTMLElement | null = null;
  for (let node: HTMLElement | null = center; node; node = node.parentElement) {
    const candidate = node.closest<HTMLElement>('[data-node-id]') ?? node.closest<HTMLElement>('[data-region-id]');
    if (!candidate) break;
    const r = candidate.getBoundingClientRect();
    if (r.x <= rect.x && r.y <= rect.y && r.x + r.width >= rect.x + rect.w && r.y + r.height >= rect.y + rect.h) {
      enclosing = candidate;
      break;
    }
  }
  const base = enclosing?.getBoundingClientRect();
  return {
    kind: 'region',
    ...(enclosing?.dataset.nodeId ? { nodeId: enclosing.dataset.nodeId } : {}),
    ...(enclosing?.dataset.regionId ? { regionId: enclosing.dataset.regionId } : {}),
    ...(enclosing ? {} : { selector: `[region ${rect.x},${rect.y}]` }),
    rect,
    ...(base ? { deltas: {
      dx: Math.round(rect.x - base.x),
      dy: Math.round(rect.y - base.y),
      dw: Math.round(rect.w - base.width),
      dh: Math.round(rect.h - base.height),
    } } : {}),
    excerpt: center?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120) ?? '',
  };
}
