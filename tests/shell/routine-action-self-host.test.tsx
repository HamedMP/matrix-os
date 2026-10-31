// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TerminalRoutineConfirmations } from "../../shell/src/components/terminal/TerminalRoutineConfirmations";
afterEach(() => { cleanup(); delete document.documentElement.dataset.matrixSelfHosted; });
it("keeps a self-hosted Terminal usable without a Clerk provider when Platform owner-proof service is unavailable", () => {
  document.documentElement.dataset.matrixSelfHosted = "1";
  const result = render(<TerminalRoutineConfirmations/>); expect(result.container.textContent).toBe("");
});
