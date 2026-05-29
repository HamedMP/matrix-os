import React from "react";
import { Box, Text } from "ink";
import type { TuiAction } from "../actions.js";

export function CommandPalette({
  results,
  query,
  selectedIndex = 0,
  noColor = false,
}: {
  results: readonly TuiAction[];
  query: string;
  selectedIndex?: number;
  noColor?: boolean;
}) {
  return (
    <Box borderStyle="single" borderColor={noColor ? undefined : "yellow"} flexDirection="column" paddingX={1}>
      <Text bold>Command Palette</Text>
      <Text>{`/${query}`}</Text>
      {results.map((action, index) => (
        <Box key={action.id}>
          <Text color={noColor ? undefined : index === selectedIndex ? "yellow" : undefined}>
            {index === selectedIndex ? "> " : "  "}{action.title}
          </Text>
          <Text color={noColor ? undefined : "gray"}>  {action.group}</Text>
        </Box>
      ))}
      {results.length === 0 && <Text>No commands found</Text>}
    </Box>
  );
}
