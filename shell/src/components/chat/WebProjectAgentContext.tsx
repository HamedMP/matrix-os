"use client";

import { ProjectAgentConfigFileSchema } from "@matrix-os/contracts";
import { ProjectAgentContextPanel } from "@matrix-os/ui";
import {
  PROJECT_AGENT_CONTEXT_FILE_ERROR,
  PROJECT_AGENT_CONTEXT_OPEN_FILE_ERROR,
  PROJECT_AGENT_CONTEXT_RESPONSE_LIMIT,
  projectAgentContextFileLocationRequest,
  projectAgentContextFilesPath,
} from "@matrix-os/ui/project-agent-context";
import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import { useFileBrowser } from "@/hooks/useFileBrowser";
import { usePreviewWindow } from "@/hooks/usePreviewWindow";
import { getGatewayUrl } from "@/lib/gateway";
import { ShellFileAuthority } from "@/components/file-browser/ShellFileAuthority";
import type { WebProject } from "./web-projects";

export const WebProjectAgentContextNavigation = createContext<{
  openFiles: () => void;
  openPreview?: () => void;
  openMcpSettings: () => void;
} | null>(null);

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Project context response missing");
  try {
    let bytes = 0;
    let body = "";
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return JSON.parse(body + decoder.decode()) as unknown;
      bytes += chunk.value.byteLength;
      if (bytes > PROJECT_AGENT_CONTEXT_RESPONSE_LIMIT) {
        await reader.cancel();
        throw new Error("Project context response too large");
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function request(gatewayUrl: string, path: string, signal: AbortSignal, init?: RequestInit): Promise<Response> {
  return fetch(`${gatewayUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
}

interface WebProjectAgentContextProps {
  gatewayUrl: string;
  identity: string;
  project: WebProject;
  isCurrentAuthority?: () => boolean;
}

export function WebProjectAgentContext(props: WebProjectAgentContextProps) {
  return <ShellFileAuthority>{(authority, shellGateway) => {
    const scope = JSON.stringify([props.identity, authority, props.gatewayUrl, props.project.id, props.project.slug]);
    return <WebProjectAgentContextScoped key={scope} {...props} shellGateway={shellGateway} authority={authority} scope={scope} />;
  }}</ShellFileAuthority>;
}

function WebProjectAgentContextScoped({ gatewayUrl, project, isCurrentAuthority, shellGateway, authority, scope }: WebProjectAgentContextProps & {
  shellGateway: string;
  authority: string;
  scope: string;
}) {
  const navigation = useContext(WebProjectAgentContextNavigation);
  const filesRequest = useRef<AbortController | null>(null);
  const [filesPending, setFilesPending] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  useLayoutEffect(() => () => filesRequest.current?.abort(), []);

  const read = useCallback(async (path: string, signal: AbortSignal) => {
    if (isCurrentAuthority && !isCurrentAuthority()) return null;
    const response = await request(gatewayUrl, path, signal);
    if ([403, 404].includes(response.status)) return null;
    if (!response.ok) throw new Error("Project context request failed");
    const result = await readJson(response);
    return isCurrentAuthority && !isCurrentAuthority() ? null : result;
  }, [gatewayUrl, isCurrentAuthority]);

  // The existing Files store is bound to the mounted OS view's gateway.
  // A separately routed chat must not send a folder path to that computer.
  const currentShell = gatewayUrl.replace(/\/$/, "") === shellGateway;
  const openFiles = async (file?: string, content?: string): Promise<boolean> => {
    if (!navigation || filesRequest.current || !currentShell || (isCurrentAuthority && !isCurrentAuthority())) return false;
    if (file && (!navigation.openPreview || !ProjectAgentConfigFileSchema.safeParse(file).success)) return false;
    const creating = file !== undefined && content !== undefined;
    const controller = new AbortController();
    filesRequest.current = controller;
    setFilesPending(true);
    setFilesError(null);
    const current = () => !controller.signal.aborted && (isCurrentAuthority?.() ?? true)
      && gatewayUrl.replace(/\/$/, "") === getGatewayUrl();
    try {
      const lookup = projectAgentContextFileLocationRequest(project.slug, project.id, creating ? undefined : file);
      const response = await request(gatewayUrl, lookup, controller.signal);
      if (!response.ok) throw new Error("Project files location unavailable");
      const location = projectAgentContextFilesPath(await readJson(response));
      if (!current()) return false;
      if (!location || (file && !creating && !location.endsWith(`/${file}`))) throw new Error("Invalid project files location");
      const path = creating ? `${location}/${file}` : location;
      if (creating) {
        const created = await request(gatewayUrl, "/api/files/touch", controller.signal, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, content, projectId: project.id, projectFile: file }),
        });
        if (!created.ok) throw new Error("File could not be created");
        if (!current()) return false;
      }
      if (file && navigation.openPreview) {
        usePreviewWindow.getState().openFile(path, { authority, mode: "source" });
        navigation.openPreview();
      } else {
        useFileBrowser.getState().requestView("files", { path, identity: authority });
        navigation.openFiles();
      }
      return true;
    } catch (error: unknown) {
      if (current()) {
        console.warn("[project-context] Files location unavailable:", error instanceof Error ? error.name : "UnknownError");
        if (!creating) setFilesError(file ? PROJECT_AGENT_CONTEXT_OPEN_FILE_ERROR : PROJECT_AGENT_CONTEXT_FILE_ERROR);
      }
      return false;
    } finally {
      if (filesRequest.current === controller) filesRequest.current = null;
      if (current()) setFilesPending(false);
    }
  };

  return <ProjectAgentContextPanel scope={scope} projectId={project.id} read={read}
    onOpenFiles={navigation && currentShell ? () => { void openFiles(); } : undefined}
    onOpenFile={navigation?.openPreview && currentShell ? file => { void openFiles(file); } : undefined}
    onCreateFile={navigation?.openPreview && currentShell ? openFiles : undefined}
    filesPending={filesPending} filesError={filesError}
    onOpenMcpSettings={navigation && currentShell ? navigation.openMcpSettings : undefined} />;
}
