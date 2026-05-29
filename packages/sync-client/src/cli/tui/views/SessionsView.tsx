import React from "react";
import { Box, Text } from "ink";
import type { MatrixSessionSummary } from "../session-types.js";

export function SessionsView({ sessions, selectedIndex = 0, noColor = false }: { sessions: readonly MatrixSessionSummary[]; selectedIndex?: number; noColor?: boolean }) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={noColor ? undefined : "cyan"} paddingX={1}>
      <Text bold>Matrix Sessions</Text>
      {sessions.map((session, index) => (
        <Text key={session.id} color={noColor ? undefined : index === selectedIndex ? "cyan" : undefined}>
          {index === selectedIndex ? "> " : "  "}{session.name} · {session.kind} · {session.status}{session.agent ? ` · ${session.agent}` : ""}{session.context ? ` · ${session.context}` : ""}
        </Text>
      ))}
      {sessions.length === 0 && <Text>No Matrix sessions yet</Text>}
    </Box>
  );
}
