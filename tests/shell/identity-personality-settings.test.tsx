// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/lib/gateway", () => ({ getGatewayUrl: () => "http://gateway.test" }));
import { IdentityPersonalitySection } from "../../shell/src/components/settings/sections/IdentityPersonalitySection.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([12, 0, 11, 27, 127])("retains an invalid control U+%i draft and allows corrected SOUL text", async code => {
  const saved: string[] = [];
  vi.stubGlobal("fetch", async (input: string, options?: RequestInit) => {
    if (options?.method === "PUT") { saved.push(String(options.body)); return new Response("{}"); }
    return String(input).endsWith("/api/identity") ? new Response("{}") : new Response("Original Rick profile");
  });
  render(<IdentityPersonalitySection />);
  await screen.findByText("Original Rick profile");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const editor = screen.getByRole("textbox", { name: "Markdown editor" }) as HTMLTextAreaElement;
  const draft = `Original Rick profile${String.fromCharCode(code)}New preference`;
  fireEvent.change(editor, { target: { value: draft } });
  expect(editor.value).toBe(draft);
  expect(screen.getByTitle("Unsaved changes")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("alert").textContent).toMatch(/Remove unsupported control characters before saving/);
  expect(saved).toEqual([]);
  fireEvent.change(editor, { target: { value: "Original Rick profile\tNew preference\nKeep values\r\n" } });
  const corrected = editor.value;
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saved).toEqual([corrected]));
  await waitFor(() => expect(screen.queryByTitle("Unsaved changes")).toBeNull());
});

it("keeps oversized UTF-8 drafts unsaved, then allows a corrected SOUL save", async () => {
  const saved: string[] = [];
  vi.stubGlobal("fetch", async (input: string, options?: RequestInit) => {
    if (options?.method === "PUT") { saved.push(String(options.body)); return new Response("{}", { status: 200 }); }
    return String(input).endsWith("/api/identity")
      ? new Response(JSON.stringify({ displayName: "Owner" })) : new Response("Original Rick profile");
  });
  render(<IdentityPersonalitySection />);
  await screen.findByText("Original Rick profile");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const editor = screen.getByRole("textbox", { name: "Markdown editor" });
  fireEvent.change(editor, { target: { value: "界".repeat(5462) } });
  expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("alert").textContent).toMatch(/16 KiB/);
  expect(saved).toEqual([]);
  fireEvent.change(editor, { target: { value: "Original Rick profile\nNew compatible preference" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saved).toEqual(["Original Rick profile\nNew compatible preference"]));
  await waitFor(() => expect(screen.queryByTitle("Unsaved changes")).toBeNull());
});

it("retains the local draft and shows a safe error when the server rejects a save", async () => {
  vi.stubGlobal("fetch", async (input: string, options?: RequestInit) => {
    if (options?.method === "PUT") return new Response("private failure", { status: 500 });
    return String(input).endsWith("/api/identity") ? new Response("{}") : new Response("Original Rick profile");
  });
  render(<IdentityPersonalitySection />);
  await screen.findByText("Original Rick profile");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsaved Rick preference" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Unable to save/));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Unsaved Rick preference");
  expect(screen.getByTitle("Unsaved changes")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
});
