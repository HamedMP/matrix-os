import React from "react";
import { Box, Text } from "ink";

export function SessionForms({ mode, noColor = false }: { mode: "create-shell" | "remote-run" | "create-coding"; noColor?: boolean }) {
  const title = mode === "create-shell" ? "Create shell session" : mode === "remote-run" ? "Remote run" : "Create coding session";
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={noColor ? undefined : "green"} paddingX={1}>
      <Text bold>{title}</Text>
      <Text>Name</Text>
      <Text>Project / cwd</Text>
      <Text>Command or prompt</Text>
    </Box>
  );
}
