/**
 * Shown when the file changed on disk (a conflict) or a save failed. The
 * local workbook stays on screen; nothing is written over the other version.
 */
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Dialog } from "../../../_shared/office-ui";
import type { SheetGridController } from "../grid";
import type { SheetSession } from "../session/session";
import type { SessionState } from "../session/types";
import { type Notify, saveAsWorkbookNow, saveCopyNow, saveNow } from "./file-actions";

export interface SaveBannerProps {
  session: SheetSession;
  state: SessionState;
  controller: SheetGridController;
  notify: Notify;
}

export function SaveBanner({ session, state, controller, notify }: SaveBannerProps) {
  const [confirmReload, setConfirmReload] = useState(false);
  const [busy, setBusy] = useState(false);

  const act = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  const reload = (): Promise<void> =>
    act(async () => {
      setConfirmReload(false);
      const result = await session.reload();
      if (!result.ok) notify(result.message, "danger");
    });

  if (state.saveState !== "conflict" && state.saveState !== "error") return null;
  const conflict = state.saveState === "conflict";
  const review = state.saveError?.code === "review_pending";

  return (
    <div className="sheets-banner" role="alert">
      <TriangleAlert size={16} aria-hidden="true" />
      <span className="sheets-banner__text">
        {conflict
          ? "This file changed on disk since you opened it. Your edits are kept here and were not written over it."
          : review
            ? "Your latest edits are not saved yet: this CSV file cannot keep the assistant's suggested changes. Accept or reject them to save, or save as .xlsx to keep reviewing later."
            : `Your latest edits are not saved. ${state.saveError?.message ?? ""}`}
      </span>
      {conflict ? (
        <>
          <button type="button" className="oui-button oui-button--primary" disabled={busy} onClick={() => void act(() => saveCopyNow(session, controller, notify))}>
            Save a copy
          </button>
          <button type="button" className="oui-button oui-button--ghost" disabled={busy} onClick={() => setConfirmReload(true)}>
            Reload from disk
          </button>
        </>
      ) : review ? (
        <button type="button" className="oui-button oui-button--primary" disabled={busy} onClick={() => void act(() => saveAsWorkbookNow(session, controller, notify))}>
          Save as .xlsx
        </button>
      ) : (
        <button type="button" className="oui-button oui-button--primary" disabled={busy} onClick={() => void act(() => saveNow(session, controller, notify))}>
          Try again
        </button>
      )}
      <Dialog
        open={confirmReload}
        onClose={() => setConfirmReload(false)}
        role="alertdialog"
        size="sm"
        title="Reload from disk?"
        description="Your edits since the last save are dropped and the version on disk is shown."
        footer={
          <>
            <button type="button" className="oui-button oui-button--ghost" onClick={() => setConfirmReload(false)}>
              Keep my edits
            </button>
            <button type="button" className="oui-button oui-button--danger" onClick={() => void reload()}>
              Reload
            </button>
          </>
        }
      />
    </div>
  );
}
