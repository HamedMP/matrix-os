// @vitest-environment jsdom
import React, { StrictMode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GettingStartedVisibilityProvider, useGettingStartedVisibility, useGettingStartedBlocker } from "../../packages/ui/src/getting-started-visibility";

function Card() {
  const { visible, blocked, requestedOpen, setRequestedOpen } = useGettingStartedVisibility();
  return <><button disabled={blocked} onClick={() => setRequestedOpen(!requestedOpen)}>Checklist</button>{visible && <div role="dialog">Checklist content</div>}</>;
}
function Blocker({ active }: { active: boolean }) {
  useGettingStartedBlocker(active);
  return null;
}
function Scene({ scope = "one", first = false, second = false, presentation = "desktop" }) {
  return <GettingStartedVisibilityProvider scope={scope}><Blocker active={first} /><Blocker active={second} /><Card key={presentation} /></GettingStartedVisibilityProvider>;
}
afterEach(cleanup);
describe("Getting started visibility", () => {
  it("restores intent only after the last overlapping blocker releases", () => {
    const view = render(<StrictMode><Scene /></StrictMode>);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    view.rerender(<StrictMode><Scene first second /></StrictMode>);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<StrictMode><Scene second /></StrictMode>);
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(<StrictMode><Scene /></StrictMode>);
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });
  it("preserves open and dismissed intent across presentation remounts", () => {
    const view = render(<Scene />);
    fireEvent.click(screen.getByRole("button"));
    view.rerender(<Scene presentation="canvas" />);
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.click(screen.getByRole("button"));
    view.rerender(<Scene first />);
    view.rerender(<Scene />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("keeps the card suppressed when a launcher hands interaction to a dialog", () => {
    const view = render(<Scene />);
    fireEvent.click(screen.getByRole("button"));
    view.rerender(<Scene first />);
    view.rerender(<Scene second />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<Scene />);
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });
  it("resets intent on scope changes without dropping still-mounted blockers", () => {
    const view = render(<Scene />);
    fireEvent.click(screen.getByRole("button"));
    view.rerender(<Scene scope="two" first />);
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(<Scene scope="two" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(<Scene scope="one" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });
});
