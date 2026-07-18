"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { ChevronDownIcon, PlusIcon, XIcon } from "lucide-react";

import { useTerminalAppContext } from "./TerminalAppContext";
import { DEFAULT_CWD } from "./terminal-layout";
import type { TerminalDesignId } from "./terminal-design";
import "./terminal-designs.css";

/**
 * OS-design-native tab strip for the terminal interior. Rendered only when an
 * OS design (winxp / win11 / macos-glass) is active; the default Matrix
 * terminal keeps its sessions drawer instead. All tab operations go through
 * the shared TerminalAppContext, so activate/create/close behave exactly like
 * the existing keyboard shortcuts and sidebar actions. Visual variants are
 * driven by `data-design` + the `data-terminal-design` ancestor attribute in
 * terminal-designs.css.
 */
export function TerminalDesignTabStrip({ design }: { design: TerminalDesignId }) {
  const ctx = useTerminalAppContext();
  const [tabListOpen, setTabListOpen] = useState(false);
  const tabListRef = useRef<HTMLDivElement>(null);
  const closeTabList = () => setTabListOpen(false);
  const closeTabListEvent = useEffectEvent(closeTabList);

  useEffect(() => {
    if (!tabListOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!tabListRef.current?.contains(event.target as Node)) closeTabListEvent();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeTabListEvent();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [tabListOpen]);

  const createTab = () => {
    void ctx.createShellSessionTab("Shell", ctx.sidebarSelectedPath ?? DEFAULT_CWD);
  };

  return (
    <div
      className="terminal-design-tabstrip"
      data-design={design}
      data-testid="terminal-design-tabstrip"
    >
      <div className="terminal-design-tabstrip-tabs" role="tablist" aria-label="Terminal tabs">
        {ctx.tabs.map((tab) => {
          const active = tab.id === ctx.activeTabId;
          return (
            <div
              key={tab.id}
              className="terminal-design-tab"
              data-active={active ? "true" : undefined}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="terminal-design-tab-activate"
                onClick={() => ctx.setActiveTab(tab.id)}
              >
                <span className="terminal-design-tab-label">{tab.label}</span>
              </button>
              <button
                type="button"
                className="terminal-design-tab-close"
                aria-label={`Close ${tab.label}`}
                onClick={() => ctx.closeTab(tab.id)}
              >
                <XIcon size={12} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      <div className="terminal-design-tabstrip-actions" ref={tabListRef}>
        <button
          type="button"
          className="terminal-design-tabstrip-button"
          aria-label="New tab"
          title="New tab"
          onClick={createTab}
        >
          <PlusIcon size={13} strokeWidth={2} aria-hidden="true" />
        </button>
        {design === "win11" ? (
          <>
            <button
              type="button"
              className="terminal-design-tabstrip-button"
              aria-label="Open tab list"
              aria-expanded={tabListOpen}
              title="Open tab list"
              onClick={() => setTabListOpen((open) => !open)}
            >
              <ChevronDownIcon size={13} strokeWidth={2} aria-hidden="true" />
            </button>
            {tabListOpen ? (
              <div className="terminal-design-tablist-menu" role="menu" aria-label="Open tabs">
                {ctx.tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={tab.id === ctx.activeTabId}
                    className="terminal-design-tablist-menu-item"
                    onClick={() => {
                      ctx.setActiveTab(tab.id);
                      setTabListOpen(false);
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
