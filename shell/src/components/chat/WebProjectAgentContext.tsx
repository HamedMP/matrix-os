"use client";

import { PROJECT_SKILL_FILE_MAX_BYTES, ProjectAgentConfigFileSchema } from "@matrix-os/contracts";
import { ProjectAgentContextPanel } from "@matrix-os/ui";
import {
  PROJECT_AGENT_CONTEXT_FILE_ERROR,
  PROJECT_AGENT_CONTEXT_OPEN_FILE_ERROR,
  PROJECT_AGENT_CONTEXT_RESPONSE_LIMIT,
  PROJECT_INSTALLED_SKILLS_PATH,
  PROJECT_INSTALLED_SKILLS_RESPONSE_LIMIT,
  parseProjectInstalledSkills,
  projectInstalledSkillFilePath,
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

async function readText(response: Response, maxBytes: number, preserveBom = false): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Project context response missing");
  try {
    let bytes = 0;
    let body = "";
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: preserveBom });
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return body + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("Project context response too large");
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function readJson(response: Response, maxBytes = PROJECT_AGENT_CONTEXT_RESPONSE_LIMIT): Promise<unknown> {
  return JSON.parse(await readText(response, maxBytes)) as unknown;
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
  const isCurrentShell = () => currentShell && gatewayUrl.replace(/\/$/, "") === getGatewayUrl()
    && (isCurrentAuthority?.() ?? true);
  const readSkillSource = async <T,>(path: string, signal: AbortSignal, decode: (response: Response) => Promise<T>) => {
    if (signal.aborted || !isCurrentShell()) throw new Error("Skill source unavailable");
    const response = await request(gatewayUrl, path, signal, { redirect: "error" });
    if (!response.ok) throw new Error("Skill source unavailable");
    const result = await decode(response);
    if (signal.aborted || !isCurrentShell()) throw new Error("Skill source unavailable");
    return result;
  };
  const loadInstalledSkills = async (signal: AbortSignal) => parseProjectInstalledSkills(await readSkillSource(
    PROJECT_INSTALLED_SKILLS_PATH, signal, response => readJson(response, PROJECT_INSTALLED_SKILLS_RESPONSE_LIMIT),
  ));
  const readInstalledSkill = async (file: string, signal: AbortSignal) => {
    const path = projectInstalledSkillFilePath(file);
    if (!path) throw new Error("Invalid skill source");
    return readSkillSource(path, signal, response => readText(response, PROJECT_SKILL_FILE_MAX_BYTES, true));
  };
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
        usePreviewWindow.getState().openFile(path, { authority, mode: "source", focus: true });
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
    loadInstalledSkills={currentShell ? loadInstalledSkills : undefined}
    readInstalledSkill={currentShell ? readInstalledSkill : undefined}
    filesPending={filesPending} filesError={filesError}
    onOpenMcpSettings={navigation && currentShell ? navigation.openMcpSettings : undefined} />;
}
