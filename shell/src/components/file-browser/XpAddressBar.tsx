"use client";

import { useState } from "react";
import { useFileBrowser } from "@/hooks/useFileBrowser";
import { XpToolMenu } from "./XpToolMenu";
import { XpChevronGlyph, XpFolderGlyph, XpRoundArrowGlyph } from "./xp-icons";
import { FILE_BROWSER_LOCATIONS } from "./file-browser-locations";

function toDisplayPath(path: string): string {
  return path === "" ? "Home" : path;
}

function toStorePath(draft: string): string {
  const trimmed = draft.trim().replace(/^\/+|\/+$/g, "");
  return trimmed === "" || trimmed === "Home" ? "" : trimmed;
}

export function XpAddressBar() {
  const currentPath = useFileBrowser((s) => s.currentPath);
  const navigate = useFileBrowser((s) => s.navigate);
  // Remount on navigation so the draft re-seeds from the store without an
  // effect (the input is an editable buffer over external navigation state).
  return (
    <XpAddressBarInner
      key={currentPath}
      currentPath={currentPath}
      onNavigate={navigate}
    />
  );
}

function XpAddressBarInner({
  currentPath,
  onNavigate,
}: {
  currentPath: string;
  onNavigate: (path: string) => void;
}) {
  const [draft, setDraft] = useState(() => toDisplayPath(currentPath));
  const [menuOpen, setMenuOpen] = useState(false);

  const go = () => onNavigate(toStorePath(draft));

  const locationItems = [
    { label: "Home", action: () => onNavigate("") },
    ...FILE_BROWSER_LOCATIONS.map((loc) => ({
      label: loc.name,
      action: () => onNavigate(loc.path),
    })),
  ];

  return (
    <div className="xp-address-bar">
      <span className="xp-address-label">Address</span>
      <div className="xp-address-combo">
        <XpFolderGlyph size={16} />
        <input
          className="xp-address-input"
          aria-label="Address"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              go();
            }
          }}
        />
        <XpToolMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          items={locationItems}
          trigger={
            <button
              type="button"
              className="xp-address-chevron"
              aria-label="Address locations"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <XpChevronGlyph />
            </button>
          }
        />
      </div>
      <button type="button" className="xp-go-btn" aria-label="Go" onClick={go}>
        <XpRoundArrowGlyph size={16} direction="right" />
        Go
      </button>
    </div>
  );
}
