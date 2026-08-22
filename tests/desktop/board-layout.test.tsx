// @vitest-environment jsdom

import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Board from "../../desktop/src/renderer/src/features/board/Board";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

describe("Board responsive layout", () => {
  beforeEach(() => {
    useConnection.setState({ api: null });
    useBoard.setState({
      cardsByProject: { "matrix-os": [] },
      firstLoadByProject: { "matrix-os": false },
      error: null,
    });
  });

  afterEach(cleanup);

  it("keeps the scroll viewport shrinkable while the column row owns intrinsic width", () => {
    const { container } = render(<Board projectSlug="matrix-os" />);

    const viewport = container.querySelector('[data-slot="project-board-scroll"]');
    const board = container.querySelector('[data-slot="project-board"]');

    expect(viewport?.className).toContain("min-w-0");
    expect(viewport?.className).toContain("overflow-x-auto");
    expect(board?.className).toContain("min-w-max");
    expect(board?.className).not.toContain("overflow-x-auto");
  });
});
