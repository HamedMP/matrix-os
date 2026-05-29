import React, { useEffect, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import { DEFAULT_TUI_ACTIONS, type TuiAction } from "./actions.js";
import {
  createTuiActionExecutor,
  type TuiActionExecutionResult,
  type TuiActionExecutionState,
  type TuiActionExecutor,
} from "./action-executor.js";
import { createTuiSafeError } from "./errors.js";
import { normalizeTuiError } from "./errors.js";
import { getQuickActionByShortcut, getQuickActions } from "./quick-actions.js";
import { searchTuiActions } from "./palette.js";
import { aggregateTuiStatusSnapshot, type TuiStatusSnapshot } from "./status.js";
import { getTerminalCapabilities } from "./terminal.js";
import { CommandPalette } from "./views/CommandPalette.js";
import { HomeView } from "./views/HomeView.js";
import { ActionStatusView } from "./views/ActionStatusView.js";
import { SessionsView, type SessionsViewState } from "./views/SessionsView.js";
import type { MatrixSessionSummary } from "./session-types.js";

const ENTER_ALTERNATE_SCREEN = "\u001B[?1049h\u001B[H\u001B[2J";
const EXIT_ALTERNATE_SCREEN = "\u001B[?1049l";

export function resolvePaletteEnterAction(results: readonly TuiAction[], selectedIndex: number): TuiAction | undefined {
  return selectedIndex >= 0 && selectedIndex < results.length ? results[selectedIndex] : undefined;
}

export function resolveHomeEnterAction(actions: readonly TuiAction[], selectedQuickActionIndex: number): TuiAction | undefined {
  const quickAction = getQuickActions(actions)[selectedQuickActionIndex];
  return quickAction?.action;
}

export function resolveHomeShortcutAction(input: string, actions: readonly TuiAction[]): TuiAction | undefined {
  return getQuickActionByShortcut(input, actions)?.action;
}

export async function executeTuiActionWithRefresh({
  action,
  executor,
  snapshot,
  loadStatusSnapshot,
}: {
  action: TuiAction;
  executor: TuiActionExecutor;
  snapshot?: TuiStatusSnapshot;
  loadStatusSnapshot: () => Promise<TuiStatusSnapshot>;
}): Promise<{ result: TuiActionExecutionResult; snapshot?: TuiStatusSnapshot }> {
  const result = await executor.execute(action, { snapshot });
  if (result.status === "succeeded" && result.refreshes.length > 0) {
    return { result, snapshot: await loadStatusSnapshot() };
  }
  return { result };
}

function createSnapshotFailure(error: unknown): TuiStatusSnapshot {
  const unknownSubsystem = { state: "unknown" as const, label: "unknown" };
  return {
    overall: "blocked",
    profile: { name: "unknown", gatewayUrl: "unknown", platformUrl: "unknown", state: "unknown" },
    auth: { state: "unknown" },
    gateway: unknownSubsystem,
    daemon: unknownSubsystem,
    sync: unknownSubsystem,
    sessions: { state: "unknown", count: 0 },
    blockingActions: ["retry"],
    refreshedAt: new Date().toISOString(),
    safeError: normalizeTuiError(error),
  };
}

export interface MatrixTuiAppProps {
  initialSnapshot?: TuiStatusSnapshot;
  noColor?: boolean;
  actions?: readonly TuiAction[];
  executor?: TuiActionExecutor;
  loadStatusSnapshot?: () => Promise<TuiStatusSnapshot>;
  loadShellSessions?: () => Promise<MatrixSessionSummary[]>;
}

export function MatrixTuiApp({
  initialSnapshot,
  noColor = false,
  actions = DEFAULT_TUI_ACTIONS,
  executor = createTuiActionExecutor(),
  loadStatusSnapshot = aggregateTuiStatusSnapshot,
  loadShellSessions,
}: MatrixTuiAppProps) {
  const { exit } = useApp();
  const [snapshot, setSnapshot] = useState<TuiStatusSnapshot | null>(initialSnapshot ?? null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedQuickActionIndex, setSelectedQuickActionIndex] = useState(0);
  const [viewMode, setViewMode] = useState<"home" | "sessions">("home");
  const [sessions, setSessions] = useState<MatrixSessionSummary[]>([]);
  const [sessionsState, setSessionsState] = useState<SessionsViewState>("empty");
  const [execution, setExecution] = useState<TuiActionExecutionState>({ status: "idle" });
  const capabilities = getTerminalCapabilities({ noColor });
  const paletteResults = searchTuiActions(actions, paletteQuery, 8);

  const executeAction = (action: TuiAction | undefined) => {
    if (execution.status === "running") {
      return;
    }
    if (!action) {
      setExecution({
        status: "failed",
        message: "No action selected",
        error: createTuiSafeError("action_unavailable", { message: "No action selected" }),
      });
      return;
    }
    if (action.id === "shell.sessions") {
      setViewMode("sessions");
      return;
    }
    setExecution({ actionId: action.id, status: "running", message: `Running ${action.title}` });
    void executeTuiActionWithRefresh({
      action,
      executor,
      snapshot: snapshot ?? undefined,
      loadStatusSnapshot,
    }).then(({ result, snapshot: refreshedSnapshot }) => {
      setExecution({
        actionId: result.actionId,
        status: result.status,
        message: result.message,
        recoveryHint: result.recoveryHint,
        error: result.error,
      });
      if (refreshedSnapshot) {
        setSnapshot(refreshedSnapshot);
      }
    }).catch((error: unknown) => {
      const safeError = normalizeTuiError(error);
      setExecution({
        actionId: action.id,
        status: "failed",
        message: safeError.message,
        recoveryHint: "Run doctor and try again.",
        error: safeError,
      });
    });
  };

  useInput((input, key) => {
    if (key.escape) {
      if (viewMode === "sessions") {
        setViewMode("home");
        return;
      }
      setPaletteOpen(false);
      setPaletteQuery("");
      setSelectedIndex(0);
      return;
    }
    if (input === "/" || (key.ctrl && input === "p")) {
      setPaletteOpen(true);
      setSelectedIndex(0);
      return;
    }
    if (!paletteOpen && input === "q") {
      exit();
      return;
    }
    if (!paletteOpen && key.upArrow) {
      setSelectedQuickActionIndex((value) => Math.max(0, value - 1));
      return;
    }
    if (!paletteOpen && key.downArrow) {
      setSelectedQuickActionIndex((value) => Math.min(Math.max(0, getQuickActions(actions).length - 1), value + 1));
      return;
    }
    if (!paletteOpen && key.return) {
      executeAction(resolveHomeEnterAction(actions, selectedQuickActionIndex));
      return;
    }
    if (!paletteOpen && input) {
      const action = resolveHomeShortcutAction(input, actions);
      if (action) {
        executeAction(action);
        return;
      }
    }
    if (paletteOpen && key.upArrow) {
      setSelectedIndex((value) => Math.max(0, value - 1));
      return;
    }
    if (paletteOpen && key.downArrow) {
      setSelectedIndex((value) => Math.min(Math.max(0, paletteResults.length - 1), value + 1));
      return;
    }
    if (paletteOpen && key.return) {
      const action = resolvePaletteEnterAction(paletteResults, selectedIndex);
      setPaletteOpen(false);
      setPaletteQuery("");
      setSelectedIndex(0);
      executeAction(action);
      return;
    }
    if (paletteOpen && key.backspace) {
      setPaletteQuery((value) => value.slice(0, -1));
      setSelectedIndex(0);
      return;
    }
    if (paletteOpen && input && !key.ctrl && !key.meta) {
      setPaletteQuery((value) => `${value}${input}`);
      setSelectedIndex(0);
    }
  });

  useEffect(() => {
    if (!paletteOpen || selectedIndex < paletteResults.length) {
      return;
    }
    setSelectedIndex(Math.max(0, paletteResults.length - 1));
  }, [paletteOpen, paletteResults.length, selectedIndex]);

  useEffect(() => {
    if (snapshot) {
      return;
    }
    let cancelled = false;
    loadStatusSnapshot().then((next) => {
      if (!cancelled) {
        setSnapshot(next);
      }
    }).catch((error: unknown) => {
      if (!cancelled) {
        console.error("[tui] unexpected status snapshot failure", error);
        setSnapshot(createSnapshotFailure(error));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadStatusSnapshot, snapshot]);

  useEffect(() => {
    if (viewMode !== "sessions") {
      return;
    }
    if (snapshot?.auth.state === "unauthenticated" || snapshot?.auth.state === "expired") {
      setSessionsState("unauthenticated");
      setSessions([]);
      return;
    }
    if (snapshot?.gateway.state !== "healthy") {
      setSessionsState("gateway-unavailable");
      setSessions([]);
      return;
    }
    if (!loadShellSessions) {
      setSessionsState("empty");
      setSessions([]);
      return;
    }
    let cancelled = false;
    setSessionsState("loading");
    loadShellSessions().then((next) => {
      if (!cancelled) {
        setSessions(next);
        setSessionsState(next.length > 0 ? "ready" : "empty");
      }
    }).catch((error: unknown) => {
      if (!cancelled) {
        const safeError = normalizeTuiError(error);
        setSessions([]);
        setSessionsState("error");
        setExecution({ status: "failed", message: safeError.message, error: safeError });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadShellSessions, snapshot, viewMode]);

  if (!snapshot) {
    return <Text>Loading Matrix OS...</Text>;
  }

  if (paletteOpen) {
    return (
      <CommandPalette
        results={paletteResults}
        query={paletteQuery}
        selectedIndex={selectedIndex}
        columns={capabilities.columns}
        noColor={capabilities.noColor}
      />
    );
  }

  if (viewMode === "sessions") {
    return <SessionsView sessions={sessions} state={sessionsState} noColor={capabilities.noColor} />;
  }

  return (
    <Box flexDirection="column">
      <HomeView
        snapshot={snapshot}
        columns={capabilities.columns}
        rows={capabilities.rows}
        noColor={capabilities.noColor}
        selectedQuickActionIndex={selectedQuickActionIndex}
      />
      {execution.status !== "idle" && <ActionStatusView state={execution} noColor={capabilities.noColor} />}
    </Box>
  );
}

export function shouldUseAlternateScreen({
  stdout = process.stdout,
  env = process.env,
}: {
  stdout?: NodeJS.WriteStream & { isTTY?: boolean };
  env?: NodeJS.ProcessEnv;
} = {}): boolean {
  return stdout.isTTY === true && env.TERM !== "dumb" && env.MATRIX_TUI_FULLSCREEN !== "0";
}

export async function launchTui(options: { noColor?: boolean } = {}): Promise<void> {
  const useAlternateScreen = shouldUseAlternateScreen();
  if (useAlternateScreen) {
    process.stdout.write(ENTER_ALTERNATE_SCREEN);
    const restoreAlternateScreen = () => {
      process.stdout.write(EXIT_ALTERNATE_SCREEN);
    };
    process.once("exit", restoreAlternateScreen);
    try {
      const { waitUntilExit } = render(<MatrixTuiApp noColor={options.noColor} />);
      await waitUntilExit();
    } finally {
      process.removeListener("exit", restoreAlternateScreen);
      restoreAlternateScreen();
    }
    return;
  }

  const { waitUntilExit } = render(<MatrixTuiApp noColor={options.noColor} />);
  await waitUntilExit();
}
