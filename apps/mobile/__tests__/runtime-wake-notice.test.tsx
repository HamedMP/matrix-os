import { act, cleanup, render, screen } from "@testing-library/react-native";

import { RuntimeWakeNotice } from "../components/RuntimeWakeNotice";
import { ToastHost } from "../components/ui/Toast";
import type { RuntimeWakeEvent } from "../lib/gateway-client";
import { TOAST_DURATION_MS } from "../lib/toast";

function fakeClient() {
  let handler: ((event: RuntimeWakeEvent) => void) | null = null;
  const unsubscribe = jest.fn(() => {
    handler = null;
  });
  return {
    client: {
      onRuntimeWake: jest.fn((next: (event: RuntimeWakeEvent) => void) => {
        handler = next;
        return unsubscribe;
      }),
    },
    emit: (event: RuntimeWakeEvent) => act(() => handler?.(event)),
    unsubscribe,
  };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("RuntimeWakeNotice", () => {
  it("shows the waking state in the shared toast for as long as the computer is waking", () => {
    const { client, emit } = fakeClient();
    render(
      <>
        <ToastHost />
        <RuntimeWakeNotice client={client} />
      </>,
    );
    expect(screen.queryByTestId("toast")).toBeNull();

    emit({ type: "notice", visible: true });
    expect(screen.getByText("Waking your Matrix computer…")).toBeTruthy();
    act(() => jest.advanceTimersByTime(TOAST_DURATION_MS * 3));
    expect(screen.getByText("Waking your Matrix computer…")).toBeTruthy();

    emit({ type: "notice", visible: false });
    expect(screen.queryByText("Waking your Matrix computer…")).toBeNull();
  });

  it("says when Matrix is at capacity", () => {
    const { client, emit } = fakeClient();
    render(
      <>
        <ToastHost />
        <RuntimeWakeNotice client={client} />
      </>,
    );

    emit({ type: "failed", code: "runtime_busy" });

    expect(screen.getByText(/Matrix is at capacity/)).toBeTruthy();
  });

  it("reports a burst of parallel failures once", () => {
    const haptic = jest.spyOn(jest.requireActual("../lib/haptics"), "warningHaptic");
    const { client, emit } = fakeClient();
    render(
      <>
        <ToastHost />
        <RuntimeWakeNotice client={client} />
      </>,
    );

    emit({ type: "failed", code: "runtime_waking" });
    emit({ type: "failed", code: "runtime_waking" });
    emit({ type: "failed", code: "runtime_waking" });

    expect(screen.getByText(/still waking up/)).toBeTruthy();
    expect(haptic).toHaveBeenCalledTimes(1);
  });

  it("stops listening and takes the notice away when it unmounts", () => {
    const { client, emit, unsubscribe } = fakeClient();
    const host = render(<ToastHost />);
    const notice = render(<RuntimeWakeNotice client={client} />);
    emit({ type: "notice", visible: true });
    expect(host.getByText("Waking your Matrix computer…")).toBeTruthy();

    notice.unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(host.queryByText("Waking your Matrix computer…")).toBeNull();
  });

  it("renders nothing without a client", () => {
    const view = render(<RuntimeWakeNotice client={null} />);
    expect(view.toJSON()).toBeNull();
  });
});
