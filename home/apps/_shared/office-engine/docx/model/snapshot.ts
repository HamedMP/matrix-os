/**
 * Snapshots of the document state, for undo and for all-or-nothing edits.
 *
 * A snapshot holds one frozen copy per unit of every part (see `parts.ts`).
 * A unit that did not change since it was last frozen is shared between
 * snapshots, so a snapshot after an edit copies only the paragraphs that edit
 * touched. Restoring keeps every live unit that still matches its frozen copy
 * and re-creates the others, with the identity (block, revision and field
 * ids) the elements had when the snapshot was taken.
 */

import type { DocxSnapshot } from "../../api/docx.js";
import type { XmlChildNode, XmlDocument, XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { appendChild, cloneDocument, cloneNode, remove } from "../../xml/index.js";
import { type FrozenPart, type PartSlot, type PartStore, containerOf } from "./parts.js";

interface SnapshotEntry {
  readonly slot: PartSlot;
  readonly version: number;
  readonly part: FrozenPart;
}

/** The private shape behind the opaque {@link DocxSnapshot}. */
export interface SnapshotData extends DocxSnapshot {
  readonly owner: PartStore;
  readonly entries: readonly SnapshotEntry[];
}

interface UnitCopy {
  readonly stamp: number;
  /** `PartStore.retagEpoch` when the copy was made; ids on the live unit may differ after it moves on. */
  readonly epoch: number;
  readonly frozen: XmlChildNode;
}

/** Copies the identity tags of a subtree onto a structurally identical subtree. */
function copyTags(store: PartStore, from: XmlChildNode, to: XmlChildNode): void {
  if (from.kind !== "element" || to.kind !== "element") return;
  const sources: XmlElement[] = [from];
  const targets: XmlElement[] = [to];
  while (sources.length > 0) {
    const source = sources.pop() as XmlElement;
    const target = targets.pop() as XmlElement;
    const tags = store.tags.get(source);
    if (tags !== undefined) store.tags.set(target, { ...tags });
    const sourceChildren = source.children;
    const targetChildren = target.children;
    for (let index = 0; index < sourceChildren.length; index++) {
      const a = sourceChildren[index] as XmlChildNode;
      const b = targetChildren[index];
      if (a.kind !== "element" || b === undefined || b.kind !== "element") continue;
      if (a.children.length > 0) {
        sources.push(a);
        targets.push(b);
      } else {
        const leafTags = store.tags.get(a);
        if (leafTags !== undefined) store.tags.set(b, { ...leafTags });
      }
    }
  }
}

export class SnapshotManager {
  private readonly store: PartStore;
  /** Live unit to its frozen copy, valid while the unit's stamp is unchanged. */
  private readonly copies = new WeakMap<XmlChildNode, UnitCopy>();

  constructor(store: PartStore) {
    this.store = store;
  }

  /** The part with no units: everything outside the container, plus the empty container. */
  private skeletonOf(slot: PartSlot): XmlDocument {
    if (slot.skeleton !== null && slot.skeleton.stamp === slot.wholeStamp) return slot.skeleton.doc;
    const container = containerOf(slot.doc);
    const units = [...container.children];
    // Detached from the end and put back in order: both are constant time per unit.
    for (let index = units.length - 1; index >= 0; index--) remove(units[index] as XmlChildNode);
    let doc: XmlDocument;
    try {
      doc = cloneDocument(slot.doc);
    } finally {
      for (const unit of units) appendChild(container, unit);
    }
    slot.skeleton = { stamp: slot.wholeStamp, doc };
    return doc;
  }

  private freeze(slot: PartSlot): FrozenPart {
    if (slot.frozen !== null && slot.frozen.version === slot.version && slot.frozen.epoch === this.store.retagEpoch) {
      return slot.frozen.part;
    }
    const store = this.store;
    const skeleton = this.skeletonOf(slot);
    const units: XmlChildNode[] = [];
    for (const live of containerOf(slot.doc).children) {
      const stamp = store.unitStamp(live, slot);
      const known = this.copies.get(live);
      if (known !== undefined && known.stamp === stamp && known.epoch === store.retagEpoch) {
        units.push(known.frozen);
        continue;
      }
      const frozen = cloneNode(live);
      copyTags(store, live, frozen);
      this.copies.set(live, { stamp, epoch: store.retagEpoch, frozen });
      units.push(frozen);
    }
    const part: FrozenPart = { skeleton, units };
    slot.frozen = { version: slot.version, epoch: store.retagEpoch, part };
    return part;
  }

  take(): SnapshotData {
    const entries: SnapshotEntry[] = [];
    for (const slot of this.store.list()) {
      entries.push({ slot, version: slot.version, part: this.freeze(slot) });
    }
    return Object.freeze({ kind: "docx-snapshot" as const, owner: this.store, entries: Object.freeze(entries) });
  }

  private thaw(slot: PartSlot, entry: SnapshotEntry): void {
    const store = this.store;
    // Live units that are still exactly what a frozen copy says can stay.
    const reusable = new Map<XmlChildNode, XmlChildNode>();
    for (const live of containerOf(slot.doc).children) {
      const known = this.copies.get(live);
      if (known !== undefined && known.stamp === store.unitStamp(live, slot) && known.epoch === store.retagEpoch) {
        reusable.set(known.frozen, live);
      }
    }
    const doc = cloneDocument(entry.part.skeleton);
    const container = containerOf(doc);
    for (const frozen of entry.part.units) {
      let live = reusable.get(frozen);
      if (live === undefined) {
        live = cloneNode(frozen);
        copyTags(store, frozen, live);
        this.copies.set(live, { stamp: slot.wholeStamp, epoch: store.retagEpoch, frozen });
      } else {
        reusable.delete(frozen);
      }
      appendChild(container, live);
    }
    store.replaceDoc(slot, doc);
    slot.version = entry.version;
    slot.frozen = { version: entry.version, epoch: store.retagEpoch, part: entry.part };
    slot.skeleton = { stamp: slot.wholeStamp, doc: entry.part.skeleton };
  }

  restore(snapshot: DocxSnapshot): void {
    const data = snapshot as Partial<SnapshotData> | null;
    if (data === null || typeof data !== "object" || data.kind !== "docx-snapshot" || data.owner !== this.store) {
      throw new OfficeError("invalid_argument", "the snapshot was not taken from this document");
    }
    const store = this.store;
    const kept = new Set<PartSlot>();
    for (const entry of data.entries as readonly SnapshotEntry[]) {
      kept.add(entry.slot);
      if (store.get(entry.slot.name) !== entry.slot) store.reinstate(entry.slot);
      if (entry.slot.version !== entry.version) this.thaw(entry.slot, entry);
    }
    for (const slot of store.list()) if (!kept.has(slot)) store.drop(slot);
    store.notifyAll();
  }
}
