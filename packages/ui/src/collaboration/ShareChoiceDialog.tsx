import { Dialog } from "../Dialog.js";

const actionClass = "rounded-xl border p-4 text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";

export function ShareChoiceDialog({ collaborationAvailable, pending, onSnapshot, onCollaborate, onClose }: {
  collaborationAvailable: boolean;
  pending: boolean;
  onSnapshot: () => void;
  onCollaborate: () => void;
  onClose: () => void;
}) {
  return <Dialog open onClose={onClose} aria-label="Share Chat" className="ph-no-capture w-[min(92vw,560px)] rounded-2xl border p-6">
    <div className="flex items-center justify-between gap-4">
      <div>
        <h2 className="text-lg font-semibold">Share Chat</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>Choose what kind of access to create.</p>
      </div>
      <button type="button" onClick={onClose} disabled={pending} className="rounded-lg border px-3 py-2 text-sm">Close</button>
    </div>
    <div className="mt-5 grid gap-3 sm:grid-cols-2">
      <button type="button" aria-label="Share snapshot" className={actionClass} disabled={pending} onClick={onSnapshot}>
        <span className="block font-medium">Share snapshot</span>
        <span className="mt-1 block text-sm" style={{ color: "var(--text-secondary)" }}>
          Publish a frozen copy that expires after seven days.
        </span>
      </button>
      <button type="button" aria-label="Invite collaborators" className={actionClass} disabled={pending || !collaborationAvailable} onClick={onCollaborate}>
        <span className="block font-medium">Invite collaborators</span>
        <span className="mt-1 block text-sm" style={{ color: "var(--text-secondary)" }}>
          Give named people access to this ongoing Chat and its discussion.
        </span>
        {!collaborationAvailable ? <span className="mt-2 block text-xs">Live collaboration is unavailable on this computer.</span> : null}
      </button>
    </div>
  </Dialog>;
}
