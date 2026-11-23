/**
 * The serialisable view model: plain data built from the index on demand.
 * Nothing here is cached or written back; a view is a snapshot of the trees
 * at the time it was asked for.
 */

import type {
  CommentId,
  DocxBlock,
  DocxSection,
  DocxStory,
  DocxView,
  FieldInfo,
  Hyperlink,
  InlineObject,
  InlineRun,
  NoteReference,
  ParagraphBlock,
  RevisionMark,
  RunFormat,
  SectionBreakBlock,
  TableBlock,
  TableCell,
  TableRow,
} from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import { find } from "../../xml/index.js";
import { commentElements } from "./comments.js";
import type { DocxIndex } from "./doc-index.js";
import { hyperlinkOfField, parseFieldInstruction } from "./fields.js";
import type { FieldFrame, InlineAtom, InlineContext } from "./inline.js";
import { attr, childToggle, childVal, firstChild, intAttr, isOn, twipsToPt } from "./names.js";
import { RUN_FORMAT_KEYS, type RunProps, hexColor } from "./props.js";
import { tableStyleIdOf } from "./resolve.js";
import { rowRevisionElement } from "./revisions.js";
import { type BlockRecord, type SectionRecord, type StoryRecord, rowCells, tableRows } from "./structure.js";

const EMU_PER_POINT = 12700;

function sameFormat(a: RunFormat, b: RunFormat): boolean {
  for (const key of RUN_FORMAT_KEYS) if (a[key] !== b[key]) return false;
  return true;
}

/** The link of a `w:hyperlink` element in a part. */
function hyperlinkOfElement(index: DocxIndex, element: XmlElement, story: StoryRecord): Hyperlink {
  const relationshipId = attr(element, "r:id");
  const relationship = relationshipId === null ? null : index.package.getRelationship(story.partName, relationshipId);
  return {
    href: relationship === null ? null : relationship.target,
    anchor: attr(element, "w:anchor"),
    tooltip: attr(element, "w:tooltip"),
  };
}

/** Describes the field a frame stands for. Exported for the cross-reference helper. */
export function fieldInfoOf(index: DocxIndex, frame: FieldFrame): FieldInfo {
  const parsed = parseFieldInstruction(frame.instruction);
  const target = parsed.targetBookmark === null ? null : (index.flow.bookmarks.get(parsed.targetBookmark) ?? null);
  return {
    fieldId: index.store.tags.get(frame.key)?.fieldId ?? "",
    kind: parsed.kind,
    instruction: parsed.instruction,
    targetBookmark: parsed.targetBookmark,
    targetBlockId: target === null ? null : (index.blockOf(target)?.id ?? null),
  };
}

function imageObject(index: DocxIndex, node: XmlElement, story: StoryRecord): InlineObject {
  const blip = find(node, "a:blip");
  const vml = blip === null ? find(node, "v:imagedata") : null;
  const relationshipId = blip !== null ? attr(blip, "r:embed") : vml !== null ? attr(vml, "r:id") : null;
  if (blip === null && vml === null) return { kind: "other", elementName: node.name };
  let partName: string | null = null;
  if (relationshipId !== null) {
    const relationship = index.package.getRelationship(story.partName, relationshipId);
    if (relationship !== null && relationship.targetMode === "Internal") {
      partName = index.package.resolveTarget(story.partName, relationship.target);
    }
  }
  const extent = find(node, "wp:extent");
  const properties = find(node, "wp:docPr");
  const width = extent === null ? null : intAttr(extent, "cx");
  const height = extent === null ? null : intAttr(extent, "cy");
  const altText = properties === null ? null : (attr(properties, "descr") ?? attr(properties, "title"));
  return {
    kind: "image",
    partName,
    contentType: partName === null ? null : index.package.getContentType(partName),
    widthPt: width === null ? null : width / EMU_PER_POINT,
    heightPt: height === null ? null : height / EMU_PER_POINT,
    altText: altText === "" ? null : altText,
  };
}

