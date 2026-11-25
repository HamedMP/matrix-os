import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./internal";

export interface TreeNode {
  id: string;
  label: ReactNode;
  /** Plain-text name used for type-ahead; defaults to label when it is a string. */
  textValue?: string;
  icon?: ReactNode;
  /** Trailing content such as an unread count. */
  badge?: ReactNode;
  children?: readonly TreeNode[];
  disabled?: boolean;
}

export interface TreeViewProps {
  label: string;
  nodes: readonly TreeNode[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  expandedIds?: readonly string[];
  defaultExpandedIds?: readonly string[];
  onExpandedChange?: (ids: string[]) => void;
  className?: string;
}

interface FlatNode {
  node: TreeNode;
  level: number;
  parentId: string | null;
  posinset: number;
  setsize: number;
}

function flatten(nodes: readonly TreeNode[], expanded: Set<string>, level = 1, parentId: string | null = null, out: FlatNode[] = []): FlatNode[] {
  nodes.forEach((node, index) => {
    out.push({ node, level, parentId, posinset: index + 1, setsize: nodes.length });
    if (node.children?.length && expanded.has(node.id)) flatten(node.children, expanded, level + 1, node.id, out);
  });
  return out;
}

/** Folder/label tree (role="tree") with arrow-key navigation, expand and collapse. */
export function TreeView({ label, nodes, selectedId, onSelect, expandedIds, defaultExpandedIds = [], onExpandedChange, className }: TreeViewProps) {
  const [innerExpanded, setInnerExpanded] = useState<readonly string[]>(defaultExpandedIds);
  const [focusId, setFocusId] = useState<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const expanded = useMemo(() => new Set(expandedIds ?? innerExpanded), [expandedIds, innerExpanded]);
  const flat = useMemo(() => flatten(nodes, expanded), [nodes, expanded]);
  const tabStop = focusId && flat.some((f) => f.node.id === focusId) ? focusId : selectedId && flat.some((f) => f.node.id === selectedId) ? selectedId : flat[0]?.node.id;

  const setExpanded = (id: string, open: boolean) => {
    const next = new Set(expanded);
    if (open) next.add(id);
    else next.delete(id);
    const list = [...next];
    if (expandedIds === undefined) setInnerExpanded(list);
    onExpandedChange?.(list);
  };

  const focus = (id: string) => {
    setFocusId(id);
    itemRefs.current.get(id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, item: FlatNode) => {
    const index = flat.indexOf(item);
    const hasChildren = Boolean(item.node.children?.length);
    const isOpen = expanded.has(item.node.id);
    switch (event.key) {
      case "ArrowDown":
        if (index < flat.length - 1) focus(flat[index + 1].node.id);
        break;
      case "ArrowUp":
        if (index > 0) focus(flat[index - 1].node.id);
        break;
      case "ArrowRight":
        if (hasChildren && !isOpen) setExpanded(item.node.id, true);
        else if (hasChildren && isOpen && flat[index + 1]) focus(flat[index + 1].node.id);
        break;
      case "ArrowLeft":
        if (hasChildren && isOpen) setExpanded(item.node.id, false);
        else if (item.parentId) focus(item.parentId);
        break;
      case "Home":
        if (flat[0]) focus(flat[0].node.id);
        break;
      case "End":
        if (flat.length) focus(flat[flat.length - 1].node.id);
        break;
      case "Enter":
      case " ":
        if (!item.node.disabled) onSelect?.(item.node.id);
        break;
      default: {
        if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
        const char = event.key.toLowerCase();
        const ordered = [...flat.slice(index + 1), ...flat.slice(0, index + 1)];
        const match = ordered.find((f) => (f.node.textValue ?? (typeof f.node.label === "string" ? f.node.label : "")).toLowerCase().startsWith(char));
        if (!match) return;
        focus(match.node.id);
      }
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div role="tree" aria-label={label} className={cx("oui-tree", className)}>
      {flat.map((item) => {
        const { node, level } = item;
        const hasChildren = Boolean(node.children?.length);
        const isOpen = expanded.has(node.id);
        const isSelected = node.id === selectedId;
        return (
          <div
            key={node.id}
            ref={(el) => {
              if (el) itemRefs.current.set(node.id, el);
              else itemRefs.current.delete(node.id);
            }}
            role="treeitem"
            aria-level={level}
            aria-posinset={item.posinset}
            aria-setsize={item.setsize}
            aria-expanded={hasChildren ? isOpen : undefined}
            aria-selected={isSelected}
            aria-disabled={node.disabled || undefined}
            tabIndex={node.id === tabStop ? 0 : -1}
            className={cx("oui-tree__item", isSelected && "is-selected", node.disabled && "is-disabled")}
            style={{ paddingInlineStart: 8 + (level - 1) * 16 }}
            onKeyDown={(event) => onKeyDown(event, item)}
            onFocus={() => setFocusId(node.id)}
            onClick={() => {
              if (!node.disabled) onSelect?.(node.id);
            }}
          >
            <span
              className={cx("oui-tree__twisty", hasChildren && "has-children", isOpen && "is-open")}
              aria-hidden="true"
              onClick={(event) => {
                if (!hasChildren) return;
                event.stopPropagation();
                setExpanded(node.id, !isOpen);
              }}
            >
              {hasChildren && <svg viewBox="0 0 16 16" width="10" height="10"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>}
            </span>
            {node.icon && <span className="oui-tree__icon" aria-hidden="true">{node.icon}</span>}
            <span className="oui-tree__label">{node.label}</span>
            {node.badge !== undefined && <span className="oui-tree__badge">{node.badge}</span>}
          </div>
        );
      })}
    </div>
  );
}
