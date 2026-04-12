"use client";

import React, { useState, useEffect, useRef } from "react";

interface GroupEntry {
  slug: string;
  name: string;
  member_count?: number;
}

interface GroupSwitcherProps {
  onGroupChange: (slug: string | null) => void;
  activeGroupSlug?: string | null;
}

export function GroupSwitcher({ onGroupChange, activeGroupSlug }: GroupSwitcherProps) {
  const [groups, setGroups] = useState<GroupEntry[]>([]);
  const [open, setOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current = new AbortController();
    fetch("/api/groups", { signal: abortRef.current.signal })
      .then((r) => r.json())
      .then((data: GroupEntry[]) => setGroups(data))
      .catch(() => {
        // fetch aborted on unmount — ignore
      });

    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const activeGroup = groups.find((g) => g.slug === activeGroupSlug);
  const triggerLabel = activeGroup ? activeGroup.name : "Personal";

  function select(slug: string | null) {
    onGroupChange(slug);
    setOpen(false);
  }

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {triggerLabel}
      </button>

      {open && (
        <ul role="listbox" style={{ position: "absolute", top: "100%", left: 0, background: "white", border: "1px solid #ccc", listStyle: "none", margin: 0, padding: 0, minWidth: 160 }}>
          <li
            role="option"
            aria-selected={!activeGroupSlug}
            onClick={() => select(null)}
            style={{ padding: "8px 12px", cursor: "pointer" }}
          >
            Personal
          </li>
          {groups.map((g) => (
            <li
              key={g.slug}
              role="option"
              aria-selected={g.slug === activeGroupSlug}
              onClick={() => select(g.slug)}
              style={{ padding: "8px 12px", cursor: "pointer" }}
            >
              {g.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
