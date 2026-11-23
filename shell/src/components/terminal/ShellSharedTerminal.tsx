"use client";

import { ChatCollaboration } from "@matrix-os/ui";
import { useMemo } from "react";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { useShellAuthIdentity } from "@/lib/shell-auth-identity";
import { useCollaborationOrganization } from "@/lib/collaboration-organization-state";
import { createShellCollaborationApi } from "@/lib/collaboration";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";

const e2eBypass = process.env.NEXT_PUBLIC_E2E_TEST_BYPASS === "1";
const COLLABORATION_LAYERS = { dialog: SHELL_Z_INDEX.appDialog, popover: SHELL_Z_INDEX.popover };

export function ShellSharedTerminal({ scopeId }: { scopeId: string }) {
  const { isLoaded, userId } = useShellAuthIdentity();
  const browserOrigin = useBrowserOrigin();
  const { status: organizationStatus } = useCollaborationOrganization();
  const api = useMemo(
    () => browserOrigin ? createShellCollaborationApi(browserOrigin) : null,
    [browserOrigin],
  );
  const actorId = userId ?? (e2eBypass ? "user_e2e" : null);

  if ((!isLoaded && !e2eBypass) || !browserOrigin) {
    return <p role="status" className="p-8">Loading shared terminal…</p>;
  }
  // Same rule as shared Chats: without an organization (always the case on
  // self-hosted computers) there is nothing to share the terminal through.
  if (organizationStatus === "none") {
    return <div role="alert" className="m-auto max-w-lg rounded-2xl border p-8 text-center">
      Organization sharing is no longer available for this account.
    </div>;
  }
  if (!actorId || !api) {
    return <div role="alert" className="m-auto max-w-lg rounded-2xl border p-8 text-center">
      Shared terminals require an authenticated Matrix account.
    </div>;
  }
  return <div data-slot="native-shared-terminal" className="flex min-h-0 flex-1 overflow-hidden">
    <ChatCollaboration view={{ kind: "terminal", scopeId }} api={api} actorId={actorId} layers={COLLABORATION_LAYERS} />
  </div>;
}
