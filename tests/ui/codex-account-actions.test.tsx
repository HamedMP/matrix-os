// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderAccount } from "@matrix-os/contracts";
import { CodexAccountActions } from "../../packages/ui/src/agents-providers/CodexAccountActions";
afterEach(cleanup);
const account = { id: "owner_codex", displayName: "Synthetic account", accessSourceId: "owner_openai_profile", authState: "authenticated" } as ProviderAccount;
function props() { return { account, harnessId: "codex", scopeOwner: {}, disabled: false, canLogout: true, canChangeAccount: true, onMutate: vi.fn().mockResolvedValue(true), onRefresh: vi.fn() }; }
it("drops an old account confirmation after the source/owner scope changes", () => {
  const p = props(), view = render(<CodexAccountActions {...p}/>);
  fireEvent.click(screen.getByRole("button", { name: "Change account" }));
  view.rerender(<CodexAccountActions {...p} scopeOwner={{}}/>);
  expect(screen.queryByRole("dialog")).toBeNull(); expect(p.onMutate).not.toHaveBeenCalled();
});
it("does not refresh a new account scope when an old pending logout settles", async () => {
  const p = props(); let settle!: (ok: boolean) => void;
  p.onMutate.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
  const view = render(<CodexAccountActions {...p}/>);
  fireEvent.click(screen.getByRole("button", { name: "Change account" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Log out and change account" }));
  view.rerender(<CodexAccountActions {...p} scopeOwner={{}} account={{ ...account, id: "other" }}/>);
  await act(async () => { settle(true); });
  expect(p.onRefresh).not.toHaveBeenCalled(); expect(screen.queryByRole("dialog")).toBeNull();
  expect(p.onMutate).toHaveBeenCalledExactlyOnceWith({ type: "logout_account", accountId: "owner_codex" });
});
it("keeps active logout single-flight and prevents escape/duplicate mutation", async () => {
  const p = props(); let settle!: (ok: boolean) => void;
  p.onMutate.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
  render(<CodexAccountActions {...p}/>); fireEvent.click(screen.getByRole("button", { name: "Change account" }));
  const d = screen.getByRole("dialog"), confirm = within(d).getByRole("button", { name: "Log out and change account" });
  fireEvent.click(confirm); fireEvent.click(confirm); fireEvent.keyDown(d, { key: "Escape" });
  expect(confirm).toBeDisabled(); expect(screen.getByRole("dialog")).toBeVisible(); expect(p.onMutate).toHaveBeenCalledOnce();
  await act(async () => { settle(true); });
  expect(p.onRefresh).toHaveBeenCalledOnce(); expect(screen.queryByRole("dialog")).toBeNull();
});
it("does not advertise unsupported account replacement or mutate an unauthenticated account", () => {
  const p = props(), view = render(<CodexAccountActions {...p} canChangeAccount={false}/>);
  expect(screen.queryByRole("button", { name: "Change account" })).toBeNull();
  view.rerender(<CodexAccountActions {...p} account={{ ...account, authState: "unauthenticated" }}/>);
  expect(screen.queryByRole("button")).toBeNull(); expect(p.onMutate).not.toHaveBeenCalled();
});
