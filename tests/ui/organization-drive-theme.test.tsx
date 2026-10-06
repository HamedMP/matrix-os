// @vitest-environment jsdom
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrganizationDriveBrowser } from "../../packages/ui/src/organization-drive/OrganizationDriveBrowser";
afterEach(cleanup);
it("inherits Web and Electron host theme tokens for the shared Library", () => {
  const view = render(
    <OrganizationDriveBrowser
      name="Shared files"
      files={[]}
      usedBytes={0}
      reservedBytes={0}
      quotaBytes={1000}
      busy={false}
      canUpload={false}
      folder=""
      onFolderChange={vi.fn()}
      onDownload={vi.fn()}
    />,
  );
  const root = view.container.querySelector("section")!;
  expect(root.style.getPropertyValue("--mw-paper")).toBe("var(--background)");
  expect(root.style.getPropertyValue("--mw-ink")).toBe("var(--foreground)");
  expect(root.style.getPropertyValue("--mw-canvas")).toContain(
    "var(--bg-sunken)",
  );
  expect(root.style.getPropertyValue("--mw-muted")).toContain(
    "var(--text-secondary)",
  );
  expect(root.style.getPropertyValue("--mw-border")).toContain(
    "var(--border-default)",
  );
});
