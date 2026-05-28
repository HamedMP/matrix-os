import React from "react";
import { Box, Text } from "ink";
import type { TuiStatusSnapshot } from "../status.js";

export function FirstRunView({ snapshot, noColor = false }: { snapshot: TuiStatusSnapshot; noColor?: boolean }) {
  const needsLogin = snapshot.auth.state === "unauthenticated" || snapshot.auth.state === "expired";
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={noColor ? undefined : "green"} paddingX={1}>
      <Text bold>Welcome to Matrix OS</Text>
      <Text>{`Profile ${snapshot.profile.name}`}</Text>
      {needsLogin ? (
        <Text>Log in to connect your Matrix instance</Text>
      ) : (
        <>
          <Text>{`Signed in${snapshot.auth.handle ? ` as ${snapshot.auth.handle}` : ""}`}</Text>
          <Text>Start sync at ~/matrixos</Text>
        </>
      )}
    </Box>
  );
}
