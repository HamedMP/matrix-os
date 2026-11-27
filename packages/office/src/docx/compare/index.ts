/**
 * Document comparison: `compareDocx` of `../../api/docx.ts`.
 *
 * The result is a private copy of the original in which every difference
 * from the revised version is a native tracked revision:
 *
 * - paragraphs are aligned structurally (`./plan.ts`): the body, every table
 *   row by row and cell by cell, the footnotes and endnotes both versions
 *   refer to at the same place, and the headers and footers of the same
 *   section and type
 * - changed paragraphs are compared word by word (`./inline.ts`); a split or
 *   merged paragraph is an inserted or deleted paragraph mark
 * - whole paragraphs come, go or move (`w:moveFrom`/`w:moveTo` with range
 *   markers), whole rows and tables are marked on their rows
 * - formatting that differs on unchanged text becomes `w:rPrChange` and
 *   `w:pPrChange`
 *
 * Revisions pending in either input are accepted first. Styles, numbering,
 * settings, table properties and section properties are those of the
 * original. Before it is returned the result is checked against the texts of
 * both inputs (`./verify.ts`); a result that fails the check is an error.
 */

import type { CompareOptions, DocxDocument, OpenDocx } from "../../api/docx.js";
import type { HeaderFooterType, StoryId } from "../../api/docx-model.js";
import { OfficeError } from "../../errors.js";
import { lookupNamespace } from "../../xml/index.js";
import { type DocxIndex, getDocxIndex } from "../internal.js";
import { mergeContainer } from "./build.js";
import { ObjectAlphabet, extractBlocks } from "./extract.js";
import { Importer } from "./importer.js";
import type { BuildContext } from "./inline.js";
import { readMedia } from "./media.js";
import { acceptAllInPlace } from "./normalise.js";
import { summarise } from "./summary.js";
import type { BuildCounters, CompareDetailedOptions, CompareExpectation, CompareResult, Stamp } from "./types.js";
import { noteTextsInView, storyTextInView, verifyComparison } from "./verify.js";

export type {
  ChangeClassification,
  CompareChange,
  CompareDetailedOptions,
  CompareExpectation,
  CompareResult,
  CompareSummary,
  StoryExpectation,
} from "./types.js";
export { COMPARE_SELF_CHECK } from "./types.js";
export { verifyComparison } from "./verify.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const MAX_AUTHOR_LENGTH = 255;
const HEADER_TYPES: readonly HeaderFooterType[] = ["default", "first", "even"];

function validate(options: CompareOptions): void {
  if (typeof options !== "object" || options === null) {
    throw new OfficeError("invalid_argument", "compare options are required");
  }
  const { author, date } = options;
  if (typeof author !== "string" || author.trim() === "" || author.length > MAX_AUTHOR_LENGTH) {
    throw new OfficeError("invalid_argument", "compare needs the author of the revisions");
  }
  if (typeof date !== "string" || !ISO_DATE.test(date)) {
    throw new OfficeError("invalid_argument", "compare needs an ISO 8601 date for the revisions");
  }
}

/** The bytes of an input; an open document is serialised, which leaves it as it is. */
async function bytesOf(input: Uint8Array | DocxDocument): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (typeof input !== "object" || input === null || typeof input.save !== "function") {
    throw new OfficeError("invalid_argument", "compare takes the bytes of a document or an open document");
  }
  return input.save();
}

/** The stories of the same section and type that both versions have. */
function headerFooterPairs(target: DocxIndex, source: DocxIndex): Array<{ a: StoryId; b: StoryId; label: string }> {
  const pairs: Array<{ a: StoryId; b: StoryId; label: string }> = [];
  const seenA = new Set<StoryId>();
  const seenB = new Set<StoryId>();
  const sectionsA = target.structure.sections;
  const sectionsB = source.structure.sections;
  for (let section = 0; section < Math.min(sectionsA.length, sectionsB.length); section++) {
    for (const kind of ["headers", "footers"] as const) {
      for (const type of HEADER_TYPES) {
        const a = sectionsA[section]?.[kind][type];
        const b = sectionsB[section]?.[kind][type];
        if (a === undefined || b === undefined || seenA.has(a) || seenB.has(b)) continue;
        if (target.story(a) === null || source.story(b) === null) continue;
        seenA.add(a);
        seenB.add(b);
        pairs.push({ a, b, label: `${kind === "headers" ? "header" : "footer"} ${pairs.length + 1}` });
      }
    }
  }
  return pairs;
}

