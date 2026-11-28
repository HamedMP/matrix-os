/**
 * Explains why a file did not open. Nothing was written: the file on disk is
 * exactly as it was, so the owner can open it elsewhere or try again.
 */
import { TriangleAlert } from "lucide-react";
import { EmptyState } from "../../../_shared/office-ui";
import { fileName } from "../session";
import type { SessionErrorCode } from "../session/types";

export interface OpenErrorProps {
  code: SessionErrorCode;
  path: string;
  onRetry: () => void;
  onBack: () => void;
}

const EXPLANATIONS: Partial<Record<SessionErrorCode, { headline: string; description: string }>> = {
  corrupt: {
    headline: "This file is damaged",
    description: "Sheets could not read it, so it was not opened. The file was not changed. If another program made it, try opening and saving it there again.",
  },
  unsupported: {
    headline: "Sheets cannot open this kind of file",
    description: "It may be encrypted, password protected, a macro or chart sheet, or not a spreadsheet at all. The file was not changed.",
  },
  too_large: {
    headline: "This file is too large",
    description: "Sheets opens files up to 10 MB with a bounded number of cells. The file was not changed.",
  },
  field_too_long: {
    headline: "A value is too long for a cell",
    description: "A field in this file is longer than a cell holds (32,767 characters). Sheets did not open it, so none of its text is cut. The file was not changed.",
  },
  not_found: {
    headline: "This file is gone",
    description: "It was moved, renamed or deleted since it was last opened.",
  },
  forbidden: {
    headline: "Sheets may not open this file",
    description: "It is in a protected part of your home.",
  },
  unavailable: {
    headline: "The file could not be reached",
    description: "Your computer did not answer in time. Check the connection and try again.",
  },
  invalid_path: {
    headline: "This is not a spreadsheet file",
    description: "Sheets opens .xlsx, .csv and .tsv files.",
  },
};

export function OpenError({ code, path, onRetry, onBack }: OpenErrorProps) {
  const text = EXPLANATIONS[code] ?? { headline: "The file could not be opened", description: "Something went wrong while reading it. The file was not changed." };
  const retryable = code === "unavailable" || code === "failed";
  return (
    <div className="sheets-open-error" role="alert">
      <EmptyState
        icon={<TriangleAlert />}
        headline={text.headline}
        description={`${fileName(path)}: ${text.description}`}
        action={retryable ? { label: "Try again", onClick: onRetry } : { label: "Back to start", onClick: onBack }}
        secondaryAction={retryable ? { label: "Back to start", onClick: onBack } : undefined}
      />
    </div>
  );
}
