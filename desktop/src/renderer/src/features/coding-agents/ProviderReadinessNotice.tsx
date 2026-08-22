import type { AgentProviderSummary } from "@matrix-os/contracts";
import { AlertCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "../../design/primitives";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import { executeProviderSetupAction } from "./provider-setup-terminal";
import {
  findProviderForSetupAction,
  type ProviderReadinessPresentation,
} from "./provider-readiness";

const SETUP_ERROR = "Could not open provider setup. Open Providers settings to continue.";
const REFRESH_ERROR = "Provider status is unavailable right now.";

export function ProviderReadinessNotice(props: {
  readiness: ProviderReadinessPresentation;
  providers: AgentProviderSummary[];
  onRefresh: () => Promise<void>;
}): React.JSX.Element | null {
  const api = useConnection((state) => state.api);
  const openTab = useTabs((state) => state.openTab);
  const requestSettingsSection = useUi((state) => state.requestSettingsSection);
  const [pendingAction, setPendingAction] = useState<"primary" | "refresh" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!props.readiness.blocked || props.readiness.state === "ready") return null;

  const runAction = async (requestedAction: "primary" | "refresh") => {
    const readinessAction = props.readiness.action;
    if (!readinessAction || pendingAction) return;
    const refreshing = requestedAction === "refresh" || readinessAction.kind === "refresh";
    setPendingAction(requestedAction);
    setError(null);
    try {
      if (refreshing) {
        await props.onRefresh();
        return;
      }
      if (readinessAction.action.kind === "open_settings") {
        requestSettingsSection("providers");
        openTab({ kind: "settings", title: "Settings" });
        return;
      }
      const provider = findProviderForSetupAction(props.providers, readinessAction.action);
      const opened = provider
        ? await executeProviderSetupAction({
            provider,
            action: readinessAction.action,
            api,
            openTab,
            requestSettingsSection,
          })
        : false;
      if (!opened) setError(SETUP_ERROR);
    } catch (err: unknown) {
      console.error(
        "[provider-readiness] Recovery action failed:",
        err instanceof Error ? err.name : typeof err,
      );
      setError(refreshing ? REFRESH_ERROR : SETUP_ERROR);
    } finally {
      setPendingAction(null);
    }
  };

  const actionLabel = props.readiness.action?.kind === "setup"
    ? props.readiness.action.action.label
    : "Refresh status";
  const primaryPendingLabel = props.readiness.action?.kind === "refresh" ? "Refreshing…" : "Opening…";
  const showSecondaryRefresh = props.readiness.action?.kind === "setup";

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2.5 rounded-lg border px-3 py-2.5"
      style={{
        borderColor: "var(--warning)",
        background: "color-mix(in srgb, var(--warning) 8%, transparent)",
      }}
    >
      <AlertCircle
        aria-hidden="true"
        size={15}
        className="mt-0.5 shrink-0"
        style={{ color: "var(--warning)" }}
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>
          {props.readiness.title}
        </p>
        <p className="mt-0.5 text-xs" style={{ color: "var(--text-secondary)" }}>
          {props.readiness.description}
        </p>
        {error ? (
          <p className="mt-1 text-xs" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}
      </div>
      {props.readiness.action ? (
        <div className="flex shrink-0 items-center gap-1.5">
          {showSecondaryRefresh ? (
            <Button
              variant="ghost"
              disabled={pendingAction !== null}
              aria-label="Refresh provider status"
              onClick={() => void runAction("refresh")}
            >
              {pendingAction === "refresh" ? "Refreshing…" : "Refresh status"}
            </Button>
          ) : null}
          <Button
            variant="subtle"
            disabled={pendingAction !== null}
            aria-label={props.readiness.action.kind === "refresh" ? "Refresh provider status" : actionLabel}
            onClick={() => void runAction("primary")}
          >
            {pendingAction === "primary" ? primaryPendingLabel : actionLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
