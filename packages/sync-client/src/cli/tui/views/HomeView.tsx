import React from "react";
import { Box, Text } from "ink";
import { Mascot } from "./Mascot.js";
import type { TuiStatusSnapshot } from "../status.js";

const WORDMARK = [
  "M   M   A   TTTTT RRRR  III X   X    OOO   SSS",
  "MM MM  A A    T   R   R  I   X X    O   O S",
  "M M M AAAAA   T   RRRR   I    X     O   O  SSS",
  "M   M A   A   T   R  R   I   X X    O   O     S",
  "M   M A   A   T   R   R III X   X    OOO  SSS",
];

function stateLabel(snapshot: TuiStatusSnapshot): string {
  if (snapshot.overall === "unauthenticated") {
    return "login required";
  }
  return snapshot.overall;
}

function stateColor(snapshot: TuiStatusSnapshot): "green" | "yellow" | "cyan" {
  if (snapshot.overall === "healthy") return "green";
  if (snapshot.overall === "degraded" || snapshot.overall === "unauthenticated") return "yellow";
  return "cyan";
}

export function HomeView({
  snapshot,
  columns = 80,
  noColor = false,
}: {
  snapshot: TuiStatusSnapshot;
  columns?: number;
  noColor?: boolean;
}) {
  const narrow = columns < 80;
  const wide = columns >= 92;
  const stageWidth = Math.max(40, Math.min(columns, wide ? 96 : 76));
  const sessionLabel = `${snapshot.sessions.count} ${snapshot.sessions.count === 1 ? "session" : "sessions"}`;
  const status = `${stateLabel(snapshot)} · ${snapshot.profile.name} · ${snapshot.gateway.label} · ${sessionLabel}`;
  const color = noColor ? undefined : stateColor(snapshot);

  return (
    <Box flexDirection="column" width={stageWidth} alignItems="center">
      <Box flexDirection="column" alignItems="center" marginBottom={1}>
        {!narrow ? (
          <>
            {WORDMARK.map((line, index) => (
              <Text key={index} bold color={noColor ? undefined : "cyan"}>{line}</Text>
            ))}
            <Text color={noColor ? undefined : "gray"}>MATRIX OS</Text>
          </>
        ) : (
          <Text bold color={noColor ? undefined : "cyan"}>MATRIX OS</Text>
        )}
      </Box>

      <Box width="100%" justifyContent="center">
        <Box flexDirection="column" width={wide ? 64 : "100%"}>
          <Box borderStyle="single" borderColor={noColor ? undefined : "gray"} flexDirection="row">
            <Box width={2} flexShrink={0} backgroundColor={noColor ? undefined : "cyan"}>
              <Text color={noColor ? undefined : "cyan"}>|</Text>
            </Box>
            <Box flexDirection="column" paddingX={1} paddingY={1}>
              <Text color={noColor ? undefined : "gray"}>{'Ask Hermes... "review my current PR"'}</Text>
              <Text color={noColor ? undefined : "cyan"}>Build    Hermes    Codex    Shell</Text>
              <Text color={noColor ? undefined : "gray"}>/ commands    tab agents    s sessions    q quit</Text>
            </Box>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text color={color}>{status}</Text>
            {snapshot.blockingActions.length > 0 && (
              <Text color={noColor ? undefined : "yellow"}>{`Next: /${snapshot.blockingActions[0]}`}</Text>
            )}
          </Box>
          {!wide && !narrow && (
            <Box marginTop={1} justifyContent="center">
              <Mascot state={snapshot.overall} noColor={noColor} />
            </Box>
          )}
        </Box>
        {wide && (
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
