import { TerminalPaneActionSchema, type TerminalPaneAction } from "@matrix-os/contracts";
import { validateSessionName } from "./names.js";

/** No shell text: only fixed CLI verbs and schema-validated direction arguments. */
export function terminalPaneActionArgs(name: string, input: TerminalPaneAction): string[] {
  const session = validateSessionName(name);
  const action = TerminalPaneActionSchema.parse(input);
  const prefix = ["--session", session, "action"];
  switch (action.type) {
    case "split": return [...prefix, "new-pane", "--direction", action.direction];
    case "focus": return [...prefix, "move-focus", action.direction];
    case "resize": return [...prefix, "resize", "increase", action.direction];
    case "fullscreen": return [...prefix, "toggle-fullscreen"];
    case "scroll": return [...prefix, action.edge === "top" ? "scroll-to-top" : "scroll-to-bottom"];
    case "close": return [...prefix, "close-pane"];
  }
}
