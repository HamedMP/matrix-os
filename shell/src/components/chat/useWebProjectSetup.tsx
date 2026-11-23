"use client";
import { useContext, useLayoutEffect, useMemo, useRef } from "react";
import {
  useProjectSetup,
  ProjectSetupControls,
  ProjectSetupIntroduction,
  ProjectSetupProgress,
  ProjectSetupAcceptedNote,
  projectSetupAnswerPlaceholder,
  projectSetupControlsMessageId,
  type ProjectSetupTransport,
} from "@matrix-os/ui";
import type { CanonicalChatModelSelection } from "@matrix-os/contracts";
import { PROJECT_SKILL_FILE_MAX_BYTES } from "@matrix-os/contracts";
import {
  parseProjectInstalledSkills,
  PROJECT_INSTALLED_SKILLS_PATH,
  projectInstalledSkillFilePath,
  projectAgentContextFileLocationRequest,
  projectAgentContextFilesPath,
} from "@matrix-os/ui/project-agent-context";
import { getGatewayUrl } from "@/lib/gateway";
import { usePreviewWindow } from "@/hooks/usePreviewWindow";
import { ShellFileAuthority } from "@/components/file-browser/ShellFileAuthority";
import {
  WebProjectAgentContextNavigation,
  requestWebProjectContext,
  readWebProjectJson,
  readWebProjectText,
} from "./WebProjectAgentContext";
import type { WebProject } from "./web-projects";

export function useWebProjectSetup({
  project,
  chatId,
  scope,
  gatewayUrl,
  eligible,
  selection,
  isCurrentAuthority,
  openChat,
  messages,
}: {
  project?: WebProject;
  chatId?: string;
  scope: string;
  gatewayUrl: string;
  eligible: boolean;
  selection?: CanonicalChatModelSelection;
  isCurrentAuthority?: () => boolean;
  openChat: (id: string) => void;
  messages: readonly { id: string; role: string; requestId?: string; tool?: string }[];
}) {
  const navigation = useContext(WebProjectAgentContextNavigation);
  const authorityCheck = useRef(isCurrentAuthority);
  authorityCheck.current = isCurrentAuthority;
  const transport = useMemo<ProjectSetupTransport>(() => {
    const send = async (path: string, signal: AbortSignal, method = "GET", body?: unknown) => {
      const current = () =>
        !signal.aborted &&
        (authorityCheck.current?.() ?? true) &&
        gatewayUrl.replace(/\/$/, "") === getGatewayUrl();
      if (!current()) throw new Error("Project setup unavailable");
      const response = await requestWebProjectContext(gatewayUrl, path, signal, {
        method,
        redirect: "error",
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      if (response.status === 404 && path.endsWith("/project-setup")) return { draft: null };
      if (!response.ok) throw new Error("Project setup request failed");
      const result = await readWebProjectJson(response, 512 * 1024);
      if (!current()) throw new Error("Project setup changed");
      return result;
    };
    return {
      get: (path, signal) => send(path, signal),
      post: (path, body, signal) => send(path, signal, "POST", body),
      patch: (path, body, signal) => send(path, signal, "PATCH", body),
    };
    // A new authority scope must replace the transport and cancel old requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gatewayUrl, scope]);
  const setup = useProjectSetup({
    client: transport,
    scope,
    projectId: project?.id,
    chatId,
    eligible,
    selection,
    onOpenChat: openChat,
  });
  const sources = {
    loadInstalledSkills: async (signal: AbortSignal) =>
      parseProjectInstalledSkills(await transport.get(PROJECT_INSTALLED_SKILLS_PATH, signal)),
    readInstalledSkill: async (file: string, signal: AbortSignal) => {
      const path = projectInstalledSkillFilePath(file);
      if (!path || (isCurrentAuthority && !isCurrentAuthority())) throw new Error("Skill source unavailable");
      const response = await requestWebProjectContext(gatewayUrl, path, signal, { redirect: "error" });
      if (!response.ok) throw new Error("Skill source unavailable");
      const content = await readWebProjectText(response, PROJECT_SKILL_FILE_MAX_BYTES, true);
      if (signal.aborted || (isCurrentAuthority && !isCurrentAuthority()))
        throw new Error("Skill source changed");
      return content;
    },
  };
  const fileRequest = useRef<AbortController | null>(null);
  useLayoutEffect(
    () => () => {
      fileRequest.current?.abort();
      fileRequest.current = null;
    },
    [scope, project?.id, chatId],
  );
  const openFile = async (path: string, authority: string): Promise<boolean> => {
    if (!project || !navigation?.openPreview || fileRequest.current) return false;
    const controller = new AbortController();
    fileRequest.current = controller;
    try {
      const payload = await transport.get(
        projectAgentContextFileLocationRequest(project.slug, project.id, path),
        controller.signal,
      );
      const location = projectAgentContextFilesPath(payload);
      if (!controller.signal.aborted && location?.endsWith(`/${path}`) && (isCurrentAuthority?.() ?? true)) {
        usePreviewWindow.getState().openFile(location, { authority, mode: "source", focus: true });
        navigation.openPreview();
        return true;
      }
      return false;
    } catch (error: unknown) {
      console.warn(
        "[project-setup] File could not be opened",
        error instanceof Error ? error.name : "UnknownError",
      );
      return false;
    } finally {
      if (fileRequest.current === controller) fileRequest.current = null;
    }
  };
  const projectName = project?.name ?? "this project";
  const draft = setup.draft;
  const messageId = draft?.generation?.runId ? projectSetupControlsMessageId(draft,
    messages.map(({ id, role, requestId, tool }) => ({ id, role, runId: requestId, tool }))) : draft?.currentQuestionMessageId;
  return {
    ...setup,
    messageId,
    awaitingMessage: Boolean(messageId && !messages.some(message => message.id === messageId)),
    placeholder: projectSetupAnswerPlaceholder(setup.introduction, draft?.step, setup.mcpHandoff),
    note: draft ? <ProjectSetupAcceptedNote draft={draft} /> : null,
    header: draft ? <ProjectSetupProgress projectName={projectName} draft={draft} /> : null,
    controls: eligible ? (
      <ShellFileAuthority>
        {(authority) => (
          <ProjectSetupControls
            key={authority}
            setup={setup}
            transport={transport}
            selection={selection}
            onOpenMcpSettings={navigation?.openMcpSettings}
            mcpSettingsOpen={navigation?.mcpSettingsOpen}
            onOpenFile={(path) => openFile(path, authority)}
            {...sources}
          />
        )}
      </ShellFileAuthority>
    ) : null,
    introductionContent: setup.introduction ? (
      <ProjectSetupIntroduction projectName={projectName} setup={setup} />
    ) : null,
  };
}
