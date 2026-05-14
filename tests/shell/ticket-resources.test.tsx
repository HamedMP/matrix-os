// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TicketResourcesPanel } from "../../shell/src/components/workspace/TicketResourcesPanel.js";

describe("TicketResourcesPanel", () => {
  it("shows artifacts and approved previews in the selected ticket context", () => {
    render(<TicketResourcesPanel
      ticket={{ id: "ticket_1", identifier: "MAT-1", title: "Preview work" }}
      artifacts={[{ id: "artifact_1", label: "Patch", kind: "diff" }]}
      previews={[{ id: "preview_1", label: "Dev server", url: "https://preview.example.test", lastStatus: "ok" }]}
    />);

    expect(screen.getByText("Ticket resources")).toBeTruthy();
    expect(screen.getByText("Patch")).toBeTruthy();
    expect(screen.getByText("Dev server")).toBeTruthy();
  });
});
