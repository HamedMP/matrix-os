import React, { useEffect, useState } from "react";
import { render, Text, useInput } from "ink";
import { DEFAULT_TUI_ACTIONS } from "./actions.js";
import { normalizeTuiError } from "./errors.js";
import { searchTuiActions } from "./palette.js";
import { aggregateTuiStatusSnapshot, type TuiStatusSnapshot } from "./status.js";
import { getTerminalCapabilities } from "./terminal.js";
import { CommandPalette } from "./views/CommandPalette.js";
import { HomeView } from "./views/HomeView.js";

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

export function MatrixTuiApp({ initialSnapshot, noColor = false }: { initialSnapshot?: TuiStatusSnapshot; noColor?: boolean }) {
  const [snapshot, setSnapshot] = useState<TuiStatusSnapshot | null>(initialSnapshot ?? null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const capabilities = getTerminalCapabilities({ noColor });
  const paletteResults = searchTuiActions(DEFAULT_TUI_ACTIONS, paletteQuery, 8);

  useInput((input, key) => {
    if (key.escape) {
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
    if (paletteOpen && key.upArrow) {
      setSelectedIndex((value) => Math.max(0, value - 1));
      return;
    }
    if (paletteOpen && key.downArrow) {
      setSelectedIndex((value) => Math.min(Math.max(0, paletteResults.length - 1), value + 1));
      return;
    }
    if (paletteOpen && key.return) {
      setPaletteOpen(false);
      setPaletteQuery("");
      setSelectedIndex(0);
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
    aggregateTuiStatusSnapshot().then((next) => {
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
  }, [snapshot]);

  if (!snapshot) {
    return <Text>Loading Matrix OS...</Text>;
  }

  if (paletteOpen) {
    return <CommandPalette results={paletteResults} query={paletteQuery} selectedIndex={selectedIndex} noColor={capabilities.noColor} />;
  }

  return <HomeView snapshot={snapshot} columns={capabilities.columns} noColor={capabilities.noColor} />;
}

export async function launchTui(options: { noColor?: boolean } = {}): Promise<void> {
  const { waitUntilExit } = render(<MatrixTuiApp noColor={options.noColor} />);
  await waitUntilExit();
}
