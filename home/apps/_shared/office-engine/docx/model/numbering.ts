/**
 * List numbering: `word/numbering.xml` (abstract definitions, instances,
 * level overrides) and the counters that turn a numbered paragraph into the
 * label a reader sees (`3.1`, `(a)`, a bullet).
 */

import type { NumberingLabel } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import { attr, childToggle, childVal, firstChild, intAttr } from "./names.js";
import { formatCounter, numberingFormatOf } from "./number-format.js";
import { type ParagraphProps, readParagraphProps } from "./props.js";

export interface LevelDefinition {
  readonly level: number;
  readonly start: number;
  /** `w:numFmt`, for example `decimal` or `bullet`. */
  readonly numFmt: string;
  /** `w:lvlText`: the label pattern, with `%1` to `%9` for the counters. */
  readonly text: string;
  /**
   * `w:lvlRestart`: null restarts after any higher level, 0 never restarts,
   * n restarts only when level n-1 or a higher one is used.
   */
  readonly restart: number | null;
  /** `w:isLgl`: write every counter in the label as decimal. */
  readonly legal: boolean;
  /** `w:pStyle`: the paragraph style that selects this level. */
  readonly styleId: string | null;
  /** Indents the level gives its paragraphs. */
  readonly paragraph: ParagraphProps;
}

interface NumInstance {
  readonly abstractId: string;
  readonly overrides: Map<number, { start: number | null; level: LevelDefinition | null }>;
}

const MAX_LEVELS = 9;
const MAX_LINKS = 8;

function readLevel(element: XmlElement): LevelDefinition | null {
  const level = intAttr(element, "w:ilvl");
  if (level === null || level < 0 || level >= MAX_LEVELS) return null;
  const startElement = firstChild(element, "w:start");
  const restartElement = firstChild(element, "w:lvlRestart");
  return {
    level,
    start: (startElement === null ? null : intAttr(startElement, "w:val")) ?? 1,
    numFmt: childVal(element, "w:numFmt") ?? "decimal",
    text: childVal(element, "w:lvlText") ?? "",
    restart: restartElement === null ? null : intAttr(restartElement, "w:val"),
    legal: childToggle(element, "w:isLgl") ?? false,
    styleId: childVal(element, "w:pStyle"),
    paragraph: readParagraphProps(firstChild(element, "w:pPr")),
  };
}

/** Symbol-font bullets are stored in the private use area; show the character they draw. */
function bulletText(text: string): string {
  let result = "";
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (code >= 0xf000 && code <= 0xf0ff) {
      result += code === 0xf0a7 ? "▪" : code === 0xf0d8 ? "➢" : code === 0xf0fc ? "✓" : "•";
    } else {
      result += char;
    }
  }
  return result;
}

export class NumberingDefinitions {
  private readonly abstracts = new Map<string, { levels: Map<number, LevelDefinition>; styleLink: string | null }>();
  private readonly instances = new Map<string, NumInstance>();
  /** Numbering style id to the instance it defines, for `w:numStyleLink`. */
  private readonly styleNumIds: (styleId: string) => string | null;

  constructor(numberingRoot: XmlElement | null, styleNumIds: (styleId: string) => string | null) {
    this.styleNumIds = styleNumIds;
    if (numberingRoot === null) return;
    for (const node of numberingRoot.children) {
      if (node.kind !== "element") continue;
      if (node.name === "w:abstractNum") {
        const id = attr(node, "w:abstractNumId");
        if (id === null || this.abstracts.has(id)) continue;
        const levels = new Map<number, LevelDefinition>();
        for (const child of node.children) {
          if (child.kind !== "element" || child.name !== "w:lvl") continue;
          const level = readLevel(child);
          if (level !== null && !levels.has(level.level)) levels.set(level.level, level);
        }
        this.abstracts.set(id, { levels, styleLink: childVal(node, "w:numStyleLink") });
      } else if (node.name === "w:num") {
        const id = attr(node, "w:numId");
        const abstractId = childVal(node, "w:abstractNumId");
        if (id === null || abstractId === null || this.instances.has(id)) continue;
        const overrides: NumInstance["overrides"] = new Map();
        for (const child of node.children) {
          if (child.kind !== "element" || child.name !== "w:lvlOverride") continue;
          const level = intAttr(child, "w:ilvl");
          if (level === null || level < 0 || level >= MAX_LEVELS) continue;
          const startElement = firstChild(child, "w:startOverride");
          const levelElement = firstChild(child, "w:lvl");
          overrides.set(level, {
            start: startElement === null ? null : intAttr(startElement, "w:val"),
            level: levelElement === null ? null : readLevel(levelElement),
          });
        }
        this.instances.set(id, { abstractId, overrides });
      }
    }
  }

