import type { CanonicalChatRecord } from "@matrix-os/contracts";

import { formatRelativeTime, formatUpdated } from "@/lib/relative-time";
import { chatActivityAt } from "@/lib/requests/canonical-chat";
import type { ProjectSummary } from "@/lib/requests/projects";

/** What the screens show of a project: in the list, in its header and in its menu. */
export interface ProjectRow {
  id: string;
  name: string;
  /** When it last changed, already worded ("Updated today"). Left out when that is not known. */
  updated?: string;
}

/** What the project screen shows of one of its chats. */
export interface ProjectChatRow {
  id: string;
  title: string;
  /** The last message, on one line. */
  preview?: string;
  /** When the chat was last active, already worded ("2h"). */
  time?: string;
}

export function projectRow(project: ProjectSummary, now?: Date): ProjectRow {
  const updated = formatUpdated(project.updatedAt, now);
  return { id: project.id, name: project.name, ...(updated ? { updated } : {}) };
}

/** The rows of the projects list, in the order given: the projects whose name contains `query`. */
export function projectRows(projects: readonly ProjectSummary[], query: string, now?: Date): ProjectRow[] {
  const wanted = query.trim().toLocaleLowerCase();
  const shown = wanted
    ? projects.filter((project) => project.name.toLocaleLowerCase().includes(wanted))
    : projects;
  return shown.map((project) => projectRow(project, now));
}

/** The rows of a project's chats, in the order given. */
export function projectChatRows(records: readonly CanonicalChatRecord[], now?: Date): ProjectChatRow[] {
  return records.map((record) => {
    const preview = record.chat.lastMessagePreview?.replace(/\s+/g, " ").trim();
    const time = formatRelativeTime(chatActivityAt(record), now);
    return {
      id: record.chat.id,
      title: record.chat.title.trim() || "New chat",
      ...(preview ? { preview } : {}),
      ...(time ? { time } : {}),
    };
  });
}
