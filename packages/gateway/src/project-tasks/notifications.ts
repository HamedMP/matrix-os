/**
 * Notification sources for the board (spec 2699 section 9). This module only
 * decides who should hear about a change and under which dedupe key; delivery
 * goes through the gateway's existing channel path. Nobody is notified about
 * their own action.
 */
import type { ActorRef, BoardMember } from "@matrix-os/contracts/project-tasks";

export interface TaskNotification {
  recipient: ActorRef;
  dedupeKey: string;
  kind: "assigned" | "mentioned" | "commented";
  taskId: string;
  projectSlug: string;
  text: string;
}

const MENTION = /(^|[\s([{"'“])@([A-Za-z0-9._-]{1,40})/g;
const MAX_TITLE = 120;

function title(value: string): string {
  return value.length <= MAX_TITLE ? value : `${value.slice(0, MAX_TITLE - 1)}…`;
}

/** Member handles mentioned in a comment, in order, each once. */
export function mentionedMembers(body: string, members: readonly BoardMember[]): BoardMember[] {
  const found: BoardMember[] = [];
  for (const match of body.matchAll(MENTION)) {
    const handle = match[2]!.replace(/[.,]+$/, "").toLowerCase();
    const member = members.find((candidate) => candidate.handle.toLowerCase() === handle);
    if (member && !found.includes(member)) found.push(member);
  }
  return found;
}

export function assignmentNotification(input: {
  taskId: string; taskKey: string; taskTitle: string; projectSlug: string; actor: ActorRef; assignee: ActorRef | null;
}): TaskNotification[] {
  if (!input.assignee || input.assignee === input.actor || !input.assignee.startsWith("user:")) return [];
  return [{
    recipient: input.assignee, kind: "assigned", taskId: input.taskId, projectSlug: input.projectSlug,
    dedupeKey: `task:${input.taskId}:assigned:${input.actor}`,
    text: `Assigned to you: ${input.taskKey} ${title(input.taskTitle)}`,
  }];
}

export function commentNotifications(input: {
  taskId: string; taskKey: string; taskTitle: string; projectSlug: string; commentId: string; author: ActorRef; body: string;
  assignee: ActorRef | null; createdBy: ActorRef; members: readonly BoardMember[];
}): TaskNotification[] {
  const notifications: TaskNotification[] = [];
  const notified = new Set<ActorRef>([input.author]);
  for (const member of mentionedMembers(input.body, input.members)) {
    if (notified.has(member.actor) || !member.actor.startsWith("user:")) continue;
    notified.add(member.actor);
    notifications.push({
      recipient: member.actor, kind: "mentioned", taskId: input.taskId, projectSlug: input.projectSlug,
      dedupeKey: `task:${input.taskId}:comment:${input.commentId}:${member.actor}`,
      text: `Mentioned in ${input.taskKey} ${title(input.taskTitle)}`,
    });
  }
  for (const recipient of [input.assignee, input.createdBy]) {
    if (!recipient || notified.has(recipient) || !recipient.startsWith("user:")) continue;
    notified.add(recipient);
    notifications.push({
      recipient, kind: "commented", taskId: input.taskId, projectSlug: input.projectSlug,
      dedupeKey: `task:${input.taskId}:comment:${input.commentId}`,
      text: `New comment on ${input.taskKey} ${title(input.taskTitle)}`,
    });
  }
  return notifications;
}