function describeObject(
  index: DocxIndex,
  atom: InlineAtom,
  story: StoryRecord,
): { object: InlineObject; footnoteRef: NoteReference | null } {
  const node = atom.node;
  switch (node.name) {
    case "w:br":
      return { object: { kind: "break", breakType: attr(node, "w:type") === "column" ? "column" : "page" }, footnoteRef: null };
    case "w:footnoteReference":
    case "w:endnoteReference": {
      const kind = node.name === "w:footnoteReference" ? "footnote" : "endnote";
      const target = index.story(`${kind}:${attr(node, "w:id") ?? ""}`);
      return {
        object: { kind: "noteReference" },
        footnoteRef: target === null ? null : { kind, storyId: target.id, label: target.noteMark ?? "" },
      };
    }
    case "w:footnoteRef":
    case "w:endnoteRef": {
      const kind = node.name === "w:footnoteRef" ? "footnote" : "endnote";
      return {
        object: { kind: "noteReference" },
        footnoteRef: story.kind === kind ? { kind, storyId: story.id, label: story.noteMark ?? "" } : null,
      };
    }
    case "w:drawing":
    case "w:pict":
      return { object: imageObject(index, node, story), footnoteRef: null };
    default:
      return { object: { kind: "other", elementName: node.name }, footnoteRef: null };
  }
}

interface ContextInfo {
  readonly hyperlink: Hyperlink | null;
  readonly field: FieldInfo | null;
  readonly revision: RevisionMark | null;
}

function buildRuns(index: DocxIndex, record: BlockRecord, story: StoryRecord, runBase: RunProps): InlineRun[] {
  const paragraph = record.element;
  const scan = index.scan(paragraph);
  const marks = index.revisions.marks;
  const resolver = index.resolver;
  const runs: InlineRun[] = [];

  const formats = new Map<XmlElement | null, { format: RunFormat; formatRevision: RevisionMark | null }>();
  const formatOf = (run: XmlElement | null): { format: RunFormat; formatRevision: RevisionMark | null } => {
    let known = formats.get(run);
    if (known === undefined) {
      const rPr = run === null ? null : firstChild(run, "w:rPr");
      const change = rPr === null ? null : firstChild(rPr, "w:rPrChange");
      known = {
        format: resolver.runFormat(runBase, rPr),
        formatRevision: change === null ? null : (marks.get(change) ?? null),
      };
      formats.set(run, known);
    }
    return known;
  };
  const contexts = new Map<InlineContext, ContextInfo>();
  // One object per link source, so that two stretches of the same link compare equal.
  const links = new Map<XmlElement, Hyperlink | null>();
  const linkOf = (source: XmlElement, read: () => Hyperlink | null): Hyperlink | null => {
    let known = links.get(source);
    if (known === undefined) {
      known = read();
      links.set(source, known);
    }
    return known;
  };
  const contextOf = (context: InlineContext): ContextInfo => {
    let known = contexts.get(context);
    if (known === undefined) {
      const element = context.hyperlink;
      let hyperlink = element === null ? null : linkOf(element, () => hyperlinkOfElement(index, element, story));
      for (let position = context.fields.length - 1; hyperlink === null && position >= 0; position--) {
        const frame = context.fields[position] as FieldFrame;
        hyperlink = linkOf(frame.key, () => hyperlinkOfField(parseFieldInstruction(frame.instruction)));
      }
      const innermostField = context.fields[context.fields.length - 1];
      const innermostRevision = context.revisions[context.revisions.length - 1];
      known = {
        hyperlink,
        field: innermostField === undefined ? null : fieldInfoOf(index, innermostField),
        revision: innermostRevision === undefined ? null : (marks.get(innermostRevision) ?? null),
      };
      contexts.set(context, known);
    }
    return known;
  };

  let open: readonly CommentId[] = index.flow.commentsOpenAt.get(paragraph) ?? [];
  const markers = scan.markers;
  let markerIndex = 0;
  // Source identity of the previous atom: runs merge only while all of these stay the same.
  let lastContext: ContextInfo | null = null;
  let lastOpen: readonly CommentId[] | null = null;
  let lastFormatRevision: RevisionMark | null = null;

  for (const atom of scan.atoms) {
    while (markerIndex < markers.length && (markers[markerIndex] as { offset: number }).offset <= atom.start) {
      const node = (markers[markerIndex] as { node: XmlElement }).node;
      markerIndex += 1;
      const id = attr(node, "w:id");
      if (id === null) continue;
      if (node.name === "w:commentRangeStart" && !open.includes(id)) open = [...open, id];
      else if (node.name === "w:commentRangeEnd" && open.includes(id)) open = open.filter((entry) => entry !== id);
    }
    const { format, formatRevision } = formatOf(atom.run);
    const info = contextOf(atom.context);
    const last = runs[runs.length - 1];
    if (
      atom.kind !== "object" &&
      last !== undefined &&
      last.object === null &&
      lastContext !== null &&
      lastContext.hyperlink === info.hyperlink &&
      lastContext.field?.fieldId === info.field?.fieldId &&
      lastContext.revision === info.revision &&
      lastFormatRevision === formatRevision &&
      lastOpen === open &&
      sameFormat(last, format)
    ) {
      last.text += atom.text;
      continue;
    }
    const described = atom.kind === "object" ? describeObject(index, atom, story) : null;
    runs.push({
      ...format,
      start: atom.start,
      text: atom.text,
      hyperlink: info.hyperlink === null ? null : { ...info.hyperlink },
      footnoteRef: described?.footnoteRef ?? null,
      commentIds: [...open],
      field: info.field === null ? null : { ...info.field },
      revision: info.revision === null ? null : { ...info.revision },
      formatRevision: formatRevision === null ? null : { ...formatRevision },
      object: described?.object ?? null,
    });
    lastContext = info;
    lastOpen = open;
    lastFormatRevision = formatRevision;
  }
  return runs;
}

