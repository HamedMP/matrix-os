import React from "react";
import { Box, Text } from "ink";
import { getQuickActions, type QuickAction } from "../quick-actions.js";
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
  selectedQuickActionIndex = 0,
  quickActions = getQuickActions(),
}: {
  snapshot: TuiStatusSnapshot;
  columns?: number;
  rows?: number;
  noColor?: boolean;
  selectedQuickActionIndex?: number;
  quickActions?: readonly QuickAction[];
}) {
  const narrow = columns < 80;
  const showFullMascot = columns >= 96;
  const stageWidth = Math.max(40, Math.min(columns, showFullMascot ? 112 : narrow ? 60 : 76));
  const quickActionWidth = showFullMascot ? 42 : "100%";
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
    >
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={noColor ? undefined : MATRIX_GREEN}>MATRIX OS</Text>
        <Text color={noColor ? undefined : "gray"}>Action console</Text>
      </Box>

      <Box flexDirection={showFullMascot ? "row" : "column"}>
        <Box borderStyle="single" borderColor={noColor ? undefined : "gray"} flexDirection="column" paddingX={1} width={quickActionWidth}>
          <Text color={noColor ? undefined : "gray"}>Quick actions</Text>
          {quickActions.map((quickAction, index) => {
            const selected = index === selectedQuickActionIndex;
            const prefix = selected ? ">" : " ";
            return (
              <Text key={quickAction.id} color={selected && !noColor ? MATRIX_GREEN : undefined}>
                {`${prefix} [${quickAction.shortcut}] ${quickAction.action.title}`}
              </Text>
            );
          })}
          <Text color={noColor ? undefined : "gray"}>
            {narrow ? "/ palette · q quit" : "/ palette · arrows select · enter run · q quit"}
          </Text>
        </Box>

        {showFullMascot ? (
          <Box marginLeft={2}>
            <Mascot state={snapshot.overall} noColor={noColor} />
          </Box>
        ) : (
          <Box marginTop={1}>
            <Mascot state={snapshot.overall} noColor={noColor} compact />
          </Box>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={color}>{status}</Text>
        {snapshot.blockingActions.length > 0 && (
          <Text color={noColor ? undefined : MATRIX_GREEN}>{`Next: /${snapshot.blockingActions[0]}`}</Text>
        )}
      </Box>
    </Box>
  );
}
