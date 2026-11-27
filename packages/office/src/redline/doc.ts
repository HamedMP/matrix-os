/**
 * The tracked-changes document: `createRedline`, `loadRedline` and the
 * additions around them (user edits, string serialisation, HTML clean-up).
 */

import type {
  CreateRedline,
  LoadRedline,
  RedlineChange,
  RedlineDoc,
  RedlineFormat,
  RedlineMode,
  RedlineOptions,
  RedlineState,
} from "../api/redline.js";
import { OfficeError } from "../errors.js";
import { parseHtml, parseText, type IdSource } from "./html-parse.js";
import { renderBlocks } from "./html-render.js";
import { applyEdit, checkEditOptions, type EditOptions } from "./merge.js";
import { MAX_REDLINE_LENGTH, plainText, type ChangeRecord, type DocData, type SideItem } from "./model.js";
import { resolveChanges } from "./resolve.js";
import { checkStateLimits, loadState, saveState } from "./state.js";
import { viewBlocks, viewText } from "./views.js";

/** Who made an edit and when. */
export interface UserEditOptions {
  author: string;
  /** ISO 8601, supplied by the caller. */
  date: string;
  /** Report relocated text as a move. Default true. */
  detectMoves?: boolean;
}

/** A {@link RedlineDoc} with the additions of this module. */
export interface TrackedRedline extends RedlineDoc {
  /** Same as `toHtml("final")`: what to send or save once the changes are settled. */
  toFinalHtml(): string;
  /**
   * Records a further edit. `newFinal` is the whole final text after the edit
   * (HTML for an `html` document, plain text for a `text` one); its
   * differences from the current final text become pending changes by
   * `options.author`. Pending changes that the edit leaves alone stay.
   */
  applyUserEdit(newFinal: string, options: UserEditOptions): void;
}

function parseSide(format: RedlineFormat, source: string, ids: IdSource): SideItem[] {
  if (typeof source !== "string") throw new OfficeError("invalid_argument", "a redline is made from strings");
  return format === "html" ? parseHtml(source, ids) : parseText(source);
}

function checkMode(mode: RedlineMode): void {
  if (mode !== "markup" && mode !== "final" && mode !== "original") {
    throw new OfficeError("invalid_argument", "mode must be markup, final or original");
  }
}

class Tracked implements TrackedRedline {
  constructor(private readonly data: DocData) {}

  get format(): RedlineFormat {
    return this.data.format;
  }

  listChanges(): RedlineChange[] {
    // Bounded by the number of pending changes.
    const texts = new Map<string, string>();
    for (const item of this.data.items) {
      if (item.c !== null) texts.set(item.c, (texts.get(item.c) ?? "") + plainText(item));
    }
    const byId = this.changeMap();
    const out: RedlineChange[] = [];
    for (const [id, text] of texts) {
      const change = byId.get(id);
      if (change) out.push({ id, kind: change.kind, text, author: change.author, date: change.date, pairedWith: change.pairedWith });
    }
    return out;
  }

  accept(ids: readonly string[] | "all"): void {
    resolveChanges(this.data, ids, true);
  }

  reject(ids: readonly string[] | "all"): void {
    resolveChanges(this.data, ids, false);
  }

  toHtml(mode: RedlineMode): string {
    checkMode(mode);
    return renderBlocks(viewBlocks(this.data.items, mode, this.changeMap()), this.data.format === "text");
  }

  toText(mode: RedlineMode): string {
    checkMode(mode);
    return viewText(this.data.items, mode);
  }

  toFinalText(): string {
    return viewText(this.data.items, "final");
  }

  toFinalHtml(): string {
    return this.toHtml("final");
  }

  toJSON(): RedlineState {
    return saveState(this.data);
  }

  applyUserEdit(newFinal: string, options: UserEditOptions): void {
    checkEditOptions(options);
    const ids: IdSource = { next: this.data.nextBlock };
    const next = parseSide(this.data.format, newFinal, ids);
    // Work on a copy so a failure part-way leaves the document as it was.
    const draft = loadState(saveState(this.data));
    draft.nextBlock = ids.next;
    applyEdit(draft, next, options);
    // A draft its own loader would refuse is not kept.
    checkStateLimits(draft);
    Object.assign(this.data, draft);
  }

  private changeMap(): Map<string, ChangeRecord> {
    // Bounded by the number of pending changes.
    const map = new Map<string, ChangeRecord>();
    for (const change of this.data.changes) map.set(change.id, change);
    return map;
  }
}

/** Implements {@link CreateRedline}; the result also has the additions of {@link TrackedRedline}. */
export function createRedline(original: string, revised: string, options: RedlineOptions): TrackedRedline {
  checkEditOptions(options as EditOptions);
  const format = options.format ?? "text";
  if (format !== "text" && format !== "html") throw new OfficeError("invalid_argument", "format must be text or html");
  const ids: IdSource = { next: 1 };
  const before = parseSide(format, original, ids);
  const after = parseSide(format, revised, ids);
  const data: DocData = {
    format,
    items: before.map((item) => ({ k: item.k, t: item.t, a: item.p, b: item.p, c: null })),
    changes: [],
    nextChange: 1,
    nextBlock: ids.next,
    accepted: false,
  };
  applyEdit(data, after, { author: options.author, date: options.date, detectMoves: options.detectMoves });
  checkStateLimits(data);
  return new Tracked(data);
}

/** Implements {@link LoadRedline}. */
export function loadRedline(state: RedlineState): TrackedRedline {
  return new Tracked(loadState(state));
}

// The compiler checks both functions against the contract here.
const contract: { createRedline: CreateRedline; loadRedline: LoadRedline } = { createRedline, loadRedline };
void contract;

/**
 * Records a further edit by a person on any redline. A document made by
 * this module is changed in place and returned; any other implementation of
 * the contract is rebuilt from its `toJSON()` and the new document returned.
 */
export function applyUserEdit(doc: RedlineDoc, newFinal: string, options: UserEditOptions): TrackedRedline {
  const tracked = doc instanceof Tracked ? doc : new Tracked(loadState(doc.toJSON()));
  tracked.applyUserEdit(newFinal, options);
  return tracked;
}

/** The document as a JSON string, pending changes included, for storing a draft. */
export function serialiseRedline(doc: RedlineDoc): string {
  return JSON.stringify(doc.toJSON());
}

/** Rebuilds a document from {@link serialiseRedline}. Throws `invalid_argument` for anything else. */
export function deserialiseRedline(json: string): TrackedRedline {
  if (typeof json !== "string" || json.length > 16 * MAX_REDLINE_LENGTH) {
    throw new OfficeError("invalid_argument", "redline state is not a string of an acceptable size");
  }
  let state: unknown;
  try {
    state = JSON.parse(json);
  } catch (error) {
    throw new OfficeError("invalid_argument", "redline state is not valid JSON", { cause: error });
  }
  return new Tracked(loadState(state));
}

/**
 * Untrusted HTML reduced to the structure a redline keeps (see
 * `../api/redline.ts`): safe to insert into a page.
 */
export function sanitiseHtml(html: string): string {
  if (typeof html !== "string") throw new OfficeError("invalid_argument", "sanitiseHtml takes a string");
  const items = parseHtml(html, { next: 1 }).map((item) => ({ k: item.k, t: item.t, a: item.p, b: item.p, c: null }));
  return renderBlocks(viewBlocks(items, "final", new Map()), false);
}
