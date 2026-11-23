/**
 * Style resolution: `word/styles.xml` with its document defaults and
 * `w:basedOn` chains, reduced to the properties a paragraph or run inherits.
 */

import type { XmlElement } from "../../api/xml.js";
import { find } from "../../xml/index.js";
import { attr, childVal, firstChild } from "./names.js";
import { type ParagraphProps, type RunProps, type ThemeFonts, readParagraphProps, readRunProps } from "./props.js";

export interface StyleRecord {
  readonly id: string;
  /** `paragraph`, `character`, `table` or `numbering`. */
  readonly type: string;
  /** The stored name, for example `heading 1`. */
  readonly name: string | null;
  readonly basedOn: string | null;
  readonly paragraph: ParagraphProps;
  readonly run: RunProps;
  readonly element: XmlElement;
}

/** Longest `w:basedOn` chain followed; also stops a cycle. */
const MAX_CHAIN = 32;

/** Reads the Latin major and minor fonts from the theme part. */
export function readThemeFonts(themeRoot: XmlElement | null): ThemeFonts | null {
  if (themeRoot === null) return null;
  const typeface = (name: string): string | null => {
    const font = find(themeRoot, name);
    const latin = font === null ? null : firstChild(font, "a:latin");
    const value = latin === null ? null : attr(latin, "typeface");
    return value === null || value === "" ? null : value;
  };
  return { major: typeface("a:majorFont"), minor: typeface("a:minorFont") };
}

export class StyleSheet {
  readonly theme: ThemeFonts | null;
  readonly defaultRun: RunProps;
  readonly defaultParagraph: ParagraphProps;
  /** Id of the default paragraph style (usually `Normal`), or null. */
  readonly defaultParagraphStyleId: string | null;

  private readonly elements = new Map<string, XmlElement>();
  private readonly records = new Map<string, StyleRecord>();
  private readonly chains = new Map<string, StyleRecord[]>();

  constructor(stylesRoot: XmlElement | null, theme: ThemeFonts | null) {
    this.theme = theme;
    let defaultRun: RunProps = {};
    let defaultParagraph: ParagraphProps = {};
    let defaultParagraphStyleId: string | null = null;
    if (stylesRoot !== null) {
      for (const node of stylesRoot.children) {
        if (node.kind !== "element") continue;
        if (node.name === "w:docDefaults") {
          const rPrDefault = firstChild(node, "w:rPrDefault");
          const pPrDefault = firstChild(node, "w:pPrDefault");
          if (rPrDefault !== null) defaultRun = readRunProps(firstChild(rPrDefault, "w:rPr"), theme);
          if (pPrDefault !== null) defaultParagraph = readParagraphProps(firstChild(pPrDefault, "w:pPr"));
        } else if (node.name === "w:style") {
          const id = attr(node, "w:styleId");
          if (id === null || this.elements.has(id)) continue;
          this.elements.set(id, node);
          const isDefault = attr(node, "w:default");
          if (
            defaultParagraphStyleId === null &&
            attr(node, "w:type") === "paragraph" &&
            (isDefault === "1" || isDefault === "true" || isDefault === "on")
          ) {
            defaultParagraphStyleId = id;
          }
        }
      }
    }
    this.defaultRun = defaultRun;
    this.defaultParagraph = defaultParagraph;
    this.defaultParagraphStyleId = defaultParagraphStyleId;
  }

  has(id: string): boolean {
    return this.elements.has(id);
  }

  get(id: string): StyleRecord | null {
    const known = this.records.get(id);
    if (known !== undefined) return known;
    const element = this.elements.get(id);
    if (element === undefined) return null;
    const record: StyleRecord = {
      id,
      type: attr(element, "w:type") ?? "paragraph",
      name: childVal(element, "w:name"),
      basedOn: childVal(element, "w:basedOn"),
      paragraph: readParagraphProps(firstChild(element, "w:pPr")),
      run: readRunProps(firstChild(element, "w:rPr"), this.theme),
      element,
    };
    this.records.set(id, record);
    return record;
  }

  /** The style and the styles it is based on, the most basic first. */
  chain(id: string | null): StyleRecord[] {
    if (id === null) return [];
    const known = this.chains.get(id);
    if (known !== undefined) return known;
    const chain: StyleRecord[] = [];
    const seen = new Set<string>();
    let current: string | null = id;
    while (current !== null && !seen.has(current) && chain.length < MAX_CHAIN) {
      seen.add(current);
      const record = this.get(current);
      if (record === null) break;
      chain.unshift(record);
      current = record.basedOn;
    }
    this.chains.set(id, chain);
    return chain;
  }

  /** Run properties of a character or table style with everything it is based on. */
  runPropsOf(id: string | null): RunProps {
    const merged: RunProps = {};
    for (const record of this.chain(id)) Object.assign(merged, record.run);
    delete merged.styleId;
    return merged;
  }

  /** The id of the built-in or custom paragraph style with the given stored name, ignoring case. */
  findByName(name: string, type: string): string | null {
    const wanted = name.toLowerCase();
    for (const id of this.elements.keys()) {
      const record = this.get(id);
      if (record !== null && record.type === type && record.name !== null && record.name.toLowerCase() === wanted) {
        return id;
      }
    }
    return null;
  }

  /** Ids of all styles of a type, in file order. */
  ids(type: string): string[] {
    const found: string[] = [];
    for (const [id, element] of this.elements) {
      if ((attr(element, "w:type") ?? "paragraph") === type) found.push(id);
    }
    return found;
  }
}

/** The name shown for a style: built-in heading names are stored in lower case. */
export function displayStyleName(name: string | null): string | null {
  if (name === null) return null;
  const heading = /^heading ([1-9])$/i.exec(name);
  return heading === null ? name : `Heading ${heading[1]}`;
}

/** 1 to 9 when the stored style name is a built-in heading name, else 0. */
export function headingLevelOfName(name: string | null): number {
  const heading = name === null ? null : /^heading ([1-9])$/i.exec(name);
  return heading === null ? 0 : Number(heading[1]);
}
