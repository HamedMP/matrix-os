import React from "react";
import { Box, Text } from "ink";
import { DEFAULT_TUI_ACTIONS } from "../actions.js";

export function HelpView({ noColor = false }: { noColor?: boolean }) {
  return (
    <Box flexDirection="column">
      <Text bold>Matrix OS Commands</Text>
      {DEFAULT_TUI_ACTIONS.map((action) => (
        <Text key={action.id} color={noColor ? undefined : "gray"}>{`${action.title} · ${action.group}`}</Text>
      ))}
    </Box>
  );
}

export function AboutView() {
  return <Text>Matrix OS CLI TUI</Text>;
}
