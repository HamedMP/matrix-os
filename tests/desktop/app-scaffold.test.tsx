import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "@renderer/App";

describe("desktop app scaffold", () => {
  it("renders the Matrix OS scaffold shell", () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain("Matrix OS");
    expect(html).toContain("Operator scaffold");
  });
});