function buildParagraph(index: DocxIndex, record: BlockRecord, story: StoryRecord): ParagraphBlock {
  const paragraph = record.element;
  const scan = index.scan(paragraph);
  const table = record.parentTableId === null ? null : index.block(record.parentTableId);
  const resolved = index.resolver.paragraph(paragraph, tableStyleIdOf(table?.element ?? null));
  const marks = index.revisions.marks;
  const bookmarks: string[] = [];
  for (const [name, target] of index.structure.blockLevelBookmarks) if (target === paragraph) bookmarks.push(name);
  for (const marker of scan.markers) {
    if (marker.node.name !== "w:bookmarkStart") continue;
    const name = attr(marker.node, "w:name");
    if (name !== null && !bookmarks.includes(name)) bookmarks.push(name);
  }
  const label = index.labels.get(paragraph);
  const mark = scan.mark === null ? null : (marks.get(scan.mark) ?? null);
  const formatRevision = scan.propertiesChange === null ? null : (marks.get(scan.propertiesChange) ?? null);
  return {
    type: "paragraph",
    id: record.id,
    style: resolved.style,
    numbering: label === undefined ? null : { ...label, counters: [...label.counters] },
    text: scan.text,
    runs: buildRuns(index, record, story, resolved.runBase),
    markRevision: mark === null ? null : { ...mark },
    formatRevision: formatRevision === null ? null : { ...formatRevision },
    bookmarks,
  };
}

interface CellDraft {
  readonly cell: TableCell;
  readonly column: number;
  readonly merge: "none" | "restart" | "continue";
}

function buildTable(index: DocxIndex, record: BlockRecord, story: StoryRecord): TableBlock {
  const table = record.element;
  const marks = index.revisions.marks;
  const grid = firstChild(table, "w:tblGrid");
  const columnWidthsPt: number[] = [];
  if (grid !== null) {
    for (const node of grid.children) {
      if (node.kind === "element" && node.name === "w:gridCol") columnWidthsPt.push(twipsToPt(intAttr(node, "w:w") ?? 0));
    }
  }
  const drafts: CellDraft[][] = [];
  const rows: TableRow[] = [];
  for (const row of tableRows(table)) {
    const trPr = firstChild(row, "w:trPr");
    const gridBefore = trPr === null ? null : firstChild(trPr, "w:gridBefore");
    let column = gridBefore === null ? 0 : Math.max(0, intAttr(gridBefore, "w:val") ?? 0);
    const rowDrafts: CellDraft[] = [];
    for (const cellElement of rowCells(row)) {
      const tcPr = firstChild(cellElement, "w:tcPr");
      const span = tcPr === null ? null : firstChild(tcPr, "w:gridSpan");
      const merge = tcPr === null ? null : firstChild(tcPr, "w:vMerge");
      const width = tcPr === null ? null : firstChild(tcPr, "w:tcW");
      const shading = tcPr === null ? null : firstChild(tcPr, "w:shd");
      const colSpan = Math.max(1, (span === null ? null : intAttr(span, "w:val")) ?? 1);
      const mergeState = merge === null ? "none" : attr(merge, "w:val") === "restart" ? "restart" : "continue";
      const widthType = width === null ? null : attr(width, "w:type");
      const widthValue = width === null ? null : intAttr(width, "w:w");
      const cell: TableCell = {
        blocks: index.blocksIn(cellElement).map((child) => buildBlock(index, child, story)),
        colSpan,
        rowSpan: 1,
        mergedAbove: mergeState === "continue",
        widthPt: widthValue !== null && (widthType === null || widthType === "dxa") ? twipsToPt(widthValue) : null,
        fill: shading === null ? null : hexColor(attr(shading, "w:fill")),
      };
      rowDrafts.push({ cell, column, merge: mergeState });
      column += colSpan;
    }
    const mark = rowRevisionElement(row);
    const revision = mark === null ? null : (marks.get(mark) ?? null);
    drafts.push(rowDrafts);
    rows.push({
      cells: rowDrafts.map((draft) => draft.cell),
      isHeader: trPr !== null && (childToggle(trPr, "w:tblHeader") ?? false),
      revision: revision === null ? null : { ...revision },
    });
  }
  // A vertical merge runs down from its first cell while the cells below continue it.
  for (let rowIndex = 0; rowIndex < drafts.length; rowIndex++) {
    for (const draft of drafts[rowIndex] as CellDraft[]) {
      if (draft.merge !== "restart") continue;
      let span = 1;
      for (let below = rowIndex + 1; below < drafts.length; below++) {
        const continued = (drafts[below] as CellDraft[]).some(
          (other) => other.column === draft.column && other.merge === "continue",
        );
        if (!continued) break;
        span += 1;
      }
      draft.cell.rowSpan = span;
    }
  }
  return { type: "table", id: record.id, rows, columnWidthsPt };
}

