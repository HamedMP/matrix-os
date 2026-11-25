/**
 * What every Mail view needs besides the state: the store, the providers, the
 * host bridge, the clock and the conversations being dragged.
 */
import { createContext, useContext, type MutableRefObject } from "react";
import type { MailAccountEntry, MailStore, ThreadKey } from "../model";
import type { AttachmentBridge } from "./attachments";
import type { LayoutBridge } from "./layout-prefs";

export type MailBridge = AttachmentBridge & LayoutBridge;

export interface MailUi {
  store: MailStore;
  entries: readonly MailAccountEntry[];
  bridge: MailBridge | undefined;
  now: () => number;
  timeZone: string;
  /** Lower-cased addresses of the connected mailboxes. */
  ownAddresses: readonly string[];
  /** Keys being dragged right now; `dragover` cannot read the payload. */
  dragKeys: MutableRefObject<ThreadKey[]>;
  /** Shows a short message. */
  notify: (title: string, tone?: "info" | "success" | "warning" | "danger", action?: { label: string; onClick: () => void }) => void;
}

export const MailUiContext = createContext<MailUi | null>(null);

export function useMailUi(): MailUi {
  const value = useContext(MailUiContext);
  if (!value) throw new Error("useMailUi must be used inside MailUiContext");
  return value;
}

/** The host bridge, when the app runs inside Matrix OS. */
export function hostBridge(): MailBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { MatrixOS?: MailBridge }).MatrixOS;
}
