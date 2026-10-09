import type { OnboardingAiProvider, OnboardingWidgetEvent } from "@matrix-os/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api";
import { desktopProviderIdentityKey } from "../../lib/provider-settings-identity";
import { useConnection } from "../../stores/connection";
import { canonicalChatRequestId } from "../chat/canonical-chat-submission";
import { createDesktopProviderWorkflowClient, openDesktopProviderWorkflowAuthorization } from "../settings/provider-workflow-transport";
import { pickProviderConnectionOption } from "./onboarding-widget-runner";

const POLL_MS = 2_000;
const MAX_WAIT_MS = 10 * 60 * 1000;
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "expired"]);

interface ActiveSignIn {
  operationId: string;
  authorizationUrl: string | null;
  controller: AbortController;
}

export interface OnboardingAiConnect {
  signInCode: string | null;
  startSignIn: (provider: OnboardingAiProvider) => void;
  reopenSignIn: () => void;
  cancelSignIn: () => void;
  submitKey: (provider: OnboardingAiProvider, key: string) => void;
}

/** Drives the Claude / ChatGPT connection workflows behind the widget's Change AI panel. */
export function useOnboardingAiConnect(api: ApiClient | null, dispatch: (event: OnboardingWidgetEvent) => void): OnboardingAiConnect {
  const identityKey = useConnection((state) => desktopProviderIdentityKey(state));
  const invalidateProviderCatalog = useConnection((state) => state.invalidateProviderCatalog);
  const isIdentityCurrent = useCallback(() => desktopProviderIdentityKey(useConnection.getState()) === identityKey, [identityKey]);
  const client = useMemo(() => (api ? createDesktopProviderWorkflowClient(api, isIdentityCurrent) : null), [api, isIdentityCurrent]);
  const active = useRef<ActiveSignIn | null>(null);
  const [signInCode, setSignInCode] = useState<string | null>(null);

  const finish = useCallback((provider: OnboardingAiProvider, harnessInstanceId: string, succeeded: boolean) => {
    active.current = null;
    setSignInCode(null);
    if (!isIdentityCurrent()) return;
    if (succeeded) {
      invalidateProviderCatalog(identityKey, [harnessInstanceId]);
      dispatch({ type: "ai.connected", provider });
    } else {
      dispatch({ type: "ai.failed" });
    }
  }, [dispatch, identityKey, invalidateProviderCatalog, isIdentityCurrent]);

  useEffect(() => () => active.current?.controller.abort(), []);

  const startSignIn = useCallback((provider: OnboardingAiProvider) => {
    if (!client) { dispatch({ type: "ai.failed" }); return; }
    active.current?.controller.abort();
    const controller = new AbortController();
    void (async () => {
      const target = pickProviderConnectionOption(await client.capabilities(controller.signal), provider, "account");
      if (!target || !client.startConnection) throw new Error("No sign-in option");
      const operation = await client.startConnection({ ...target, idempotencyKey: canonicalChatRequestId() }, controller.signal);
      active.current = { operationId: operation.id, authorizationUrl: operation.authorizationUrl, controller };
      setSignInCode(operation.deviceCode);
      if (operation.authorizationUrl) await openDesktopProviderWorkflowAuthorization(operation.authorizationUrl);
      const deadline = Date.now() + MAX_WAIT_MS;
      let state = operation.state;
      while (!TERMINAL_STATES.has(state) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (controller.signal.aborted) return;
        const next = await client.get(operation.id, controller.signal);
        state = next.state;
        if (active.current?.operationId === operation.id) {
          active.current.authorizationUrl = next.authorizationUrl;
          setSignInCode(next.deviceCode);
        }
      }
      if (controller.signal.aborted) return;
      finish(provider, target.harnessInstanceId, state === "succeeded");
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("[onboarding-widget] AI sign-in failed:", error instanceof Error ? error.name : typeof error);
      active.current = null;
      setSignInCode(null);
      if (isIdentityCurrent()) dispatch({ type: "ai.failed" });
    });
  }, [client, dispatch, finish, isIdentityCurrent]);

  const reopenSignIn = useCallback(() => {
    const url = active.current?.authorizationUrl;
    if (url) void openDesktopProviderWorkflowAuthorization(url);
  }, []);

  const cancelSignIn = useCallback(() => {
    const current = active.current;
    active.current = null;
    setSignInCode(null);
    dispatch({ type: "ai.cancelled" });
    if (!current || !client) return;
    current.controller.abort();
    void client.cancel(current.operationId, AbortSignal.timeout(10_000)).catch((error: unknown) => {
      console.warn("[onboarding-widget] AI sign-in cancel failed:", error instanceof Error ? error.name : typeof error);
    });
  }, [client, dispatch]);

  const submitKey = useCallback((provider: OnboardingAiProvider, key: string) => {
    if (!client) { dispatch({ type: "ai.failed" }); return; }
    const signal = AbortSignal.timeout(30_000);
    void (async () => {
      const target = pickProviderConnectionOption(await client.capabilities(signal), provider, "api_key");
      if (!target || !client.submitConnectionKey) throw new Error("No key option");
      await client.submitConnectionKey({ ...target, apiKey: key }, signal);
      finish(provider, target.harnessInstanceId, true);
    })().catch((error: unknown) => {
      console.warn("[onboarding-widget] AI key save failed:", error instanceof Error ? error.name : typeof error);
      if (isIdentityCurrent()) dispatch({ type: "ai.failed" });
    });
  }, [client, dispatch, finish, isIdentityCurrent]);

  return { signInCode, startSignIn, reopenSignIn, cancelSignIn, submitKey };
}