/**
 * `compareDocx` with its summary. `open` is the `openDocx` of the build, so
 * the result is a handle with the engines of the build.
 */
export async function compareDocumentsDetailed(
  original: Uint8Array | DocxDocument,
  revised: Uint8Array | DocxDocument,
  options: CompareDetailedOptions,
  open: OpenDocx,
): Promise<CompareResult> {
  validate(options);
  // Both inputs are opened again: the comparison rewrites its own copies and never touches a caller's handle.
  const document = await open(await bytesOf(original), options.limits);
  const other = await open(await bytesOf(revised), options.limits);
  const target = getDocxIndex(document);
  const source = getDocxIndex(other);
  if (lookupNamespace(target.store.main().doc.root, "w") !== lookupNamespace(source.store.main().doc.root, "w")) {
    throw new OfficeError("unsupported_format", "the two documents use different word-processing namespaces");
  }
  acceptAllInPlace(target);
  acceptAllInPlace(source);
  const targetMedia = await readMedia(target);
  const sourceMedia = await readMedia(source);

  const headerFooter = headerFooterPairs(target, source);
  const check: CompareExpectation = {
    body: {
      label: "body",
      original: storyTextInView(target, "body", "final") ?? "",
      revised: storyTextInView(source, "body", "final") ?? "",
    },
    stories: headerFooter.map((pair) => ({
      storyId: pair.a,
      label: pair.label,
      original: storyTextInView(target, pair.a, "final") ?? "",
      revised: storyTextInView(source, pair.b, "final") ?? "",
    })),
    notes: {
      footnote: { original: noteTextsInView(target, "footnote", "final"), revised: noteTextsInView(source, "footnote", "final") },
      endnote: { original: noteTextsInView(target, "endnote", "final"), revised: noteTextsInView(source, "endnote", "final") },
    },
  };

  let changes = 0;
  const stamp: Stamp = {
    author: options.author,
    date: options.date,
    nextId: () => {
      changes += 1;
      return target.allocateAnnotationId();
    },
    touch: () => {
      changes += 1;
    },
  };
  const counters: BuildCounters = { insertedParagraphs: 0, deletedParagraphs: 0, movedParagraphs: 0, insertedRows: 0, deletedRows: 0 };
  let moves = 0;
  const context: BuildContext = {
    stamp,
    importer: new Importer(target, source, sourceMedia, stamp),
    compareFormatting: options.compareFormatting !== false,
    detectMoves: options.detectMoves !== false,
    counters,
    notePairs: new Map(),
    moveName: () => {
      moves += 1;
      return `move${moves}`;
    },
  };
  const alphabet = new ObjectAlphabet();
  const mergeStory = (targetId: StoryId, sourceId: StoryId): void => {
    const a = target.story(targetId);
    const b = source.story(sourceId);
    if (a === null || b === null) return;
    const before = changes;
    const aBlocks = extractBlocks({ index: target, media: targetMedia, alphabet, partName: a.partName }, a.container);
    const bBlocks = extractBlocks({ index: source, media: sourceMedia, alphabet, partName: b.partName }, b.container);
    mergeContainer(a.container, aBlocks, bBlocks, context, { sourcePart: b.partName, targetPart: a.partName });
    if (changes !== before) target.markDirty(a.container);
  };

  mergeStory("body", "body");
  const comparedNotes = new Set<string>();
  for (const [key, sourceId] of [...context.notePairs]) {
    const kind = key.startsWith("footnote:") ? "footnote" : "endnote";
    const sourceKey = `${kind}:${sourceId}`;
    if (comparedNotes.has(sourceKey)) continue;
    comparedNotes.add(sourceKey);
    mergeStory(key, sourceKey);
  }
  for (const pair of headerFooter) mergeStory(pair.a, pair.b);

  // The result is a handle with the caller's limits: it must open again under them.
  target.checkXmlLimits();
  verifyComparison(target, check);
  return { document, summary: summarise(document, counters), check };
}

/** `compareDocx` as a `DocxFactories` entry of `../index.ts`. */
export async function compareDocuments(
  original: Uint8Array | DocxDocument,
  revised: Uint8Array | DocxDocument,
  options: CompareOptions,
  open: OpenDocx,
): Promise<DocxDocument> {
  return (await compareDocumentsDetailed(original, revised, options, open)).document;
}
