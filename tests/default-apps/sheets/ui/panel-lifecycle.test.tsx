// @vitest-environment jsdom
import React, { StrictMode, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { createSheetGridController } from "../../../../home/apps/sheets/src/grid";
import type { SheetSession } from "../../../../home/apps/sheets/src/session/session";
import { type SheetPanels, useSheetPanels } from "../../../../home/apps/sheets/src/ui/panel-slots";
import { openModel, proposeOnModel } from "../review/fixture";

const noop = (): void => undefined;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

/** Mounts `useSheetPanels` the way the app does: under StrictMode, which sets effects up, cleans them up and sets them up again. */
async function mountPanels(session: SheetSession): Promise<{ panels: SheetPanels; unmount: () => void }> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const grid = createSheetGridController(session);
  let panels: SheetPanels | null = null;
  function Probe() {
    panels = useSheetPanels(session, grid, null, noop);
    return null;
  }
  const mounted = createRoot(document.createElement("div"));
  root = mounted;
  await act(async () => {
    mounted.render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
  });
  if (panels === null) throw new Error("the panels did not render");
  return {
    panels,
    unmount: () => {
      act(() => mounted.unmount());
      root = null;
    },
  };
}

describe("the workbook panels under StrictMode", () => {
  it("keep following the workbook and running actions after the setup, cleanup and setup cycle", async () => {
    const model = await openModel();
    const { panels } = await mountPanels(model.session);
    expect(panels.review.getState().total).toBe(0);

    act(() => proposeOnModel(model));
    expect(panels.review.getState().total).toBe(3);

    // The deterministic check needs no model; a disposed assistant would ignore it.
    await act(async () => panels.assistant.check());
    expect(panels.assistant.getState().messages.length).toBeGreaterThan(0);
  });

  it("stop following the workbook once unmounted", async () => {
    const model = await openModel();
    const { panels, unmount } = await mountPanels(model.session);
    unmount();
    proposeOnModel(model);
    expect(panels.review.getState().total).toBe(0);
    await panels.assistant.check();
    expect(panels.assistant.getState().messages).toEqual([]);
  });
});
