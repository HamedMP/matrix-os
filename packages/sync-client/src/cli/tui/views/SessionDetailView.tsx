import React from "react";
import { Box, Text } from "ink";
import type { MatrixSessionSummary } from "../session-types.js";

export function SessionDetailView({ session, noColor = false }: { session: MatrixSessionSummary; noColor?: boolean }) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={noColor ? undefined : "gray"} paddingX={1}>
      <Text bold>{session.name}</Text>
      <Text>{`${session.kind} · ${session.status}`}</Text>
      {session.projectSlug && <Text>{`Project ${session.projectSlug}`}</Text>}
      {session.agent && <Text>{`Agent ${session.agent}`}</Text>}
      <Text>Actions: attach · observe · takeover · send · kill</Text>
      {session.timeline?.map((event, index) => <Text key={index}>{event.summary}</Text>)}
    </Box>
  );
}
