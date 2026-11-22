import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  useProjectSetup,
  useProjectSetupLaunch,
  ProjectSetupControls,
  ProjectSetupIntroduction,
  type ProjectSetupTransport,
  type ProjectSetupMarkdownState,
} from "@matrix-os/ui";
import { PROJECT_SKILL_FILE_MAX_BYTES, type CanonicalChatModelSelection } from "@matrix-os/contracts";
import {
  PROJECT_INSTALLED_SKILLS_PATH,
  parseProjectInstalledSkills,
  projectInstalledSkillFilePath,
  projectAgentContextFileLocationRequest,
  projectAgentContextFilesPath,
} from "@matrix-os/ui/project-agent-context";
import type { ApiClient } from "../../lib/api";
import { AppError } from "../../lib/errors";
import { useConnection } from "../../stores/connection";
import { useBoard } from "../../stores/board";
import { useUi } from "../../stores/ui";
import { useTabs } from "../../stores/tabs";
import { openFileInDesktopEditor } from "../editor/desktop-editor-store";

export function useDesktopProjectSetup({
  api,
  projectId,
  chatId,
  eligible,
  selection,
  openChat,
  refresh,
}: {
  api?: ApiClient;
  projectId: string | null;
  chatId?: string | null;
  eligible: boolean;
  selection?: CanonicalChatModelSelection | null;
  openChat: (id: string) => void;
  refresh: () => void;
}) {
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const launch = useProjectSetupLaunch();
  const scope = JSON.stringify([api?.baseUrl, runtimeSlot, authGeneration]);
  const editorScope = JSON.stringify([scope, projectId, chatId]);
  // Tabs stay mounted during Settings. Keep only this checkout/Chat's three review editors.
  const [editors, setEditors] = useState<{
    scope: string;
    files: Record<string, ProjectSetupMarkdownState>;
  }>({ scope: editorScope, files: {} });
  useLayoutEffect(() => {
    setEditors({ scope: editorScope, files: {} });
  }, [editorScope]);
  const project = useBoard((state) => state.projects.find((item) => item.id === projectId));
  const transport = useMemo<ProjectSetupTransport | null>(() => {
    if (!api || typeof api.forRuntime !== "function") return null;
    const client = api.forRuntime(runtimeSlot);
    const current = (signal: AbortSignal) => {
      const connection = useConnection.getState();
      if (
        signal.aborted ||
        connection.api !== api ||
        connection.runtimeSlot !== runtimeSlot ||
        connection.authGeneration !== authGeneration
      )
        throw new Error("Setup scope changed");
    };
    const read = async (path: string, signal: AbortSignal) => {
      current(signal);
      try {
        const payload = await client.get<unknown>(path, {
          signal,
          cache: "no-store",
          maxBytes: 512 * 1024,
          omitErrorBody: true,
        });
        current(signal);
        return payload;
      } catch (error: unknown) {
        if (error instanceof AppError && error.httpStatus === 404 && path.endsWith("/project-setup"))
          return { draft: null };
        throw error;
      }
    };
    return {
      get: read,
      post: async (path, body, signal) => {
        current(signal);
        const result = await client.post<unknown>(path, body, {
          signal,
          maxBytes: 512 * 1024,
          omitErrorBody: true,
        });
        current(signal);
        return result;
      },
      patch: async (path, body, signal) => {
        current(signal);
        const result = await client.patch<unknown>(path, body, {
          signal,
          maxBytes: 512 * 1024,
          omitErrorBody: true,
        });
        current(signal);
        return result;
      },
    };
  }, [api, runtimeSlot, authGeneration]);
  const setup = useProjectSetup({
    client: transport,
    scope,
    projectId,
    chatId,
    eligible,
    selection,
    onOpenChat: (id) => {
      launch?.dismiss();
      openChat(id);
    },
    onChanged: refresh,
  });
  const markdownEdits = {
    files: editors.scope === editorScope ? editors.files : {},
    onChange: (path: string, state: ProjectSetupMarkdownState) => setEditors(previous => {
      const paths = setup.draft?.proposals.map(file => file.path) ?? [];
      if (previous.scope !== editorScope || !paths.includes(path)) return previous;
      // A regenerated skill may replace its old path; retain only this review's bounded files.
      const files = Object.fromEntries(Object.entries(previous.files).filter(([key]) => paths.includes(key)));
      if (!files[path] && Object.keys(files).length >= 3) return previous;
      return { scope: editorScope, files: { ...files, [path]: state } };
    }),
  };
  const seenRequest = useRef(0);
  const startSetup = useEffectEvent(() => setup.start());
  useEffect(() => {
    if (!launch?.requested || launch.sequence === seenRequest.current) return;
    seenRequest.current = launch.sequence;
    void startSetup();
  }, [launch?.requested, launch?.sequence, eligible, transport]);
  const view = {
    ...setup,
    dismiss: () => {
      setup.dismiss();
      launch?.dismiss();
    },
  };
  const openMcpSettings = () => {
    useUi.getState().requestSettingsSection("mcps");
    useTabs.getState().openTab({ kind: "settings", title: "Settings" });
  };
  const fileRequest = useRef<AbortController | null>(null);
  useLayoutEffect(
    () => () => {
      fileRequest.current?.abort();
      fileRequest.current = null;
    },
    [scope, projectId, chatId],
  );
  const openFile = async (path: string): Promise<boolean> => {
    if (!api || !project?.slug || fileRequest.current) return false;
    const controller = new AbortController();
    fileRequest.current = controller;
    try {
      const result = await transport?.get(
        projectAgentContextFileLocationRequest(project.slug, projectId!, path),
        controller.signal,
      );
      const location = projectAgentContextFilesPath(result);
      return (
        !controller.signal.aborted &&
        Boolean(
          location?.endsWith(`/${path}`) && openFileInDesktopEditor(`./${encodeURIComponent(location!)}`),
        )
      );
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
  const sources = {
    loadInstalledSkills: async (signal: AbortSignal) =>
      parseProjectInstalledSkills(await transport!.get(PROJECT_INSTALLED_SKILLS_PATH, signal)),
    readInstalledSkill: async (file: string, signal: AbortSignal) => {
      const path = projectInstalledSkillFilePath(file);
      if (!api || !path) throw new Error("Skill source unavailable");
      const blob = await api
        .forRuntime(runtimeSlot)
        .getBlob(path, { signal, maxBytes: PROJECT_SKILL_FILE_MAX_BYTES, omitErrorBody: true });
      if (signal.aborted) throw new Error("Skill source cancelled");
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await blob.arrayBuffer());
    },
  };
  return {
    ...view,
    controls: eligible ? (
      <ProjectSetupControls
        setup={view}
        transport={transport}
        selection={selection}
        onOpenMcpSettings={openMcpSettings}
        markdownEdits={markdownEdits}
        onOpenFile={openFile}
        {...sources}
      />
    ) : null,
    introductionContent:
      setup.introduction || (launch?.requested && !setup.draft) ? (
        <ProjectSetupIntroduction projectName={project?.name ?? "this project"} setup={view} />
      ) : null,
  };
}
