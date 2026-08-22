import type { AgentProviderSummary, SafeSetupAction } from "@matrix-os/contracts";
import { AlertCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "../../design/primitives";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import { executeProviderSetupAction } from "./provider-setup-terminal";
import type { ProviderReadinessPresentation } from "./provider-readiness";

const SETUP_ERROR = "Could not open provider setup. Open Providers settings to continue.";
const REFRESH_ERROR = "Provider status is unavailable right now.";

function sameSetupAction(left: SafeSetupAction, right: SafeSetupAction): boolean {
  if (left.kind !== right.kind || left.id !== right.id || left.label !== right.label) return false;
  return left.kind === "open_settings" ||
    (right.kind === "foreground_terminal" && left.command === right.command);
}

export function ProviderReadinessNotice(props: {
  readiness: ProviderReadinessPresentation;
  providers: AgentProviderSummary[];
  onRefresh: () => Promise<void>;
}): React.JSX.Element | null {
  const api = useConnection((state) => state.api);
  const openTab = useTabs((state) => state.openTab);
  const requestSettingsSection = useUi((state) => state.requestSettingsSection);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!props.readiness.blocked || props.readiness.state === "ready") return null;

  const runAction = async () => {
    const readinessAction = props.readiness.action;
    if (!readinessAction || pending) return;
    setPending(true);
    setError(null);
    try {
      if (readinessAction.kind === "refresh") {
        await props.onRefresh();
        return;
      }
      if (readinessAction.action.kind === "open_settings") {
        requestSettingsSection("providers");
        openTab({ kind: "settings", title: "Settings" });
        return;
      }
      const provider = props.providers.find((candidate) =>
        candidate.setupActions.some((action) => sameSetupAction(action, readinessAction.action))
      );
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
      setError(readinessAction.kind === "refresh" ? REFRESH_ERROR : SETUP_ERROR);
    } finally {
      setPending(false);
    }
  };

  const actionLabel = props.readiness.action?.kind === "setup"
    ? props.readiness.action.action.label
    : "Refresh status";
  const pendingLabel = props.readiness.action?.kind === "refresh" ? "Refreshing…" : "Opening…";

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
        <Button
          variant="subtle"
          disabled={pending}
          aria-label={props.readiness.action.kind === "refresh" ? "Refresh provider status" : actionLabel}
          onClick={() => void runAction()}
        >
          {pending ? pendingLabel : actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