  /** The abstract definition an instance counts with, following numbering style links. */
  abstractIdOf(numId: string): string | null {
    let instance = this.instances.get(numId);
    for (let hop = 0; instance !== undefined && hop < MAX_LINKS; hop++) {
      const abstract = this.abstracts.get(instance.abstractId);
      if (abstract === undefined) return null;
      if (abstract.levels.size > 0 || abstract.styleLink === null) return instance.abstractId;
      const linked = this.styleNumIds(abstract.styleLink);
      if (linked === null) return instance.abstractId;
      instance = this.instances.get(linked);
    }
    return null;
  }

  level(numId: string, level: number): LevelDefinition | null {
    const override = this.instances.get(numId)?.overrides.get(level)?.level;
    if (override !== undefined && override !== null) return override;
    const abstractId = this.abstractIdOf(numId);
    return abstractId === null ? null : (this.abstracts.get(abstractId)?.levels.get(level) ?? null);
  }

  startOverride(numId: string, level: number): number | null {
    return this.instances.get(numId)?.overrides.get(level)?.start ?? null;
  }

  /** The level of an instance that is tied to a paragraph style, or null. */
  levelForStyle(numId: string, styleId: string): number | null {
    for (let level = 0; level < MAX_LEVELS; level++) {
      if (this.level(numId, level)?.styleId === styleId) return level;
    }
    return null;
  }
}

/** A numbered paragraph: its element and the instance and level it resolves to. */
export interface NumberedParagraph {
  readonly element: XmlElement;
  readonly numId: string;
  readonly level: number;
}

/**
 * Computes the label of every numbered paragraph, given in document order.
 * Instances that share an abstract definition share its counters, which is
 * how a list continues after a break; `w:startOverride` restarts a level the
 * first time its instance uses it.
 */
export function computeNumberingLabels(
  paragraphs: Iterable<NumberedParagraph>,
  definitions: NumberingDefinitions,
): Map<XmlElement, NumberingLabel> {
  const labels = new Map<XmlElement, NumberingLabel>();
  const counters = new Map<string, Array<number | null>>();
  const overridden = new Set<string>();
  for (const { element, numId, level } of paragraphs) {
    const abstractId = definitions.abstractIdOf(numId);
    const definition = definitions.level(numId, level);
    if (abstractId === null || definition === null) continue;
    const state = counters.get(abstractId) ?? new Array<number | null>(MAX_LEVELS).fill(null);
    counters.set(abstractId, state);
    const overrideKey = `${numId}:${level}`;
    const override = overridden.has(overrideKey) ? null : definitions.startOverride(numId, level);
    const current = state[level] ?? null;
    if (override !== null) {
      overridden.add(overrideKey);
      state[level] = override;
    } else {
      state[level] = current === null ? definition.start : current + 1;
    }
    for (let deeper = level + 1; deeper < MAX_LEVELS; deeper++) {
      const restart = definitions.level(numId, deeper)?.restart ?? null;
      if (restart === null || (restart > 0 && level <= restart - 1)) state[deeper] = null;
    }
    // A list that begins below its first level shows the start value of the levels it skipped.
    for (let higher = 0; higher < level; higher++) {
      if (state[higher] === null) state[higher] = definitions.level(numId, higher)?.start ?? 1;
    }

    const format = numberingFormatOf(definition.numFmt);
    let text: string;
    if (format === "bullet") {
      text = bulletText(definition.text);
    } else {
      text = definition.text.replace(/%([1-9])/g, (_match, digit: string) => {
        const index = Number(digit) - 1;
        if (index > level) return "";
        const value = state[index] ?? 1;
        const numFmt = definition.legal ? "decimal" : (definitions.level(numId, index)?.numFmt ?? "decimal");
        return formatCounter(value, numFmt);
      });
    }
    labels.set(element, {
      text,
      level,
      numId,
      format,
      counters: format === "bullet" ? [] : state.slice(0, level + 1).map((value) => value ?? 1),
    });
  }
  return labels;
}
