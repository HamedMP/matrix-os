import React, { Fragment, useState, type ReactNode } from 'react';
import { ChatRailSection, resolveCanonicalChatLifecycleGroup } from '@matrix-os/ui';
import type { RenameableConversation } from './ChatTitleRename';
import type { CanonicalChatNavigationPageQuery, CanonicalChatNavigationPageResponse } from '@matrix-os/contracts';
import { usePagedStatusGroup } from './usePagedStatusGroup';

type GroupKey = 'pinned' | 'needsYou' | 'working' | 'done';
export function webChatLifecycleGroup(item: RenameableConversation): GroupKey {
  const record = item.canonicalRecord;
  if (!record) return "done";
  if (record.chat.userState?.pinned) return "pinned";
  const group = resolveCanonicalChatLifecycleGroup(record);
  return group === "recent" ? "done" : group;
}
export function groupWebChats(items: readonly RenameableConversation[]): Record<GroupKey, RenameableConversation[]> {
  const result: Record<GroupKey, RenameableConversation[]> = { pinned: [], needsYou: [], working: [], done: [] };
  for (const item of items) result[webChatLifecycleGroup(item)].push(item);
  return result;
}

export function WebChatLifecycleGroups({ conversations, projects, attention, attentionCount = 0, scopeKey, navigationUpdatedAt, loadPage, excludedChatIds, renderRow }: {
  attentionCount?: number; scopeKey?: string;
  navigationUpdatedAt?: number;
  loadPage?: (input: CanonicalChatNavigationPageQuery) => Promise<CanonicalChatNavigationPageResponse>;
  excludedChatIds?: readonly string[];
  conversations: readonly RenameableConversation[]; projects?: ReactNode; attention?: ReactNode; renderRow(item: RenameableConversation): ReactNode;
}) {
  const groups = groupWebChats(conversations);
  const pinnedPage = usePagedStatusGroup('pinned', loadPage, scopeKey, navigationUpdatedAt);
  const needsPage = usePagedStatusGroup('needsYou', loadPage, scopeKey, navigationUpdatedAt);
  const workingPage = usePagedStatusGroup('working', loadPage, scopeKey, navigationUpdatedAt);
  const donePage = usePagedStatusGroup('done', loadPage, scopeKey, navigationUpdatedAt);
  const pages = { pinned: pinnedPage, needsYou: needsPage, working: workingPage, done: donePage };
  const [state, setState] = useState(() => ({scopeKey, expanded: {pinned: true, needsYou: true, working: true, done: true}}));
  let current = state;
  if (current.scopeKey !== scopeKey) { current = {scopeKey, expanded: {pinned: true, needsYou: true, working: true, done: true}}; setState(current); }
  const section = (key: GroupKey, label: string, extra?: ReactNode) => {
    const page = pages[key];
    const rows = page && loadPage && !page.loading && !page.error || page && loadPage && page.rows.length
      ? page!.rows.filter(row => !excludedChatIds?.includes(row.id))
      : loadPage ? groups[key].slice(0, 10) : groups[key];
    const count = page && loadPage && !page.loading && !page.error ? page.count : groups[key].length;
    return rows.length || extra || key !== "pinned" ? <ChatRailSection key={key} label={label}
    count={count + (key === "needsYou" ? attentionCount : 0)} attention={key === "needsYou"} expanded={current.expanded[key]}
    onExpandedChange={expanded => setState(value => value.scopeKey === scopeKey ? {...value, expanded: {...value.expanded, [key]: expanded}} : value)}>
    {rows.map(item => <Fragment key={item.id}>{renderRow(item)}</Fragment>)}{extra}
    {page && loadPage && page.cursor ? <button type="button" aria-label={`Show more ${label} chats`} className="matrix-web-project-more" disabled={page.loading} onClick={page.loadMore}>Show more</button> : null}
    {page?.error && loadPage ? <p role="alert" className="matrix-web-project-note">Chats could not be loaded.</p> : null}
  </ChatRailSection> : null;
  };
  return <>{section('pinned','Pinned')}{projects}{section('needsYou','Needs you',attention)}{section('working','Working')}{section('done','Done')}</>;
}
