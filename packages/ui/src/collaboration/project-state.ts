import type {
  CollaborationProjectInventory,
  CollaborationProjectInventoryItem,
  CollaborationProjectMembershipEffect,
  CollaborationScope,
} from "@matrix-os/contracts";

export type ProjectPresentationState = {
  canConfirm: boolean;
  isAvailable: boolean;
  statusLabel: string;
  blockerMessages: string[];
};

const KIND_LABELS: Record<CollaborationProjectInventoryItem["kind"], string> = {
  app: "app",
  chat: "Chat",
  file: "file",
  layout: "layout",
  terminal: "terminal",
};

export function deriveProjectPresentation(
  scope: CollaborationScope,
  inventory: CollaborationProjectInventory,
): ProjectPresentationState {
  const blockerMessages = inventory.blockers.map((blocker) =>
    `${blocker.id} must be made shareable before the whole project can be shared.`,
  );
  const isOwnerPreparing = scope.role === "owner"
    && (scope.lifecycle === "private" || scope.lifecycle === "preparing");
  return {
    canConfirm: isOwnerPreparing && blockerMessages.length === 0,
    isAvailable: scope.lifecycle !== "deleting" && scope.lifecycle !== "deleted",
    statusLabel: projectLifecycleLabel(scope.lifecycle),
    blockerMessages,
  };
}

export function projectInventoryItemLabel(item: CollaborationProjectInventoryItem): string {
  return `${KIND_LABELS[item.kind]}: ${item.id}`;
}

export function projectMembershipEffectLabel(effect: CollaborationProjectMembershipEffect): string {
  const name = effect.actor.displayName;
  switch (effect.effect) {
    case "join_project":
      return `${name} joins the whole project as ${effect.role}.`;
    case "end_item_grant":
      return `${name}'s standalone ${effect.resourceKind === "chat" ? "Chat" : "terminal"} access ends. ${name} is not added to the project.`;
    case "retain_item_only":
      return `${name} keeps standalone access only to ${effect.resourceId}.`;
  }
}

function projectLifecycleLabel(lifecycle: CollaborationScope["lifecycle"]): string {
  switch (lifecycle) {
    case "private": return "Private project";
    case "preparing": return "Preparing project sharing";
    case "shared": return "Shared project";
    case "archived": return "Archived shared project";
    case "deleting": return "Deleting shared project";
    case "deleted": return "Deleted project";
    case "recovering": return "Recovering project sharing";
  }
}
