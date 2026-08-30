import {
  AgentsProvidersView,
  useProviderSettingsController,
} from "@matrix-os/ui";
import "@matrix-os/ui/agents-providers.css";
import { useCallback, useMemo, useState } from "react";
import type { ApiClient } from "../../lib/api";
import { useConnection } from "../../stores/connection";
import {
  createDesktopProviderSettingsTransport,
  desktopProviderIdentityKey,
  openExistingProviderTerminalSession,
  openProviderAuthorizationPath,
} from "./provider-settings-desktop-adapter";

const ACTION_ERROR = "Provider action is unavailable. Refresh and try again.";

function ProviderSettingsUnavailable({
  signedOut,
  failed = false,
  onRetry,
}: {
  signedOut: boolean;
  failed?: boolean;
  onRetry?: () => void;
}) {
  return (
    <div className="matrix-agents-providers">
      <header className="matrix-ap-page-head">
        <div>
          <span className="matrix-ap-eyebrow">Settings</span>
          <h1>Agents &amp; providers</h1>
          <p>Choose which harness runs a task, which model it uses, and who funds the route.</p>
        </div>
      </header>
      <div className="matrix-ap-empty-state" role="status">
        <strong>
          {signedOut
            ? "Sign in to manage providers"
            : failed ? "Provider settings are unavailable" : "Loading provider settings"}
        </strong>
        <span>
          {signedOut
            ? "Provider settings are scoped to your Matrix account and selected computer."
            : failed
              ? "The settings response could not be loaded safely. Refresh and try again."
              : "Checking this computer’s agents, accounts, and model routes…"}
        </span>
        {failed && onRetry ? (
          <button
            type="button"
            className="matrix-ap-button matrix-ap-button-primary"
            aria-label="Retry provider settings"
            onClick={onRetry}
          >
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ConnectedAgentsProvidersAdapter({
  api,
  identityKey,
  platformHost,
  runtimeSlot,
}: {
  api: ApiClient;
  identityKey: string;
  platformHost: string;
  runtimeSlot: string;
}) {
  const runtimeApi = useMemo(() => api.forRuntime(runtimeSlot), [api, runtimeSlot]);
  const transport = useMemo(
    () => createDesktopProviderSettingsTransport(runtimeApi),
    [runtimeApi],
  );
  const controller = useProviderSettingsController({ identityKey, transport });
  const [actionError, setActionError] = useState<string | null>(null);

  const isIdentityCurrent = useCallback(
    () => desktopProviderIdentityKey(useConnection.getState()) === identityKey,
    [identityKey],
  );

  const openTerminal = useCallback((terminalSessionId: string) => {
    setActionError(null);
    void openExistingProviderTerminalSession(runtimeApi, terminalSessionId, isIdentityCurrent)
      .then((opened) => {
        if (!opened && isIdentityCurrent()) setActionError(ACTION_ERROR);
      })
      .catch((error: unknown) => {
        console.error(
          "[provider-settings] Could not open terminal session:",
          error instanceof Error ? error.name : typeof error,
        );
        if (isIdentityCurrent()) setActionError(ACTION_ERROR);
      });
  }, [isIdentityCurrent, runtimeApi]);

  const openBrowser = useCallback((authorizationPath: string) => {
    setActionError(null);
    void openProviderAuthorizationPath({ authorizationPath, platformHost, runtimeSlot })
      .then((opened) => {
        if (!opened && isIdentityCurrent()) setActionError(ACTION_ERROR);
      });
  }, [isIdentityCurrent, platformHost, runtimeSlot]);

  if (controller.snapshot === null) {
    return (
      <ProviderSettingsUnavailable
        signedOut={false}
        failed={controller.error !== null}
        onRetry={() => void controller.refresh()}
      />
    );
  }

  return (
    <AgentsProvidersView
      snapshot={controller.snapshot}
      selectedHarnessId={controller.selectedHarnessId}
      connectionAttempt={controller.connectionAttempt}
      busy={controller.busy}
      error={controller.error ?? actionError}
      onSelectHarness={controller.onSelectHarness}
      onRefresh={() => {
        setActionError(null);
        void controller.refresh();
      }}
      onMutate={(intent) => {
        setActionError(null);
        void controller.mutate(intent);
      }}
      onOpenTerminal={openTerminal}
      onOpenBrowser={openBrowser}
      onAddCredit={() => setActionError(ACTION_ERROR)}
    />
  );
}

export default function AgentsProvidersAdapter() {
  const status = useConnection((state) => state.status);
  const handle = useConnection((state) => state.handle);
  const platformHost = useConnection((state) => state.platformHost);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const api = useConnection((state) => state.api);
  const identityKey = desktopProviderIdentityKey({
    status,
    handle,
    platformHost,
    runtimeSlot,
    authGeneration,
  });

  if (status !== "signed-in" || api === null) {
    return <ProviderSettingsUnavailable signedOut={status === "signed-out"} />;
  }

  return (
    <ConnectedAgentsProvidersAdapter
      key={identityKey}
      api={api}
      identityKey={identityKey}
      platformHost={platformHost}
      runtimeSlot={runtimeSlot}
    />
  );
}
