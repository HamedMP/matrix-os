// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RetainedHarnessAction } from "../../packages/ui/src/agents-providers/RetainedHarnessAction";
afterEach(cleanup);
it("retains pending and safe failure across newly allocated callbacks in the same scope", async () => {
  let settle!: (value: boolean) => void;
  const owner = {}; const action = vi.fn(() => new Promise<boolean>(resolve => { settle = resolve; }));
  const success = vi.fn();
  const props = { label: "Disconnect", disabled: false, scopeKey: "pi:disconnect", scopeOwner: owner, onSuccess: success };
  const { rerender } = render(<RetainedHarnessAction {...props} action={() => action()} />);
  fireEvent.click(screen.getByRole("button"));
  rerender(<RetainedHarnessAction {...props} action={() => action()} />);
  expect(screen.getByRole("button")).toBeDisabled();
  fireEvent.click(screen.getByRole("button")); expect(action).toHaveBeenCalledOnce();
  await act(async () => settle(false));
  expect(screen.getByRole("alert")).toHaveTextContent("Try again");
  rerender(<RetainedHarnessAction {...props} action={() => action()} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Try again");
  expect(success).not.toHaveBeenCalled();
});
it("drops settlement from a former captured owner scope", async () => {
  let settle!: (value: boolean) => void; const success = vi.fn();
  const { rerender } = render(<RetainedHarnessAction label="Disconnect" disabled={false} scopeKey="pi:disconnect" scopeOwner={{}} onSuccess={success} action={() => new Promise<boolean>(resolve => { settle = resolve; })} />);
  fireEvent.click(screen.getByRole("button"));
  rerender(<RetainedHarnessAction label="Disconnect" disabled={false} scopeKey="pi:disconnect" scopeOwner={{}} onSuccess={success} action={async () => true} />);
  await act(async () => settle(true));
  expect(success).not.toHaveBeenCalled(); expect(screen.getByRole("button")).toBeEnabled();
});
