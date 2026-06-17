// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PanelStrip from "../../desktop/src/renderer/src/features/workspace/PanelStrip";
import { defaultLayout, useWorkspace, type PanelLayout } from "../../desktop/src/renderer/src/stores/workspace";

const groupHarness = vi.hoisted(() => ({
  props: null as null | {
    onLayoutChange?: (layout: Record<string, number>) => void;
    onLayoutChanged?: (layout: Record<string, number>) => void;
  },
}));

vi.mock("react-resizable-panels", () => ({
  Group: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => {
    groupHarness.props = props as typeof groupHarness.props;
    return <div data-testid="panel-group">{children}</div>;
  },
  Panel: ({ children }: React.PropsWithChildren<{ id: string }>) => <section>{children}</section>,
  Separator: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

describe("PanelStrip layout persistence", () => {
  beforeEach(() => {
    const layout: PanelLayout = defaultLayout(1);
    useWorkspace.setState({
      layouts: {
        "task-1": {
          ...layout,
          visible: { ...layout.visible, editor: true },
          sizes: { ...layout.sizes, terminal: 70, editor: 30 },
        },
      },
    });
    groupHarness.props = null;
  });

  afterEach(() => {
    cleanup();
    useWorkspace.setState({ layouts: {} });
  });

  it("persists panel sizes from the layout change callback", () => {
    render(<PanelStrip taskId="task-1" renderPanel={(panel) => <div>{panel}</div>} />);

    expect(groupHarness.props?.onLayoutChange).toEqual(expect.any(Function));
    expect(groupHarness.props?.onLayoutChanged).toBeUndefined();

    act(() => {
      groupHarness.props?.onLayoutChange?.({ terminal: 64, editor: 36 });
    });

    expect(useWorkspace.getState().layouts["task-1"]?.sizes).toMatchObject({
      terminal: 64,
      editor: 36,
    });
  });
});
