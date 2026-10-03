import React, { Fragment, type ReactNode } from 'react';
import { resolveCanonicalChatLifecycleGroup } from '@matrix-os/ui';
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

export function WebChatLifecycleGroups({ conversations, projects, attention, renderRow }: {
  conversations: readonly RenameableConversation[]; projects?: ReactNode; attention?: ReactNode; renderRow(item: RenameableConversation): ReactNode;
}) {
  const groups = groupWebChats(conversations);
  const section = (key: GroupKey, label: string, extra?: ReactNode) => groups[key].length || extra ? <section aria-label={label} className="px-2 pb-2">
    <h3 className="px-2 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</h3>
    {groups[key].map(item => <Fragment key={item.id}>{renderRow(item)}</Fragment>)}{extra}
  </section> : null;
  return <>{section('pinned','Pinned')}{projects}{section('needsYou','Needs you',attention)}{section('working','Working')}{section('done','Done')}</>;
}
