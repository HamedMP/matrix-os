import { useAuth } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { z } from "zod/v4";
import type { RenameableConversation } from "./ChatTitleRename";

const ProjectsResponseSchema = z.object({
  projects: z.array(z.object({
    id: z.string().min(1),
    slug: z.string().min(1),
    name: z.string().min(1),
  })),
});
export type WebProject = z.infer<typeof ProjectsResponseSchema>["projects"][number];
// `projects: null` records a failed load for that request key.
type ProjectsResult = { key: string; projects: WebProject[] | null };
export interface WebProjectsState {
  identity: string;
  projects: WebProject[];
  loading: boolean;
  error: boolean;
  retry(): void;
}

/** The owner's projects on the routed computer; a former computer's or account's list is never shown. */
export function useWebProjects(gatewayUrl: string, scopeKey: string): WebProjectsState {
  const { userId, sessionId } = useAuth();
  const identity = `${userId ?? "self-hosted"}\n${sessionId ?? ""}\n${scopeKey}\n${gatewayUrl}`;
  const [result, setResult] = useState<ProjectsResult | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${identity}\n${attempt}`;

  // The gateway derives ownership from the authenticated request. A result is
  // only shown for the request key that produced it, so a former computer's or
  // account's response never populates a newly selected one.
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- projects belong to the current routed VPS and cannot be resolved at shell build time.
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${gatewayUrl}/api/workspace/projects`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    }).then(response => {
      if (!response.ok) throw new Error("ProjectsUnavailable");
      return response.json();
    }).then(body => {
      if (!controller.signal.aborted) setResult({ key, projects: ProjectsResponseSchema.parse(body).projects });
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("[web-projects] list unavailable", cause instanceof Error ? cause.name : "UnknownError");
      setResult({ key, projects: null });
    });
    return () => controller.abort();
  }, [gatewayUrl, key]);

  const settled = result?.key === key ? result : null;
  return {
    identity,
    projects: settled?.projects ?? [],
    loading: settled === null,
    error: settled !== null && settled.projects === null,
    retry: () => setAttempt(value => value + 1),
  };
}

/** Chats in one project, matched by project id or slug as on Electron Desktop. */
export function projectChats<T extends RenameableConversation>(chats: readonly T[], project: WebProject): T[] {
  return chats.filter(chat => {
    const projectId = chat.canonicalRecord?.projectId;
    return projectId !== undefined && (projectId === project.id || projectId === project.slug);
  });
}
