/**
 * The public `.docx` handle: the read side of the contract, saving, and
 * snapshots. Editing and revision resolution are supplied as engines (see
 * `DocxEngines`); they work on the same `DocxIndex`.
 */

import type {
  CompareOptions,
  CreateDocxOptions,
  DocxDocument,
  DocxSnapshot,
  OpenDocx,
  PlainTextOptions,
} from "../../api/docx.js";
import type {
  BlockId,
  CrossReference,
  DefinedTerm,
  DocxBlock,
  DocxComment,
  DocxProperties,
  DocxStory,
  DocxView,
  OutlineItem,
  Revision,
  RevisionId,
  StoryId,
} from "../../api/docx-model.js";
import type { ApplyOptions, ApplyResult, DocxOp, ResolveRevisionsResult } from "../../api/docx-ops.js";
import type { OpcPackage } from "../../api/opc.js";
import type { XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { appendChild, createElement, insertAfter, prependChild, remove, removeAttr, textContent } from "../../xml/index.js";
import { listComments } from "./comments.js";
import { findCrossReferences } from "./crossrefs.js";
import type { DocxIndex } from "./doc-index.js";
import { buildOutline } from "./labels.js";
import { firstChild } from "./names.js";
import { blocksText, rangeText } from "./plain-text.js";
import { findDefinedTerms } from "./terms.js";
import { buildBlock, buildStory, buildView, readTrackRevisions } from "./view.js";

/**
 * The parts of the handle that other modules of `src/docx/` implement.
 * `index.ts` passes them to `openDocx`; a handle without an engine throws
 * `invalid_operation` from the methods that need it.
 */
export interface DocxEngines {
  /** Implements `DocxDocument.applyOps`. Must leave the document unchanged when it throws. */
  applyOps?: (index: DocxIndex, ops: readonly DocxOp[], options: ApplyOptions) => ApplyResult;
  /** Implements `DocxDocument.acceptRevisions`. */
  acceptRevisions?: (index: DocxIndex, ids: readonly RevisionId[] | "all") => ResolveRevisionsResult;
  /** Implements `DocxDocument.rejectRevisions`. */
  rejectRevisions?: (index: DocxIndex, ids: readonly RevisionId[] | "all") => ResolveRevisionsResult;
}

/**
 * The module-level functions that other modules of `src/docx/` implement.
 * `index.ts` calls them and hands each what it needs to make handles that
 * carry the engines of the build, so they never import `index.ts` themselves.
 */
export interface DocxFactories {
  /**
   * Implements `createDocx`: assembles a package in memory and calls
   * `finish(pkg, texts)` with the XML text of every model part it wrote
   * (keyed by part name) to get the handle.
   */
  createDocx?: (
    options: CreateDocxOptions | undefined,
    finish: (pkg: OpcPackage, texts: ReadonlyMap<string, string>) => DocxDocument,
  ) => DocxDocument;
  /** Implements `compareDocx`. `open` is `openDocx` of the build. */
  compareDocx?: (
    original: Uint8Array | DocxDocument,
    revised: Uint8Array | DocxDocument,
    options: CompareOptions,
    open: OpenDocx,
  ) => Promise<DocxDocument>;
}

/** Elements of `w:settings` that come before `w:trackRevisions` in the schema order. */
const BEFORE_TRACK_REVISIONS: ReadonlySet<string> = new Set([
  "w:writeProtection",
  "w:view",
  "w:zoom",
  "w:removePersonalInformation",
  "w:removeDateAndTime",
  "w:doNotDisplayPageBoundaries",
  "w:displayBackgroundShape",
  "w:printPostScriptOverText",
  "w:printFractionalCharacterWidth",
  "w:printFormsData",
  "w:embedTrueTypeFonts",
  "w:embedSystemFonts",
  "w:saveSubsetFonts",
  "w:saveFormsData",
  "w:mirrorMargins",
  "w:alignBordersAndEdges",
  "w:bordersDoNotSurroundHeader",
  "w:bordersDoNotSurroundFooter",
  "w:gutterAtTop",
  "w:hideSpellingErrors",
  "w:hideGrammaticalErrors",
  "w:activeWritingStyle",
  "w:proofState",
  "w:formsDesign",
  "w:attachedTemplate",
  "w:linkStyles",
  "w:stylePaneFormatFilter",
  "w:stylePaneSortMethod",
  "w:documentType",
  "w:mailMerge",
  "w:revisionView",
]);

const indexes = new WeakMap<DocxDocument, DocxIndex>();

function missingEngine(name: string): OfficeError {
  return new OfficeError("invalid_operation", `this document handle has no ${name} engine`);
}

class DocxDocumentHandle implements DocxDocument {
  readonly package: OpcPackage;
  readonly #index: DocxIndex;
  readonly #engines: DocxEngines;

  constructor(index: DocxIndex, engines: DocxEngines) {
    this.package = index.package;
    this.#index = index;
    this.#engines = engines;
    indexes.set(this, index);
  }

  getView(): DocxView {
    return buildView(this.#index);
  }

  getBlock(blockId: BlockId): DocxBlock | null {
    const record = typeof blockId === "string" ? this.#index.block(blockId) : null;
    return record === null ? null : buildBlock(this.#index, record);
  }

  getStory(storyId: StoryId): DocxStory | null {
    const story = typeof storyId === "string" ? this.#index.story(storyId) : null;
    return story === null ? null : buildStory(this.#index, story);
  }

  getProperties(): DocxProperties {
    const root = this.#index.partRoot("coreProperties");
    const read = (name: string): string | null => {
      const element = root === null ? null : firstChild(root, name);
      return element === null ? null : textContent(element);
    };
    return {
      title: read("dc:title"),
      creator: read("dc:creator"),
      lastModifiedBy: read("cp:lastModifiedBy"),
      created: read("dcterms:created"),
      modified: read("dcterms:modified"),
    };
  }

  applyOps(ops: readonly DocxOp[], options: ApplyOptions): ApplyResult {
    const engine = this.#engines.applyOps;
    if (engine === undefined) throw missingEngine("editing");
    return engine(this.#index, ops, options);
  }

  getTrackRevisions(): boolean {
    return readTrackRevisions(this.#index);
  }

  setTrackRevisions(enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new OfficeError("invalid_argument", "enabled must be a boolean");
    if (readTrackRevisions(this.#index) === enabled) return;
    const snapshot = this.#index.snapshot();
    try {
      this.#writeTrackRevisions(enabled);
      // Even a new settings part counts against the limits the document must reopen under.
      this.#index.checkXmlLimits();
    } catch (error) {
      this.#index.restore(snapshot);
      throw error;
    }
  }

  #writeTrackRevisions(enabled: boolean): void {
    const settings = this.#index.ensurePart("settings");
    const existing = firstChild(settings, "w:trackRevisions");
    if (!enabled) {
      if (existing !== null) remove(existing);
    } else if (existing !== null) {
      removeAttr(existing, "w:val");
    } else {
      const element = createElement("w:trackRevisions");
      let anchor: XmlElement | null = null;
      for (const node of settings.children) {
        if (node.kind === "element" && BEFORE_TRACK_REVISIONS.has(node.name)) anchor = node;
      }
      if (anchor !== null) insertAfter(anchor, element);
      else if (settings.children.length > 0) prependChild(settings, element);
      else appendChild(settings, element);
    }
    this.#index.markDirty(settings);
  }

  listRevisions(): Revision[] {
    return this.#index.revisions.groups.map(({ revision }) => ({
      ...revision,
      blockIds: [...revision.blockIds],
      range: revision.range === null ? null : { start: { ...revision.range.start }, end: { ...revision.range.end } },
      formatChange:
        revision.formatChange === null
          ? null
          : { before: { ...revision.formatChange.before }, after: { ...revision.formatChange.after } },
    }));
  }

  acceptRevisions(ids: readonly RevisionId[] | "all"): ResolveRevisionsResult {
    const engine = this.#engines.acceptRevisions;
    if (engine === undefined) throw missingEngine("revision");
    return engine(this.#index, ids);
  }

  rejectRevisions(ids: readonly RevisionId[] | "all"): ResolveRevisionsResult {
    const engine = this.#engines.rejectRevisions;
    if (engine === undefined) throw missingEngine("revision");
    return engine(this.#index, ids);
  }

  listComments(): DocxComment[] {
    return listComments(this.#index);
  }

  getOutline(): OutlineItem[] {
    return buildOutline(this.#index);
  }

  getDefinedTerms(): DefinedTerm[] {
    return findDefinedTerms(this.#index);
  }

  getCrossReferences(): CrossReference[] {
    return findCrossReferences(this.#index);
  }

  getPlainText(options: PlainTextOptions = {}): string {
    const view = options.view ?? "final";
    if (view !== "final" && view !== "original" && view !== "markup") {
      throw new OfficeError("invalid_argument", "unknown text view");
    }
    if (options.range !== undefined) return rangeText(this.#index, options.range, view);
    if (options.blockId !== undefined) return blocksText(this.#index, [this.#index.requireBlock(options.blockId)], view);
    const story = this.#index.story(options.storyId ?? "body");
    if (story === null) {
      throw new OfficeError("stale_reference", "unknown story id", { details: { storyId: String(options.storyId) } });
    }
    return blocksText(this.#index, story.blocks, view);
  }

  snapshot(): DocxSnapshot {
    return this.#index.snapshot();
  }

  restore(snapshot: DocxSnapshot): void {
    this.#index.restore(snapshot);
  }

  save(): Promise<Uint8Array> {
    return this.#index.save();
  }
}

/** Wraps an index in the public handle. */
export function createDocumentHandle(index: DocxIndex, engines: DocxEngines): DocxDocument {
  return new DocxDocumentHandle(index, engines);
}

/**
 * The index behind a handle made by this module. Throws `invalid_argument`
 * for any other object.
 */
export function getDocxIndex(document: DocxDocument): DocxIndex {
  const index = indexes.get(document);
  if (index === undefined) throw new OfficeError("invalid_argument", "not a document handle of this engine");
  return index;
}
