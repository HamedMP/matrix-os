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
  /** Null until the server has created the workflow, so Cancel can still abort the start request. */
  operationId: string | null;
  authorizationUrl: string | null;
  controller: AbortController;
}

export interface OnboardingAiConnect {
  signInCode: string | null;
  signInNeedsCode: boolean;
  startSignIn: (provider: OnboardingAiProvider) => void;
  reopenSignIn: () => void;
  cancelSignIn: () => void;
  submitKey: (provider: OnboardingAiProvider, key: string) => void;
  submitCode: (code: string) => void;
}

function cancelOperation(client: Pick<ReturnType<typeof createDesktopProviderWorkflowClient>, "cancel">, operationId: string) {
  void client.cancel(operationId, AbortSignal.timeout(10_000)).catch((error: unknown) => {
    console.warn("[onboarding-widget] AI sign-in cancel failed:", error instanceof Error ? error.name : typeof error);
  });
}

/** Drives the Claude / ChatGPT connection workflows behind the widget's Change AI panel. */
export function useOnboardingAiConnect(api: ApiClient | null, dispatch: (event: OnboardingWidgetEvent) => void): OnboardingAiConnect {
  const identityKey = useConnection((state) => desktopProviderIdentityKey(state));
  const invalidateProviderCatalog = useConnection((state) => state.invalidateProviderCatalog);
  const isIdentityCurrent = useCallback(() => desktopProviderIdentityKey(useConnection.getState()) === identityKey, [identityKey]);
  const client = useMemo(() => (api ? createDesktopProviderWorkflowClient(api, isIdentityCurrent) : null), [api, isIdentityCurrent]);
  const active = useRef<ActiveSignIn | null>(null);
  const [signInCode, setSignInCode] = useState<string | null>(null);
  const [signInNeedsCode, setSignInNeedsCode] = useState(false);

  const clearSignIn = useCallback(() => {
    active.current = null;
    setSignInCode(null);
    setSignInNeedsCode(false);
  }, []);

  const finish = useCallback((provider: OnboardingAiProvider, harnessInstanceId: string, succeeded: boolean) => {
    clearSignIn();
    if (!isIdentityCurrent()) return;
    if (succeeded) {
      invalidateProviderCatalog(identityKey, [harnessInstanceId]);
      dispatch({ type: "ai.connected", provider });
    } else {
      dispatch({ type: "ai.failed" });
    }
  }, [clearSignIn, dispatch, identityKey, invalidateProviderCatalog, isIdentityCurrent]);

  useEffect(() => () => active.current?.controller.abort(), []);

  const startSignIn = useCallback((provider: OnboardingAiProvider) => {
    if (!client) { dispatch({ type: "ai.failed" }); return; }
    active.current?.controller.abort();
    const controller = new AbortController();
    const signIn: ActiveSignIn = { operationId: null, authorizationUrl: null, controller };
    active.current = signIn;
    void (async () => {
      const rows = await client.capabilities(controller.signal);
      const target = pickProviderConnectionOption(rows, provider, "account", { codeEntry: Boolean(client.submitCode) });
      if (controller.signal.aborted) return;
      if (!target || !client.startConnection) {
        clearSignIn();
        if (isIdentityCurrent()) dispatch({ type: "ai.needsSettings" });
        return;
      }
      const { method, ...request } = target;
      const operation = await client.startConnection({ ...request, idempotencyKey: canonicalChatRequestId() }, controller.signal);
      if (controller.signal.aborted) {
        cancelOperation(client, operation.id);
        return;
      }
      signIn.operationId = operation.id;
      signIn.authorizationUrl = operation.authorizationUrl;
      setSignInCode(operation.deviceCode);
      setSignInNeedsCode(method === "browser");
      if (operation.authorizationUrl) await openDesktopProviderWorkflowAuthorization(operation.authorizationUrl);
      const deadline = Date.now() + MAX_WAIT_MS;
      let state = operation.state;
      while (!TERMINAL_STATES.has(state) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (controller.signal.aborted) return;
        const next = await client.get(operation.id, controller.signal);
        state = next.state;
        if (active.current === signIn) {
          signIn.authorizationUrl = next.authorizationUrl;
          setSignInCode(next.deviceCode);
        }
      }
      if (controller.signal.aborted) return;
      finish(provider, target.harnessInstanceId, state === "succeeded");
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("[onboarding-widget] AI sign-in failed:", error instanceof Error ? error.name : typeof error);
      clearSignIn();
      if (isIdentityCurrent()) dispatch({ type: "ai.failed" });
    });
  }, [clearSignIn, client, dispatch, finish, isIdentityCurrent]);

  const submitCode = useCallback((code: string) => {
    const current = active.current;
    if (!client?.submitCode || !current?.operationId) { dispatch({ type: "ai.failed" }); return; }
    void client.submitCode(current.operationId, code, AbortSignal.timeout(30_000)).catch((error: unknown) => {
      if (active.current !== current) return;
      console.warn("[onboarding-widget] AI sign-in code failed:", error instanceof Error ? error.name : typeof error);
      current.controller.abort();
      clearSignIn();
      if (isIdentityCurrent()) dispatch({ type: "ai.failed" });
    });
  }, [clearSignIn, client, dispatch, isIdentityCurrent]);

  const reopenSignIn = useCallback(() => {
    const url = active.current?.authorizationUrl;
    if (url) void openDesktopProviderWorkflowAuthorization(url);
  }, []);

  const cancelSignIn = useCallback(() => {
    const current = active.current;
    clearSignIn();
    dispatch({ type: "ai.cancelled" });
    if (!current) return;
    current.controller.abort();
    if (client && current.operationId) cancelOperation(client, current.operationId);
  }, [clearSignIn, client, dispatch]);

  const submitKey = useCallback((provider: OnboardingAiProvider, key: string) => {
    if (!client) { dispatch({ type: "ai.failed" }); return; }
    const signal = AbortSignal.timeout(30_000);
    void (async () => {
      const target = pickProviderConnectionOption(await client.capabilities(signal), provider, "api_key");
      if (!target || !client.submitConnectionKey) {
        if (isIdentityCurrent()) dispatch({ type: "ai.needsSettings" });
        return;
      }
      await client.submitConnectionKey({ ...target, apiKey: key }, signal);
      finish(provider, target.harnessInstanceId, true);
    })().catch((error: unknown) => {
      console.warn("[onboarding-widget] AI key save failed:", error instanceof Error ? error.name : typeof error);
      if (isIdentityCurrent()) dispatch({ type: "ai.failed" });
    });
  }, [client, dispatch, finish, isIdentityCurrent]);

  return { signInCode, signInNeedsCode, startSignIn, reopenSignIn, cancelSignIn, submitKey, submitCode };
}
