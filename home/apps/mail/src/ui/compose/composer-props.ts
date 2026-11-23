/**
 * Props of the full composer. The workspace passes `ComposerSlotProps`; the
 * rest default to the host bridge (`window.MatrixOS`) and can be injected.
 */
import type { MailAi } from "../../agent/ai";
import type { ProposalRegistry } from "../../agent/proposals";
import type { PickerFiles } from "../../compose/attachments";
import type { SignatureBridge } from "../../compose/signature";
import type { ComposerSlotProps } from "../slots";

/** The parts of `window.MatrixOS` the composer uses. */
export interface ComposeBridge extends SignatureBridge {
  /** Absent when the host has no file access (the Attach button is then disabled). */
  files?: PickerFiles;
}

export interface ComposerProps extends ComposerSlotProps {
  /** Defaults to `window.MatrixOS`. */
  bridge?: ComposeBridge;
  /** Defaults to `MatrixOS.ai`; null hides the assistant. */
  ai?: MailAi | null;
  /** Agent draft proposals; an open proposal for this draft opens as a redline. */
  proposals?: ProposalRegistry;
  now?: () => number;
}

function isPickerFiles(value: unknown): value is PickerFiles {
  const files = value as Partial<Record<keyof PickerFiles, unknown>> | null;
  return typeof files === "object" && files !== null
    && typeof files.list === "function" && typeof files.stat === "function" && typeof files.read === "function";
}

/** The host bridge, reduced to what the composer uses. */
export function hostComposeBridge(): ComposeBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const host = (window as unknown as { MatrixOS?: Record<string, unknown> }).MatrixOS;
  if (!host) return undefined;
  const readData = typeof host.readData === "function" ? (host.readData as SignatureBridge["readData"]) : undefined;
  const writeData = typeof host.writeData === "function" ? (host.writeData as SignatureBridge["writeData"]) : undefined;
  return {
    readData: readData && ((key) => readData.call(host, key)),
    writeData: writeData && ((key, value) => writeData.call(host, key, value)),
    files: isPickerFiles(host.files) ? host.files : undefined,
  };
}
