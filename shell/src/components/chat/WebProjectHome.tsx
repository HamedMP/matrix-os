"use client";

import { FolderOpen } from "@/lib/hugeicons";
import { WebProjectAgentContext } from "./WebProjectAgentContext";
import type { WebProject } from "./web-projects";

export function WebProjectHome({ project, gatewayUrl, identity, isCurrentAuthority }: {
  project: WebProject;
  gatewayUrl: string;
  identity: string;
  isCurrentAuthority?: () => boolean;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-slot="chat-project-home">
      <div className="mx-auto w-full max-w-[808px] px-6 pb-4 pt-5">
        <div className="mb-5 flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-hover)] text-foreground">
            <FolderOpen size={20} aria-hidden />
          </span>
          <h1 className="truncate text-[26px] font-medium leading-[31px] text-foreground" style={{ fontFamily: "var(--font-heading)" }}>
            {project.name}
          </h1>
        </div>
        <WebProjectAgentContext project={project} gatewayUrl={gatewayUrl} identity={identity} isCurrentAuthority={isCurrentAuthority} />
      </div>
    </div>
  );
}
