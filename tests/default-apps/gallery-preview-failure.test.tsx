// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DemoFrame from "../../specs/550-app-store-launch/design-prototype/src/DemoFrame";
import PreviewDocument from "../../specs/550-app-store-launch/design-prototype/src/PreviewDocument";
import { usePreviewDocument } from "../../specs/550-app-store-launch/design-prototype/src/usePreviewDocument";
vi.mock("../../specs/550-app-store-launch/design-prototype/src/usePreviewDocument", () => ({ usePreviewDocument: vi.fn() }));
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  vi.mocked(usePreviewDocument).mockReturnValue({ key: "current-folio", html: "", error: "This example is unavailable." });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it("explains a failed thumbnail instead of leaving a blank tile", () => {
  render(createElement(DemoFrame, { id: "folio" }));
  expect(screen.getByRole("status").textContent).toContain("Open this app to retry");
  expect(screen.queryByTitle("folio current interface thumbnail")).toBeNull();
});
it("retries an interactive example without navigating to an authenticated owner frame", () => {
  render(createElement(PreviewDocument, { id: "folio", title: "Folio preview" }));
  fireEvent.click(screen.getByRole("button", { name: "Retry example" }));
  expect(usePreviewDocument).toHaveBeenLastCalledWith("folio", "current", true, 1);
});
it("uses an actual phone viewport with the same opaque frame boundary", () => {
  vi.mocked(usePreviewDocument).mockReturnValue({ key: "current-folio", html: "<p>Fictional</p>", error: "" });
  render(createElement(DemoFrame, { id: "folio", viewport: "phone" }));
  const frame = screen.getByTitle("folio current interface thumbnail");
  expect(frame.style.width).toBe("390px");
  expect(frame.style.height).toBe("760px");
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
  expect(frame.getAttribute("src")).toBeNull();
});
