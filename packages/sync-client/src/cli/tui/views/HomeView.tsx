import React from "react";
import { Box, Text } from "ink";
import { Mascot } from "./Mascot.js";
import type { TuiStatusSnapshot } from "../status.js";

function stateLabel(snapshot: TuiStatusSnapshot): string {
  if (snapshot.overall === "unauthenticated") {
    return "login required";
  }
  return snapshot.overall;
}

export function HomeView({
  snapshot,
  columns = 80,
  noColor = false,
}: {
  snapshot: TuiStatusSnapshot;
  columns?: number;
  noColor?: boolean;
}) {
  const narrow = columns < 80;
  const sessionLabel = `${snapshot.sessions.count} ${snapshot.sessions.count === 1 ? "session" : "sessions"}`;
  const status = `${stateLabel(snapshot)} · ${snapshot.profile.name} · ${snapshot.gateway.label} · ${sessionLabel}`;

  return (
    <Box flexDirection="column" width={Math.max(40, Math.min(columns, 100))}>
      <Box justifyContent="center" marginBottom={1}>
        <Text bold color={noColor ? undefined : "cyan"}>Matrix OS</Text>
      </Box>
      <Box borderStyle="single" borderColor={noColor ? undefined : "gray"} flexDirection="column" paddingX={1}>
        <Text>{'Ask Hermes... "review my current PR"'}</Text>
        <Text color={noColor ? undefined : "blue"}>Build · Hermes  Codex  Shell</Text>
      </Box>
      <Box marginTop={1} justifyContent="space-between">
        <Text>{"/ commands   tab agents   s sessions"}</Text>
        {!narrow && <Mascot state={snapshot.overall} noColor={noColor} />}
      </Box>
      <Box marginTop={1}>
        <Text color={noColor ? undefined : snapshot.overall === "healthy" ? "green" : "yellow"}>{status}</Text>
      </Box>
      {snapshot.blockingActions.length > 0 && (
        <Text color={noColor ? undefined : "yellow"}>{`Next: /${snapshot.blockingActions[0]}`}</Text>
      )}
    </Box>
  );
}
