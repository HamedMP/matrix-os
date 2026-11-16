"use client";

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { AGENT_INBOX_PILL_STYLE } from "../desktop-agent-inbox.js";
import { formatInboxTime, type AgentInboxGroup } from "../agent-inbox-model.js";
import { AgentLogo } from "../agent-logo.js";
import type { ChatNavigationRecord } from "../chat-navigation/projection.js";
import { ChatComposerSelect } from "./composer/ChatComposerSelect.js";
import {
  PROJECT_CONVERSATION_PAGE_SIZE, PROJECT_CONVERSATION_SORTS, PROJECT_CONVERSATION_STATUS_FILTERS,
  projectConversationAgents, projectConversationCounts, queryProjectConversations, toProjectConversationRow,
  type ProjectConversationQuery, type ProjectConversationRow, type ProjectConversationSort, type ProjectConversationStatusFilter,
} from "./project-conversations.js";

const muted: CSSProperties = { color: "var(--text-tertiary, var(--muted-foreground))" };
const border: CSSProperties = { borderColor: "var(--border-subtle, var(--border))" };
const STATUS_COLOR: Record<AgentInboxGroup, string> = { needs: "#E0A12E", running: "#3BA55D", done: "var(--text-tertiary, #8a8780)" };
const EMPTY_FILTER_COPY: Record<ProjectConversationStatusFilter, string> = {
  all: "No chats match your search.", needs: "Nothing needs you right now.", running: "No agents are running.", done: "No finished chats yet.",
};
const chipClass = "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] outline-none hover:bg-[var(--bg-hover,rgba(0,0,0,0.05))] focus-visible:ring-2 focus-visible:ring-[var(--accent,currentColor)] aria-pressed:bg-[var(--bg-hover,rgba(0,0,0,0.05))] aria-pressed:font-medium";
const rowClass = "grid w-full grid-cols-[30px_minmax(0,1fr)_auto] items-start gap-3 rounded-lg px-2.5 py-2 text-left outline-none";

export interface ProjectConversationListProps {
  projectName: string;
  records: readonly ChatNavigationRecord[];
  status: "loading" | "ready" | "error";
  /** Reference time for relative labels; callers tick it (for example with useMinuteClock). */
  nowMs: number;
  onSelect?: (record: ChatNavigationRecord) => void;
  onRetry?: () => void;
  activeChatId?: string;
  /** Last-message preview when the caller's projection carries one. */
  snippetFor?: (record: ChatNavigationRecord) => string | undefined;
  /** The source list was bounded upstream; older Chats may be missing. */
  truncated?: boolean;
  /** Shown under the empty-state copy, e.g. a pointer to the composer. */
  emptyHint?: ReactNode;
}

/**
 * One row per project Chat with search, status/agent filters and sort, shared
 * by the Electron Desktop and Web Desktop project pages. Status uses the agent
 * inbox's vocabulary; rendering is paged so long projects stay bounded.
 */
