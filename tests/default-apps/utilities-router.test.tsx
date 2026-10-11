import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceRouter } from "../../home/apps/utilities/src/WorkspaceRouter";
import { utilityCatalog } from "../../home/apps/utilities/src/catalog-adapter";
import { toolAvailability } from "../../home/apps/utilities/src/tool-availability";

describe("Utilities platform-safe renderer", () => {
  it("shows a canonical fallback and never mounts broken controls for limited tools", () => {
    for (const tool of utilityCatalog.filter((candidate) => !toolAvailability(candidate).available)) {
      const html = renderToStaticMarkup(<WorkspaceRouter tool={tool}/>);
      expect(html).toContain("Available on the website");
      expect(html).toContain(`https://matrix-os.com/tools/${tool.slug}`);
      expect(html).toContain('rel="noopener noreferrer"');
      expect(html).not.toContain("<input");
      expect(html).not.toContain("<textarea");
      expect(html).not.toContain("<button");
    }
  });
  it("does not crash for a future unknown mode", () => {
    const tool = { ...utilityCatalog[0], mode: "future-mode" };
    const html = renderToStaticMarkup(<WorkspaceRouter tool={tool}/>);
    expect(html).toContain("This tool is unavailable");
  });
});
