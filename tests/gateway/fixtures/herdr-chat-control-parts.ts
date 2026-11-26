import type { CanonicalChatMessagePart } from "@matrix-os/contracts";
import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";

export function herdrControlParts(): CanonicalChatMessagePart[] {
  return [
    { type: "text", text: "Check the selected terminal." },
    {
      type: "invocation_reference",
      invocation: {
        kind: "command",
        descriptorId: "herdr-terminal-control",
        invocation: "/herdr-terminal-control",
      },
    },
    {
      type: "resource_reference",
      resource: {
        kind: "terminal_session",
        id: `${HERDR_TERMINAL_WORKSPACE_ID}:tt_${"7".repeat(32)}`,
        label: "Build",
        revision: "a".repeat(64),
      },
    },
  ];
}
