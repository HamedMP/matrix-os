import { QueuedTurnsPanel as SharedQueuedTurnsPanel } from "@matrix-os/ui";
import type { ComponentProps } from "react";

import { DESKTOP_Z_INDEX } from "../../design/layering";

export type { QueuedTurnAction } from "@matrix-os/ui";

/** Electron Desktop placement of the shared queued-turns panel. */
export function QueuedTurnsPanel(props: ComponentProps<typeof SharedQueuedTurnsPanel>) {
  return <SharedQueuedTurnsPanel menuZIndex={DESKTOP_Z_INDEX.popover} {...props} />;
}
