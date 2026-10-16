import { act, render, renderHook, screen } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { RefreshControl, Text } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { AgentsListScreen } from "../components/agents/AgentsListScreen";
import { Page } from "../components/shell/Page";
import { withRefreshTap } from "../lib/haptics";
import { usePullToRefresh } from "../lib/use-pull-to-refresh";

const LIGHT = Haptics.ImpactFeedbackStyle.Light;

describe("pulling to refresh", () => {
  beforeEach(() => {
    jest.mocked(Haptics.impactAsync).mockClear();
  });

  it("is felt as a light tap the moment the pull starts a refresh", () => {
    const refresh = jest.fn(() => "refreshed");

    expect(withRefreshTap(refresh)()).toBe("refreshed");
    expect(Haptics.impactAsync).toHaveBeenCalledWith(LIGHT);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("leaves the tap to the control that draws the pull, so the shared hook adds none", async () => {
    let finish: () => void = () => {};
    const refresh = jest.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => usePullToRefresh(refresh));

    act(() => result.current.onRefresh());

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
    await act(async () => finish());
  });

  it("taps once when a page's pull runs the shared hook", async () => {
    let finish: () => void = () => {};
    const refresh = jest.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    function Harness() {
      const pull = usePullToRefresh(refresh);
      return <Page title="Files" refreshing={pull.refreshing} onRefresh={pull.onRefresh}><Text>Body</Text></Page>;
    }
    render(<Harness />);

    act(() => screen.UNSAFE_getByType(RefreshControl).props.onRefresh());

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it("taps on a page's pull", () => {
    const onRefresh = jest.fn();
    render(<Page title="Apps" onRefresh={onRefresh}><Text>Body</Text></Page>);

    act(() => screen.UNSAFE_getByType(RefreshControl).props.onRefresh());

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).toHaveBeenCalledWith(LIGHT);
  });

  it("taps on a list's pull", () => {
    const onRefresh = jest.fn();
    render(
      <SafeAreaInsetsContext.Provider value={{ top: 62, right: 0, bottom: 34, left: 0 }}>
        <AgentsListScreen
          state="ready"
          rows={[]}
          refreshing={false}
          onRefresh={onRefresh}
          onRetry={jest.fn()}
          onNewAgent={jest.fn()}
          onOpenAgent={jest.fn()}
        />
      </SafeAreaInsetsContext.Provider>,
    );

    screen.getByTestId("agents-list").props.onRefresh();

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).toHaveBeenCalledWith(LIGHT);
  });
});
