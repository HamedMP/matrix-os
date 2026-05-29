import React from "react";
import { Box, Text } from "ink";
import { Mascot } from "./Mascot.js";
import type { TuiStatusSnapshot } from "../status.js";

const MATRIX_GREEN = "#00ff41";

function stateLabel(snapshot: TuiStatusSnapshot): string {
  if (snapshot.overall === "unauthenticated") {
    return "login required";
  }
  return snapshot.overall;
}

function stateColor(_snapshot: TuiStatusSnapshot): string {
  return MATRIX_GREEN;
}

export function HomeView({
  snapshot,
  columns = 80,
  rows = 24,
  noColor = false,
}: {
  snapshot: TuiStatusSnapshot;
  columns?: number;
  rows?: number;
  noColor?: boolean;
}) {
  const narrow = columns < 80;
  const wide = columns >= 92;
  const extraWide = columns >= 124;
  const stageWidth = Math.max(40, Math.min(columns, extraWide ? 120 : wide ? 96 : 76));
  const fullScreenHeight = rows >= 30 ? rows : undefined;
  const sessionLabel = `${snapshot.sessions.count} ${snapshot.sessions.count === 1 ? "session" : "sessions"}`;
  const status = `${stateLabel(snapshot)} · ${snapshot.profile.name} · ${snapshot.gateway.label} · ${sessionLabel}`;
  const color = noColor ? undefined : stateColor(snapshot);

  return (
    <Box
      flexDirection="column"
      width={stageWidth}
      height={fullScreenHeight}
      justifyContent={fullScreenHeight ? "center" : undefined}
      alignItems="center"
    >
      <Box flexDirection="column" alignItems="center" marginBottom={1}>
        <Text bold color={noColor ? undefined : MATRIX_GREEN}>MATRIX OS</Text>
      </Box>

      {!narrow && !extraWide && (
        <Box marginBottom={1} justifyContent="center">
          <Mascot state={snapshot.overall} noColor={noColor} />
        </Box>
      )}

      <Box width="100%" justifyContent="center">
        <Box flexDirection="column" width={wide ? 64 : "100%"}>
          <Box borderStyle="single" borderColor={noColor ? undefined : "gray"} flexDirection="row">
            <Box width={2} flexShrink={0} backgroundColor={noColor ? undefined : MATRIX_GREEN}>
              <Text color={noColor ? undefined : MATRIX_GREEN}>|</Text>
            </Box>
            <Box flexDirection="column" paddingX={1} paddingY={1}>
              <Text color={noColor ? undefined : "gray"}>{'Ask Matrix... "review my current PR"'}</Text>
              <Text color={noColor ? undefined : MATRIX_GREEN}>Build    Matrix    Codex    Shell</Text>
              <Text color={noColor ? undefined : "gray"}>/ commands    tab agents    s sessions    q quit</Text>
            </Box>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text color={color}>{status}</Text>
            {snapshot.blockingActions.length > 0 && (
              <Text color={noColor ? undefined : MATRIX_GREEN}>{`Next: /${snapshot.blockingActions[0]}`}</Text>
            )}
          </Box>
        </Box>
        {extraWide && (
          <Box marginLeft={3}>
            <Mascot state={snapshot.overall} noColor={noColor} />
          </Box>
        )}
      </Box>

      {narrow && (
        <Box marginTop={1}>
          <Mascot state={snapshot.overall} noColor={noColor} compact />
        </Box>
      )}
    </Box>
  );
}
