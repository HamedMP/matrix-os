import type { KernelConversationContextProjection } from "@matrix-os/contracts";
import { ChatProjectContextPicker, type ChatProjectListStatus } from "@matrix-os/ui";
import { useEffect, useState } from "react";
import { useBoard } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useUi } from "../../stores/ui";

export interface ConversationContextPickerProps {
  context: KernelConversationContextProjection | null;
  disabled?: boolean;
  kind?: "project" | "repository";
  onSelect: (projectId: string) => void;
  onRemove: () => void;
  triggerLabel?: string;
  triggerText?: string;
  compact?: boolean;
}

/** Electron Desktop's project picker: the shared picker fed by the board store. */
export default function ConversationContextPicker(props: ConversationContextPickerProps) {
  const api = useConnection((state) => state.api);
  const projects = useBoard((state) => state.projects);
  const loadProjects = useBoard((state) => state.loadProjects);
  const openCreateProject = useUi((state) => state.openCreateProject);
  const [open, setOpen] = useState(false);
  const [listStatus, setListStatus] = useState<ChatProjectListStatus>("idle");
  const activeProjects = projects.filter((project) => !project.archivedAt).map((project) => ({
    id: project.id,
    slug: project.slug,
    name: project.name,
    kind: project.kind,
    repository: project.github ? `${project.github.owner}/${project.github.repo}` : null,
  }));

  useEffect(() => {
    if (!open) return;
    if (!api) {
      setListStatus("idle");
      return;
    }
    if (activeProjects.length > 0) {
      setListStatus("ready");
      return;
    }

    let current = true;
    setListStatus("loading");
    void (async () => {
      const loaded = await loadProjects(api);
      if (current) setListStatus(loaded ? "ready" : "error");
    })();
    return () => {
      current = false;
    };
  }, [activeProjects.length, api, loadProjects, open]);

  const retryProjects = async () => {
    if (!api) return;
    setListStatus("loading");
    const loaded = await loadProjects(api);
    setListStatus(loaded ? "ready" : "error");
  };

  return (
    <ChatProjectContextPicker
      {...props}
      projects={activeProjects}
      listStatus={api ? listStatus : "disconnected"}
      onOpenChange={setOpen}
      onRetry={() => void retryProjects()}
      onCreateProject={openCreateProject}
    />
  );
}
