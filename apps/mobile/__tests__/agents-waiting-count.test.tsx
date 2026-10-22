import { renderHook } from "@testing-library/react-native";

import { useAgentsWaitingCount } from "../components/agents/use-agents-waiting-count";

const mockUseAgents = jest.fn();
const mockUseAgentStatuses = jest.fn();

jest.mock("@/lib/queries/use-agents", () => ({ useAgents: () => mockUseAgents() }));
jest.mock("@/lib/queries/use-agent-statuses", () => ({
  useAgentStatuses: (...args: unknown[]) => mockUseAgentStatuses(...args),
}));

describe("agents waiting count", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("is how many of the saved agents are waiting on the person", () => {
    const agents = [{ id: "bot_a" }, { id: "bot_b" }, { id: "bot_c" }];
    mockUseAgents.mockReturnValue({ agents });
    mockUseAgentStatuses.mockReturnValue({ waitingCount: 2 });

    const { result, unmount } = renderHook(() => useAgentsWaitingCount());

    expect(result.current).toBe(2);
    expect(mockUseAgentStatuses).toHaveBeenCalledWith(agents);
    unmount();
  });

  it("is zero while there are no agents", () => {
    mockUseAgents.mockReturnValue({ agents: [] });
    mockUseAgentStatuses.mockReturnValue({ waitingCount: 0 });

    const { result, unmount } = renderHook(() => useAgentsWaitingCount());

    expect(result.current).toBe(0);
    unmount();
  });
});