function breakTypeOf(sectPr: XmlElement | null): SectionBreakBlock["breakType"] {
  const value = sectPr === null ? null : childVal(sectPr, "w:type");
  switch (value) {
    case "continuous":
    case "evenPage":
    case "oddPage":
    case "nextColumn":
      return value;
    default:
      return "nextPage";
  }
}

function buildSectionBreak(index: DocxIndex, record: BlockRecord): SectionBreakBlock {
  const sections = index.structure.sections;
  const sectionIndex = Math.max(0, sections.findIndex((section) => section.element === record.element));
  // `w:type` of a section says how that section starts, so the break takes it from the next one.
  return {
    type: "sectionBreak",
    id: record.id,
    sectionIndex,
    breakType: breakTypeOf(sections[sectionIndex + 1]?.element ?? null),
  };
}

export function buildBlock(index: DocxIndex, record: BlockRecord, story?: StoryRecord): DocxBlock {
  const owner = story ?? (index.story(record.storyId) as StoryRecord);
  if (record.type === "paragraph") return buildParagraph(index, record, owner);
  if (record.type === "table") return buildTable(index, record, owner);
  return buildSectionBreak(index, record);
}

export function buildStory(index: DocxIndex, story: StoryRecord): DocxStory {
  return {
    id: story.id,
    kind: story.kind,
    label: story.label,
    blocks: story.blocks.map((record) => buildBlock(index, record, story)),
  };
}

function buildSection(record: SectionRecord, position: number): DocxSection {
  const sectPr = record.element;
  const size = sectPr === null ? null : firstChild(sectPr, "w:pgSz");
  const margins = sectPr === null ? null : firstChild(sectPr, "w:pgMar");
  const columns = sectPr === null ? null : firstChild(sectPr, "w:cols");
  const points = (element: XmlElement | null, name: string, fallback: number): number => {
    const value = element === null ? null : intAttr(element, name);
    return twipsToPt(value ?? fallback);
  };
  const pageWidthPt = points(size, "w:w", 12240);
  const pageHeightPt = points(size, "w:h", 15840);
  const orient = size === null ? null : attr(size, "w:orient");
  return {
    index: position,
    pageWidthPt,
    pageHeightPt,
    orientation: orient === "landscape" || (orient === null && pageWidthPt > pageHeightPt) ? "landscape" : "portrait",
    marginTopPt: points(margins, "w:top", 1440),
    marginRightPt: points(margins, "w:right", 1440),
    marginBottomPt: points(margins, "w:bottom", 1440),
    marginLeftPt: points(margins, "w:left", 1440),
    columns: Math.max(1, (columns === null ? null : intAttr(columns, "w:num")) ?? 1),
    headers: { ...record.headers },
    footers: { ...record.footers },
  };
}

/** The `w:trackRevisions` setting of the document. */
export function readTrackRevisions(index: DocxIndex): boolean {
  const settings = index.partRoot("settings");
  const element = settings === null ? null : firstChild(settings, "w:trackRevisions");
  return element !== null && isOn(attr(element, "w:val"));
}

export function buildView(index: DocxIndex): DocxView {
  const stories = index.structure.stories;
  const ofKind = (kind: StoryRecord["kind"]): DocxStory[] =>
    stories.filter((story) => story.kind === kind).map((story) => buildStory(index, story));
  return {
    body: buildStory(index, stories[0] as StoryRecord),
    headers: ofKind("header"),
    footers: ofKind("footer"),
    footnotes: ofKind("footnote"),
    endnotes: ofKind("endnote"),
    sections: index.structure.sections.map(buildSection),
    trackRevisions: readTrackRevisions(index),
    revisionCount: index.revisions.groups.length,
    commentCount: commentElements(index).length,
  };
}