export function ProjectConversationList({ projectName, records, status, nowMs, onSelect, onRetry, activeChatId, snippetFor, truncated, emptyHint }: ProjectConversationListProps) {
  const [query, setQuery] = useState<ProjectConversationQuery>({ search: "", status: "all", agent: "all", sort: "activity" });
  const rows = useMemo(() => records.map((record) => toProjectConversationRow(record, snippetFor?.(record))), [records, snippetFor]);
  const agents = useMemo(() => projectConversationAgents(rows), [rows]);
  const counts = useMemo(() => projectConversationCounts(rows), [rows]);
  // A removed agent must not leave the list filtered to nothing.
  const staleAgent = query.agent !== "all" && !agents.some((agent) => agent.value === query.agent);
  const effective = useMemo(() => (staleAgent ? { ...query, agent: "all" } : query), [query, staleAgent]);
  const matches = useMemo(() => queryProjectConversations(rows, effective), [rows, effective]);
  const queryKey = `${effective.search}\u0000${effective.status}\u0000${effective.agent}\u0000${effective.sort}`;
  const [page, setPage] = useState({ key: queryKey, count: PROJECT_CONVERSATION_PAGE_SIZE });
  const limit = page.key === queryKey ? page.count : PROJECT_CONVERSATION_PAGE_SIZE;
  const shown = matches.slice(0, limit);
  const update = (patch: Partial<ProjectConversationQuery>) => setQuery((current) => ({ ...current, ...patch }));

  return <section aria-label="Project chats" data-slot="project-conversation-list" className="flex min-w-0 flex-col">
    <ConversationToolbar query={query} effective={effective} agents={agents} counts={counts} onChange={update} />
    <div className="pt-1"><ConversationListBody projectName={projectName} status={status} rowCount={rows.length} shown={shown} query={effective}
      nowMs={nowMs} activeChatId={activeChatId} onSelect={onSelect} onRetry={onRetry} emptyHint={emptyHint}
      onClearFilters={() => update({ search: "", status: "all", agent: "all" })} /></div>
    {status === "error" && rows.length > 0 ? <p role="alert" className="px-2.5 pt-1 text-xs">Project chats could not be refreshed.{onRetry ? <> <button type="button" className="underline" onClick={onRetry}>Try again</button></> : null}</p> : null}
    {matches.length > shown.length ? <button type="button" className={`${chipClass} mx-auto mt-1`} style={muted}
      onClick={() => setPage({ key: queryKey, count: limit + PROJECT_CONVERSATION_PAGE_SIZE })}>
      Show more ({matches.length - shown.length})
    </button> : null}
    {truncated && matches.length <= shown.length && rows.length > 0 ? <p className="px-2.5 pt-2 text-[11.5px]" style={muted}>Showing the most recent chats.</p> : null}
  </section>;
}

function ConversationToolbar({ query, effective, agents, counts, onChange }: {
  query: ProjectConversationQuery; effective: ProjectConversationQuery;
  agents: ReadonlyArray<{ value: string; label: string }>; counts: Record<ProjectConversationStatusFilter, number>;
  onChange(patch: Partial<ProjectConversationQuery>): void;
}) {
  const update = onChange;
  return <>
    <div className="flex flex-wrap items-center gap-2 pb-2">
      <label className="flex h-8 min-w-[12rem] flex-1 items-center gap-2 rounded-lg border px-2.5" style={border}>
        <HugeiconsIcon icon={Search01Icon} size={14} strokeWidth={1.5} aria-hidden style={muted} />
        <input type="search" aria-label="Search chats by title" placeholder="Search chats" maxLength={200} value={query.search}
          onChange={(event) => update({ search: event.currentTarget.value })}
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none" style={{ color: "var(--text-primary, var(--foreground))" }} />
      </label>
      <ChatComposerSelect label="Filter by agent" value={effective.agent} menuSide="bottom"
        options={agents.length > 1 ? [{ value: "all", label: "All agents" }, ...agents] : []}
        onChange={(agent) => update({ agent })} />
      <ChatComposerSelect label="Sort chats" value={effective.sort} menuSide="bottom" options={[...PROJECT_CONVERSATION_SORTS]}
        onChange={(sort) => update({ sort: sort as ProjectConversationSort })} />
    </div>
    <div role="group" aria-label="Filter by status" className="flex gap-1 overflow-x-auto border-b pb-2" style={border}>
      {PROJECT_CONVERSATION_STATUS_FILTERS.map(({ id, label }) => <button key={id} type="button" aria-pressed={effective.status === id}
        className={chipClass} style={{ color: "var(--text-primary, var(--foreground))" }} onClick={() => update({ status: id })}>
        {label} <span className="text-[11px]" style={muted}>{counts[id]}</span>
      </button>)}
    </div>
  </>;
}

