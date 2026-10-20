// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import DraftDetail from "../../home/apps/app-gallery/src/store/DraftDetail";
import { createStoreClient } from "../../home/apps/app-gallery/src/store-model";
import { draft, id } from "./app-store-fixtures";
afterEach(cleanup);
it("lets the publisher inspect unchanged source before submission consent", async () => {
  const gatewayFetch = vi.fn(async (url: string) =>
    url.includes("/diff?")
      ? {
          path: "src/private-example.ts",
          change: "unchanged",
          binary: false,
          truncated: false,
          before: "const sample = 'REVIEW THIS UNCHANGED SOURCE';",
          after: "const sample = 'REVIEW THIS UNCHANGED SOURCE';",
        }
      : {
          ...draft,
          sourceFiles: [
            ...draft.changedFiles,
            { path: "src/private-example.ts", change: "unchanged" },
          ],
        },
  );
  render(
    <DraftDetail
      client={createStoreClient({ gatewayFetch, openApp: vi.fn() })}
      id={id}
      onBack={vi.fn()}
    />,
  );
  const source = await screen.findByRole("button", {
    name: "src/private-example.ts",
  });
  expect(
    gatewayFetch.mock.calls.filter(([url]) => url.includes("/diff?")),
  ).toHaveLength(0);
  expect(screen.queryByText(/REVIEW THIS UNCHANGED SOURCE/)).toBeNull();
  fireEvent.click(source);
  expect(
    await screen.findAllByText(/REVIEW THIS UNCHANGED SOURCE/),
  ).toHaveLength(2);
  expect(
    (
      screen.getByRole("button", {
        name: "Submit for review",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
