// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import Edition from "../../home/app-templates/connected-starter/src/edition/Edition";
const source = {
  id: "s1",
  connectionId: "c1",
  email: "reader@example.test",
  label: "Reading",
  scope: "personal",
  state: "completed",
};
afterEach(() => {
  cleanup();
  delete window.MatrixOS;
  vi.restoreAllMocks();
});
it("keeps an account visible when retention removal fails and requires concrete confirmation", async () => {
  const mail = vi.fn(async (action: string) => {
    if (action === "sources") return { sources: [source] };
    if (action === "messages") return { messages: [] };
    if (action === "cleanup-recovery") return { operations: [] };
    if (action === "retention") throw new Error("/private/archive failed");
    return {};
  });
  window.MatrixOS = { mail };
  render(<Edition />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Remove retained account history",
    }),
  );
  expect(mail).not.toHaveBeenCalledWith("retention", expect.anything());
  expect(screen.getByRole("dialog").textContent).toContain(
    "reader@example.test",
  );
  expect(screen.getByRole("dialog").textContent).toContain("cannot be undone");
  fireEvent.click(
    screen.getByRole("button", { name: "Remove retained history" }),
  );
  await waitFor(() =>
    expect(mail).toHaveBeenCalledWith("retention", {
      sourceId: "s1",
      mode: "purge",
    }),
  );
  expect(screen.getByRole("alert").textContent).not.toContain("/private");
  expect(screen.getByRole("dialog")).toBeTruthy();
});
