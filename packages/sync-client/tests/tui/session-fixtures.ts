import type { MatrixSessionSummary } from "../../src/cli/tui/session-types.js";

export const shellSessionFixtures: MatrixSessionSummary[] = [
  {
    id: "shell-main",
    kind: "shell",
    name: "main",
    status: "running",
    context: "~/matrix-os",
    attention: "ready",
    nativeAttachCommand: ["matrix", "shell", "connect", "main"],
  },
  {
    id: "shell-review",
    kind: "shell",
    name: "review",
    status: "detached",
    context: "~/matrix-tui-action-console",
    attention: "busy",
    nativeAttachCommand: ["matrix", "shell", "connect", "review"],
  },
];

export const emptyShellSessionFixtures: MatrixSessionSummary[] = [];
