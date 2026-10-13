import type { OnboardingAiProvider, OnboardingWidgetEvent } from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderWorkflowClient } from "../../agents-providers/types.js";
import { pickProviderConnectionOption } from "./catalog.js";
import { onboardingRequestId } from "./chat-port.js";

const POLL_MS = 2_000;
const MAX_WAIT_MS = 10 * 60 * 1000;
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "expired"]);

export interface OnboardingAiConnectPort {
  client: Pick<ProviderWorkflowClient, "capabilities" | "startConnection" | "submitConnectionKey" | "get" | "cancel" | "submitCode">;
  openAuthorization(url: string): unknown;
  /** False once the signed-in owner or runtime changed under an in-flight sign-in. */
  isIdentityCurrent(): boolean;
  /** Refresh whatever provider catalog the host renders from. */
  onConnected(harnessInstanceId: string): void;
}

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
  /** Stops a sign-in or key save whose panel was closed some other way, without touching the widget. */
  abandonSignIn: () => void;
  submitKey: (provider: OnboardingAiProvider, key: string) => void;
  submitCode: (code: string) => void;
}

function cancelOperation(client: OnboardingAiConnectPort["client"], operationId: string) {
  void client.cancel(operationId, AbortSignal.timeout(10_000)).catch((error: unknown) => {
    console.warn("[onboarding-widget] AI sign-in cancel failed:", error instanceof Error ? error.name : typeof error);
  });
}

/** Drives the Claude / ChatGPT connection workflows behind the widget's Change AI panel. */
export function useOnboardingAiConnect(
  port: OnboardingAiConnectPort | null,
  dispatch: (event: OnboardingWidgetEvent) => void,
): OnboardingAiConnect {
  const active = useRef<ActiveSignIn | null>(null);
  const keySave = useRef<object | null>(null);
  const [signInCode, setSignInCode] = useState<string | null>(null);
  const [signInNeedsCode, setSignInNeedsCode] = useState(false);

  const clearSignIn = useCallback(() => {
    active.current = null;
    setSignInCode(null);
    setSignInNeedsCode(false);
  }, []);

  const finish = useCallback((provider: OnboardingAiProvider, harnessInstanceId: string, succeeded: boolean) => {
    clearSignIn();
    if (!port?.isIdentityCurrent()) return;
    if (succeeded) {
      port.onConnected(harnessInstanceId);
      dispatch({ type: "ai.connected", provider });
    } else {
      dispatch({ type: "ai.failed" });
    }
  }, [clearSignIn, dispatch, port]);

  useEffect(() => () => active.current?.controller.abort(), []);

  const startSignIn = useCallback((provider: OnboardingAiProvider) => {
    if (!port) { dispatch({ type: "ai.failed" }); return; }
    const { client } = port;
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
        if (port.isIdentityCurrent()) dispatch({ type: "ai.needsSettings" });
        return;
      }
      const { method, ...request } = target;
      const operation = await client.startConnection({ ...request, idempotencyKey: onboardingRequestId() }, controller.signal);
      if (controller.signal.aborted) {
        cancelOperation(client, operation.id);
        return;
      }
      signIn.operationId = operation.id;
      signIn.authorizationUrl = operation.authorizationUrl;
      setSignInCode(operation.deviceCode);
      setSignInNeedsCode(method === "browser");
      if (operation.authorizationUrl) await port.openAuthorization(operation.authorizationUrl);
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
      if (port.isIdentityCurrent()) dispatch({ type: "ai.failed" });
    });
  }, [clearSignIn, dispatch, finish, port]);

  const submitCode = useCallback((code: string) => {
    const current = active.current;
    if (!port?.client.submitCode || !current?.operationId) { dispatch({ type: "ai.failed" }); return; }
    void port.client.submitCode(current.operationId, code, AbortSignal.timeout(30_000)).catch((error: unknown) => {
      if (active.current !== current) return;
      console.warn("[onboarding-widget] AI sign-in code failed:", error instanceof Error ? error.name : typeof error);
      current.controller.abort();
      clearSignIn();
      if (port.isIdentityCurrent()) dispatch({ type: "ai.failed" });
    });
  }, [clearSignIn, dispatch, port]);

  const reopenSignIn = useCallback(() => {
    const url = active.current?.authorizationUrl;
    if (url && port) void port.openAuthorization(url);
  }, [port]);

  const abandonSignIn = useCallback(() => {
    keySave.current = null;
    const current = active.current;
    if (!current) return;
    clearSignIn();
    current.controller.abort();
    if (port && current.operationId) cancelOperation(port.client, current.operationId);
  }, [clearSignIn, port]);

  const cancelSignIn = useCallback(() => {
    abandonSignIn();
    dispatch({ type: "ai.cancelled" });
  }, [abandonSignIn, dispatch]);

  const submitKey = useCallback((provider: OnboardingAiProvider, key: string) => {
    if (!port) { dispatch({ type: "ai.failed" }); return; }
    const { client } = port;
    const attempt = {};
    keySave.current = attempt;
    const isCurrent = () => keySave.current === attempt;
    const signal = AbortSignal.timeout(30_000);
    void (async () => {
      const target = pickProviderConnectionOption(await client.capabilities(signal), provider, "api_key");
      if (!target || !client.submitConnectionKey) {
        if (!isCurrent()) return;
        keySave.current = null;
        if (port.isIdentityCurrent()) dispatch({ type: "ai.needsSettings" });
        return;
      }
      await client.submitConnectionKey({ ...target, apiKey: key }, signal);
      if (!isCurrent()) {
        // The key is stored, but the user has moved on, so only the catalog learns about it.
        if (port.isIdentityCurrent()) port.onConnected(target.harnessInstanceId);
        return;
      }
      keySave.current = null;
      finish(provider, target.harnessInstanceId, true);
    })().catch((error: unknown) => {
      console.warn("[onboarding-widget] AI key save failed:", error instanceof Error ? error.name : typeof error);
      if (!isCurrent()) return;
      keySave.current = null;
      if (port.isIdentityCurrent()) dispatch({ type: "ai.failed" });
    });
  }, [dispatch, finish, port]);

  return { signInCode, signInNeedsCode, startSignIn, reopenSignIn, cancelSignIn, abandonSignIn, submitKey, submitCode };
}
