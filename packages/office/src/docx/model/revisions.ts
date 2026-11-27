/**
 * Tracked changes: reads the revision elements of every story and groups
 * them into the logical revisions the contract describes.
 *
 * Grouping: revision elements of the same kind, author and date that touch
 * (nothing unrevised lies between them, a paragraph mark counts as one
 * position) are one revision. A tracked table row takes the content changes
 * inside it that share its kind, author and date. The inserted cells of one
 * table with one author and date are one revision and its deleted cells
 * another (`w:cellIns`, `w:cellDel`: a tracked column); they take the content
 * changes inside them the same way. Property changes of one table
 * (`w:tblPrChange`, `w:tcPrChange`, `w:cellMerge`, …) by one author are one
 * revision.
 */

import type { Revision, RevisionId, RevisionMark } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import type { Flow } from "./flow.js";
import type { PartStore } from "./parts.js";
import type { FormatResolver } from "./resolve.js";
import { type Draft, type RevisionMember, StoryPass } from "./revision-pass.js";
import type { Structure } from "./structure.js";

export type { RevisionMember, RevisionMemberRole } from "./revision-pass.js";
export { cellGoneInView, cellRevisionElements, rowGoneInView, rowRevisionElement, rowRevisionElements, tableGoneInView } from "./table-revisions.js";

export interface RevisionGroup {
  readonly revision: Revision;
  /** The XML elements that make up the revision, in document order. */
  readonly members: readonly RevisionMember[];
  /** `w:name` of the move range the revision belongs to, or null. */
  readonly moveName: string | null;
}

export interface RevisionIndex {
  readonly groups: RevisionGroup[];
  readonly byId: Map<RevisionId, RevisionGroup>;
  /** Revision element to the mark shown on the run, paragraph or row it belongs to. */
  readonly marks: Map<XmlElement, RevisionMark>;
}

export interface RevisionIdState {
  nextRevision: number;
}

/** Pairs a deletion with the insertion that replaces it: same author and date, one directly after the other. */
function pairReplacements(drafts: readonly Draft[]): void {
  const insertsByStart = new Map<string, Draft>();
  const insertsByEnd = new Map<string, Draft>();
  const key = (draft: Draft, offset: number): string => `${draft.info.author}\u0000${draft.info.date ?? ""}\u0000${offset}`;
  for (const draft of drafts) {
    if (draft.scope !== "text" || draft.info.kind !== "insert") continue;
    insertsByStart.set(key(draft, draft.sort), draft);
    insertsByEnd.set(key(draft, draft.end), draft);
  }
  for (const draft of drafts) {
    if (draft.scope !== "text" || draft.info.kind !== "delete" || draft.pairedWith !== null) continue;
    for (const candidate of [insertsByStart.get(key(draft, draft.end)), insertsByEnd.get(key(draft, draft.sort))]) {
      if (candidate === undefined || candidate.pairedWith !== null) continue;
      draft.pairedWith = candidate;
      candidate.pairedWith = draft;
      break;
    }
  }
}

/** Pairs the two halves of each move, by move range name and otherwise by author and text. */
function pairMoves(drafts: readonly Draft[]): void {
  const sources = drafts.filter((draft) => draft.info.kind === "moveFrom");
  const targets = drafts.filter((draft) => draft.info.kind === "moveTo");
  const link = (from: Draft, to: Draft): void => {
    from.pairedWith = to;
    to.pairedWith = from;
  };
  for (const from of sources) {
    if (from.moveName === null) continue;
    const to = targets.find((draft) => draft.pairedWith === null && draft.moveName === from.moveName);
    if (to !== undefined) link(from, to);
  }
  for (const from of sources) {
    if (from.pairedWith !== null) continue;
    const to = targets.find(
      (draft) => draft.pairedWith === null && draft.info.author === from.info.author && draft.text === from.text,
    );
    if (to !== undefined) link(from, to);
  }
}

/**
 * Gives every revision an id that it keeps while any of its elements stay:
 * the id lives on the elements, and a revision takes the oldest id its
 * elements carry that no earlier revision of this pass has taken.
 */
function assignIds(store: PartStore, state: RevisionIdState, drafts: readonly Draft[]): void {
  const taken = new Set<RevisionId>();
  for (const draft of drafts) {
    let chosen: RevisionId | null = null;
    let chosenNumber = Number.POSITIVE_INFINITY;
    for (const member of draft.members) {
      const id = store.tags.get(member.element)?.revisionId;
      if (id === undefined || taken.has(id)) continue;
      const number = Number(id.slice(3));
      if (number < chosenNumber) {
        chosen = id;
        chosenNumber = number;
      }
    }
    if (chosen === null) {
      state.nextRevision += 1;
      chosen = `rev${state.nextRevision}`;
    }
    taken.add(chosen);
    draft.id = chosen;
    for (const member of draft.members) {
      const tags = store.tags.get(member.element);
      if (tags === undefined) {
        store.tags.set(member.element, { revisionId: chosen });
      } else if (tags.revisionId !== chosen) {
        if (tags.revisionId !== undefined) store.retagEpoch += 1;
        tags.revisionId = chosen;
      }
    }
  }
}

export function buildRevisionIndex(
  store: PartStore,
  state: RevisionIdState,
  structure: Structure,
  flow: Flow,
  resolver: FormatResolver,
): RevisionIndex {
  const drafts: Draft[] = [];
  for (const story of structure.stories) {
    const pass = new StoryPass(story, structure, flow, resolver);
    pass.run();
    pairReplacements(pass.drafts);
    drafts.push(...pass.drafts);
  }
  pairMoves(drafts);
  assignIds(store, state, drafts);

  const index: RevisionIndex = { groups: [], byId: new Map(), marks: new Map() };
  for (const draft of drafts) {
    const hasRange = draft.scope === "text" || draft.scope === "runFormat";
    const revision: Revision = {
      id: draft.id,
      kind: draft.info.kind,
      scope: draft.scope,
      author: draft.info.author,
      date: draft.info.date,
      storyId: draft.storyId,
      blockIds: draft.blockIds,
      range:
        hasRange && draft.start !== null && draft.endPosition !== null
          ? { start: draft.start, end: draft.endPosition }
          : null,
      text: draft.text,
      formatChange: draft.info.kind === "format" ? (draft.formatChange ?? { before: {}, after: {} }) : null,
      pairedWith: draft.pairedWith?.id ?? null,
    };
    const group: RevisionGroup = { revision, members: draft.members, moveName: draft.moveName };
    index.groups.push(group);
    index.byId.set(revision.id, group);
    const mark: RevisionMark = {
      revisionId: revision.id,
      kind: revision.kind,
      author: revision.author,
      date: revision.date,
    };
    for (const member of draft.members) index.marks.set(member.element, mark);
  }
  return index;
}
