"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Calendar03Icon, HashtagIcon, MessageMultiple01Icon, WorkflowSquare03Icon } from "@hugeicons/core-free-icons";
import { POPOVER_LAYER } from "../layering.js";
import { ChatComposerSelect } from "../chat/composer/ChatComposerSelect.js";
import type { ChannelTreeNode } from "./model.js";
import { rowClass, sectionLabelClass, subtleBorder, textPrimary, textSecondary, textTertiary } from "./presentation.js";
import type { BoardSummary } from "./types.js";

export type BoardSidePanel = "watchers" | "schedules";

export interface ChannelSidebarProps {
  boards: readonly BoardSummary[];
  board: string;
  tree: readonly ChannelTreeNode[];
  totalUnread: number;
  scope: string;
  activeWatchers?: number;
  activeSchedules?: number;
  panel?: BoardSidePanel | null;
  onSelectBoard(name: string): void;
  onSelectScope(scope: string): void;
  /** Shows the Automation entries; omitted where watchers and schedules are not offered. */
  onOpenPanel?(panel: BoardSidePanel): void;
}

/** Left pane: board switcher, channels grouped by prefix with unread counts, and automation entries. */
export function ChannelSidebar({
  boards, board, tree, totalUnread, scope, activeWatchers = 0, activeSchedules = 0, panel = null, onSelectBoard, onSelectScope, onOpenPanel,
}: ChannelSidebarProps) {
  return <nav aria-label="Channels" className="flex h-full min-h-0 flex-col">
    <div className="flex items-center gap-1 border-b px-2 py-2" style={subtleBorder}>
      <span className="pl-1 text-xs font-medium" style={textTertiary}>Board</span>
      {boards.length > 1
        ? <ChatComposerSelect label="Switch board" value={board} menuSide="bottom" menuZIndex={POPOVER_LAYER}
            options={boards.map((item) => ({ value: item.name, label: item.scope === "organization" ? `${item.name} (shared)` : item.name }))}
            onChange={onSelectBoard} />
        : <span className="px-2 text-sm font-medium" style={textPrimary}>{board}</span>}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
      <p className={sectionLabelClass} style={textTertiary}>CHANNELS</p>
      <ul className="flex flex-col gap-px">
        <li>
          <ChannelRow label="All channels" icon={MessageMultiple01Icon} depth={0} unread={totalUnread}
            active={scope === "*" && panel === null} onSelect={() => onSelectScope("*")} />
        </li>
        {tree.map((node) => <ChannelNode key={node.path} node={node} scope={scope} panelOpen={panel !== null} onSelectScope={onSelectScope} />)}
      </ul>
      {onOpenPanel ? <>
      <p className={sectionLabelClass} style={textTertiary}>AUTOMATION</p>
      <ul className="flex flex-col gap-px">
        <li>
          <ChannelRow label="Watchers" icon={WorkflowSquare03Icon} depth={0} detail={`${activeWatchers} active`}
            active={panel === "watchers"} onSelect={() => onOpenPanel("watchers")} />
        </li>
        <li>
          <ChannelRow label="Schedules" icon={Calendar03Icon} depth={0} detail={`${activeSchedules}`}
            active={panel === "schedules"} onSelect={() => onOpenPanel("schedules")} />
        </li>
      </ul>
      </> : null}
    </div>
  </nav>;
}

function ChannelNode({ node, scope, panelOpen, onSelectScope }: {
  node: ChannelTreeNode; scope: string; panelOpen: boolean; onSelectScope(scope: string): void;
}) {
  const isGroup = node.children.length > 0;
  // A group selects its subtree; a leaf channel selects exactly itself.
  const target = isGroup ? `${node.path}/` : node.path;
  return <li>
    <ChannelRow label={isGroup ? `${node.segment}/` : node.segment} icon={isGroup ? null : HashtagIcon} depth={node.depth}
      unread={isGroup ? 0 : node.unread} groupUnread={isGroup ? node.unread : 0}
      active={!panelOpen && scope === target} onSelect={() => onSelectScope(target)}
      title={isGroup ? `Everything under ${node.path}/` : node.path} />
    {isGroup ? <ul className="flex flex-col gap-px">
      {node.channel ? <li>
        <ChannelRow label={node.segment} icon={HashtagIcon} depth={node.depth + 1} unread={node.channel.unread}
          active={!panelOpen && scope === node.path} onSelect={() => onSelectScope(node.path)} title={node.path} />
      </li> : null}
      {node.children.map((child) => <ChannelNode key={child.path} node={child} scope={scope} panelOpen={panelOpen} onSelectScope={onSelectScope} />)}
    </ul> : null}
  </li>;
}

function ChannelRow({ label, icon, depth, unread = 0, groupUnread = 0, detail, active, title, onSelect }: {
  label: string; icon: typeof HashtagIcon | null; depth: number; unread?: number; groupUnread?: number; detail?: string;
  active: boolean; title?: string; onSelect(): void;
}) {
  const unreadLabel = unread > 0 ? `, ${unread} unread` : groupUnread > 0 ? `, ${groupUnread} unread inside` : "";
  return <button type="button" aria-current={active} aria-label={`${label}${unreadLabel}`} title={title} onClick={onSelect}
    className={`${rowClass} flex h-8 items-center gap-2 pr-2 text-[13px]`} style={{ paddingLeft: 8 + depth * 14 }}>
    {icon ? <HugeiconsIcon icon={icon} size={14} strokeWidth={1.5} aria-hidden style={textTertiary} /> : <span aria-hidden className="w-3.5" />}
    <span className={`min-w-0 flex-1 truncate${unread > 0 ? " font-semibold" : ""}`} style={unread > 0 ? textPrimary : textSecondary}>{label}</span>
    {unread > 0
      ? <span className="min-w-5 rounded-full px-1.5 text-center text-[11px] font-semibold leading-5" style={{ background: "var(--warning)", color: "var(--text-on-warning, var(--text-primary))" }}>{unread}</span>
      : groupUnread > 0
        ? <span aria-hidden className="size-1.5 rounded-full" style={{ background: "var(--warning)" }} />
        : detail ? <span className="text-[11px]" style={textTertiary}>{detail}</span> : null}
  </button>;
}
