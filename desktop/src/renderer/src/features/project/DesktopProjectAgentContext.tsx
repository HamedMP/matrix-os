import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ProjectAgentConfigFileSchema } from "@matrix-os/contracts";
import { ProjectAgentContextPanel } from "@matrix-os/ui";
import {
  PROJECT_AGENT_CONTEXT_OPEN_FILE_ERROR,
  PROJECT_AGENT_CONTEXT_RESPONSE_LIMIT,
  projectAgentContextFileLocationRequest,
  projectAgentContextFilesPath,
} from "@matrix-os/ui/project-agent-context";
import { AppError } from "../../../../shared/app-error";
import { useConnection } from "../../stores/connection";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../../stores/runtime-generation";
import { openFileInDesktopEditor } from "../editor/desktop-editor-store";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";

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

  const read = useCallback(async (path: string, signal: AbortSignal) => {
    if (!api) return null;
    try {
      return await api.forRuntime(runtimeSlot).get<unknown>(path, {
        signal, cache: "no-store", maxBytes: PROJECT_AGENT_CONTEXT_RESPONSE_LIMIT, omitErrorBody: true,
      });
    } catch (error: unknown) {
      if (error instanceof AppError && [403, 404].includes(error.httpStatus ?? 0)) return null;
      throw error;
    }
  }, [api, runtimeSlot]);

  const openFile = async (file: string, content?: string): Promise<boolean> => {
    if (!api || filesPending || fileRequest.current || !ProjectAgentConfigFileSchema.safeParse(file).success) return false;
    const creating = content !== undefined;
    const runtime = captureRuntimeGeneration();
    const controller = new AbortController();
    fileRequest.current = controller;
    setOpeningFile(true);
    setFileError(null);
    const current = () => {
      const connection = useConnection.getState();
      return !controller.signal.aborted && isCurrentRuntimeGeneration(runtime) && connection.api === api
        && connection.runtimeSlot === runtimeSlot && connection.authGeneration === authGeneration;
    };
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
    read={api ? read : null}
    onOpenFiles={api ? onOpenFiles : undefined}
    onOpenFile={api ? file => { void openFile(file); } : undefined}
    onCreateFile={api ? openFile : undefined}
    filesPending={filesPending || openingFile}
    filesError={fileError}
    onOpenMcpSettings={openMcpSettings}
  />;
}
