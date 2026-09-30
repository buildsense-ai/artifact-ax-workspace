import * as Y from 'yjs';

/**
 * Minimal two-way binding between a <textarea> and a Y.Text — the piece that
 * actually demonstrates Yjs: two people typing in the same pad merge at
 * character level instead of last-writer-wins.
 *
 *   const dispose = bindTextarea(el, doc.getText('notes:w-1'));
 *
 * The binding is deliberately editor-agnostic: any object satisfying
 * TextAreaLike works, so tests run without a DOM.
 */

export interface TextEdit {
  /** Index where the change begins. */
  index: number;
  /** Characters removed at `index`. */
  remove: number;
  /** Characters inserted at `index`. */
  insert: string;
}

/**
 * Compute the minimal single-splice edit turning `before` into `after` by
 * trimming the common prefix and suffix. Inputs produce exactly one splice
 * per change; remote merges may collapse several edits into one coarse edit,
 * which is fine for cursor math.
 */
export function diffTextEdit(before: string, after: string): TextEdit {
  let index = 0;
  const max = Math.min(before.length, after.length);
  while (index < max && before[index] === after[index]) index += 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > index && afterEnd > index && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return { index, remove: beforeEnd - index, insert: after.slice(index, afterEnd) };
}

/**
 * Where a caret at `position` should land after `edit` is applied: positions
 * before the edit stay; positions inside the replaced range clamp to the end
 * of the inserted text; positions after shift by the length delta.
 */
export function adjustCursorAfterEdit(position: number, edit: TextEdit): number {
  if (position <= edit.index) return position;
  if (position >= edit.index + edit.remove) {
    return position + (edit.insert.length - edit.remove);
  }
  return edit.index + edit.insert.length;
}

/** The slice of HTMLTextAreaElement the binding needs (testable, DOM-free). */
export interface TextAreaLike {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface BindOptions {
  onFocusChange?: (focused: boolean) => void;
}

/**
 * Bind a textarea to a Y.Text. Local input splices into the text inside one
 * transaction per input event; remote updates are applied back with caret
 * preservation. Returns a dispose function.
 */
export function bindTextarea(textarea: TextAreaLike, ytext: Y.Text, options: BindOptions = {}): () => void {
  textarea.value = ytext.toString();

  const onInput = () => {
    const current = ytext.toString();
    if (current === textarea.value) return;
    const edit = diffTextEdit(current, textarea.value);
    ytext.doc?.transact(() => {
      if (edit.remove > 0) ytext.delete(edit.index, edit.remove);
      if (edit.insert.length > 0) ytext.insert(edit.index, edit.insert);
    });
  };

  const onTextChange = () => {
    const remote = ytext.toString();
    if (remote === textarea.value) return;
    const edit = diffTextEdit(textarea.value, remote);
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    textarea.value = remote;
    textarea.setSelectionRange(adjustCursorAfterEdit(start, edit), adjustCursorAfterEdit(end, edit));
  };

  const onFocus = () => options.onFocusChange?.(true);
  const onBlur = () => options.onFocusChange?.(false);

  ytext.observe(onTextChange);
  textarea.addEventListener('input', onInput);
  textarea.addEventListener('focus', onFocus);
  textarea.addEventListener('blur', onBlur);

  return () => {
    ytext.unobserve(onTextChange);
    textarea.removeEventListener('input', onInput);
    textarea.removeEventListener('focus', onFocus);
    textarea.removeEventListener('blur', onBlur);
  };
}
