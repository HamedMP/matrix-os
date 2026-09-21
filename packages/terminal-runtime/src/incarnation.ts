import { createHash } from "node:crypto";

/** A stable public identity derived from each tab's persisted random internal name. */
export function terminalTabIncarnation(tab: { zellijTabName: string }): `ti_${string}` {
  return `ti_${createHash("sha256")
    .update("matrix-terminal-tab-incarnation-v1\0")
    .update(tab.zellijTabName)
    .digest("hex").slice(0, 32)}`;
}
