import React from "react";
import { Box, Text } from "ink";
import type { TuiActionExecutionState } from "../action-executor.js";

export function ActionStatusView({
  state,
  noColor = false,
}: {
  state: TuiActionExecutionState;
  noColor?: boolean;
}) {
  const color = noColor
    ? undefined
    : state.status === "failed"
      ? "red"
      : state.status === "succeeded"
        ? "green"
        : "yellow";
  const label = state.status === "idle" ? "Ready" : state.status;

  return (
    <Box borderStyle="single" borderColor={color} flexDirection="column" paddingX={1}>
      <Text color={color}>{`Action: ${label}`}</Text>
      {state.message && <Text>{state.message}</Text>}
      {state.recoveryHint && <Text color={noColor ? undefined : "gray"}>{state.recoveryHint}</Text>}
    </Box>
  );
}
