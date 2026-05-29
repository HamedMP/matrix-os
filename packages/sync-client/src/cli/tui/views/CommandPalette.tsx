import React from "react";
import { Box, Text } from "ink";
import type { TuiAction } from "../actions.js";

function actionDescription(action: TuiAction): string {
  return action.intents[0] ?? action.aliases[0] ?? action.group;
}

function paddedTitle(title: string): string {
  return title.length >= 34 ? `${title}  ` : title.padEnd(34);
}

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
    <Box borderStyle="single" borderColor={noColor ? undefined : "cyan"} flexDirection="column" paddingX={1} paddingY={1} width={76}>
      <Box justifyContent="space-between">
        <Text bold color={noColor ? undefined : "cyan"}>MATRIX COMMANDS</Text>
        <Text color={noColor ? undefined : "gray"}>esc closes</Text>
      </Box>
      <Text color={noColor ? undefined : "gray"}>{`/${query}`}</Text>
      {results.map((action, index) => (
        <Box key={action.id} marginTop={1} flexDirection="column">
          <Text color={noColor ? undefined : index === selectedIndex ? "yellow" : undefined}>
            {index === selectedIndex ? "> " : "  "}{paddedTitle(action.title)}{action.group}
          </Text>
          <Text color={noColor ? undefined : "gray"}>
            {"    "}{actionDescription(action)}
          </Text>
        </Box>
      ))}
      {results.length === 0 && <Text>No commands found</Text>}
    </Box>
  );
}
