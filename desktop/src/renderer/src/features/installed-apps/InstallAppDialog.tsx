import { useState } from "react";
import { Button, Dialog } from "../../design/primitives";
import type { InstalledAppPlatform } from "../../../../shared/installed-apps-ipc";
import { INSTALL_DESTINATION } from "./installed-apps";

export interface InstallAppDialogRequest {
  mode: "install" | "uninstall";
  name: string;
  iconUrl: string | null;
}

const UNINSTALL_FROM: Record<InstalledAppPlatform, string> = {
  mac: "Applications",
  windows: "the Start menu",
  linux: "your apps menu",
};

function DialogAppIcon({ url, name }: { url: string | null; name: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (url && failedUrl !== url) {
    return <img src={url} alt="" className="size-14 shrink-0 object-contain" draggable={false} onError={() => setFailedUrl(url)} />;
  }
  return (
    <span
      aria-hidden="true"
      className="flex size-14 shrink-0 items-center justify-center rounded-[16px] text-xl font-semibold"
      style={{ background: "var(--accent-muted)", color: "var(--accent-text)" }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/** Confirms installing an app as a desktop app, or uninstalling it (spec 2711 "User Journey"). */
export function InstallAppDialog({
  request,
  platform,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  request: InstallAppDialogRequest | null;
  platform: InstalledAppPlatform;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const installing = request?.mode === "install";
  const title = request ? `${installing ? "Install" : "Uninstall"} ${request.name}?` : "Install app";
  return (
    <Dialog
      open={request !== null}
      onClose={() => { if (!busy) onCancel(); }}
      width={400}
      title={title}
      role={installing ? "dialog" : "alertdialog"}
      placement="center"
    >
      {request ? (
        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-center gap-3">
            <DialogAppIcon url={request.iconUrl} name={request.name} />
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{title}</h2>
              <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
                {installing
                  ? INSTALL_DESTINATION[platform]
                  : `This removes it from ${UNINSTALL_FROM[platform]}. Its files and data stay in Matrix.`}
              </p>
            </div>
          </div>
          {installing ? (
            <p className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--bg-hover)", color: "var(--text-secondary)" }}>
              Uses the same access it has inside Matrix.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--danger-muted)", color: "var(--danger-text)" }}>
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
            <Button variant={installing ? "primary" : "danger"} onClick={onConfirm} disabled={busy} aria-busy={busy}>
              {installing ? (busy ? "Installing…" : "Install") : (busy ? "Uninstalling…" : "Uninstall")}
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
