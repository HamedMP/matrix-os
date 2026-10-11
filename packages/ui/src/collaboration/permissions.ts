import type { CollaborationScope } from "@matrix-os/contracts";

export interface ChatPermissionPresentation {
  roleLabel: "Owner" | "Editor" | "Viewer";
  canDiscuss: boolean;
  canManageMembers: boolean;
  canRequestAi: boolean;
  composerExplanation: string;
  aiExplanation: string;
}

export function deriveChatPermissions(scope: CollaborationScope): ChatPermissionPresentation {
  const canDiscuss = scope.lifecycle === "shared"
    && scope.capabilities.discuss
    && (scope.role === "owner" || scope.role === "editor");
  const canRequestAi = scope.lifecycle === "shared"
    && scope.capabilities.requestAi
    && (scope.role === "owner" || scope.role === "editor");
  return {
    roleLabel: scope.role === "owner" ? "Owner" : scope.role === "editor" ? "Editor" : "Viewer",
    canDiscuss,
    canManageMembers: scope.lifecycle === "shared" && scope.role === "owner" && scope.capabilities.manageMembers,
    canRequestAi,
    composerExplanation: canDiscuss
      ? "Messages are shared with everyone in this Chat."
      : "Viewers can read this Chat but cannot post messages.",
    aiExplanation: canRequestAi
      ? `${scope.role === "owner" ? "Owners" : "Editors"} can request AI when the owner runtime is available.`
      : scope.role === "viewer"
        ? "Viewers cannot request AI."
        : "AI requests are unavailable until the owner runtime is ready.",
  };
}
