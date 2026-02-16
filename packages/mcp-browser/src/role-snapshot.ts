export interface AXNode {
  role: string;
  name?: string;
  value?: string;
  level?: number;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  required?: boolean;
  children?: AXNode[];
}

export interface FormatOptions {
  maxChars?: number;
}

const SKIP_ROLES = new Set(["presentation", "none", "generic"]);

export function formatAccessibilityTree(
  tree: AXNode | null | undefined,
  opts?: FormatOptions,
): string {
  if (!tree) return "(empty page)";

  const maxChars = opts?.maxChars ?? 20_000;
  const lines: string[] = [];
  let charCount = 0;
  let truncated = false;

  function walk(node: AXNode, depth: number): void {
    if (truncated) return;
    if (SKIP_ROLES.has(node.role)) return;

    const indent = "  ".repeat(depth);
    const parts: string[] = [node.role];

    if (node.name) {
      parts.push(`"${node.name}"`);
    }

    const attrs: string[] = [];
    if (node.level !== undefined) attrs.push(`level=${node.level}`);
    if (node.value !== undefined) attrs.push(`value="${node.value}"`);
    if (node.checked) attrs.push("checked");
    if (node.disabled) attrs.push("disabled");
    if (node.expanded !== undefined) attrs.push(node.expanded ? "expanded" : "collapsed");
    if (node.selected) attrs.push("selected");
    if (node.required) attrs.push("required");

    if (attrs.length > 0) {
      parts.push(`[${attrs.join(", ")}]`);
    }

    const line = `${indent}${parts.join(" ")}`;
    charCount += line.length + 1;

    if (charCount > maxChars) {
      truncated = true;
      return;
    }

    lines.push(line);

    if (node.children) {
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    }
  }

  walk(tree, 0);

  if (truncated) {
    lines.push("[truncated]");
  }

  return lines.join("\n");
}
