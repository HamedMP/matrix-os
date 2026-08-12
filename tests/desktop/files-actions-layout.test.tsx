// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileActionMenu } from "../../desktop/src/renderer/src/features/files/FileActionMenu";
import {
  BrowserListing,
  EntryButton,
  getFileListColumns,
} from "../../desktop/src/renderer/src/features/files/browser-views";

const entry = {
  name: "note.md",
  type: "file" as const,
  sizeBytes: 12,
  modifiedAt: "2026-08-12T07:00:00.000Z",
  capabilities: { canRename: true, canMove: true, canTrash: true },
};

describe("Files list action layout", () => {
  it("reserves a fixed action column after Modified in regular and compact lists", () => {
    expect(getFileListColumns(false)).toBe("minmax(0,1fr) 72px 104px 32px");
    expect(getFileListColumns(true)).toBe("minmax(0,1fr) 64px 88px 32px");

    const columns = getFileListColumns(false);
    render(
      <BrowserListing
        grid={false}
        gridRef={{ current: null }}
        listColumns={columns}
        draftRow={null}
        buttons={(
          <EntryButton
            entry={entry}
            grid={false}
            listColumns={columns}
            selected={false}
            pressed={false}
            buttonRef={() => {}}
            onSelect={() => {}}
            onNavigate={() => {}}
            onKeyDown={() => {}}
          />
        )}
        sortKey="name"
        sortDirection="asc"
        onSort={() => {}}
      />,
    );

    const modifiedHeader = screen.getByRole("button", { name: "Sort by modified" });
    const header = modifiedHeader.parentElement;
    const row = screen.getByRole("button", { name: "Open note.md" });
    expect(header?.style.gridTemplateColumns).toBe(columns);
    expect(row.style.gridTemplateColumns).toBe(columns);
    expect(header?.lastElementChild?.getAttribute("aria-hidden")).toBe("true");
    expect(row.lastElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  it("reveals the accessible action button on hover, focus-within, or selection", () => {
    const onMenuOpen = vi.fn();
    const view = render(
      <Tooltip.Provider>
        <FileActionMenu label="note.md" items={[]} selected={false} onMenuOpen={onMenuOpen}>
          <button type="button">Open note.md</button>
        </FileActionMenu>
      </Tooltip.Provider>,
    );

    const action = screen.getByRole("button", { name: "More actions for note.md" });
    expect(action.className).toContain("opacity-0");
    expect(action.className).toContain("group-hover:opacity-100");
    expect(action.className).toContain("group-focus-within:opacity-100");
    expect(action.getAttribute("tabindex")).not.toBe("-1");

    view.rerender(
      <Tooltip.Provider>
        <FileActionMenu label="note.md" items={[]} selected onMenuOpen={onMenuOpen}>
          <button type="button">Open note.md</button>
        </FileActionMenu>
      </Tooltip.Provider>,
    );
    expect(screen.getByRole("button", { name: "More actions for note.md" }).className).toContain("opacity-100");
  });
});
