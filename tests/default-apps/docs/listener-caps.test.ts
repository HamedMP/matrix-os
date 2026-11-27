// @vitest-environment jsdom
/**
 * Every listener registry in the Docs app is bounded: a component that keeps
 * subscribing without unsubscribing (a leak) hits a cap instead of growing the
 * registry forever, unsubscribing frees the slot, and dispose drops them all.
 */

import { describe, expect, it } from "vitest";
import { MAX_LISTENERS } from "../../../home/apps/docs/src/listeners";
import { ReviewController } from "../../../home/apps/docs/src/review/index";
import { AssistantStore } from "../../../home/apps/docs/src/ui/agent/assistant-store";
import { scripted, sessionWith } from "./agent/helpers";
import { mount } from "./editor/helpers";

type Subscribe = (listener: () => void) => () => void;

/**
 * Subscribes until the registry refuses (it may already hold the app's own listeners), checks that
 * it refused at the cap at the latest, and that unsubscribing frees a slot.
 */
function expectBounded(subscribe: Subscribe): void {
  const stops: Array<() => void> = [];
  let refused: unknown = null;
  while (refused === null && stops.length <= MAX_LISTENERS) {
    try {
      stops.push(subscribe(() => undefined));
    } catch (error) {
      refused = error;
    }
  }
  expect(String(refused)).toMatch(/too many/);
  stops.pop()!();
  stops.push(subscribe(() => undefined));
  for (const stop of stops) stop();
}

describe("listener registries", () => {
  it("bound the assistant store and drop its listeners on dispose", async () => {
    const session = await sessionWith(["Text."]);
    const store = new AssistantStore({ session, generate: scripted().generate, getSelection: () => null, log: () => undefined });
    expectBounded(store.subscribe);
    // Dispose drops whatever is still registered: a listener left behind is not called again.
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.dispose();
    store.setMode("ask");
    expect(calls).toBe(0);
    session.dispose();
  });

  it("bound the review controller", async () => {
    const session = await sessionWith(["Text."]);
    const review = new ReviewController(session, { log: () => undefined });
    expectBounded(review.subscribe);
    review.dispose();
    session.dispose();
  });

  it("bound the editor and the session", async () => {
    const m = await mount({ paragraphs: ["Text"] });
    try {
      expectBounded(m.editor.subscribe);
      expectBounded((listener) => m.editor.onSelectionChange(listener));
      expectBounded(m.session.subscribe);
      expectBounded((listener) => m.session.onChange(listener));
    } finally {
      m.unmount();
    }
  });
});
