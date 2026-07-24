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
      className="mt-4 flex flex-col gap-2 rounded-xl border p-4"
      style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
    >
      <div className="flex items-center gap-2">
        <StatusDot color="var(--status-waiting)" pulse />
        <p className="flex-1 text-sm" style={{ color: "var(--text-primary)" }}>
          Waiting for {serviceName} to connect — finish the sign-in in your browser.
        </p>
        <Button onClick={onConfirm} disabled={manualBusy}>
          {manualBusy ? "Checking..." : "I've connected"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={manualBusy}>
          Cancel
        </Button>
      </div>
      {manualNote ? (
        <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
          {manualNote}
        </p>
      ) : null}
    </div>
  );
}
