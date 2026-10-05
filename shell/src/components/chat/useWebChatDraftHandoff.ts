"use client";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import type { CanonicalChatResourceReference } from "@matrix-os/contracts";
import type { StartAgentChat } from "@matrix-os/ui";
import { getGatewayUrl } from "@/lib/gateway";
import {
  isSelfHostedRuntime,
  SELF_HOSTED_SHELL_USER_ID,
} from "@/lib/self-host-mode";
import {
  applicableCompanyDriveDraft,
  useCompanyDriveChatDraft,
} from "@/stores/company-drive-chat-draft";
import { organizationDriveNavigationIdentity } from "@/stores/organization-drive-navigation";
type Request = NonNullable<
  ReturnType<typeof useCompanyDriveChatDraft.getState>["request"]
>;
export function useWebChatDraftHandoff({
  scope,
  active = true,
  sessionId,
  resources,
  startDraft,
}: {
  scope: string;
  active?: boolean;
  sessionId?: string;
  resources: readonly CanonicalChatResourceReference[];
  startDraft: (...args: Parameters<StartAgentChat>) => {
    id: number;
    scope: string;
  };
}) {
  const { userId, sessionId: authSessionId } = useAuth();
  const identity = organizationDriveNavigationIdentity(
    isSelfHostedRuntime() ? SELF_HOSTED_SHELL_USER_ID : userId,
    isSelfHostedRuntime() ? undefined : authSessionId,
    getGatewayUrl(),
  );
  const request = useCompanyDriveChatDraft((state) => state.request);
  const [appliedId, setAppliedId] = useState<number | null>(null);
  const dispatched = useRef<string | null>(null);
  const paused = useRef<string | null>(null);
  const pending = useRef<{
    request: Request;
    id: number;
    scope: string;
    originScope: string;
    entered: boolean;
  } | null>(null);
  useEffect(() => {
    if (!active || !request) {
      pending.current = null;
      dispatched.current = null;
      paused.current = null;
      setAppliedId(null);
      return;
    }
    if (useCompanyDriveChatDraft.getState().request !== request) return;
    if (!applicableCompanyDriveDraft(request, identity)) {
      useCompanyDriveChatDraft.getState().consume(request);
      pending.current = null;
      dispatched.current = null;
      paused.current = null;
      return;
    }
    if (pending.current && pending.current.request !== request) {
      pending.current = null;
      dispatched.current = null;
      paused.current = null;
    }
    const previous = pending.current;
    if (previous?.scope === scope) previous.entered = true;
    if (
      previous && previous.scope !== scope &&
      (previous.entered || previous.originScope !== scope)
    ) {
      // Navigation cancels this delivery, not the unconsumed owner intent.
      pending.current = null;
      dispatched.current = null;
      paused.current = request.id;
      setAppliedId(null);
      return;
    }
    // Do not pull the owner back out of the conversation they just selected.
    // Reactivating Chat or choosing a new draft permits another delivery.
    if (paused.current === request.id && sessionId) return;
    if (dispatched.current === request.id) return;
    paused.current = null;
    dispatched.current = request.id;
    setAppliedId(null);
    const target = startDraft("", request.references ?? [request.reference]);
    pending.current = {
      request, ...target, originScope: scope, entered: target.scope === scope,
    };
  }, [active, request, identity, startDraft, scope, sessionId]);
  useEffect(() => {
    const target = pending.current;
    if (
      !active ||
      !target ||
      appliedId !== target.id ||
      target.scope !== scope ||
      sessionId ||
      !applicableCompanyDriveDraft(target.request, identity)
    )
      return;
    const expected = target.request.references ?? [target.request.reference];
    if (JSON.stringify(resources) !== JSON.stringify(expected)) return;
    // A post-commit observation proves the reference composer accepted this handoff.
    useCompanyDriveChatDraft.getState().consume(target.request);
    pending.current = null;
  }, [active, appliedId, scope, sessionId, resources, identity]);
  return {
    identity,
    acknowledge(id: number) {
      const target = pending.current;
      if (target?.id === id && target.scope === scope && !sessionId)
        setAppliedId(id);
    },
  };
}
