// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryImport } from "../../packages/ui/src/memory-workspace/MemoryImport";
import { MemoryEditor } from "../../packages/ui/src/memory-workspace/MemoryEditor";
import { SHELL_Z_INDEX } from "../../shell/src/lib/shell-layering";
import type {
  MemoryImportSource,
  MemorySource,
  MemoryWorkspaceClient,
} from "../../packages/ui/src/memory-workspace/model";
const source: MemorySource = {
  id: "source-one",
  title: "note",
  content: "body",
  preview: "body",
  kind: "note",
  collection: "Imported",
  revision: 1,
  occurredAt: null,
  updatedAt: "2026-10-05T10:00:00Z",
  ingestion: { hindsight: "ready", openviking: "ready" },
};
function client(): MemoryWorkspaceClient {
  return {
    snapshot: vi.fn(),
    getSource: vi.fn(),
    importSources: vi.fn(),
    updateSource: vi.fn(),
    deleteSource: vi.fn(),
    search: vi.fn(),
    compare: vi.fn(),
  };
}
async function importFile(view: ReturnType<typeof render>) {
  const file = new File(["body"], "note.md");
  Object.defineProperty(file, "text", { value: async () => "body" });
  fireEvent.change(view.container.querySelector('input[type="file"]')!, {
    target: { files: [file] },
  });
  await screen.findByText("note");
  fireEvent.click(screen.getByRole("button", { name: /Import 1 source/ }));
}
afterEach(cleanup);
it("uses a new intent after deletion so a stale receipt cannot hide the tombstone conflict", async () => {
  const api = client();
  let previousRequest: string | undefined;
  let deleted = false;
  const importSources = vi.fn(
    async (_records: MemoryImportSource[], requestId: string) => {
      if (requestId === previousRequest) return { sources: [] };
      previousRequest = requestId;
      if (deleted)
        throw Object.assign(new Error("safe_failure"), { status: 409 });
      return { sources: [source] };
    },
  );
  api.importSources = importSources;
  const firstImported = vi.fn().mockResolvedValue(undefined);
  const first = render(
    <MemoryImport client={api} onClose={() => {}} onImported={firstImported} />,
  );
  await importFile(first);
  await waitFor(() => expect(firstImported).toHaveBeenCalledTimes(1));
  first.unmount();
  deleted = true;
  const laterImported = vi.fn();
  const later = render(
    <MemoryImport client={api} onClose={() => {}} onImported={laterImported} />,
  );
  await importFile(later);
  await waitFor(() => expect(importSources).toHaveBeenCalledTimes(2));
  expect(importSources.mock.calls[1][1]).not.toBe(
    importSources.mock.calls[0][1],
  );
  expect(importSources.mock.calls[1][0]).toEqual(
    importSources.mock.calls[0][0],
  );
  expect(importSources.mock.calls[1][0][0].restoreDeleted).toBeUndefined();
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(laterImported).not.toHaveBeenCalled();
});
it("a later explicit import receives current source receipts rather than replaying an old revision", async () => {
  const api = client();
  let previousRequest: string | undefined;
  let revision = 1;
  api.importSources = vi.fn(
    async (_records: MemoryImportSource[], requestId: string) => {
      const current = requestId === previousRequest ? 1 : revision;
      previousRequest = requestId;
      return { sources: [{ ...source, revision: current }] };
    },
  );
  const refreshed = vi.fn().mockResolvedValue(undefined);
  const first = render(
    <MemoryImport client={api} onClose={() => {}} onImported={refreshed} />,
  );
  await importFile(first);
  await waitFor(() => expect(refreshed).toHaveBeenCalledTimes(1));
  first.unmount();
  revision = 3;
  const later = render(
    <MemoryImport client={api} onClose={() => {}} onImported={refreshed} />,
  );
  await importFile(later);
  await waitFor(() => expect(refreshed).toHaveBeenCalledTimes(2));
  const calls = vi.mocked(api.importSources).mock.calls;
  expect(calls[1][1]).not.toBe(calls[0][1]);
  expect(
    (await vi.mocked(api.importSources).mock.results[1].value).sources[0]
      .revision,
  ).toBe(3);
});
it("keeps an empty replay visible as failure instead of closing the import dialog", async () => {
  const api = client();
  api.importSources = vi.fn().mockResolvedValue({ sources: [] });
  const refreshed = vi.fn();
  const view = render(
    <MemoryImport client={api} onClose={() => {}} onImported={refreshed} />,
  );
  await importFile(view);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(refreshed).not.toHaveBeenCalled();
});
it.each(["import", "editor"])(
  "uses the central app-dialog layer for the %s modal and backdrop",
  (kind) => {
    const api = client();
    const view = render(
      kind === "import" ? (
        <MemoryImport
          client={api}
          onClose={() => {}}
          onImported={async () => {}}
        />
      ) : (
        <MemoryEditor
          client={api}
          source={null}
          onClose={() => {}}
          onSaved={async () => {}}
        />
      ),
    );
    expect(
      view.container.querySelector<HTMLElement>(".mw-dialog")!.style.zIndex,
    ).toBe(String(SHELL_Z_INDEX.appDialog));
    expect(
      view.container.querySelector<HTMLElement>(".mw-dialog-backdrop")!.style
        .zIndex,
    ).toBe(String(SHELL_Z_INDEX.appDialog));
    expect(SHELL_Z_INDEX.appDialog).toBeGreaterThan(
      SHELL_Z_INDEX.fullscreenWindow,
    );
    expect(SHELL_Z_INDEX.appDialog).toBeLessThan(SHELL_Z_INDEX.settings);
  },
);
