import { AlertCircle, CheckCircle2, Download, LoaderCircle } from "@renderer/lib/hugeicons";
import { Button, Dialog } from "../../design/primitives";
import { useDesktopUpdate } from "../../stores/desktop-update";
import ReleaseNotesMarkdown from "./ReleaseNotesMarkdown";

const STATE_COPY = {
  disabled: {
    title: "Updates are unavailable in this preview",
    detail: "Install a packaged Matrix OS build to check for and install updates.",
  },
  checking: {
    title: "Checking for updates…",
    detail: "Looking for the latest version of Matrix OS.",
  },
  "up-to-date": {
    title: "Matrix OS is up to date",
    detail: "You're already running the latest available version.",
  },
  error: {
    title: "Unable to check for updates",
    detail: "Check your connection and try again.",
  },
} as const;

function ReleaseNotes({ notes }: { notes: string }) {
  return (
    <div
      data-selectable
      className="max-h-56 overflow-y-auto rounded-lg border px-4 py-3 text-sm leading-6 [&_a]:font-medium [&_a]:text-[var(--accent)] [&_code]:rounded [&_code]:bg-[var(--bg-sunken)] [&_code]:px-1 [&_h1]:mt-3 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:mb-2 [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-2 [&_h3]:font-semibold [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5"
      style={{
        background: "var(--bg-sunken)",
        borderColor: "var(--border-subtle)",
        color: "var(--text-secondary)",
      }}
    >
      <ReleaseNotesMarkdown notes={notes} />
    </div>
  );
}

export default function ManualUpdateDialog() {
  const open = useDesktopUpdate((state) => state.manualDialogOpen);
  const snapshot = useDesktopUpdate((state) => state.snapshot);
  const installing = useDesktopUpdate((state) => state.installing);
  const close = useDesktopUpdate((state) => state.closeManualDialog);
  const check = useDesktopUpdate((state) => state.check);
  const install = useDesktopUpdate((state) => state.install);
  const progress = Math.round(snapshot.progress ?? 0);
  const retryable = snapshot.status === "error" || snapshot.status === "disabled";
  const closeLabel = retryable
    ? "Close"
    : snapshot.status === "checking" || snapshot.status === "downloading"
      ? "Hide"
      : "Done";

  let title: string;
  let detail: string;
  let icon = <LoaderCircle className="animate-spin" size={22} />;
  if (snapshot.status === "downloading") {
    title = snapshot.version
      ? `Downloading Matrix OS ${snapshot.version}`
      : "Downloading Matrix OS";
    detail = "The update will be ready to install when the download finishes.";
    icon = <Download size={22} />;
  } else if (snapshot.status === "ready") {
    title = snapshot.version
      ? `Matrix OS ${snapshot.version} is ready`
      : "A Matrix OS update is ready";
    detail = "Restart Matrix OS to finish installing this update.";
    icon = <CheckCircle2 size={22} />;
  } else {
    const copy = STATE_COPY[snapshot.status];
    title = copy.title;
    detail = copy.detail;
    if (snapshot.status === "up-to-date") icon = <CheckCircle2 size={22} />;
    if (snapshot.status === "disabled" || snapshot.status === "error") {
      icon = <AlertCircle size={22} />;
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      width={560}
      placement="center"
      title="Software Update"
    >
      <div className="flex items-start gap-4 px-6 pt-6 pb-5">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
          style={{
            background: "var(--update-action-muted)",
            color: "var(--update-action)",
          }}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
            {title}
          </h2>
          <p className="mt-1 text-sm leading-5" style={{ color: "var(--text-secondary)" }}>
            {detail}
          </p>
        </div>
      </div>

      {snapshot.status === "downloading" ? (
        <div className="px-6 pb-5">
          <div
            role="progressbar"
            aria-label="Download progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            className="h-2 overflow-hidden rounded-full"
            style={{ background: "var(--bg-sunken)" }}
          >
            <div
              className="h-full rounded-full transition-[width] duration-200"
              style={{ width: `${progress}%`, background: "var(--update-action)" }}
            />
          </div>
          <p className="mt-2 text-right text-xs" style={{ color: "var(--text-tertiary)" }}>
            {progress}%
          </p>
        </div>
      ) : null}

      {snapshot.status === "ready" && snapshot.release ? (
        <div className="px-6 pb-5">
          <ReleaseNotes notes={snapshot.release.notes} />
        </div>
      ) : null}

      <div className="flex justify-end gap-2 border-t px-6 py-4" style={{ borderColor: "var(--border-subtle)" }}>
        {retryable ? (
          <Button variant="subtle" onClick={() => void check()}>Retry</Button>
        ) : null}
        {snapshot.status === "ready" ? (
          <>
            <Button variant="ghost" onClick={close}>Later</Button>
            <Button
              variant="primary"
              disabled={installing}
              style={{
                background: "var(--update-action)",
                color: "var(--update-action-foreground)",
              }}
              onClick={() => void install()}
            >
              {installing ? "Restarting…" : "Restart & Install"}
            </Button>
          </>
        ) : (
          <Button variant="subtle" onClick={close}>{closeLabel}</Button>
        )}
      </div>
    </Dialog>
  );
}
