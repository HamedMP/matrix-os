import React from "react";
import { Box, Text } from "ink";
import type { ShellRuntimePane, ShellRuntimeTab } from "../session-types.js";

export function ShellRuntimeViews({
  tabs,
  panes,
  layouts,
  noColor = false,
}: {
  tabs: readonly ShellRuntimeTab[];
  panes: readonly ShellRuntimePane[];
  layouts: readonly string[];
  noColor?: boolean;
}) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={noColor ? undefined : "blue"} paddingX={1}>
      <Text bold>Shell Runtime</Text>
      <Text>Tabs</Text>
      {tabs.map((tab) => <Text key={tab.index}>{`${tab.index}: ${tab.name ?? "unnamed"}`}</Text>)}
      <Text>Panes</Text>
      {panes.map((pane) => <Text key={pane.id}>{pane.title ?? pane.id}</Text>)}
      <Text>Layouts</Text>
      {layouts.map((layout) => <Text key={layout}>{layout}</Text>)}
    </Box>
  );
}
