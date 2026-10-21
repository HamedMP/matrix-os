// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ExpandableFileTree } from "../../desktop/src/renderer/src/features/panels/ExpandableFileTree";

afterEach(cleanup);

it("expands a folder selected from a Chat path into its scoped tree", async () => {
  const loadDirectory = vi.fn(async (path: string) => path === ""
    ? [{ path: "src", kind: "directory" as const }]
    : path === "src"
      ? [{ path: "src/components", kind: "directory" as const }]
      : [{ path: "src/components/Button.tsx", kind: "file" as const }]);
  render(<ExpandableFileTree directoryPath="src/components" loadDirectory={loadDirectory} onOpenFile={vi.fn()} />);
  expect(await screen.findByRole("button", { name: "Open file src/components/Button.tsx" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Collapse folder src/components" }).getAttribute("aria-current")).toBe("true");
  await waitFor(() => expect(loadDirectory).toHaveBeenCalledWith("src/components"));
});
