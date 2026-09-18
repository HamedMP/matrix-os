"use client";

import { useAuth } from "@clerk/nextjs";
import { ChatCollaboration } from "@matrix-os/ui";
import { useMemo } from "react";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { createShellCollaborationApi } from "@/lib/collaboration";

const e2eBypass = process.env.NEXT_PUBLIC_E2E_TEST_BYPASS === "1";

export function ShellSharedTerminal({ scopeId }: { scopeId: string }) {
  const { isLoaded, userId } = useAuth();
  const browserOrigin = useBrowserOrigin();
  const api = useMemo(
    () => browserOrigin ? createShellCollaborationApi(browserOrigin) : null,
    [browserOrigin],
  );
  const actorId = userId ?? (e2eBypass ? "user_e2e" : null);

  if ((!isLoaded && !e2eBypass) || !browserOrigin) {
    return <p role="status" className="p-8">Loading shared terminal…</p>;
  }
  if (!actorId || !api) {
    return <div role="alert" className="m-auto max-w-lg rounded-2xl border p-8 text-center">
      Shared terminals require an authenticated Matrix account.
    </div>;
  }
  return <div data-slot="native-shared-terminal" className="flex min-h-0 flex-1 overflow-hidden">
    <ChatCollaboration view={{ kind: "terminal", scopeId }} api={api} actorId={actorId} />
  </div>;
}
