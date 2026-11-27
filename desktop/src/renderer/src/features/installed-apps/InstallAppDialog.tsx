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

function dialogCopy(request: InstallAppDialogRequest, platform: InstalledAppPlatform, busy: boolean) {
  if (request.mode === "install") {
    return {
      title: `Install ${request.name}?`,
      detail: INSTALL_DESTINATION[platform],
      confirm: busy ? "Installing…" : "Install",
      variant: "primary" as const,
    };
  }
  return {
    title: `Uninstall ${request.name}?`,
    detail: `This removes it from ${UNINSTALL_FROM[platform]}. Its files and data stay in Matrix.`,
    confirm: busy ? "Uninstalling…" : "Uninstall",
    variant: "danger" as const,
  };
}

function DialogBody({ request, platform, busy, error, onCancel, onConfirm }: {
  request: InstallAppDialogRequest;
  platform: InstalledAppPlatform;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const copy = dialogCopy(request, platform, busy);
  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex items-center gap-3">
        <DialogAppIcon url={request.iconUrl} name={request.name} />
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{copy.title}</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{copy.detail}</p>
        </div>
      </div>
      {request.mode === "install" ? (
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
        <Button variant={copy.variant} onClick={onConfirm} disabled={busy} aria-busy={busy}>{copy.confirm}</Button>
      </div>
    </div>
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
  return (
    <Dialog
      open={request !== null}
      onClose={() => { if (!busy) onCancel(); }}
      width={400}
      title={request ? dialogCopy(request, platform, busy).title : "Install app"}
      role={request?.mode === "uninstall" ? "alertdialog" : "dialog"}
      placement="center"
    >
      {request ? <DialogBody request={request} platform={platform} busy={busy} error={error} onCancel={onCancel} onConfirm={onConfirm} /> : null}
    </Dialog>
  );
}
