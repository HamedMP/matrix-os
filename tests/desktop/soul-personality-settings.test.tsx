// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import IdentityPersonalitySection from "../../desktop/src/renderer/src/features/settings/sections/IdentityPersonalitySection";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

afterEach(() => { cleanup(); useConnection.setState({ api: null }); });

it.each([12, 0, 11, 27, 127])("retains an invalid Electron control U+%i draft and saves corrected text", async code => {
  const saved: string[] = [];
  useConnection.setState({ api: {
    getText: async () => "Original Rick profile",
    putText: async (_path: string, text: string) => { saved.push(text); },
  } as never });
  render(<IdentityPersonalitySection />);
  const editor = await screen.findByRole("textbox", { name: "SOUL system instructions" }) as HTMLTextAreaElement;
  await waitFor(() => expect(editor.value).toBe("Original Rick profile"));
  const draft = `Original Rick profile${String.fromCharCode(code)}New preference`;
  fireEvent.change(editor, { target: { value: draft } });
  expect(editor.value).toBe(draft);
  expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("alert").textContent).toMatch(/Remove unsupported control characters before saving/);
  expect(saved).toEqual([]);
  fireEvent.change(editor, { target: { value: "Original Rick profile\tNew preference\nKeep values\r\n" } });
  const corrected = editor.value;
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Saved");
  expect(saved).toEqual([corrected]);
});

it("prevents oversized UTF-8 SOUL saves in Electron and saves the corrected draft", async () => {
  const saved: string[] = [];
  useConnection.setState({ api: {
    getText: async () => "Original Rick profile",
    putText: async (_path: string, text: string) => { saved.push(text); },
  } as never });
  render(<IdentityPersonalitySection />);
  const editor = await screen.findByRole("textbox", { name: "SOUL system instructions" });
  await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("Original Rick profile"));
  fireEvent.change(editor, { target: { value: "界".repeat(5462) } });
  expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("alert").textContent).toMatch(/16 KiB/);
  expect(saved).toEqual([]);
  fireEvent.change(editor, { target: { value: "Original Rick profile\nNew preference" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Saved");
  expect(saved).toEqual(["Original Rick profile\nNew preference"]);
});

it("keeps a failed Electron save draft available for a corrected retry", async () => {
  let attempts = 0;
  useConnection.setState({ api: {
    getText: async () => "Original Rick profile",
    putText: async () => { attempts++; if (attempts === 1) throw new Error("private failure"); },
  } as never });
  render(<IdentityPersonalitySection />);
  const editor = await screen.findByRole("textbox", { name: "SOUL system instructions" });
  await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("Original Rick profile"));
  fireEvent.change(editor, { target: { value: "Unsaved Rick preference" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("alert");
  expect((editor as HTMLTextAreaElement).value).toBe("Unsaved Rick preference");
  expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Saved");
  expect(attempts).toBe(2);
});
