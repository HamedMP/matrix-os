import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "@renderer/App";

describe("desktop app scaffold", () => {
  it("renders the initial app shell", () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain("bg-app");
    expect(html).toContain("Connecting");
  });

  it("keeps Node globals out of the sandboxed renderer tsconfig", () => {
    const rendererConfig = JSON.parse(readFileSync(join(process.cwd(), "desktop/tsconfig.json"), "utf8"));
    const nodeConfig = JSON.parse(readFileSync(join(process.cwd(), "desktop/tsconfig.node.json"), "utf8"));

    expect(rendererConfig.compilerOptions.types).toEqual([]);
    expect(rendererConfig.include).toEqual(["src/renderer/src/**/*", "src/shared/**/*"]);
    expect(nodeConfig.compilerOptions.types).toEqual(["node"]);
    expect(nodeConfig.include).toContain("src/main/**/*");
    expect(nodeConfig.include).toContain("src/preload/**/*");
  });
});
