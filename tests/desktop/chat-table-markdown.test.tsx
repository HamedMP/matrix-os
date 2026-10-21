// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { tableToMarkdown } from "@desktop/renderer/src/components/conversation/message";

describe("tableToMarkdown", () => {
  it("escapes backslashes before pipes so copied cells keep their text", () => {
    const table = document.createElement("table");
    table.innerHTML = "<tr><th>Path</th><th>Rule</th></tr><tr><td>C:\\temp\\</td><td>a\\|b</td></tr>";
    expect(tableToMarkdown(table)).toBe([
      "| Path | Rule |",
      "| --- | --- |",
      "| C:\\\\temp\\\\ | a\\\\\\|b |",
    ].join("\n"));
  });
});
