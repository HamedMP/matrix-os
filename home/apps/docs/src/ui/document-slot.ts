/**
 * Keeps one value for the open document on behalf of a panel that comes and
 * goes: the workspace owns the slot, so switching side-panel tabs or closing
 * the side panel does not lose the value. A value made for another document
 * is disposed when the next one is asked for, and `clear` disposes it when
 * the workspace closes. It holds at most one value.
 */

export interface Disposable {
  dispose(): void;
}

export class DocumentSlot<T extends Disposable> {
  private entry: { documentKey: number; value: T } | null = null;

  /** The value for `documentKey`, made with `create` the first time it is asked for. */
  get(documentKey: number, create: () => T): T {
    if (this.entry !== null && this.entry.documentKey === documentKey) return this.entry.value;
    this.clear();
    const value = create();
    this.entry = { documentKey, value };
    return value;
  }

  /** The value kept now, for any document, or null. */
  current(): T | null {
    return this.entry?.value ?? null;
  }

  clear(): void {
    const entry = this.entry;
    this.entry = null;
    entry?.value.dispose();
  }
}