function ConversationListBody({ projectName, status, rowCount, shown, query, nowMs, activeChatId, onSelect, onRetry, emptyHint, onClearFilters }: {
  projectName: string; status: ProjectConversationListProps["status"]; rowCount: number; shown: readonly ProjectConversationRow[];
  query: ProjectConversationQuery; nowMs: number; activeChatId?: string; onSelect?: (record: ChatNavigationRecord) => void;
  onRetry?: () => void; emptyHint?: ReactNode; onClearFilters(): void;
}) {
  if (status === "loading" && rowCount === 0) {
    return <p role="status" className="px-2.5 py-6 text-center text-xs" style={muted}>Loading chats…</p>;
  }
  if (status === "error" && rowCount === 0) {
    return <div role="alert" className="px-2.5 py-6 text-center text-xs">
      <p>Project chats could not be loaded.</p>
      {onRetry ? <button type="button" className={`${chipClass} mx-auto mt-2`} onClick={onRetry}>Try again</button> : null}
    </div>;
  }
  if (rowCount === 0) {
    return <div className="px-2.5 py-8 text-center">
      <p className="text-[13.5px] font-medium" style={{ color: "var(--text-primary, var(--foreground))" }}>No chats in {projectName} yet</p>
      <p className="mt-1 text-xs" style={muted}>{emptyHint ?? "Start one below; every conversation in this project shows up here."}</p>
    </div>;
  }
  if (shown.length === 0) {
    const searching = query.search.trim() !== "";
    return <div className="px-2.5 py-6 text-center text-xs" style={muted}>
      <p>{searching ? EMPTY_FILTER_COPY.all : EMPTY_FILTER_COPY[query.status]}</p>
      {searching || query.status !== "all" || query.agent !== "all"
        ? <button type="button" className={`${chipClass} mx-auto mt-2`} onClick={onClearFilters}>Clear filters</button> : null}
    </div>;
  }
  return <ul aria-label={`${projectName} chats`} className="flex flex-col">
    {shown.map((row) => <li key={row.id}>
      <ConversationRow row={row} time={formatInboxTime(row.record.chat.activityAt ?? row.record.chat.updatedAt, nowMs)}
        active={row.id === activeChatId} onOpen={onSelect ? () => onSelect(row.record) : undefined} />
    </li>)}
  </ul>;
}

function ConversationRow({ row, time, active, onOpen }: { row: ProjectConversationRow; time: string; active: boolean; onOpen?: () => void }) {
  const subline = [row.agentLabel, time].filter(Boolean).join(" · ");
  const body = <>
    <span className="mt-0.5"><AgentLogo kind={row.artwork} label={row.agentLabel} dimmed={row.group === "done"}
      badge={row.group !== "done" ? <span data-status-dot={row.group} className={`absolute -bottom-[3px] -right-[3px] size-[11px] rounded-full border-2${row.group === "running" ? " motion-safe:animate-pulse" : ""}`}
        style={{ background: row.pill === "Approval" || row.pill === "Failed" ? "#D64541" : STATUS_COLOR[row.group], borderColor: "var(--bg-surface, var(--card))" }} /> : null} /></span>
    <span className="min-w-0">
      <span className="block truncate text-[13.5px] font-medium leading-snug" style={{ color: "var(--text-primary, var(--foreground))" }}>{row.title}</span>
      <span className="mt-0.5 block truncate text-xs" style={muted}>{subline}</span>
      {row.snippet ? <span className="mt-1 block truncate text-[12.5px] leading-snug" style={{ color: "var(--text-secondary, var(--muted-foreground))" }}>{row.snippet}</span> : null}
    </span>
    <span className="mt-0.5 whitespace-nowrap rounded-full px-1.5 py-px text-[11px] font-semibold" style={AGENT_INBOX_PILL_STYLE[row.pill]}>{row.pill}</span>
  </>;
  if (!onOpen) return <div className={rowClass}>{body}</div>;
  return <button type="button" aria-label={`Open ${row.title}, ${row.pill}`} aria-current={active ? "page" : undefined} onClick={onOpen}
    className={`${rowClass} hover:bg-[var(--bg-hover,rgba(0,0,0,0.05))] focus-visible:ring-2 focus-visible:ring-[var(--accent,currentColor)] aria-[current=page]:bg-[var(--bg-hover,rgba(0,0,0,0.05))]`}>{body}</button>;
}
