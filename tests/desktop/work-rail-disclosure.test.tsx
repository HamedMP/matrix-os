// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useWorkRailDisclosure } from "@desktop/renderer/src/features/work/work-rail/use-work-rail-disclosure";

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); useConnection.setState({ status: "signed-out", userId: null }); });
function signIn(userId = "viewer-a", runtimeSlot: "primary" | "local" = "primary") {
  useConnection.setState({ status: "signed-in", userId, runtimeSlot, platformHost: "https://platform.test" });
}
it("starts Done expanded and remembers explicit section and Agent collapse for this viewer and Computer", () => {
  signIn();
  const first = renderHook(useWorkRailDisclosure);
  expect(first.result.current.sections).toEqual({ agents: true, pinned: true, projects: true, needsYou: true, working: true, done: true });
  act(() => first.result.current.setExpanded("done", false));
  act(() => first.result.current.setExpanded("agents", false));
  first.unmount();
  const reopened = renderHook(useWorkRailDisclosure);
  expect(reopened.result.current.sections.done).toBe(false);
  expect(reopened.result.current.sections.agents).toBe(false);
  act(() => signIn("viewer-b"));
  expect(reopened.result.current.sections.done).toBe(true);
  act(() => signIn("viewer-a", "local"));
  expect(reopened.result.current.sections.agents).toBe(true);
  act(() => signIn());
  expect(reopened.result.current.sections.done).toBe(false);
});
it("ignores a disclosure callback captured before the viewer changes", () => {
  signIn();
  const view = renderHook(useWorkRailDisclosure);
  const old = view.result.current.setExpanded;
  act(() => signIn("viewer-b"));
  act(() => old("done", false));
  expect(view.result.current.sections.done).toBe(true);
  expect(localStorage.length).toBe(0);
});
it("fails safely on malformed stored presentation without accepting unknown keys", () => {
  signIn();
  localStorage.setItem('matrix-chat-rail-disclosure:["https://platform.test","viewer-a","primary"]', '{"done":"yes","agents":false,"unknown":true}');
  const view = renderHook(useWorkRailDisclosure);
  expect(view.result.current.sections.done).toBe(true);
  expect(view.result.current.sections.agents).toBe(false);
  expect("unknown" in view.result.current.sections).toBe(false);
});

it("honors existing stored Done collapse without rewriting unrelated scopes", () => {
  signIn();
  const key = 'matrix-chat-rail-disclosure:["https://platform.test","viewer-a","primary"]';
  const previous = '{"done":false,"agents":false}';
  const otherKey = 'matrix-chat-rail-disclosure:["https://platform.test","viewer-b","primary"]';
  localStorage.setItem(key, previous);
  localStorage.setItem(otherKey, '{"done":false}');
  const view = renderHook(useWorkRailDisclosure);
  expect(view.result.current.sections.done).toBe(false);
  expect(localStorage.getItem(key)).toBe(previous);
  act(() => view.result.current.setExpanded("done", true));
  expect(view.result.current.sections.done).toBe(true);
  expect(view.result.current.sections.agents).toBe(false);
  expect(localStorage.getItem(otherKey)).toBe('{"done":false}');
});
it("uses expanded Done for old preferences that omitted Done", () => {
  signIn();
  localStorage.setItem('matrix-chat-rail-disclosure:["https://platform.test","viewer-a","primary"]', '{"agents":false}');
  const view = renderHook(useWorkRailDisclosure);
  expect(view.result.current.sections.done).toBe(true);
  expect(view.result.current.sections.agents).toBe(false);
});

it("retains independent choices from two mounted rails after both are reopened", () => {
  signIn();
  const first = renderHook(useWorkRailDisclosure);
  const second = renderHook(useWorkRailDisclosure);
  act(() => first.result.current.setExpanded("done", false));
  act(() => second.result.current.setExpanded("agents", false));
  first.unmount(); second.unmount();
  const reopened = renderHook(useWorkRailDisclosure);
  expect(reopened.result.current.sections.done).toBe(false);
  expect(reopened.result.current.sections.agents).toBe(false);
});

it("merges repeated changes from a retained rail with newer saved choices", () => {
  signIn();
  const first = renderHook(useWorkRailDisclosure);
  const second = renderHook(useWorkRailDisclosure);
  act(() => first.result.current.setExpanded("done", false));
  act(() => second.result.current.setExpanded("agents", false));
  act(() => first.result.current.setExpanded("working", false));
  first.unmount(); second.unmount();
  const reopened = renderHook(useWorkRailDisclosure);
  expect(reopened.result.current.sections).toMatchObject({ done: false, agents: false, working: false });
});

it("retains local choices when presentation storage cannot be read or written", () => {
  signIn();
  const view = renderHook(useWorkRailDisclosure);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Storage unavailable", "SecurityError"); });
  act(() => view.result.current.setExpanded("done", false));
  act(() => view.result.current.setExpanded("agents", false));
  expect(view.result.current.sections).toMatchObject({ done: false, agents: false });
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Storage unavailable", "SecurityError"); });
  act(() => view.result.current.setExpanded("working", false));
  expect(view.result.current.sections).toMatchObject({ done: false, agents: false, working: false });
});

it("keeps signed-out choices local to their rail and resets them on sign-in", () => {
  useConnection.setState({ status: "signed-out", userId: null });
  const first = renderHook(useWorkRailDisclosure);
  const second = renderHook(useWorkRailDisclosure);
  act(() => first.result.current.setExpanded("done", false));
  act(() => second.result.current.setExpanded("agents", false));
  expect(first.result.current.sections).toMatchObject({ done: false, agents: true });
  expect(second.result.current.sections).toMatchObject({ done: true, agents: false });
  expect(localStorage.length).toBe(0);
  act(() => signIn());
  expect(first.result.current.sections.done).toBe(true);
  expect(second.result.current.sections.agents).toBe(true);
});

it("rejects a captured disclosure update after the authentication generation changes", () => {
  signIn();
  const view = renderHook(useWorkRailDisclosure);
  const previous = view.result.current.setExpanded;
  act(() => useConnection.setState({ authGeneration: useConnection.getState().authGeneration + 1 }));
  act(() => previous("done", false));
  expect(view.result.current.sections.done).toBe(true);
  expect(localStorage.length).toBe(0);
});

it.each(['{', '[]', '{"done":"yes","unknown":true}', "x".repeat(513)])("retains local choices and bounded boolean keys when newer storage is invalid (%#)", raw => {
  signIn();
  const view = renderHook(useWorkRailDisclosure);
  const key = 'matrix-chat-rail-disclosure:["https://platform.test","viewer-a","primary"]';
  vi.spyOn(console, "warn").mockImplementation(() => {});
  act(() => view.result.current.setExpanded("done", false));
  localStorage.setItem(key, raw);
  act(() => view.result.current.setExpanded("agents", false));
  const saved = JSON.parse(localStorage.getItem(key)!);
  expect(saved).toEqual({ agents: false, pinned: true, projects: true, needsYou: true, working: true, done: false });
  expect(localStorage.getItem(key)!.length).toBeLessThanOrEqual(512);
});
