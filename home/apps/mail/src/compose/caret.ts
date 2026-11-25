/**
 * Keeping the caret in place when the editor is re-rendered from the
 * redline. A position is a count over the editor's visible content: each
 * character of text, each `br`, and each start of a block after other
 * content count one. The same walk measures and restores, so a re-render
 * that keeps the visible text puts the caret back where it was.
 */
const BLOCKS = new Set(["DIV", "P", "LI", "UL", "OL", "BLOCKQUOTE", "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "TABLE", "TR", "TD", "TH"]);

type Stop =
  | { kind: "text"; node: Text; start: number }
  | { kind: "break"; node: Element; at: number }
  | { kind: "block"; node: Element; at: number };

function walk(root: Node): { stops: Stop[]; length: number } {
  const stops: Stop[] = [];
  let count = 0;
  let boundary = true;
  const visit = (node: Node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) {
        const text = child as Text;
        stops.push({ kind: "text", node: text, start: count });
        count += text.data.length;
        if (text.data.length) boundary = false;
      } else if (child.nodeType === 1) {
        const element = child as Element;
        if (element.tagName === "BR") {
          stops.push({ kind: "break", node: element, at: count });
          count += 1;
          boundary = true;
          continue;
        }
        if (BLOCKS.has(element.tagName)) {
          if (!boundary) count += 1;
          boundary = true;
          stops.push({ kind: "block", node: element, at: count });
        }
        visit(element);
      }
    }
  };
  visit(root);
  return { stops, length: count };
}

/** The caret position inside `root`, or null when the selection is elsewhere. */
export function captureCaret(root: HTMLElement): number | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.endContainer)) return null;
  const probe = root.ownerDocument.createRange();
  probe.selectNodeContents(root);
  probe.setEnd(range.endContainer, range.endOffset);
  const holder = root.ownerDocument.createElement("div");
  holder.appendChild(probe.cloneContents());
  return walk(holder).length;
}

function insideReadOnly(node: Node, root: HTMLElement): Element | null {
  for (let current: Node | null = node.parentNode; current && current !== root; current = current.parentNode) {
    if (current.nodeType === 1 && (current as Element).getAttribute("contenteditable") === "false") return current as Element;
  }
  return null;
}

/** Puts the caret at `offset` inside `root`, clamped to its content. */
export function restoreCaret(root: HTMLElement, offset: number): void {
  const selection = root.ownerDocument.getSelection();
  if (!selection) return;
  const range = root.ownerDocument.createRange();
  const { stops } = walk(root);
  let placed = false;
  for (const stop of stops) {
    if (stop.kind === "text") {
      const end = stop.start + stop.node.data.length;
      if (offset < stop.start || offset > end) continue;
      const readOnly = insideReadOnly(stop.node, root);
      if (readOnly) range.setStartAfter(readOnly);
      else range.setStart(stop.node, offset - stop.start);
      placed = true;
      break;
    }
    if (stop.kind === "block" && stop.at === offset && !stop.node.querySelector("*:not(br)") && !stop.node.textContent) {
      range.setStart(stop.node, 0);
      placed = true;
      break;
    }
    if (stop.kind === "break" && stop.at === offset) {
      range.setStartBefore(stop.node);
      placed = true;
      break;
    }
  }
  if (!placed) {
    range.selectNodeContents(root);
    range.collapse(false);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}
