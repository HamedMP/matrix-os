import React from "react";
import { Box, Text } from "ink";
import type { TuiOverallState } from "../status.js";

const RABBIT_ART = [
  "                      .@@.",
  "                        .@@@@.",
  "                          @@@@@",
  "            .@@.           @@@@@.",
  "             .@@@@oo.         @@@@.",
  "                @@@@@@@o.      @@@'",
  "                  '@@@@@@@@o.    @@.",
  "                      'o@@@@@o.  @@'",
  "                           '@@@o  .@@@@.",
  "                                .@@@@@@@@.",
  "                                @@@@@@@@@@",
  "                                 '@@@@@@@'",
  "",
  "                      .@@@@oo.o@@@.  ..",
  "            .@@@@o.   @@@@@@@@@@@@. .@@.",
  "            @@@@@@@@@@@@@@@'  ''   .@@@@@.",
  "             '@@@@'' '@@@'   ''    '''''",
  "",
  "        .@@@@@@@@@@o.  .@@@.  .@@@@@@@o.",
  "       @@@@@@@@@@@@@@o.@@@@@o@@@@@@@@@@@@.",
  "        '@@@'  '@@@'   '@@'   '@@' '@@@'",
  "",
  "   .@@@@.",
  "  @@@@@@@. .@@@@@. .o@@@@@@@@@o. .@@@. .@@@.",
  "  '@@@@'  @@@@@@@.@@@@@@@@@@@@@@.'@@@' '@@@'",
];

const COMPACT_RABBIT = "rabbit: .@@. @@@";

function mascotColor(state: TuiOverallState): "green" | "yellow" | "cyan" {
  if (state === "healthy") return "green";
  if (state === "degraded" || state === "unauthenticated") return "yellow";
  return "cyan";
}

export function Mascot({ state, noColor, compact = false }: { state: TuiOverallState; noColor?: boolean; compact?: boolean }) {
  const color = noColor ? undefined : mascotColor(state);

  if (compact) {
    return <Text color={color}>{COMPACT_RABBIT}</Text>;
  }

  return (
    <Box flexDirection="column" alignItems="center">
      {RABBIT_ART.map((line, index) => (
        <Text key={index} color={color}>{line}</Text>
      ))}
    </Box>
  );
}
