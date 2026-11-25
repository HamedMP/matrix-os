/**
 * The Mail composer (new, reply, reply all, forward), mounted by
 * `ui/slots.tsx` in the workspace's dock. It can be popped out into a
 * dialog and docked again; the body, including pending tracked changes,
 * survives the move.
 *
 *   <Composer store={store} state={state} draft={draft} entries={entries} onClose={close} />
 *
 * Optional: `bridge` (defaults to `window.MatrixOS`), `ai` (defaults to
 * `MatrixOS.ai`), `proposals` (the mail agent's registry), `now`.
 */
import { useMemo, useState } from "react";
import { Maximize2 } from "lucide-react";
import { Dialog } from "../../../../_shared/office-ui";
import { bridgeMailAi } from "../../agent/ai";
import { ComposeForm, titleFor } from "./ComposeForm";
import { hostComposeBridge, type ComposerProps } from "./composer-props";
import "./compose.css";

export type { ComposeBridge, ComposerProps } from "./composer-props";

export function Composer(props: ComposerProps) {
  const [popped, setPopped] = useState(false);
  const bridge = useMemo(() => props.bridge ?? hostComposeBridge(), [props.bridge]);
  const ai = useMemo(() => (props.ai !== undefined ? props.ai : bridgeMailAi()), [props.ai]);
  const form = <ComposeForm {...props} bridge={bridge} ai={ai} popped={popped} onTogglePop={() => setPopped((value) => !value)} />;
  if (!popped) return form;
  const title = titleFor(props.draft.kind);
  return (
    <>
      <div className="mail-compose-placeholder" role="status">
        <span>{title} is open in a window.</span>
        <button type="button" className="oui-button oui-button--ghost" onClick={() => setPopped(false)}>
          <Maximize2 size={14} aria-hidden="true" /> Dock
        </button>
      </div>
      <Dialog open onClose={() => setPopped(false)} title={title} size="lg" showClose={false} dismissOnBackdrop={false} className="mail-compose-dialog">
        {form}
      </Dialog>
    </>
  );
}

export default Composer;
