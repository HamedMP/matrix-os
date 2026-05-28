import React from "react";
import { Box, Text } from "ink";

export function WorkspaceDataViews({ previews, events, noColor = false }: { previews: ReadonlyArray<{ id: string; label: string; url: string }>; events: ReadonlyArray<{ id: string; type: string }>; noColor?: boolean }) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={noColor ? undefined : "green"} paddingX={1}>
      <Text bold>Previews</Text>
      {previews.map((preview) => <Text key={preview.id}>{`${preview.label} · ${preview.url}`}</Text>)}
      <Text bold>Events</Text>
      {events.map((event) => <Text key={event.id}>{event.type}</Text>)}
      <Text>Export workspace</Text>
      <Text>Delete workspace data</Text>
    </Box>
  );
}
