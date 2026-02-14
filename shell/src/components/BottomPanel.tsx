"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useCommandStore } from "@/stores/commands";
import { Terminal } from "./Terminal";
import { ModuleGraph } from "./ModuleGraph";
import { ActivityFeed } from "./ActivityFeed";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  TerminalSquareIcon,
  NetworkIcon,
  ActivityIcon,
  ChevronDownIcon,
  ChevronUpIcon,
} from "lucide-react";

type Tab = "terminal" | "graph" | "activity";

const STORAGE_KEY = "matrix-os-bottom-panel";

function loadPreference(): { open: boolean; tab: Tab } {
  if (typeof window === "undefined") return { open: false, tab: "terminal" };
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch {
    // ignore
  }
  return { open: false, tab: "terminal" };
}

function savePreference(open: boolean, tab: Tab) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ open, tab }));
  } catch {
    // ignore
  }
}

export function BottomPanel() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("terminal");

  useEffect(() => {
    const pref = loadPreference();
    setOpen(pref.open);
    setTab(pref.tab);
  }, []);

  const selectTab = useCallback(
    (t: Tab) => {
      if (t === tab && open) {
        setOpen(false);
        savePreference(false, t);
      } else {
        setTab(t);
        setOpen(true);
        savePreference(true, t);
      }
    },
    [tab, open],
  );

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      savePreference(next, tab);
      return next;
    });
  }, [tab]);

  const register = useCommandStore((s) => s.register);
  const unregister = useCommandStore((s) => s.unregister);
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;

  useEffect(() => {
    register([
      {
        id: "action:toggle-bottom-panel",
        label: "Toggle Bottom Panel",
        group: "Actions",
        shortcut: "Cmd+J",
        keywords: ["terminal", "activity", "modules", "panel"],
        execute: () => toggleRef.current(),
      },
    ]);
    return () => unregister(["action:toggle-bottom-panel"]);
  }, [register, unregister]);

  return (
    <div className="flex flex-col border-t border-border bg-card">
      <div className="flex items-center gap-1 px-2 py-1">
        <Button
          variant={tab === "terminal" ? "secondary" : "ghost"}
          size="sm"
          className="h-6 gap-1.5 text-xs"
          onClick={() => selectTab("terminal")}
        >
          <TerminalSquareIcon className="size-3" />
          Terminal
        </Button>
        <Button
          variant={tab === "graph" ? "secondary" : "ghost"}
          size="sm"
          className="h-6 gap-1.5 text-xs"
          onClick={() => selectTab("graph")}
        >
          <NetworkIcon className="size-3" />
          Modules
        </Button>
        <Button
          variant={tab === "activity" ? "secondary" : "ghost"}
          size="sm"
          className="h-6 gap-1.5 text-xs"
          onClick={() => selectTab("activity")}
        >
          <ActivityIcon className="size-3" />
          Activity
        </Button>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="size-5"
          onClick={toggle}
        >
          {open ? (
            <ChevronDownIcon className="size-3" />
          ) : (
            <ChevronUpIcon className="size-3" />
          )}
        </Button>
      </div>

      <div
        className="overflow-hidden transition-[max-height] duration-200 ease-in-out"
        style={{ maxHeight: open ? 240 : 0 }}
      >
        <Separator />
        <div className="h-[240px] min-h-0">
          {tab === "terminal" && <Terminal />}
          {tab === "graph" && <ModuleGraph />}
          {tab === "activity" && (
            <div className="h-full overflow-y-auto">
              <ActivityFeed />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
