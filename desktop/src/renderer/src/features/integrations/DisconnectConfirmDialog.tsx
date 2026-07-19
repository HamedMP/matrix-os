// Confirmation dialog for the destructive disconnect action. Rendered with
// connection=null closed; the parent closes it once the disconnect settles
// (success or failure — failures surface via the store's error banner).
import { Button, Dialog } from "../../design/primitives";
import type { ConnectedIntegration } from "./types";

export function DisconnectConfirmDialog({
  connection,
  disconnecting,
  onCancel,
  onConfirm,
}: {
  connection: ConnectedIntegration | null;
  disconnecting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={connection !== null} onClose={onCancel} width={400}>
      {connection ? (
        <div className="flex flex-col gap-4 p-5">
          <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            Disconnect {connection.accountLabel}?
          </p>
          <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
            The agent will no longer be able to use this account. You can reconnect it at any time.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onCancel} disabled={disconnecting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={onConfirm} disabled={disconnecting}>
              {disconnecting ? "Removing..." : "Disconnect"}
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
