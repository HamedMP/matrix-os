import type { CollaborationScope } from "@matrix-os/contracts";

export interface ChatPermissionPresentation {
  roleLabel: "Owner" | "Editor" | "Viewer";
  canDiscuss: boolean;
  canManageMembers: boolean;
  canRequestAi: false;
  composerExplanation: string;
  aiExplanation: string;
}

export function deriveChatPermissions(scope: CollaborationScope): ChatPermissionPresentation {
  const canDiscuss = scope.lifecycle === "shared"
    && scope.capabilities.discuss
    && (scope.role === "owner" || scope.role === "editor");
  return {
    roleLabel: scope.role === "owner" ? "Owner" : scope.role === "editor" ? "Editor" : "Viewer",
    canDiscuss,
    canManageMembers: scope.lifecycle === "shared" && scope.role === "owner" && scope.capabilities.manageMembers,
    canRequestAi: false,
    composerExplanation: canDiscuss
      ? "Messages are shared with everyone in this Chat."
      : "Viewers can read this Chat but cannot post messages.",
    aiExplanation: "AI requests are unavailable in shared Chats during this milestone.",
  };
}
