import { useLayoutEffect, useRef, useState } from "react";
import { PROJECT_SKILL_FILE_MAX_BYTES, ProjectAgentConfigFileSchema } from "@matrix-os/contracts";
import { ProjectAgentContextPanel } from "@matrix-os/ui";
import {
  PROJECT_AGENT_CONTEXT_OPEN_FILE_ERROR,
  PROJECT_AGENT_CONTEXT_RESPONSE_LIMIT,
  PROJECT_INSTALLED_SKILLS_PATH,
  PROJECT_INSTALLED_SKILLS_RESPONSE_LIMIT,
  parseProjectInstalledSkills,
  projectInstalledSkillFilePath,
  projectAgentContextFileLocationRequest,
  projectAgentContextFilesPath,
} from "@matrix-os/ui/project-agent-context";
import { useConnection } from "../../stores/connection";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../../stores/runtime-generation";
import { openFileInDesktopEditor } from "../editor/desktop-editor-store";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import { useDesktopProjectAgentContextReader } from "./desktop-project-slash-scope";

function openMcpSettings(): void {
  useUi.getState().requestSettingsSection("mcps");
  useTabs.getState().openTab({ kind: "settings", title: "Settings" });
}

interface DesktopProjectAgentContextProps {
  projectId?: string;
  projectSlug: string;
  onOpenFiles: () => Promise<void>;
  filesPending: boolean;
}

export function DesktopProjectAgentContext(props: DesktopProjectAgentContextProps) {
  const api = useConnection(state => state.api);
  const runtimeSlot = useConnection(state => state.runtimeSlot);
  const authGeneration = useConnection(state => state.authGeneration);
  const scope = JSON.stringify([api?.baseUrl, runtimeSlot, authGeneration]);
  if (!props.projectId) return null;
  return <DesktopProjectAgentContextScoped key={JSON.stringify([scope, props.projectId, props.projectSlug])}
    {...props} projectId={props.projectId} scope={scope} api={api} runtimeSlot={runtimeSlot} authGeneration={authGeneration} />;
}

function DesktopProjectAgentContextScoped({ projectId, projectSlug, onOpenFiles, filesPending, scope, api, runtimeSlot, authGeneration }: DesktopProjectAgentContextProps & {
  projectId: string;
  scope: string;
  api: ReturnType<typeof useConnection.getState>["api"];
  runtimeSlot: string;
  authGeneration: number;
}) {
  const fileRequest = useRef<AbortController | null>(null);
  const [openingFile, setOpeningFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  useLayoutEffect(() => () => fileRequest.current?.abort(), []);

  const { read } = useDesktopProjectAgentContextReader();

  const isCurrentAuthority = (runtime: number, signal: AbortSignal) => {
    const connection = useConnection.getState();
    return !signal.aborted && isCurrentRuntimeGeneration(runtime) && connection.api === api
      && connection.runtimeSlot === runtimeSlot && connection.authGeneration === authGeneration;
  };
  const loadInstalledSkills = async (signal: AbortSignal) => {
    const runtime = captureRuntimeGeneration();
    if (!api || !isCurrentAuthority(runtime, signal)) throw new Error("Skill source unavailable");
    const result = await api.forRuntime(runtimeSlot).get<unknown>(PROJECT_INSTALLED_SKILLS_PATH, {
      signal, cache: "no-store", maxBytes: PROJECT_INSTALLED_SKILLS_RESPONSE_LIMIT, omitErrorBody: true,
    });
    if (!isCurrentAuthority(runtime, signal)) throw new Error("Skill source unavailable");
    return parseProjectInstalledSkills(result);
  };
  const readInstalledSkill = async (file: string, signal: AbortSignal) => {
    const runtime = captureRuntimeGeneration();
    const path = projectInstalledSkillFilePath(file);
    if (!api || !path || !isCurrentAuthority(runtime, signal)) throw new Error("Skill source unavailable");
    const blob = await api.forRuntime(runtimeSlot).getBlob(path, {
      signal, maxBytes: PROJECT_SKILL_FILE_MAX_BYTES, omitErrorBody: true,
    });
    const bytes = await blob.arrayBuffer();
    if (!isCurrentAuthority(runtime, signal)) throw new Error("Skill source unavailable");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  };

  const openFile = async (file: string, content?: string): Promise<boolean> => {
    if (!api || filesPending || fileRequest.current || !ProjectAgentConfigFileSchema.safeParse(file).success) return false;
    const creating = content !== undefined;
    const runtime = captureRuntimeGeneration();
    const controller = new AbortController();
    fileRequest.current = controller;
    setOpeningFile(true);
    setFileError(null);
    const current = () => isCurrentAuthority(runtime, controller.signal);
    try {
      if (!current()) return false;
      const client = api.forRuntime(runtimeSlot);
      const options = { signal: controller.signal, maxBytes: PROJECT_AGENT_CONTEXT_RESPONSE_LIMIT, omitErrorBody: true };
      const response = await client.get<unknown>(projectAgentContextFileLocationRequest(projectSlug, projectId, creating ? undefined : file), {
        ...options, cache: "no-store",
      });
      if (!current()) return false;
      const location = projectAgentContextFilesPath(response);
      if (!location || (!creating && !location.endsWith(`/${file}`))) throw new Error("File unavailable");
      const path = creating ? `${location}/${file}` : location;
      if (creating) {
        const result = await client.post<{ ok?: boolean }>("/api/files/touch", { path, content, projectId, projectFile: file }, options);
        if (!result.ok) throw new Error("File could not be created");
        if (!current()) return false;
      }
      // Editor also accepts URI paths. Encode the validated Files path to preserve literal percent sequences.
      const opened = openFileInDesktopEditor(`./${encodeURIComponent(path)}`);
      if (!opened) setFileError(PROJECT_AGENT_CONTEXT_OPEN_FILE_ERROR);
      return creating || opened;
    } catch (error: unknown) {
      if (current()) {
        console.warn("[project-context] File unavailable:", error instanceof Error ? error.name : "UnknownError");
        if (!creating) setFileError(PROJECT_AGENT_CONTEXT_OPEN_FILE_ERROR);
      }
      return false;
    } finally {
      if (fileRequest.current === controller) fileRequest.current = null;
      if (current()) setOpeningFile(false);
    }
  };

  return <ProjectAgentContextPanel
    scope={scope}
    projectId={projectId}
    read={read}
    onOpenFiles={api ? onOpenFiles : undefined}
    onOpenFile={api ? file => { void openFile(file); } : undefined}
    onCreateFile={api ? openFile : undefined}
    loadInstalledSkills={api ? loadInstalledSkills : undefined}
    readInstalledSkill={api ? readInstalledSkill : undefined}
    filesPending={filesPending || openingFile}
    filesError={fileError}
    onOpenMcpSettings={openMcpSettings}
  />;
}
