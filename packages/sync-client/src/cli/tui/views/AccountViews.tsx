import React from "react";
import { Box, Text } from "ink";
import type { AccountProfileState } from "../account.js";

export function AccountViews({ state, noColor = false }: { state: AccountProfileState; noColor?: boolean }) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={noColor ? undefined : "cyan"} paddingX={1}>
      <Text bold>{`Profile ${state.profileName}`}</Text>
      <Text>{state.authenticated ? `Signed in${state.handle ? ` as ${state.handle}` : ""}` : "Not signed in"}</Text>
      {state.expired && <Text>Session expired</Text>}
      <Text>{state.authenticated ? "Logout" : "Login"}</Text>
    </Box>
  );
}
