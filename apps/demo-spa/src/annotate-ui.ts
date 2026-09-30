/**
 * Annotation overlay — the pi-annotate interaction pattern, ported to run
 * inside the artifact page (MIT-style reference; upstream is a browser
 * extension so this is a distilled port, not a dependency).
 *
 * Entering annotate mode installs a capture layer:
 *   click            → pick element (semantic anchor → unique selector)
 *   drag             → pick a region rect
 *   Alt/⌥ + scroll   → cycle the hovered element's ancestors (DevTools-style)
 *   ESC / Cancel     → discard all pending notes
 *   Done             → submit every card with text
 *
 * Each pick spawns a numbered badge pinned to the anchor, a floating note
 * card with an inline textarea, and an SVG connector — the batch submits
 * through one `onSubmit`, so the caller's annotate/task pipeline stays
 * unchanged. The overlay owns its listeners and cleans up on exit.
 */

import { anchorChainFor, pickAnchored, pickElement, pickRegion } from './annotate-anchor.js';
import type { AnchorPick } from './annotate-anchor.js';

export interface PendingAnnotation {
  anchor: AnchorPick;
  text: string;
}

export interface AnnotateOverlayOptions {
  onSubmit(items: PendingAnnotation[]): void;
  /** Fires whenever the mode flips so the host can re-render its button. */
  onModeChange?(active: boolean): void;
}

interface AnnItem {
  anchor: AnchorPick;
  target: HTMLElement | null;
  badge: HTMLElement;
  card: HTMLElement;
  textarea: HTMLTextAreaElement;
  line: SVGPathElement;
}

const CARD_W = 260;
const CARD_GAP = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function anchorRect(anchor: AnchorPick): { x: number; y: number; w: number; h: number } | null {
  return anchor.rect ?? null;
}

/** Re-resolve a pick's live DOM element (anchors are id/selector-stable). */
function resolveAnchorElement(anchor: AnchorPick): HTMLElement | null {
  try {
    if (anchor.nodeId) return document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(anchor.nodeId)}"]`);
    if (anchor.regionId) return document.querySelector<HTMLElement>(`[data-region-id="${CSS.escape(anchor.regionId)}"]`);
    if (anchor.selector) return document.querySelector<HTMLElement>(anchor.selector);
  } catch {
    return null;
  }
  return null;
}

