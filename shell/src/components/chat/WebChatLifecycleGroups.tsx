import React, { Fragment, useState, type ReactNode } from 'react';
import { ChatRailSection, resolveCanonicalChatLifecycleGroup } from '@matrix-os/ui';
import type { RenameableConversation } from './ChatTitleRename';

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

export function WebChatLifecycleGroups({ conversations, projects, attention, attentionCount = 0, scopeKey, renderRow }: {
  attentionCount?: number; scopeKey?: string;
  conversations: readonly RenameableConversation[]; projects?: ReactNode; attention?: ReactNode; renderRow(item: RenameableConversation): ReactNode;
}) {
  const groups = groupWebChats(conversations);
  const [state, setState] = useState(() => ({scopeKey, expanded: {pinned: true, needsYou: true, working: true, done: true}}));
  let current = state;
  if (current.scopeKey !== scopeKey) { current = {scopeKey, expanded: {pinned: true, needsYou: true, working: true, done: true}}; setState(current); }
  const section = (key: GroupKey, label: string, extra?: ReactNode) => groups[key].length || extra || key !== "pinned" ? <ChatRailSection key={key} label={label}
    count={groups[key].length + (key === "needsYou" ? attentionCount : 0)} attention={key === "needsYou"} expanded={current.expanded[key]}
    onExpandedChange={expanded => setState(value => value.scopeKey === scopeKey ? {...value, expanded: {...value.expanded, [key]: expanded}} : value)}>
    {groups[key].map(item => <Fragment key={item.id}>{renderRow(item)}</Fragment>)}{extra}
  </ChatRailSection> : null;
  return <>{section('pinned','Pinned')}{projects}{section('needsYou','Needs you',attention)}{section('working','Working')}{section('done','Done')}</>;
}
