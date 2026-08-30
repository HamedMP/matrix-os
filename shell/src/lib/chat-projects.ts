import type { KernelConversationSummary } from "@matrix-os/contracts";

export interface WebChatProject {
  id: string;
  slug: string;
  name: string;
  kind: "scratch" | "github" | "folder";
  localPath?: string;
}

export type WebChatProjectAction =
  | { type: "rename"; name: string }
  | { type: "delete"; confirmation: string };

export interface WebChatRailModel {
  projects: Array<{ project: WebChatProject; conversations: KernelConversationSummary[] }>;
  recents: KernelConversationSummary[];
}

export function buildWebChatRailModel(
  conversations: readonly KernelConversationSummary[],
  projects: readonly WebChatProject[],
): WebChatRailModel {
  const groups = projects.map((project) => ({ project, conversations: [] as KernelConversationSummary[] }));
  const groupByReference = new Map<string, (typeof groups)[number]>();
  for (const group of groups) {
    groupByReference.set(group.project.id, group);
    groupByReference.set(group.project.slug, group);
  }
  const recents: KernelConversationSummary[] = [];
  for (const conversation of conversations.toSorted((a, b) => b.updatedAt - a.updatedAt)) {
    const group = conversation.context ? groupByReference.get(conversation.context.projectId) : undefined;
    if (group) group.conversations.push(conversation);
    else recents.push(conversation);
  }
  return { projects: groups, recents };
}

export async function mutateWebChatProject(
  fetcher: typeof fetch,
  gatewayUrl: string,
  slug: string,
  action: WebChatProjectAction,
): Promise<void> {
  const response = await fetcher(`${gatewayUrl}/api/projects/${encodeURIComponent(slug)}/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Project action failed");
}

export async function fetchWebChatProjects(
  fetcher: typeof fetch,
  gatewayUrl: string,
): Promise<WebChatProject[]> {
  const response = await fetcher(`${gatewayUrl}/api/workspace/projects`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Projects unavailable");
  const payload = await response.json() as { projects?: unknown };
  if (!Array.isArray(payload.projects)) return [];
  return payload.projects.flatMap((value): WebChatProject[] => {
    if (!value || typeof value !== "object") return [];
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.id !== "string"
      || typeof candidate.slug !== "string"
      || typeof candidate.name !== "string"
      || !["scratch", "github", "folder"].includes(String(candidate.kind))
    ) return [];
    return [{
      id: candidate.id,
      slug: candidate.slug,
      name: candidate.name,
      kind: candidate.kind as WebChatProject["kind"],
      ...(typeof candidate.localPath === "string" ? { localPath: candidate.localPath } : {}),
    }];
  });
}
