import { approvalDetailFields, approvalTitleParts } from "@/lib/supervised-tool-approval-details";

describe("approvalDetailFields", () => {
  it("names each part of a command request and keeps the command as code", () => {
    expect(approvalDetailFields(JSON.stringify({ command: "ls -la ~/matrix", description: "List the folder", run_in_background: true, timeout: 120000 }))).toEqual([
      { key: "command", label: "Command", value: "ls -la ~/matrix", code: true },
      { key: "description", label: "Description", value: "List the folder", code: false },
      { key: "run_in_background", label: "Run in background", value: "Yes", code: false },
      { key: "timeout", label: "Timeout", value: "120000", code: false },
    ]);
  });

  it("names file, web and search inputs", () => {
    expect(approvalDetailFields(JSON.stringify({ file_path: "~/notes/todo.md", url: "https://example.com", query: "matrix os", pattern: "*.ts", dangerouslyDisableSandbox: false }))).toEqual([
      { key: "file_path", label: "File", value: "~/notes/todo.md", code: true },
      { key: "url", label: "Address", value: "https://example.com", code: true },
      { key: "query", label: "Search", value: "matrix os", code: false },
      { key: "pattern", label: "Pattern", value: "*.ts", code: true },
      { key: "dangerouslyDisableSandbox", label: "Dangerously disable sandbox", value: "No", code: false },
    ]);
  });

  it("lays out nested values as indented code and leaves empty ones out", () => {
    expect(approvalDetailFields(JSON.stringify({ edits: [{ old_string: "a" }], note: null }))).toEqual([
      { key: "edits", label: "Edits", value: "[\n  {\n    \"old_string\": \"a\"\n  }\n]", code: true },
    ]);
  });

  it.each([
    ["cut-off JSON", "{\"command\":\"ls -la"],
    ["plain text", "Read the file at ~/notes"],
    ["a JSON list", "[\"a\",\"b\"]"],
    ["a JSON string", "\"ls\""],
    ["an empty object", "{}"],
  ])("gives %s back for display as it came", (_case, details) => {
    expect(approvalDetailFields(details)).toBeNull();
  });
});

describe("approvalTitleParts", () => {
  it.each([
    ["Run a command · “echo hello”", { action: "Run a command", subject: "echo hello" }],
    ["Open a web page · “example.com/a · b”", { action: "Open a web page", subject: "example.com/a · b" }],
    ["Run a command", { action: "Run a command" }],
    ["Review integration request", { action: "Review integration request" }],
  ])("splits %s", (title, parts) => {
    expect(approvalTitleParts(title)).toEqual(parts);
  });
});
