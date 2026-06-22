// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ShellNotificationStack,
} from "../../shell/src/components/ShellNotificationStack.js";
import { ShellNotificationCard } from "../../shell/src/components/ShellNotificationCard.js";
import {
  getShellNotificationHostSnapshot,
  subscribeShellNotificationHost,
} from "../../shell/src/components/shell-notification-host.js";

describe("ShellNotificationStack", () => {
  it("anchors shell overlays in a shared top-right viewport stack", () => {
    render(
      <ShellNotificationStack>
        <ShellNotificationCard data-testid="shell-notification-card">
          <button type="button">Retry</button>
        </ShellNotificationCard>
      </ShellNotificationStack>,
    );

    const stack = screen.getByTestId("shell-notification-stack");
    expect(stack.className).toContain("fixed");
    expect(stack.className).toContain("right-3");
    expect(stack.className).toContain("top-[calc(env(safe-area-inset-top)+0.75rem)]");
    expect(stack.className).toContain("md:top-9");
    expect(stack.className).toContain("pointer-events-none");
    expect(stack.className).toContain("flex-col");
    expect(stack.className).toContain("z-[10000]");

    const card = screen.getByTestId("shell-notification-card");
    expect(card.className).toContain("pointer-events-auto");
    expect(card.className).toContain("max-w-[min(92vw,560px)]");
  });

  it("does not assign duplicate card test ids by default", () => {
    render(
      <ShellNotificationStack>
        <ShellNotificationCard>First</ShellNotificationCard>
        <ShellNotificationCard>Second</ShellNotificationCard>
      </ShellNotificationStack>,
    );

    expect(screen.queryByTestId("shell-notification-card")).toBeNull();
  });

  it("only assigns the host id to registering stacks", () => {
    render(
      <ShellNotificationStack registerHost={false}>
        <ShellNotificationCard>Fallback</ShellNotificationCard>
      </ShellNotificationStack>,
    );

    const stack = screen.getByTestId("shell-notification-stack");
    expect(stack.id).toBe("");
  });

  it("keeps the registered host stable across rerenders", () => {
    const hostChanges: Array<HTMLElement | null> = [];
    const unsubscribe = subscribeShellNotificationHost(() => {
      hostChanges.push(getShellNotificationHostSnapshot());
    });

    const { rerender, unmount } = render(
      <ShellNotificationStack>
        <ShellNotificationCard>First</ShellNotificationCard>
      </ShellNotificationStack>,
    );

    expect(hostChanges).toHaveLength(1);
    const host = hostChanges[0];
    expect(host).toBeInstanceOf(HTMLElement);

    rerender(
      <ShellNotificationStack>
        <ShellNotificationCard>Second</ShellNotificationCard>
      </ShellNotificationStack>,
    );

    expect(hostChanges).toEqual([host]);

    unmount();
    unsubscribe();
  });
});
