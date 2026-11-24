/**
 * Carries text positions through an edit. Every primitive that changes the
 * markup text of a paragraph, or moves text between paragraphs, reports it
 * here; pinned positions follow.
 */

import type { BlockId, TextPosition } from "../../api/docx-model.js";

export class PositionTracker {
  private readonly slots: Array<TextPosition | null> = [];

  /** Starts following a position. Returns the handle to read it back with. */
  pin(position: TextPosition | null): number {
    this.slots.push(position === null ? null : { blockId: position.blockId, offset: position.offset });
    return this.slots.length - 1;
  }

  read(handle: number): TextPosition | null {
    const slot = this.slots[handle] ?? null;
    return slot === null ? null : { blockId: slot.blockId, offset: slot.offset };
  }

  /** Stops following the positions pinned after `count` were pinned. */
  truncate(count: number): void {
    this.slots.length = Math.min(this.slots.length, count);
  }

  get size(): number {
    return this.slots.length;
  }

  /** `length` characters were inserted at `offset`. A position exactly there stays in front of them. */
  textInserted(blockId: BlockId, offset: number, length: number): void {
    if (length <= 0) return;
    for (const slot of this.slots) {
      if (slot !== null && slot.blockId === blockId && slot.offset > offset) slot.offset += length;
    }
  }

  /** `length` characters from `offset` were removed. Positions inside move to where the text was. */
  textRemoved(blockId: BlockId, offset: number, length: number): void {
    if (length <= 0) return;
    for (const slot of this.slots) {
      if (slot === null || slot.blockId !== blockId || slot.offset <= offset) continue;
      slot.offset = slot.offset >= offset + length ? slot.offset - length : offset;
    }
  }

  /**
   * The text of `from` at and after `fromOffset` now sits in `to`, starting
   * at `toOffset`: a paragraph was split, or merged into another.
   */
  textMoved(from: BlockId, fromOffset: number, to: BlockId, toOffset: number): void {
    for (const slot of this.slots) {
      if (slot === null || slot.blockId !== from || slot.offset < fromOffset) continue;
      slot.blockId = to;
      slot.offset = toOffset + (slot.offset - fromOffset);
    }
  }

  /** A block is gone. Its positions move to `fallback`, the nearest surviving position, or become null. */
  blockRemoved(blockId: BlockId, fallback: TextPosition | null): void {
    for (let at = 0; at < this.slots.length; at++) {
      const slot = this.slots[at];
      if (slot === null || slot === undefined || slot.blockId !== blockId) continue;
      this.slots[at] = fallback === null ? null : { blockId: fallback.blockId, offset: fallback.offset };
    }
  }
}
