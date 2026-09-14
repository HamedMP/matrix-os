// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatFileNavigationProvider, useChatFileNavigation } from "@desktop/renderer/src/features/work/ChatFileNavigation";

afterEach(cleanup);

it("clears inspector requests on navigation without remounting children or accepting stale opens", () => {
  const reveal = vi.fn();
  let delayedOpen: (() => void) | undefined;
  function Consumer({ chatId }: { chatId: string }) {
    const navigation = useChatFileNavigation();
    const [text, setText] = React.useState("");
    const open = () => navigation?.open({ chatId, target: {
      kind: "project", projectId: "project", path: "README.md", label: "README.md",
    } });
    return <>
      <input aria-label="Draft" value={text} onChange={(event) => setText(event.target.value)} />
      <button onClick={() => { delayedOpen = open; open(); }}>Open file</button>
      <output>{navigation?.request?.chatId ?? "no file"}</output>
    </>;
  }
  const tree = (scope: string) => <ChatFileNavigationProvider scopeKey={scope} reveal={reveal}>
    <Consumer chatId={scope} />
  </ChatFileNavigationProvider>;
  const view = render(tree("a"));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "retained" } });
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByRole("status").textContent).toBe("a");
  const oldOpen = delayedOpen;
  view.rerender(tree("b"));
  expect(screen.getByRole("status").textContent).toBe("no file");
  view.rerender(tree("a"));
  act(() => oldOpen?.());
  expect(screen.getByRole("status").textContent).toBe("no file");
  expect(reveal).toHaveBeenCalledTimes(1);
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("retained");
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByRole("status").textContent).toBe("a");
  view.unmount();
  act(() => delayedOpen?.());
  expect(reveal).toHaveBeenCalledTimes(2);
});
