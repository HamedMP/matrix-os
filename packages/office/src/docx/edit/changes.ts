/**
 * Works out what an edit did to the block structure: which blocks were
 * created and removed, and which surviving blocks show something else now.
 * Shared by `applyOps` and by accepting and rejecting revisions.
 */

import type { BlockId, StoryId } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import type { BlockRecord, DocxIndex } from "../internal.js";
import { rowCells, tableRows } from "../internal.js";

interface BlockState {
  /** Position in document order. */
  readonly order: number;
  readonly storyId: StoryId;
}

function blockStates(index: DocxIndex): Map<BlockId, BlockState> {
  const states = new Map<BlockId, BlockState>();
  const visit = (record: BlockRecord): void => {
    states.set(record.id, { order: states.size, storyId: record.storyId });
    if (record.type !== "table") return;
    for (const row of tableRows(record.element)) {
      for (const cell of rowCells(row)) for (const inner of index.blocksIn(cell)) visit(inner);
    }
  };
  for (const story of index.structure.stories) for (const record of story.blocks) visit(record);
  return states;
}

function labelTexts(index: DocxIndex): Map<BlockId, string> {
  const labels = new Map<BlockId, string>();
  for (const [element, label] of index.labels) {
    const record = index.blockOf(element);
    if (record !== null) labels.set(record.id, label.text);
  }
  return labels;
}

export interface BlockChanges {
  createdBlockIds: BlockId[];
  removedBlockIds: BlockId[];
  changedBlockIds: BlockId[];
  changedStoryIds: StoryId[];
}

export interface ChangeRecorder {
  /** Document order of the blocks after the edit; valid once `finish` ran. */
  order(): ReadonlyMap<BlockId, number>;
  /** Compares the document with the state at `beginChanges`. `touched` are the block elements that were edited. */
  finish(touched: Iterable<XmlElement>): BlockChanges;
}

/** Records the block structure before an edit. */
export function beginChanges(index: DocxIndex): ChangeRecorder {
  const before = blockStates(index);
  const labelsBefore = labelTexts(index);
  let after: Map<BlockId, BlockState> = before;
  return {
    order() {
      const order = new Map<BlockId, number>();
      for (const [id, state] of after) order.set(id, state.order);
      return order;
    },
    finish(touched) {
      after = blockStates(index);
      const created = [...after.keys()].filter((id) => !before.has(id));
      const removed = [...before.keys()].filter((id) => !after.has(id));
      const changed = new Set<BlockId>();
      const add = (record: BlockRecord | null): void => {
        // The tables around a changed block show something else too.
        for (let scope = record, depth = 0; scope !== null && depth < 64; depth++) {
          if (before.has(scope.id)) changed.add(scope.id);
          scope = scope.parentTableId === null ? null : index.block(scope.parentTableId);
        }
      };
      for (const element of touched) add(index.blockOf(element));
      for (const id of [...created, ...removed]) {
        // A block that came or went changes the table it is in.
        const record = index.block(id);
        if (record !== null && record.parentTableId !== null) add(index.block(record.parentTableId));
      }
      const labelsAfter = labelTexts(index);
      for (const [id, text] of labelsAfter) {
        if (before.has(id) && labelsBefore.get(id) !== text) add(index.block(id));
      }
      for (const id of labelsBefore.keys()) {
        if (after.has(id) && !labelsAfter.has(id)) add(index.block(id));
      }
      const stories = new Map<StoryId, number>();
      const storyOrder = new Map(index.structure.stories.map((story, at) => [story.id, at] as const));
      const noteStory = (storyId: StoryId | undefined): void => {
        if (storyId !== undefined) stories.set(storyId, storyOrder.get(storyId) ?? Number.MAX_SAFE_INTEGER);
      };
      for (const id of created) noteStory(after.get(id)?.storyId);
      for (const id of removed) noteStory(before.get(id)?.storyId);
      for (const id of changed) noteStory(after.get(id)?.storyId);
      const byOrder = (states: Map<BlockId, BlockState>) => (a: BlockId, b: BlockId) =>
        (states.get(a)?.order ?? 0) - (states.get(b)?.order ?? 0);
      return {
        createdBlockIds: created.sort(byOrder(after)),
        removedBlockIds: removed.sort(byOrder(before)),
        changedBlockIds: [...changed].sort(byOrder(after)),
        changedStoryIds: [...stories.keys()].sort((a, b) => (stories.get(a) ?? 0) - (stories.get(b) ?? 0)),
      };
    },
  };
}
