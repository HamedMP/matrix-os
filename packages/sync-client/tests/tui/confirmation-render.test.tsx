import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { buildConfirmationRequest } from "../../src/cli/tui/confirmations.js";
import { ConfirmationOverlay } from "../../src/cli/tui/views/ConfirmationOverlay.js";

describe("confirmation overlay", () => {
  it("renders deliberate confirmation copy for dangerous actions", () => {
    const request = buildConfirmationRequest({ id: "instance.restart", title: "Restart instance", danger: "confirm" });
    const output = renderToString(<ConfirmationOverlay request={request!} typedValue="" noColor />);

    expect(output).toContain("Restart instance");
    expect(output).toContain("Type confirm");
    expect(output).toContain("Esc cancels");
  });

  it("renders exact phrase requirement for irreversible actions", () => {
    const request = buildConfirmationRequest({
      id: "workspace.deleteData",
      title: "Delete project workspace data",
      danger: "exact-phrase",
      confirmationPhrase: "delete project workspace data",
    });
    const output = renderToString(<ConfirmationOverlay request={request!} typedValue="delete" noColor />);

    expect(output).toContain("delete project workspace data");
    expect(output).toContain("delete");
  });
});
