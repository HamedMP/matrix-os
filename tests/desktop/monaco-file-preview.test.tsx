// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { MonacoReadOnlyEditor, languageForPath, monacoThemeForDocument } from "@desktop/renderer/src/features/editor/MonacoReadOnlyEditor";
import { FileTypeIcon } from "@desktop/renderer/src/features/files/FileTypeIcon";
import { afterEach, describe, expect, it } from "vitest";

describe("Chat inspector code preview", () => {
  afterEach(cleanup);

  it("maps common workspace extensions to Monaco languages", () => {
    expect(languageForPath("src/app.tsx")).toBe("typescript");
    expect(languageForPath(".github/workflows/ci.yml")).toBe("yaml");
    expect(languageForPath("Dockerfile")).toBe("dockerfile");
    expect(languageForPath("LICENSE")).toBe("plaintext");
  });

  it("keeps file content readable when Monaco workers are unavailable", () => {
    const { container } = render(<MonacoReadOnlyEditor path="src/app.ts" content="export const ready = true;" />);

    expect(screen.getByText("export const ready = true;")).toBeTruthy();
    expect(container.querySelector("[data-monaco-fallback]")).not.toBeNull();
  });

  it("uses the Matrix appearance instead of the host OS color scheme", () => {
    document.documentElement.setAttribute("data-theme", "light");
    expect(monacoThemeForDocument(document.documentElement)).toBe("vs");

    document.documentElement.setAttribute("data-theme", "dark");
    expect(monacoThemeForDocument(document.documentElement)).toBe("vs-dark");
  });

  it("renders a real material file icon asset for each filename", () => {
    const { container } = render(<FileTypeIcon filename="app.tsx" />);
    const icon = container.querySelector("img");

    expect(icon?.getAttribute("src")).toMatch(/^data:image\/svg\+xml,/);
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });
});
