import React from "react";
import { Box, Text } from "ink";

export interface InstanceViewState {
  handle: string;
  health: "healthy" | "degraded" | "offline" | "unknown";
  logsAvailable: boolean;
  restartEligible: boolean;
}

export function InstanceViews({ state, noColor = false }: { state: InstanceViewState; noColor?: boolean }) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={noColor ? undefined : "yellow"} paddingX={1}>
      <Text bold>{`Instance ${state.handle}`}</Text>
      <Text>{state.health}</Text>
      {state.logsAvailable && <Text>Logs</Text>}
      {state.restartEligible && <Text>Restart</Text>}
    </Box>
  );
}
