// The "waiting for browser sign-in" banner shown while a connect flow is
// pending: poll runs in the background, the user can manually confirm
// ("I've connected") or cancel.
import { Button, StatusDot } from "../../design/primitives";

export function ConnectPendingBanner({
  serviceName,
  manualBusy,
  manualNote,
  onConfirm,
  onCancel,
}: {
  serviceName: string;
  manualBusy: boolean;
  manualNote: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="mt-4 grid min-w-0 gap-3 rounded-xl border p-4"
      style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
    >
      <div role="status" className="grid gap-2">
        <div className="flex items-start gap-2">
          <span className="mt-1.5 flex shrink-0" aria-hidden="true">
            <StatusDot color="var(--status-waiting)" pulse />
          </span>
          <p className="min-w-0 text-sm" style={{ color: "var(--text-primary)" }}>
            Waiting for {serviceName} to connect — finish the sign-in in your browser.
          </p>
        </div>
        {manualNote ? (
          <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
            {manualNote}
          </p>
        ) : null}
      </div>
      <div role="group" aria-label="Sign-in actions" className="flex flex-wrap items-center gap-2">
        <Button variant="primary" className="min-h-9 max-[520px]:min-h-11" onClick={onConfirm} disabled={manualBusy}>
          {manualBusy ? "Checking..." : "I've connected"}
        </Button>
        <Button variant="ghost" className="min-h-9 max-[520px]:min-h-11" onClick={onCancel} disabled={manualBusy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
