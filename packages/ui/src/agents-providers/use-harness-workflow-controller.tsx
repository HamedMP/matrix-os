import { type ReactNode, useEffect, useRef, useState } from "react";
import type {
  ProviderHarnessInstance,
  ProviderAccessSource,
  ProviderWorkflow,
  ProviderWorkflowConnectionOption,
} from "@matrix-os/contracts";
import { ProviderWorkflowClientError } from "./provider-workflow-client.js";
import { hasConfiguredConnection } from "./harness-connection.js";
import { managedConnectionCapability } from "./managed-connection-capability.js";
import { useWorkflowPolling } from "./use-workflow-polling.js";
import { useDialogFocus } from "./use-dialog-focus.js";
import type { ProviderWorkflowClient, ProviderWorkflowUICapability, ProviderWorkflowUIOperation } from "./types.js";

const active = (operation: ProviderWorkflow | null) =>
  operation?.state === "pending" || operation?.state === "running";
/** Ephemeral foreground state is scoped to this exact harness and transport lifetime. */
export type HarnessWorkflowPanelProps = {
  harness: Pick<
    ProviderHarnessInstance,
    "id" | "harness" | "displayName" | "installState" | "authState"
  > & Partial<Pick<ProviderHarnessInstance, "enabled" | "configuredEnabled" | "localObservation" | "selectedAccountId">>;
  source?: ProviderAccessSource;
  capability: ProviderWorkflowUICapability;
  client: ProviderWorkflowClient;
  disabled: boolean;
  onRefresh: () => void;
  onOpenTerminal: (reference: string) => void;
  onOpenAuthorizationUrl?: (url: string) => void;
  onConnectSaved?: () => Promise<void>;
  connectSavedDisabled?: boolean;
  onDisconnect?: () => Promise<boolean | void>;
  onSetupHarness?: (
    harness: ProviderHarnessInstance["harness"],
  ) => Promise<boolean>;
  onStateChange?: (status: string | null) => void;
  operationId?: string | null;
  onOperationId?: (id: string | null) => void;
  renderConnection?: (changeAccountAction: ReactNode) => ReactNode;
  renderAccountActions?: (disabled: boolean) => ReactNode;
  advancedConfiguration?: ReactNode;
  connectRequest?: number;
};

