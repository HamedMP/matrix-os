import type { HarnessWorkflowController } from "./use-harness-workflow-controller.js";
const providerNames = { openai: "OpenAI", anthropic: "Anthropic", openrouter: "OpenRouter" };
export function WorkflowKeyForm({ state }: { state: HarnessWorkflowController }) {
  const { selectedOption, harness, capability, client, disabled, onRefresh, method, setMethod, providerId, setProviderId, apiKey, setApiKey, pending, failure, setFailure, run, back } = state;
  return <>
          {method === "key" ? (
            <form
              className="matrix-ap-key-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!apiKey.trim()) return;
                void run(async (signal) => {
                  if (capability.connectionOptions) {
                    if (!selectedOption || !client.submitConnectionKey || !capability.connectionOptions.some(item =>
                      item.id === selectedOption.id && item.availability === "available" && item.authKind === "api_key")) throw new Error("connection unavailable");
                    await client.submitConnectionKey({harnessInstanceId: harness.id, optionId: selectedOption.id, apiKey: apiKey.trim()}, signal);
                  } else {
                    await client.submitKey({harnessInstanceId: harness.id, providerId, apiKey: apiKey.trim()}, signal);
                  }
                  if (!signal.aborted) {
                    setApiKey("");
                    setMethod(null);
                    onRefresh();
                  }
                });
              }}
            >
              {!capability.connectionOptions && capability.apiKeyProviders.length > 1 ? (
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
  </>;
}

export function WorkflowLoginProgress({ state }: { state: HarnessWorkflowController }) {
  const { client, disabled, onOpenAuthorizationUrl, operation, authorizationCode, setAuthorizationCode, codeSubmitted, setCodeSubmitted, pending, copied, setCopied, run, seconds, connecting, browserLogin, subscriptionName } = state;
  return <>
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
              {browserLogin && operation.authorizationUrl ? (
                <form className="matrix-ap-key-form" onSubmit={event => {
                  event.preventDefault();
                  if (!authorizationCode.trim() || codeSubmitted) return;
                  void run(async signal => {
                    await client.submitCode!(operation.id, authorizationCode.trim(), signal);
                    if (!signal.aborted) { setAuthorizationCode(""); setCodeSubmitted(true); }
                  });
                }}>
                  <label className="matrix-ap-field">
                    <span>Paste the sign-in code</span>
                    <input type="password" autoComplete="off" spellCheck={false} maxLength={4096}
                      value={authorizationCode} disabled={pending || codeSubmitted}
                      onChange={event => setAuthorizationCode(event.target.value)} />
                  </label>
                  <p className="matrix-ap-help">If the sign-in page gives you a code, paste it here to finish connecting.</p>
                  <button type="submit" className="matrix-ap-button matrix-ap-button-primary"
                    disabled={disabled || pending || codeSubmitted || !authorizationCode.trim()}>
                    {codeSubmitted ? "Finishing sign-in…" : "Finish connecting"}
                  </button>
                </form>
              ) : null}
              <p role="status" className="matrix-ap-help">
                Waiting for sign-in.{" "}
                {seconds > 0
                  ? `Code expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.`
                  : "Checking expiration…"}
              </p>
            </div>
          ) : null}
  </>;
}

export function WorkflowDisconnectDialog({ state }: { state: HarnessWorkflowController }) {
  const { harness, capability, client, disabled, onRefresh, onDisconnect, onOperationId, setOperation, pending, setFailure, disconnectOpen, setDisconnectOpen, uninstall, setUninstall, dialog, run, start, failed } = state;
  return <>
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
              This disconnects the agent from Matrix on this computer. Your
              saved account login stays available for other agents. Your chats,
              projects and settings stay.
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
                onClick={() => {
                  setDisconnectOpen(false);
                  setFailure(null);
                }}
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
  </>;
}
