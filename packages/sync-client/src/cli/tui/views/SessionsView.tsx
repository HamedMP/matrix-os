import React from "react";
import { Box, Text } from "ink";
import type { MatrixSessionSummary } from "../session-types.js";

export type SessionsViewState = "ready" | "empty" | "loading" | "unauthenticated" | "gateway-unavailable" | "error";

export function SessionsView({
  sessions,
  selectedIndex = 0,
  state = sessions.length > 0 ? "ready" : "empty",
  message,
  noColor = false,
}: {
  sessions: readonly MatrixSessionSummary[];
  selectedIndex?: number;
  state?: SessionsViewState;
  message?: string;
  noColor?: boolean;
}) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={noColor ? undefined : "cyan"} paddingX={1}>
      <Text bold>Matrix Sessions</Text>
      <Text color={noColor ? undefined : "gray"}>Shell Sessions</Text>
      {state === "loading" && <Text>Loading sessions...</Text>}
      {state === "unauthenticated" && <Text>Log in to list shell sessions.</Text>}
      {state === "gateway-unavailable" && <Text>Gateway unavailable. Run doctor or check the active profile.</Text>}
      {state === "error" && <Text>{message ?? "Could not load sessions."}</Text>}
      {(state === "ready" || state === "empty") && sessions.map((session, index) => (
        <Text key={session.id} color={noColor ? undefined : index === selectedIndex ? "cyan" : undefined}>
          {index === selectedIndex ? "> " : "  "}{session.name} · {session.kind} · {session.status}{session.agent ? ` · ${session.agent}` : ""}{session.context ? ` · ${session.context}` : ""}
        </Text>
      ))}
      {state === "empty" && <Text>No shell sessions yet. Press n to create one.</Text>}
      <Text color={noColor ? undefined : "gray"}>Enter attach · n new · r refresh · k remove · Esc back</Text>
    </Box>
  );
}
