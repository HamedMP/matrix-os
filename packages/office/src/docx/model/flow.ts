/**
 * The inline pass over every story: paragraph scans in document order, with
 * the state that crosses paragraph boundaries (open complex fields, open
 * comment ranges) carried from one paragraph to the next, and the bookmark
 * and comment anchor tables that fall out of it.
 */

import type { CommentId } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import { type FieldFrame, type ParagraphScan, sameFields, scanParagraph } from "./inline.js";
import { attr } from "./names.js";
import type { PartStore } from "./parts.js";
import type { StoryRecord, Structure } from "./structure.js";

/** A point in the text: a paragraph element and a markup offset in it. */
export interface TextPoint {
  readonly paragraph: XmlElement;
  readonly offset: number;
}

export interface CommentAnchor {
  readonly storyId: string;
  start: TextPoint | null;
  end: TextPoint | null;
  /** Where the `w:commentReference` run sits. */
  reference: TextPoint | null;
}

export interface Flow {
  readonly scans: Map<XmlElement, ParagraphScan>;
  /** Position of every paragraph in story order, body first; used to sort by document order. */
  readonly order: Map<XmlElement, number>;
  /** Comment ranges open at the start of a paragraph, outermost first. Absent when none is open. */
  readonly commentsOpenAt: Map<XmlElement, readonly CommentId[]>;
  readonly commentAnchors: Map<CommentId, CommentAnchor>;
  /** Bookmark name to the paragraph in which the bookmark starts. */
  readonly bookmarks: Map<string, XmlElement>;
}

export interface FlowState {
  /** Scans kept between passes; an entry is reused while its unit stamp and incoming fields are unchanged. */
  readonly scanCache: WeakMap<XmlElement, ParagraphScan>;
  nextFieldId: number;
}

const NO_FIELDS: readonly FieldFrame[] = Object.freeze([]);

function assignFieldIds(store: PartStore, state: FlowState, scan: ParagraphScan): void {
  let last: unknown = null;
  for (const atom of scan.atoms) {
    const context = atom.context;
    if (context === last) continue;
    last = context;
    for (const frame of context.fields) {
      const tags = store.tags.get(frame.key);
      if (tags?.fieldId !== undefined) continue;
      state.nextFieldId += 1;
      const fieldId = `fld${state.nextFieldId}`;
      if (tags === undefined) store.tags.set(frame.key, { fieldId });
      else tags.fieldId = fieldId;
    }
  }
}

function passStory(store: PartStore, state: FlowState, story: StoryRecord, flow: Flow): void {
  let fields: readonly FieldFrame[] = NO_FIELDS;
  let open: readonly CommentId[] = [];
  const anchorOf = (id: CommentId): CommentAnchor => {
    let anchor = flow.commentAnchors.get(id);
    if (anchor === undefined) {
      anchor = { storyId: story.id, start: null, end: null, reference: null };
      flow.commentAnchors.set(id, anchor);
    }
    return anchor;
  };
  for (const paragraph of story.paragraphs) {
    const stamp = store.stampFor(paragraph);
    let scan = state.scanCache.get(paragraph);
    if (scan === undefined || scan.stamp !== stamp || !sameFields(scan.fieldsIn, fields)) {
      scan = scanParagraph(paragraph, fields, stamp);
      state.scanCache.set(paragraph, scan);
      assignFieldIds(store, state, scan);
    }
    fields = scan.fieldsOut;
    flow.scans.set(paragraph, scan);
    flow.order.set(paragraph, flow.order.size);
    if (open.length > 0) flow.commentsOpenAt.set(paragraph, open);
    for (const marker of scan.markers) {
      const name = marker.node.name;
      if (name === "w:bookmarkStart") {
        const bookmark = attr(marker.node, "w:name");
        if (bookmark !== null && !flow.bookmarks.has(bookmark)) flow.bookmarks.set(bookmark, paragraph);
        continue;
      }
      if (name !== "w:commentRangeStart" && name !== "w:commentRangeEnd" && name !== "w:commentReference") continue;
      const id = attr(marker.node, "w:id");
      if (id === null) continue;
      const anchor = anchorOf(id);
      const point: TextPoint = { paragraph, offset: marker.offset };
      if (name === "w:commentRangeStart") {
        if (anchor.start === null) anchor.start = point;
        if (!open.includes(id)) open = [...open, id];
      } else if (name === "w:commentRangeEnd") {
        if (anchor.end === null) anchor.end = point;
        if (open.includes(id)) open = open.filter((entry) => entry !== id);
      } else if (anchor.reference === null) {
        anchor.reference = point;
      }
    }
  }
}

export function buildFlow(store: PartStore, state: FlowState, structure: Structure): Flow {
  const flow: Flow = {
    scans: new Map(),
    order: new Map(),
    commentsOpenAt: new Map(),
    commentAnchors: new Map(),
    bookmarks: new Map(),
  };
  for (const story of structure.stories) passStory(store, state, story, flow);
  for (const [name, paragraph] of structure.blockLevelBookmarks) {
    if (!flow.bookmarks.has(name)) flow.bookmarks.set(name, paragraph);
  }
  return flow;
}