export function createAnnotateOverlay(opts: AnnotateOverlayOptions): { enter(): void; exit(): void; isActive(): boolean } {
  let active = false;
  let root: HTMLElement | null = null;
  let svg: SVGSVGElement | null = null;
  let hl: HTMLElement | null = null;
  let toolbar: HTMLElement | null = null;
  let counter: HTMLElement | null = null;
  let items: AnnItem[] = [];
  let seq = 0;
  // Element pick with ancestor cycling (Alt+scroll): the chain of ancestors
  // under the cursor; wheel moves the pick depth.
  let hoverEl: HTMLElement | null = null;
  let hoverChain: HTMLElement[] = [];
  let cycleDepth = 0;
  // Region drag bookkeeping.
  let dragStart: { x: number; y: number } | null = null;
  let dragBox: HTMLElement | null = null;

  const isInsideOverlay = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement
    && Boolean(target.closest('.ann-card') || target.closest('.ann-toolbar') || target.closest('.ann-badge'));

  /**
   * The cycle ladder contains ONLY anchored levels — `data-node-id` and
   * `data-region-id` ancestors — so every Alt+scroll depth is a real,
   * distinct anchor: highlight, badge and pick always agree 1:1 (nested
   * canvas nodes vs the canvas card are distinguishable).
   */
  const chainFor = anchorChainFor;

  function pickTarget(): HTMLElement | null {
    if (hoverChain.length > 0) return hoverChain[Math.min(cycleDepth, hoverChain.length - 1)] ?? null;
    return hoverEl;
  }

  function updateHighlight(): void {
    if (!hl) return;
    const target = pickTarget();
    if (!target) { hl.style.display = 'none'; return; }
    const r = target.getBoundingClientRect();
    hl.style.display = 'block';
    hl.style.left = `${r.left}px`;
    hl.style.top = `${r.top}px`;
    hl.style.width = `${r.width}px`;
    hl.style.height = `${r.height}px`;
    if (cycleDepth > 0) hl.dataset.ancestor = '1'; else delete hl.dataset.ancestor;
  }

  function reposition(): void {
    for (const item of items) {
      const rect = anchorRect(item.anchor);
      if (!rect) continue;
      item.badge.style.left = `${rect.x - 4}px`;
      item.badge.style.top = `${rect.y - 10}px`;
      const bx = rect.x + 8;
      const by = rect.y + rect.h / 2;
      const cardRect = item.card.getBoundingClientRect();
      const cx = cardRect.left;
      const cy = cardRect.top;
      item.line.setAttribute('d', `M ${bx} ${by} L ${cx} ${cy}`);
    }
  }

  function removeItem(item: AnnItem): void {
    items = items.filter((candidate) => candidate !== item);
    item.badge.remove();
    item.card.remove();
    item.line.remove();
    if (counter) counter.textContent = `Annotating · ${items.length} note${items.length === 1 ? '' : 's'}`;
  }

  /** Stable identity of a pick — same anchor picks must reuse one card. */
  function anchorKey(anchor: AnchorPick): string {
    return anchor.nodeId
      ?? anchor.regionId
      ?? anchor.selector
      ?? (anchor.rect ? `rect:${anchor.rect.x},${anchor.rect.y},${anchor.rect.w},${anchor.rect.h}` : 'unknown');
  }

  /** Pulse an existing card instead of spawning a duplicate pick. */
  function refocusItem(item: AnnItem): void {
    item.card.classList.remove('ann-flash');
    void item.card.offsetWidth; // restart the pulse
    item.card.classList.add('ann-flash');
    item.textarea.focus();
  }

  function spawnItem(anchor: AnchorPick): void {
    if (!root || !svg) return;
    // Same-anchor picks refocus the pending card — never duplicate badges
    // (pi-annotate semantics: the note is a property of the anchor).
    const key = anchorKey(anchor);
    const existing = items.find((item) => anchorKey(item.anchor) === key);
    if (existing) {
      refocusItem(existing);
      return;
    }
    seq += 1;
    const rect = anchorRect(anchor);
    const badge = document.createElement('div');
    badge.className = 'ann-badge';
    badge.textContent = String(seq);
    if (rect) {
      badge.style.left = `${rect.x - 4}px`;
      badge.style.top = `${rect.y - 10}px`;
    }
    badge.title = anchor.nodeId ?? anchor.regionId ?? anchor.selector ?? 'element';

    const card = document.createElement('div');
    card.className = 'ann-card';
    // Park the card just right of the anchor, clamped to the viewport.
    const cx = rect ? clamp(rect.x + rect.w + CARD_GAP, 8, window.innerWidth - CARD_W - 8) : window.innerWidth - CARD_W - 16;
    const cy = rect ? clamp(rect.y + rect.h / 2 - 40, 8, window.innerHeight - 140) : 16;
    card.style.left = `${cx}px`;
    card.style.top = `${cy}px`;

    const header = document.createElement('div');
    header.className = 'ann-card-head';
    const anchorLabel = anchor.kind === 'region'
      ? `region ${anchor.rect?.x ?? 0},${anchor.rect?.y ?? 0}`
      : anchor.nodeId ?? anchor.regionId ?? anchor.selector ?? 'element';
    header.append(`#${seq} ${anchorLabel}`);
    // pi-annotate parity: clicking the anchor label scrolls the element
    // to the top of the viewport so the note↔anchor loop closes.
    header.title = 'Scroll to anchor';
    header.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const el = resolveAnchorElement(anchor);
      if (el) {
        const top = el.getBoundingClientRect().top + window.scrollY - 80;
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
    });
    const close = document.createElement('button');
    close.className = 'ann-card-close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Remove note');
    header.appendChild(close);
    card.appendChild(header);

    if (anchor.context) {
      const ctx = document.createElement('div');
      ctx.className = 'ann-card-ctx';
      ctx.textContent = anchor.context;
      card.appendChild(ctx);
    }

    const textarea = document.createElement('textarea');
    textarea.className = 'ann-card-input';
    textarea.rows = 3;
    textarea.maxLength = 500;
    textarea.placeholder = 'What should change here?';
    card.appendChild(textarea);

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.setAttribute('class', 'ann-line');
    svg.appendChild(line);
    root.appendChild(badge);
    root.appendChild(card);

    const item: AnnItem = {
      anchor,
      target: resolveAnchorElement(anchor),
      badge,
      card,
      textarea,
      line,
    };
    items.push(item);
    close.addEventListener('click', () => removeItem(item));

    // Drag the card by its header.
    header.addEventListener('mousedown', (down) => {
      down.preventDefault();
      const startX = down.clientX - card.offsetLeft;
      const startY = down.clientY - card.offsetTop;
      const move = (ev: MouseEvent) => {
        card.style.left = `${clamp(ev.clientX - startX, 0, window.innerWidth - 80)}px`;
        card.style.top = `${clamp(ev.clientY - startY, 0, window.innerHeight - 40)}px`;
        reposition();
      };
      const up = () => {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', up, true);
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
    });

    if (counter) counter.textContent = `Annotating · ${items.length} note${items.length === 1 ? '' : 's'}`;
    textarea.focus();
    reposition();
  }

  function onClick(event: MouseEvent): void {
    if (!active) return;
    if (isInsideOverlay(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    const rawTarget = event.target as HTMLElement;
    // The click target is ground truth — a stale hover chain (mouse never
    // moved over this element, or moved between picks) must not hijack the
    // pick. Rebuild the chain when its base is not this click's target
    // (nor a descendant — clicking inside the hovered node keeps the
    // Alt+scroll ancestor cycle intact).
    if (hoverChain.length === 0 || !hoverChain.includes(rawTarget.closest<HTMLElement>('[data-node-id],[data-region-id]') ?? rawTarget)) {
      const anchorBase = rawTarget.closest<HTMLElement>('[data-node-id],[data-region-id]') ?? rawTarget;
      hoverChain = chainFor(anchorBase);
      cycleDepth = 0;
    }
    const target = pickTarget();
    spawnItem(target ? pickAnchored(target) : pickElement(rawTarget));
    cycleDepth = 0;
    hoverChain = [];
  }

  function onMouseDown(event: MouseEvent): void {
    if (!active || isInsideOverlay(event.target)) return;
    dragStart = { x: event.clientX, y: event.clientY };
  }

  function onMouseMove(event: MouseEvent): void {
    if (!active) return;
    if (dragStart) {
      const w = event.clientX - dragStart.x;
      const h = event.clientY - dragStart.y;
      if (Math.abs(w) < 8 && Math.abs(h) < 8 && !dragBox) return;
      if (!dragBox) {
        dragBox = document.createElement('div');
        dragBox.className = 'region-select';
        document.body.appendChild(dragBox);
      }
      dragBox.style.left = `${Math.min(dragStart.x, event.clientX)}px`;
      dragBox.style.top = `${Math.min(dragStart.y, event.clientY)}px`;
      dragBox.style.width = `${Math.abs(w)}px`;
      dragBox.style.height = `${Math.abs(h)}px`;
      return;
    }
    // Track hover for ancestor cycling + highlight.
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!target || isInsideOverlay(target)) return;
    if (target !== hoverEl) {
      hoverEl = target;
      hoverChain = chainFor(target);
      cycleDepth = 0;
    }
    updateHighlight();
  }

  function onMouseUp(event: MouseEvent): void {
    if (!active || !dragStart) return;
    dragStart = null;
    const box = dragBox;
    dragBox = null;
    if (!box) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = box.getBoundingClientRect();
    box.remove();
    if (rect.width < 8 || rect.height < 8) return;
    spawnItem(pickRegion({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    }));
  }

  // Alt/⌥ + scroll cycles ancestors — DevTools-style depth control.
  function onWheel(event: WheelEvent): void {
    if (!active || !(event.altKey || event.metaKey) || hoverChain.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    cycleDepth = clamp(
      cycleDepth + (event.deltaY > 0 ? 1 : -1),
      0,
      hoverChain.length - 1,
    );
    updateHighlight();
  }

  function onKey(event: KeyboardEvent): void {
    if (!active) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      exit();
      return;
    }
    // ⌘/Ctrl+Z removes the most recent pending note (overlay-local undo;
    // submitted annotations retract through board.retractAnnotation).
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z'
      && !(event.target instanceof HTMLTextAreaElement)) {
      event.preventDefault();
      const last = items.at(-1);
      if (last) removeItem(last);
    }
  }

  function onScrollOrResize(): void {
    if (active) reposition();
  }

  function teardown(): void {
    for (const item of items) {
      item.badge.remove();
      item.card.remove();
      item.line.remove();
    }
    items = [];
    seq = 0;
    dragBox?.remove();
    dragBox = null;
    dragStart = null;
    hoverEl = null;
    hoverChain = [];
    cycleDepth = 0;
    root?.remove();
    root = null;
    svg = null;
    hl = null;
    toolbar = null;
    counter = null;
    document.body.classList.remove('annotate-mode');
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('mouseup', onMouseUp, true);
    document.removeEventListener('wheel', onWheel, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScrollOrResize, true);
    window.removeEventListener('resize', onScrollOrResize);
  }

  function submit(): void {
    const pending = items
      .filter((item) => item.textarea.value.trim().length > 0)
      .map((item) => ({ anchor: item.anchor, text: item.textarea.value.trim() }));
    exit();
    if (pending.length > 0) opts.onSubmit(pending);
  }

  function enter(): void {
    if (active) return;
    active = true;
    document.body.classList.add('annotate-mode');

    root = document.createElement('div');
    root.className = 'ann-overlay';

    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ann-svg');
    root.appendChild(svg);

    hl = document.createElement('div');
    hl.className = 'ann-hl';
    hl.style.display = 'none';
    root.appendChild(hl);

    toolbar = document.createElement('div');
    toolbar.className = 'ann-toolbar';
    counter = document.createElement('span');
    counter.className = 'ann-counter';
    counter.textContent = 'Annotating · 0 notes';
    toolbar.appendChild(counter);
    const done = document.createElement('button');
    done.className = 'btn small accent';
    done.textContent = 'Done';
    done.addEventListener('click', submit);
    toolbar.appendChild(done);
    const cancel = document.createElement('button');
    cancel.className = 'btn small';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', exit);
    toolbar.appendChild(cancel);
    root.appendChild(toolbar);

    const hint = document.createElement('div');
    hint.className = 'ann-hint';
    hint.textContent = 'click element · drag region · ⌥+scroll ancestors · ⌘Z undo last · esc cancels';
    root.appendChild(hint);

    document.body.appendChild(root);

    document.addEventListener('click', onClick, true);
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('wheel', onWheel, { capture: true, passive: false });
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    opts.onModeChange?.(true);
  }

  function exit(): void {
    if (!active) return;
    active = false;
    teardown();
    opts.onModeChange?.(false);
  }

  return { enter, exit, isActive: () => active };
}
