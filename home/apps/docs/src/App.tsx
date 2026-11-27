import type { MatrixOSBridge } from "../../_shared/matrix-os";
import { ToastProvider } from "../../_shared/office-ui";
import { DocsApp } from "./ui/DocsApp";

/** Author name of the owner's revisions and comments when the bridge names nobody. */
export const DEFAULT_AUTHOR = "Owner";

export interface AppProps {
  /** Defaults to the injected `window.MatrixOS`. */
  bridge?: MatrixOSBridge;
  author?: string;
  /** Save edits after a pause. Default true. */
  autosave?: boolean;
}

function bridgeFromWindow(): MatrixOSBridge | undefined {
  return typeof window === "undefined" ? undefined : (window.MatrixOS as MatrixOSBridge | undefined);
}

export default function App({ bridge, author, autosave = true }: AppProps) {
  const resolved = bridge ?? bridgeFromWindow();
  const name = author ?? resolved?.collaboration?.participant?.displayName ?? DEFAULT_AUTHOR;
  return (
    <ToastProvider>
      <DocsApp bridge={resolved} author={name} autosave={autosave} />
    </ToastProvider>
  );
}
