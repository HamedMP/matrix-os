import React from "react";
import { Box, Text } from "ink";
import type { ConfirmationRequest } from "../confirmations.js";

export function ConfirmationOverlay({
  request,
  typedValue,
  noColor = false,
}: {
  request: ConfirmationRequest;
  typedValue: string;
  noColor?: boolean;
}) {
  return (
    <Box borderStyle="double" borderColor={noColor ? undefined : "red"} flexDirection="column" paddingX={1}>
      <Text bold>{request.title}</Text>
      <Text>{request.prompt}</Text>
      {request.danger === "exact-phrase" && <Text>{request.confirmationPhrase}</Text>}
      <Text>{`Input: ${typedValue}`}</Text>
      <Text color={noColor ? undefined : "gray"}>Esc cancels · Enter confirms</Text>
    </Box>
  );
}
