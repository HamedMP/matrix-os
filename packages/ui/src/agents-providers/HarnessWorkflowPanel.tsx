import { type ReactNode, useEffect, useRef, useState } from "react";
import type {
  ProviderHarnessInstance,
  ProviderWorkflow,
  ProviderWorkflowCapability,
} from "@matrix-os/contracts";
import { ProviderWorkflowClientError } from "./provider-workflow-client.js";
import { useDialogFocus } from "./use-dialog-focus.js";
import type { ProviderWorkflowClient } from "./types.js";

const active = (operation: ProviderWorkflow | null) =>
  operation?.state === "pending" || operation?.state === "running";
const providerNames = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
};

/** Ephemeral foreground state is scoped to this exact harness and transport lifetime. */
export function HarnessWorkflowPanel({
  harness,
  capability,
  client,
  disabled,
  onRefresh,
  onOpenTerminal,
  onOpenAuthorizationUrl,
  onDisconnect,
  onStateChange,
  onSetupHarness,
  operationId = null,
  onOperationId,
  renderConnection,
}: {
  harness: Pick<
    ProviderHarnessInstance,
    "id" | "harness" | "displayName" | "installState" | "authState"
  >;
  capability: ProviderWorkflowCapability;
  client: ProviderWorkflowClient;
  disabled: boolean;
  onRefresh: () => void;
  onOpenTerminal: (reference: string) => void;
  onOpenAuthorizationUrl?: (url: string) => void;
  onDisconnect?: () => Promise<boolean | void>;
  onSetupHarness?: (
    harness: ProviderHarnessInstance["harness"],
  ) => Promise<boolean>;
  onStateChange?: (status: string | null) => void;
  operationId?: string | null;
  onOperationId?: (id: string | null) => void;
  renderConnection?: (changeAccountAction: ReactNode) => ReactNode;
}) {
  const [operation, setOperation] = useState<ProviderWorkflow | null>(null);
  const [method, setMethod] = useState<"key" | "account" | null>(null);
  const [providerId, setProviderId] = useState(
    capability.apiKeyProviders[0] ?? "openai",
  );
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ at: string; event: string }[] | null>(
    null,
  );
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [uninstall, setUninstall] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const scope = useRef<AbortController | null>(null);
  const pendingStart = useRef<{
    kind: "login" | "install" | "uninstall";
    method?: "device_code" | "terminal";
    idempotencyKey: string;
  } | null>(null);
  const dialog = useRef<HTMLElement | null>(null);
  useDialogFocus(dialog, disconnectOpen, () => {
    if (!pending) setDisconnectOpen(false);
  });
  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    pendingStart.current = null;
    setApiKey("");
    setMethod(null);
    setOperation(null);
    setPending(false);
    setFailure(null);
    setLogs(null);
    setDisconnectOpen(false);
    setUninstall(false);
    setCopied(false);
    setProviderId(capability.apiKeyProviders[0] ?? "openai");
    return () => {
      controller.abort();
      scope.current = null;
      onStateChange?.(null);
    };
  }, [client, harness.id]);
  useEffect(() => {
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
  }, [operationId, client, harness.id]);
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
  const start = (kind: "login" | "install" | "uninstall") =>
    run(async (signal) => {
      const loginMethod =
        kind === "login"
          ? capability.loginMethods.includes("device_code")
            ? "device_code"
            : "terminal"
          : undefined;
      if (
        !pendingStart.current ||
        pendingStart.current.kind !== kind ||
        pendingStart.current.method !== loginMethod
      ) {
        pendingStart.current = {
          kind,
          ...(loginMethod ? { method: loginMethod } : {}),
          idempotencyKey: crypto.randomUUID(),
        };
      }
      const result = await client.start(
        { harnessInstanceId: harness.id, ...pendingStart.current },
        signal,
      );
      if (result.harnessInstanceId !== harness.id || result.kind !== kind)
        throw new Error("workflow scope mismatch");
      if (!signal.aborted) {
        pendingStart.current = null;
        setOperation(result);
        onOperationId?.(result.id);
        if (kind === "login") setMethod("account");
        if (
          result.terminalSessionId &&
          (kind !== "login" || !result.deviceCode)
        )
          onOpenTerminal(result.terminalSessionId);
      }
    });
  useEffect(() => {
    onStateChange?.(
      pending || active(operation)
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
  }, [pending, operation, failure]);
  useEffect(() => {
    if (!active(operation)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await client.get(operation!.id, controller.signal);
        if (controller.signal.aborted) return;
        if (
          next.id !== operation!.id ||
          next.harnessInstanceId !== harness.id ||
          next.kind !== operation!.kind
        )
          throw new Error("workflow scope mismatch");
        setOperation(next);
        setNow(Date.now());
        if (next.state === "succeeded") {
          onOperationId?.(null);
          setMethod(null);
          setApiKey("");
          onRefresh();
        } else if (active(next)) timer = setTimeout(poll, 2000);
      } catch (caught) {
        if (!controller.signal.aborted) {
          console.warn(
            "[provider-settings] Workflow status failed:",
            caught instanceof Error ? caught.name : typeof caught,
          );
          setFailure("Connection status is unavailable. Check again.");
        }
      }
    };
    timer = setTimeout(poll, 2000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [operation?.id, operation?.state, client]);
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
  const hasSubscription =
    harness.harness === "codex" || harness.harness === "claude";
  const subscriptionName =
    harness.harness === "codex"
      ? "ChatGPT"
      : harness.harness === "claude"
        ? "Claude"
        : harness.displayName;
  const back = () => {
    pendingStart.current = null;
    onOperationId?.(null);
    setMethod(null);
    setApiKey("");
    setFailure(null);
    setOperation(null);
  };

  const changeAccountAction =
    harness.authState === "authenticated" &&
    (capability.loginMethods.length || capability.apiKeyProviders.length) ? (
      <button
        type="button"
        className="matrix-ap-button"
        disabled={disabled || pending}
        onClick={() =>
          setMethod(capability.loginMethods.length ? "account" : "key")
        }
      >
        Change account
      </button>
    ) : null;

  return (
    <section
      className="matrix-ap-workflow"
      aria-label={`${harness.displayName} connection`}
      aria-busy={pending}
    >
      {renderConnection?.(changeAccountAction)}
      {failure ? (
        <p role="alert" className="matrix-ap-notice" data-tone="danger">
          {failure}
        </p>
      ) : null}
      {harness.installState === "missing" ||
      harness.installState === "installing" ||
      (harness.installState === "failed" && capability.install) ||
      operation?.kind === "install" ? (
        <div className="matrix-ap-install">
          {connecting ? (
            <>
              <p>Installing {harness.displayName}…</p>
              <progress aria-label={`Installing ${harness.displayName}`} />
              <p className="matrix-ap-help">
                The installation runs in Terminal.
              </p>
            </>
          ) : (
            <p className="matrix-ap-help">
              Not on this computer yet. Install it to get started.
            </p>
          )}
          {capability.install && !connecting ? (
            <button
              type="button"
              className="matrix-ap-button matrix-ap-button-primary"
              disabled={disabled || pending}
              onClick={() => void start("install")}
            >
              Install
            </button>
          ) : null}
        </div>
      ) : (
        <>
          {harness.authState === "expired" && !connecting ? (
            <div className="matrix-ap-notice" data-tone="warning">
              <span>Sign-in expired. Reconnect to continue.</span>
              {capability.loginMethods.length ? (
                <button
                  type="button"
                  className="matrix-ap-button"
                  disabled={disabled || pending}
                  onClick={() => void start("login")}
                >
                  Reconnect
                </button>
              ) : null}
            </div>
          ) : null}
          {(capability.loginMethods.length > 0 ||
            capability.apiKeyProviders.length > 0) &&
          (harness.authState !== "authenticated" ||
            method !== null ||
            failed) ? (
            <>
              <h3>Connect {harness.displayName} with</h3>
              <div className="matrix-ap-connection-options">
                {capability.loginMethods.length ? (
                  <button
                    type="button"
                    className="matrix-ap-connection-choice"
                    aria-pressed={method === "account"}
                    disabled={disabled || pending || connecting}
                    onClick={() => void start("login")}
                  >
                    {method === "account" ? (
                      <span
                        aria-hidden="true"
                        className="matrix-ap-method-check"
                      >
                        ✓
                      </span>
                    ) : null}
                    <strong>
                      {hasSubscription
                        ? `${subscriptionName} account`
                        : "Provider account"}{" "}
                      {hasSubscription ? (
                        <span className="matrix-ap-selected-tag">
                          Recommended
                        </span>
                      ) : null}
                    </strong>
                    <span>
                      {hasSubscription
                        ? `Use your ${subscriptionName} plan`
                        : "Sign in through this agent’s Terminal"}
                    </span>
                  </button>
                ) : null}
                {capability.apiKeyProviders.length ? (
                  <button
                    type="button"
                    className="matrix-ap-connection-choice"
                    aria-pressed={method === "key"}
                    disabled={disabled || pending || connecting}
                    onClick={() => {
                      pendingStart.current = null;
                      setMethod("key");
                      setOperation(null);
                      setFailure(null);
                    }}
                  >
                    {method === "key" ? (
                      <span
                        aria-hidden="true"
                        className="matrix-ap-method-check"
                      >
                        ✓
                      </span>
                    ) : null}
                    <strong>API key</strong>
                    <span>Pay your provider per request</span>
                  </button>
                ) : null}
              </div>
            </>
          ) : null}
          {method === "key" ? (
            <form
              className="matrix-ap-key-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!apiKey.trim()) return;
                void run(async (signal) => {
                  await client.submitKey(
                    {
                      harnessInstanceId: harness.id,
                      providerId,
                      apiKey: apiKey.trim(),
                    },
                    signal,
                  );
                  if (!signal.aborted) {
                    setApiKey("");
                    setMethod(null);
                    onRefresh();
                  }
                });
              }}
            >
              {capability.apiKeyProviders.length > 1 ? (
                <label className="matrix-ap-field">
                  <span>Provider</span>
                  <select
                    value={providerId}
                    disabled={pending || disabled}
                    onChange={(event) => {
                      setProviderId(event.target.value as typeof providerId);
                      setApiKey("");
                      setFailure(null);
                    }}
                  >
                    {capability.apiKeyProviders.map((id) => (
                      <option key={id} value={id}>
                        {providerNames[id]}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="matrix-ap-field">
                <span>Paste your {providerNames[providerId]} API key</span>
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={4096}
                  value={apiKey}
                  disabled={pending || disabled}
                  aria-invalid={Boolean(failure)}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
              <p className="matrix-ap-help">
                Create a key in your provider dashboard. It stays on this
                computer.
              </p>
              {pending ? <p role="status">Checking your key…</p> : null}
              <div className="matrix-ap-workflow-actions">
                <button
                  type="submit"
                  className="matrix-ap-button matrix-ap-button-primary"
                  disabled={pending || disabled || !apiKey.trim()}
                >
                  {pending ? "Connecting…" : failure ? "Try again" : "Connect"}
                </button>
                <button
                  type="button"
                  className="matrix-ap-button"
                  disabled={pending}
                  onClick={back}
                >
                  Back
                </button>
              </div>
            </form>
          ) : null}
          {operation?.kind === "login" && connecting ? (
            <div className="matrix-ap-device-login">
              <h3>Finish signing in to {subscriptionName}</h3>
              {operation.deviceCode ? (
                <div className="matrix-ap-device-code">
                  <code>{operation.deviceCode}</code>
                  <button
                    type="button"
                    className="matrix-ap-button"
                    onClick={() =>
                      void run(async (signal) => {
                        await navigator.clipboard.writeText(
                          operation.deviceCode!,
                        );
                        if (!signal.aborted) setCopied(true);
                      })
                    }
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              ) : null}
              {operation.authorizationUrl && onOpenAuthorizationUrl ? (
                <button
                  type="button"
                  className="matrix-ap-button matrix-ap-button-primary"
                  disabled={seconds === 0}
                  onClick={() =>
                    void run(async () => {
                      onOpenAuthorizationUrl?.(operation.authorizationUrl!);
                    })
                  }
                >
                  Open sign-in page
                </button>
              ) : null}
              <p role="status" className="matrix-ap-help">
                Waiting for sign-in.{" "}
                {seconds > 0
                  ? `Code expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.`
                  : "Checking expiration…"}
              </p>
            </div>
          ) : null}
        </>
      )}
      {failed ? (
        <div className="matrix-ap-notice" data-tone="danger" role="alert">
          <span>
            {operation.state === "expired"
              ? "The sign-in code expired."
              : operation.kind === "install"
                ? "Installation couldn't complete. Try again."
                : operation.kind === "uninstall"
                  ? "Uninstall couldn't complete. Try again."
                  : "Couldn't connect. Try again."}
          </span>
          <button
            type="button"
            className="matrix-ap-button"
            disabled={disabled || pending}
            onClick={() => void start(operation.kind)}
          >
            Try again
          </button>
          <button type="button" className="matrix-ap-button" onClick={back}>
            {operation.kind === "login" ? "Choose another way" : "Back"}
          </button>
        </div>
      ) : null}
      <div className="matrix-ap-workflow-actions">
        {harness.installState === "installed" &&
        harness.authState !== "authenticated" &&
        capability.loginMethods.length === 0 &&
        capability.apiKeyProviders.length === 0 &&
        onSetupHarness ? (
          <button
            type="button"
            className="matrix-ap-button"
            disabled={disabled || pending}
            onClick={() =>
              void run(async () => {
                if ((await onSetupHarness(harness.harness)) === false)
                  throw new Error("setup unavailable");
              })
            }
          >
            Connect {harness.displayName} in Terminal
          </button>
        ) : null}
        {failure && connecting ? (
          <button
            type="button"
            className="matrix-ap-button"
            disabled={pending || disabled}
            onClick={() =>
              void run(async (signal) => {
                const next = await client.get(operation!.id, signal);
                if (
                  next.id !== operation!.id ||
                  next.harnessInstanceId !== harness.id
                )
                  throw new Error("workflow scope mismatch");
                if (!signal.aborted) {
                  setOperation(next);
                  if (next.state === "succeeded") onRefresh();
                }
              })
            }
          >
            Check connection
          </button>
        ) : null}
        {connecting && operation?.kind !== "uninstall" ? (
          <button
            type="button"
            className="matrix-ap-button"
            disabled={pending || disabled}
            onClick={() =>
              void run(async (signal) => {
                const result = await client.cancel(operation!.id, signal);
                if (
                  result.id !== operation!.id ||
                  result.harnessInstanceId !== harness.id
                )
                  throw new Error("workflow scope mismatch");
                if (!signal.aborted) {
                  setOperation(result);
                  if (["cancelled", "succeeded"].includes(result.state)) {
                    pendingStart.current = null;
                    onOperationId?.(null);
                    onRefresh();
                  }
                }
              })
            }
          >
            Cancel
          </button>
        ) : null}
        {operation?.terminalSessionId ? (
          <button
            type="button"
            className="matrix-ap-link-button"
            onClick={() =>
              void run(async () => {
                onOpenTerminal(operation.terminalSessionId!);
              })
            }
          >
            Continue in Terminal
          </button>
        ) : null}
        {capability.logs ? (
          <button
            type="button"
            className="matrix-ap-link-button"
            disabled={pending}
            onClick={() =>
              void run(async (signal) => {
                const result = await client.logs(harness.id, signal);
                if (!signal.aborted) setLogs(result.entries);
              })
            }
          >
            View logs
          </button>
        ) : null}
        {onDisconnect && harness.authState === "authenticated" ? (
          <button
            type="button"
            className="matrix-ap-link-button"
            disabled={disabled || pending}
            onClick={() => {
              setDisconnectOpen(true);
              setUninstall(false);
            }}
          >
            Disconnect
          </button>
        ) : null}
        {!renderConnection ? changeAccountAction : null}
      </div>
      {logs !== null ? (
        <section
          className="matrix-ap-operation-logs"
          aria-label="Connection logs"
        >
          <h3>Connection logs</h3>
          {logs.length ? (
            <ol>
              {logs.map((entry, index) => (
                <li key={index}>
                  <time dateTime={entry.at}>
                    {new Date(entry.at).toLocaleString()}
                  </time>{" "}
                  · {entry.event}
                </li>
              ))}
            </ol>
          ) : (
            <p className="matrix-ap-help">No connection activity yet.</p>
          )}
          <button
            type="button"
            className="matrix-ap-link-button"
            onClick={() => setLogs(null)}
          >
            Close logs
          </button>
        </section>
      ) : null}
      {disconnectOpen ? (
        <div className="matrix-ap-dialog-backdrop">
          <section
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="matrix-ap-disconnect-title"
            className="matrix-ap-dialog"
          >
            <h3 id="matrix-ap-disconnect-title">
              Disconnect {harness.displayName}?
            </h3>
            <p className="matrix-ap-dialog-copy">
              This signs the agent out on this computer. Your chats, projects
              and settings stay.
            </p>
            {capability.uninstall ? (
              <label className="matrix-ap-uninstall-choice">
                <input
                  type="checkbox"
                  checked={uninstall}
                  onChange={(event) => setUninstall(event.target.checked)}
                  disabled={pending}
                />
                Also uninstall {harness.displayName}
                <span>You can install it again later.</span>
              </label>
            ) : null}
            <div className="matrix-ap-dialog-actions">
              <button
                type="button"
                className="matrix-ap-button"
                disabled={pending}
                onClick={() => setDisconnectOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="matrix-ap-button matrix-ap-button-danger"
                disabled={pending || disabled}
                onClick={() =>
                  void run(async (signal) => {
                    if ((await onDisconnect?.()) === false)
                      throw new Error("disconnect failed");
                    if (signal.aborted) return;
                    if (uninstall) {
                      const result = await client.start(
                        {
                          harnessInstanceId: harness.id,
                          kind: "uninstall",
                          idempotencyKey: crypto.randomUUID(),
                        },
                        signal,
                      );
                      if (
                        result.harnessInstanceId !== harness.id ||
                        result.kind !== "uninstall"
                      )
                        throw new Error("workflow scope mismatch");
                      if (!signal.aborted) {
                        setOperation(result);
                        onOperationId?.(result.id);
                      }
                    }
                    if (!signal.aborted) {
                      setDisconnectOpen(false);
                      onRefresh();
                    }
                  })
                }
              >
                Disconnect
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
