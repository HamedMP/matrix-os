/**
 * Attachment chips under a message. Documents and spreadsheets open in Docs
 * and Sheets; everything else downloads. Inline images are not listed.
 */
import { useState } from "react";
import { Download, FileSpreadsheet, FileText, Paperclip } from "lucide-react";
import type { MailAttachment, MailProvider } from "../../../_shared/office-accounts/types/mail";
import { useMailUi } from "./context";
import { downloadAttachment, OFFICE_APP_TITLES, officeAppFor, openAttachment, type AttachmentOutcome } from "./attachments";
import { formatBytes } from "./format";

export interface AttachmentChipsProps {
  provider: MailProvider | undefined;
  messageId: string;
  attachments: readonly MailAttachment[];
}

export function AttachmentChips({ provider, messageId, attachments }: AttachmentChipsProps) {
  const { bridge, notify } = useMailUi();
  const [busy, setBusy] = useState<string | null>(null);
  const listed = attachments.filter((attachment) => !attachment.inline);
  if (listed.length === 0) return null;

  const report = (outcome: AttachmentOutcome) => {
    switch (outcome.kind) {
      case "opened":
        notify(`Opened in ${OFFICE_APP_TITLES[outcome.app]}`, "success");
        break;
      case "saved": {
        const app = OFFICE_APP_TITLES[outcome.app];
        notify(`Saved to ${outcome.path}. Open it from Files to edit in ${app}.`, "info",
          bridge?.openApp ? { label: `Open ${app}`, onClick: () => bridge.openApp?.(app, `apps/${outcome.app}/index.html`) } : undefined);
        break;
      }
      case "downloaded":
        notify(`Downloaded ${outcome.name}`, "success");
        break;
      case "failed":
        notify("The attachment could not be opened. Try again.", "danger");
        break;
    }
  };

  const run = async (attachment: MailAttachment, mode: "open" | "download") => {
    if (!provider || busy) return;
    setBusy(attachment.id);
    try {
      const deps = { provider, messageId, attachment, bridge };
      report(await (mode === "open" ? openAttachment(deps) : downloadAttachment(deps)));
    } finally {
      setBusy(null);
    }
  };

  return (
    <ul className="mail-attachments" aria-label="Attachments">
      {listed.map((attachment) => {
        const app = officeAppFor(attachment.name);
        const icon = app === "docs" ? <FileText size={15} /> : app === "sheets" ? <FileSpreadsheet size={15} /> : <Paperclip size={15} />;
        const action = app ? `Open ${attachment.name} in ${OFFICE_APP_TITLES[app]}` : `Download ${attachment.name}`;
        return (
          <li key={attachment.id} className="mail-attachment">
            <button
              type="button"
              className="mail-attachment__main"
              aria-label={action}
              title={action}
              disabled={!provider || busy !== null}
              aria-busy={busy === attachment.id || undefined}
              onClick={() => void run(attachment, app ? "open" : "download")}
            >
              <span className="mail-attachment__icon" aria-hidden="true">{icon}</span>
              <span className="mail-attachment__name">{attachment.name}</span>
              <span className="mail-attachment__size">{formatBytes(attachment.size)}</span>
            </button>
            {app && (
              <button
                type="button"
                className="oui-icon-button"
                aria-label={`Download ${attachment.name}`}
                title="Download"
                disabled={!provider || busy !== null}
                onClick={() => void run(attachment, "download")}
              >
                <Download size={14} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
