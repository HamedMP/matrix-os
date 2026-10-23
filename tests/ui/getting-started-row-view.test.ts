import { describe, expect, it } from "vitest";
import type { GettingStartedRow } from "../../packages/contracts/src/index.js";
import { gettingStartedRowAction, gettingStartedRowView } from "../../packages/ui/src/get-started/getting-started-row.js";

const TRY = { label: "Find emails that need a reply", prompt: "Find emails… Don't send anything." };
const email = (patch: Partial<Extract<GettingStartedRow, { kind: "step" }>>): GettingStartedRow =>
  ({ kind: "step", id: "email-calendar", label: "Connect email & calendar", status: "incomplete", ...patch });

describe("Getting started row view", () => {
  it("shows a finished step as its try action, not struck through", () => {
    expect(gettingStartedRowView(email({ status: "complete", try: TRY }), null)).toEqual({ label: TRY.label, done: true, struck: false, trailing: "try" });
  });

  it("strikes through a finished step with nothing to try", () => {
    expect(gettingStartedRowView(email({ status: "complete" }), null)).toEqual({ label: "Connect email & calendar", done: true, struck: true, trailing: "icon" });
  });

  it("shows the help line, and waiting while its sign-in is open", () => {
    expect(gettingStartedRowView(email({ connect: "gmail", detail: "On your Matrix computer" }), null))
      .toEqual({ label: "Connect email & calendar", done: false, struck: false, detail: "On your Matrix computer", trailing: "icon" });
    expect(gettingStartedRowView(email({ connect: "gmail" }), "gmail"))
      .toEqual({ label: "Connect email & calendar", done: false, struck: false, detail: "Waiting for sign-in…", trailing: "waiting" });
  });
});

describe("Getting started row failures", () => {
  it("says when a sign-in did not finish, until it is tried again", () => {
    expect(gettingStartedRowView(email({ connect: "gmail" }), null, new Set(["gmail"])))
      .toEqual({ label: "Connect email & calendar", done: false, struck: false, detail: "Sign-in didn't finish. Click to try again.", trailing: "icon" });
    expect(gettingStartedRowView(email({ connect: "gmail" }), "gmail", new Set(["gmail"])).trailing).toBe("waiting");
  });
});

describe("Getting started row action", () => {
  it("tries a finished step, connects an unfinished one, and falls back to the step", () => {
    expect(gettingStartedRowAction(email({ status: "complete", try: TRY }), { canConnect: true })).toEqual({ type: "try", prompt: TRY.prompt });
    expect(gettingStartedRowAction(email({ connect: "google_calendar" }), { canConnect: true })).toEqual({ type: "connect", service: "google_calendar" });
    expect(gettingStartedRowAction(email({ connect: "gmail" }), { canConnect: false })).toEqual({ type: "step", id: "email-calendar" });
    expect(gettingStartedRowAction({ kind: "tool", id: "tool:linear", label: "Connect Linear", status: "incomplete", service: "linear" }, { canConnect: false }))
      .toEqual({ type: "settings" });
    expect(gettingStartedRowAction({ kind: "bot", id: "bot:echo", label: "Chat with Echo", status: "incomplete", recipeId: "echo" }, { canConnect: true }))
      .toEqual({ type: "bot", recipeId: "echo" });
  });
});