export function useHarnessWorkflowController({
  harness,
  source,
  capability: advertisedCapability,
  client,
  disabled,
  onRefresh,
  onOpenTerminal,
  onOpenAuthorizationUrl,
  onConnectSaved,
  connectSavedDisabled = false,
  onDisconnect,
  onStateChange,
  operationId = null,
  onOperationId,
  renderConnection,
  renderAccountActions,
  advancedConfiguration,
  connectRequest = 0,
}: HarnessWorkflowPanelProps) {
  const capability = managedConnectionCapability(advertisedCapability);
  const [operation, setOperation] = useState<ProviderWorkflowUIOperation | null>(null);
  const [selectedOption, setSelectedOption] = useState<ProviderWorkflowConnectionOption | null>(null);
  const [method, setMethod] = useState<"key" | "account" | null>(null);
  const [providerId, setProviderId] = useState(
    capability.apiKeyProviders[0] ?? "openai",
  );
  const [authorizationCode, setAuthorizationCode] = useState("");
  const [codeSubmitted, setCodeSubmitted] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const connected = hasConfiguredConnection(harness, source);
  const previousConnection = useRef(connected);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [uninstall, setUninstall] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [seenConnectRequest, setSeenConnectRequest] = useState(connectRequest);
  const connectionPanel = useRef<HTMLElement | null>(null);
  if (seenConnectRequest !== connectRequest) {
    setSeenConnectRequest(connectRequest);
    if (!active(operation) && !pending) setMethod("account");
  }
  useEffect(() => {
    if (connectRequest > 0 && method === "account" && !active(operation) && !pending) {
      connectionPanel.current?.querySelector<HTMLButtonElement>(".matrix-ap-method-card:not(:disabled)")?.focus({ preventScroll: true });
    }
  }, [connectRequest, method, operation, pending]);
  const scope = useRef<AbortController | null>(null);
  const receiptScope = useRef({ client, harnessId: harness.id, accountId: harness.selectedAccountId, sourceId: source?.id });
  const pendingStart = useRef<{
    kind: "login" | "install" | "uninstall";
    method?: "device_code" | "terminal" | "existing_codex" | "browser";
    optionId?: string;
    idempotencyKey: string;
  } | null>(null);
  const dialog = useRef<HTMLElement | null>(null);
  useDialogFocus(dialog, disconnectOpen, () => {
    if (!pending) {
      setDisconnectOpen(false);
      setFailure(null);
    }
  });
  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    pendingStart.current = null;
    setSelectedOption(null);
    setApiKey("");
    setAuthorizationCode("");
    setCodeSubmitted(false);
    setMethod(null);
    setOperation(null);
    setPending(false);
    setFailure(null);
    previousConnection.current = connected;
    setDisconnectOpen(false);
    setUninstall(false);
    setCopied(false);
    setProviderId(capability.apiKeyProviders[0] ?? "openai");
    return () => {
      controller.abort();
      scope.current = null;
      onStateChange?.(null);
    };
  }, [client, harness.id, harness.selectedAccountId, source?.id]);
  useEffect(() => {
    const previous = receiptScope.current;
    receiptScope.current = { client, harnessId: harness.id, accountId: harness.selectedAccountId, sourceId: source?.id };
    if (previous.client !== client || previous.harnessId !== harness.id
      || previous.accountId !== harness.selectedAccountId || previous.sourceId !== source?.id) {
      // The parent's remembered receipt belongs to the old account scope.
      // Do not re-read it under the newly selected connection.
      onOperationId?.(null);
      return;
    }
    if (!operationId || operation?.id === operationId) return;
    const controller = new AbortController();
    void client
      .get(operationId, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (value.id !== operationId || value.harnessInstanceId !== harness.id)
          throw new Error("workflow scope mismatch");
        setOperation(value);
        if (value.kind === "login" && active(value)) setMethod("account");
        if (["succeeded", "cancelled"].includes(value.state)) {
          onOperationId?.(null);
          onRefresh();
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          console.warn(
            "[provider-settings] Workflow resume failed:",
            caught instanceof Error ? caught.name : typeof caught,
          );
          setFailure("Connection status is unavailable. Check again.");
        }
      });
    return () => controller.abort();
  }, [operationId, client, harness.id, harness.selectedAccountId, source?.id]);
  useEffect(() => {
    if (operation?.state && !["pending", "running"].includes(operation.state)) {
      setAuthorizationCode("");
      setCodeSubmitted(false);
    }
  }, [operation?.state]);
  const live = (controller: AbortController) =>
    !controller.signal.aborted && scope.current === controller;
  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    const controller = scope.current;
    if (!controller || pending || disabled) return;
    setPending(true);
    setFailure(null);
    try {
      await action(controller.signal);
    } catch (caught) {
      if (live(controller)) {
        console.warn(
          "[provider-settings] Workflow action failed:",
          caught instanceof Error ? caught.name : typeof caught,
        );
        setFailure(
          method === "key"
            ? caught instanceof ProviderWorkflowClientError &&
              caught.reason === "rejected"
              ? "The key could not be verified. Check it and try again."
              : "Could not confirm the connection. Check its status before trying again."
            : "The connection could not be updated. Try again.",
        );
        if (
          method === "key" &&
          !(
            caught instanceof ProviderWorkflowClientError &&
            caught.reason === "rejected"
          )
        )
          onRefresh();
      }
    } finally {
      if (live(controller)) setPending(false);
    }
  };
  const start = (kind: "login" | "install" | "uninstall", terminal = false, option?: ProviderWorkflowConnectionOption) =>
    run(async (signal) => {
      if (kind === "login" && harness.harness !== "claude") throw new Error("connection unavailable");
      const exactOption = option ?? (kind === "login" ? selectedOption ?? operation?.connectionOption ?? undefined : undefined);
      if (kind === "login" && capability.connectionOptions && (!exactOption || !client.startConnection
        || !capability.connectionOptions.some(item => item.id === exactOption.id && item.availability === "available" && item.authKind === "subscription")))
        throw new Error("connection unavailable");
      const loginMethod = exactOption?.method ?? (
        kind === "login"
          ? terminal ? "terminal" : capability.loginMethods.includes("browser")
            ? "browser"
            : capability.loginMethods.includes("existing_codex")
            ? "existing_codex"
            : capability.loginMethods.includes("device_code")
            ? "device_code"
            : "terminal"
          : undefined);
      if (
        !pendingStart.current ||
        pendingStart.current.kind !== kind ||
        pendingStart.current.method !== loginMethod || pendingStart.current.optionId !== exactOption?.id
      ) {
        pendingStart.current = {
          kind,
          ...(loginMethod ? { method: loginMethod } : {}),
          ...(exactOption ? {optionId: exactOption.id} : {}),
          idempotencyKey: crypto.randomUUID(),
        };
      }
      const result = exactOption ? await client.startConnection!({harnessInstanceId: harness.id,
        optionId: exactOption.id, idempotencyKey: pendingStart.current.idempotencyKey}, signal)
        : await client.start({harnessInstanceId: harness.id, kind, method: loginMethod,
          idempotencyKey: pendingStart.current.idempotencyKey}, signal);
      if (exactOption && result.connectionOption?.id !== exactOption.id) throw new Error("workflow scope mismatch");
      if (result.harnessInstanceId !== harness.id || result.kind !== kind)
        throw new Error("workflow scope mismatch");
      if (!signal.aborted) {
        pendingStart.current = null;
        setOperation(result);
        onOperationId?.(result.id);
        if (kind === "login") setMethod(result.state === "succeeded" ? null : "account");
        if (result.state === "succeeded") {
          onOperationId?.(null);
          onRefresh();
        }
        if (
          result.terminalSessionId &&
          (kind !== "login" || loginMethod === "terminal")
        )
          onOpenTerminal(result.terminalSessionId);
      }
    });
  useEffect(() => {
    // A failed receipt can outlive a successfully completed native login. Only
    // reconcile a newly confirmed connection; a failed replacement of an
    // already connected account must remain visible.
    if (pending || active(operation)) return;
    if (connected && !previousConnection.current && operation?.kind === "login"
      && (operation.state === "failed" || operation.state === "expired")) {
      setOperation(null);
      setFailure(null);
      setMethod(null);
      onOperationId?.(null);
    }
    previousConnection.current = connected;
  }, [connected, pending, operation, onOperationId]);
  useEffect(() => {
    onStateChange?.(
      disconnectOpen ? null : pending || active(operation)
        ? operation?.kind === "install"
          ? "Installing"
          : operation?.kind === "uninstall"
            ? "Uninstalling"
            : "Connecting"
        : failure ||
            operation?.state === "failed" ||
            operation?.state === "expired"
          ? "Couldn't connect"
          : null,
    );
  }, [pending, operation, failure, disconnectOpen]);
  const { stop: stopPolling, restart: restartPolling } = useWorkflowPolling({ operation, client, harnessId: harness.id,
    onFailure: () => setFailure("Connection status is unavailable. Check again."),
    onUpdate: next => {
      setOperation(next);
      setFailure(null);
      setNow(Date.now());
      if (next.state === "succeeded") {
        onOperationId?.(null);
        setMethod(null);
        setApiKey("");
        onRefresh();
      }
    },
  });
  useEffect(() => {
    if (!active(operation)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [operation?.id, operation?.state]);
  const failed =
    operation?.state === "failed" || operation?.state === "expired";
  const seconds = operation
    ? Math.max(0, Math.ceil((Date.parse(operation.expiresAt) - now) / 1000))
    : 0;
  const connecting = active(operation);
  const reuseCodex = capability.loginMethods.includes("existing_codex");
  const browserLogin = harness.harness === "claude" && (operation?.connectionOption ? operation.connectionOption.method === "browser" : capability.loginMethods.includes("browser")) && !!client.submitCode;
  const inlineLogin = capability.loginMethods.includes("device_code") || reuseCodex || browserLogin;
  const hasSubscription =
    harness.harness === "codex" || harness.harness === "claude";
  const subscriptionProvider = operation?.connectionOption?.providerId ?? selectedOption?.providerId;
  const subscriptionName = subscriptionProvider ? {openai: "ChatGPT", anthropic: "Claude", openrouter: "OpenRouter"}[subscriptionProvider] :
    harness.harness === "codex"
      ? "ChatGPT"
      : harness.harness === "claude"
        ? "Claude"
        : harness.displayName;
  const back = () => {
    pendingStart.current = null;
    onOperationId?.(null);
    setMethod(null);
    setSelectedOption(null);
    setApiKey("");
    setAuthorizationCode("");
    setCodeSubmitted(false);
    setFailure(null);
    setOperation(null);
  };

  return { selectedOption, setSelectedOption, harness, source, capability, client, disabled, onRefresh, onOpenTerminal, onOpenAuthorizationUrl, onConnectSaved, connectSavedDisabled, onDisconnect, onStateChange, operationId, onOperationId, renderConnection, renderAccountActions, advancedConfiguration, connectRequest, operation, setOperation, method, setMethod, providerId, setProviderId, authorizationCode, setAuthorizationCode, codeSubmitted, setCodeSubmitted, apiKey, setApiKey, pending, failure, setFailure, connected, disconnectOpen, setDisconnectOpen, uninstall, setUninstall, copied, setCopied, connectionPanel, pendingStart, dialog, run, start, stopPolling, restartPolling, failed, seconds, connecting, reuseCodex, browserLogin, inlineLogin, hasSubscription, subscriptionName, back };
}
export type HarnessWorkflowController = ReturnType<typeof useHarnessWorkflowController>;
