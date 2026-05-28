import React from "react";
import { Box, Text } from "ink";

export interface SyncViewState {
  daemon: "running" | "stopped" | "degraded";
  syncPath: string;
  peerCount: number;
  paused: boolean;
}

export function SyncViews({ state, noColor = false }: { state: SyncViewState; noColor?: boolean }) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={noColor ? undefined : "blue"} paddingX={1}>
      <Text bold>Sync setup</Text>
      <Text>{`Path ${state.syncPath}`}</Text>
      <Text>{`Daemon ${state.daemon}`}</Text>
      <Text>{`${state.peerCount} peers`}</Text>
      <Text>{state.daemon === "running" ? (state.paused ? "Resume sync" : "Pause sync") : "Start sync"}</Text>
    </Box>
  );
}
