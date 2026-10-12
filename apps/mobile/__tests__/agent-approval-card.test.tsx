import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { ActivityIndicator } from "react-native";

import { ApprovalCard } from "../components/agents/interactions/ApprovalCard";
import { PendingInteraction, type PendingInteractionProps } from "../components/agents/interactions/PendingInteraction";
import { StatusDot } from "../components/ui/StatusDot";

import { flat } from "./ui-test-utils";

const approval = {
  interactionId: "in_abcdefgh",
  chatId: "chat_research",
  agentId: "bot_research1",
  taskId: "task_abcdefgh",
  kind: "approval",
  blocking: true,
  status: "pending",
  expiresAt: "2099-01-01T00:00:00.000Z",
  revision: 3,
  payload: {
    kind: "approval",
    tool: "integration.call",
    argsDigest: "a".repeat(64),
    account: { service: "slack", label: "#northwind-deal" },
    audience: "direct",
    preview: "Brief for today's Northwind call: new VP of Ops, expanding to Germany.",
    policyRevision: 1,
  },
};

const confirmed = { interaction: { interactionId: "in_abcdefgh", status: "resolved", revision: 4 } };

function renderApproval(overrides: Partial<PendingInteractionProps> = {}) {
  const props = {
    interaction: approval,
    onResolve: jest.fn(async () => confirmed),
    onRefresh: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as PendingInteractionProps;
  return { props, ...render(<PendingInteraction {...props} />) };
}

const allow = () => screen.getByRole("button", { name: "Allow once" });
const deny = () => screen.getByRole("button", { name: "Deny" });

describe("approval card", () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    warn.mockRestore();
  });

  it("is an outlined card: gold hairline, 16 radius, 16 padding, blocks 12 apart", () => {
    render(<ApprovalCard testID="card" title="Post in Slack · #northwind-deal" onAllow={jest.fn()} onDeny={jest.fn()} />);

    expect(flat(screen.getByTestId("card"))).toMatchObject({
      borderWidth: 1,
      borderColor: "#E0AA52",
      borderRadius: 16,
      padding: 16,
      gap: 12,
    });
  });

  it("opens with a waiting dot and Needs your approval, 6 apart", () => {
    render(<ApprovalCard testID="card" title="Post in Slack · #northwind-deal" onAllow={jest.fn()} onDeny={jest.fn()} />);

    const labelRow = screen.getByTestId("card-label");
    expect(flat(labelRow)).toMatchObject({ flexDirection: "row", alignItems: "center", gap: 6 });
    expect(labelRow.findByType(StatusDot).props.tone).toBe("waiting");
    expect(flat(screen.getByText("Needs your approval"))).toMatchObject({
      fontFamily: "Geist_500Medium", fontSize: 12, lineHeight: 17, color: "#635F5F",
    });
  });

  it("titles the card in semibold 15/22", () => {
    render(<ApprovalCard title="Post in Slack · #northwind-deal" onAllow={jest.fn()} onDeny={jest.fn()} />);

    const title = screen.getByRole("header", { name: "Post in Slack · #northwind-deal" });
    expect(flat(title)).toMatchObject({
      fontFamily: "Geist_600SemiBold", fontSize: 15, lineHeight: 22, color: "#242323",
    });
  });

  it("puts the preview in a filled box, and leaves the box out when there is no preview", () => {
    const view = render(
      <ApprovalCard testID="card" title="Slack" preview="Brief for today's call." onAllow={jest.fn()} onDeny={jest.fn()} />,
    );
    expect(flat(screen.getByTestId("card-preview"))).toMatchObject({
      backgroundColor: "#FAF9F7", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
    });
    expect(flat(screen.getByText("Brief for today's call."))).toMatchObject({
      fontFamily: "Geist_400Regular", fontSize: 13, lineHeight: 18, color: "#242323",
    });

    view.rerender(<ApprovalCard testID="card" title="Slack" preview="   " onAllow={jest.fn()} onDeny={jest.fn()} />);
    expect(screen.queryByTestId("card-preview")).toBeNull();

    view.rerender(<ApprovalCard testID="card" title="Slack" onAllow={jest.fn()} onDeny={jest.fn()} />);
    expect(screen.queryByTestId("card-preview")).toBeNull();
  });

  it("offers a filled 48pt Allow once over an outline 44pt Deny, both the card's width", () => {
    render(<ApprovalCard title="Slack" onAllow={jest.fn()} onDeny={jest.fn()} />);

    expect(flat(allow())).toMatchObject({ height: 48, alignSelf: "stretch", backgroundColor: "#171717" });
    expect(flat(deny())).toMatchObject({
      height: 44, alignSelf: "stretch", backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: "#E5E5E5",
    });
  });

  it("builds the title and the preview from what the approval carries", () => {
    renderApproval();

    expect(screen.getByRole("header", { name: "Slack · #northwind-deal" })).toBeTruthy();
    expect(screen.getByText("Brief for today's Northwind call: new VP of Ops, expanding to Germany.")).toBeTruthy();
  });

  it("allows once: sends the approval at the interaction's revision", async () => {
    const { props } = renderApproval();

    fireEvent.press(allow());

    await waitFor(() => expect(props.onResolve).toHaveBeenCalledWith("in_abcdefgh", {
      kind: "approval", baseRevision: 3, decision: "approve",
    }));
  });

  it("denies: sends the refusal at the interaction's revision", async () => {
    const { props } = renderApproval();

    fireEvent.press(deny());

    await waitFor(() => expect(props.onResolve).toHaveBeenCalledWith("in_abcdefgh", {
      kind: "approval", baseRevision: 3, decision: "deny",
    }));
  });

  it("disables both buttons while a request is in flight, with the spinner on the pressed one", async () => {
    let confirm: (value: typeof confirmed) => void = () => {};
    const onResolve = jest.fn(() => new Promise<typeof confirmed>((resolve) => { confirm = resolve; }));
    renderApproval({ onResolve: onResolve as never });

    fireEvent.press(deny());

    await waitFor(() => expect(deny().props.accessibilityState).toMatchObject({ disabled: true, busy: true }));
    expect(deny().findAllByType(ActivityIndicator)).toHaveLength(1);
    expect(allow().props.accessibilityState).toMatchObject({ disabled: true, busy: false });
    expect(allow().findAllByType(ActivityIndicator)).toHaveLength(0);

    // A second press, on either button, sends nothing more.
    fireEvent.press(allow());
    fireEvent.press(deny());
    expect(onResolve).toHaveBeenCalledTimes(1);

    await act(async () => confirm(confirmed));
  });

  it("stays on screen until the server confirms, then goes and has the agent's status read again", async () => {
    let confirm: (value: typeof confirmed) => void = () => {};
    const onResolve = jest.fn(() => new Promise<typeof confirmed>((resolve) => { confirm = resolve; }));
    const { props } = renderApproval({ onResolve: onResolve as never });

    fireEvent.press(allow());
    await waitFor(() => expect(allow().props.accessibilityState).toMatchObject({ busy: true }));
    expect(screen.getByText("Needs your approval")).toBeTruthy();
    expect(props.onRefresh).not.toHaveBeenCalled();

    await act(async () => confirm(confirmed));

    expect(screen.queryByText("Needs your approval")).toBeNull();
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(props.onRefresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the card, and says so in generic words, when the answer could not be saved", async () => {
    const onResolve = jest.fn(async () => { throw new Error("upstream said no"); });
    const { props } = renderApproval({ onResolve: onResolve as never });

    fireEvent.press(allow());

    const failure = await screen.findByRole("alert");
    expect(failure.props.children).toBe("Could not save your response. Try again.");
    expect(flat(failure).color).toBe("#BA5236");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("upstream said no");
    expect(screen.getByRole("header", { name: "Slack · #northwind-deal" })).toBeTruthy();
    expect(props.onRefresh).not.toHaveBeenCalled();
    // Both buttons are back, so the answer can be given again.
    expect(allow().props.accessibilityState).toMatchObject({ disabled: false, busy: false });
    expect(deny().props.accessibilityState).toMatchObject({ disabled: false, busy: false });
  });

  it("puts the failure under the buttons, and clears it when the answer is given again", async () => {
    const onResolve = jest.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(confirmed);
    renderApproval({ onResolve: onResolve as never });
    fireEvent.press(deny());
    const failure = await screen.findByRole("alert");

    const blocks = screen.getByTestId("interaction-in_abcdefgh").children;
    const last = blocks[blocks.length - 1];
    expect(typeof last === "string" ? last : last.props.accessibilityRole).toBe("alert");
    expect(failure.props.children).toBe("Could not save your response. Try again.");

    await act(async () => {
      fireEvent.press(deny());
    });
    expect(screen.queryByText("Needs your approval")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stays gone when reading the agent's status again fails", async () => {
    const onRefresh = jest.fn(async () => { throw new Error("status down"); });
    renderApproval({ onRefresh });

    fireEvent.press(allow());

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Needs your approval")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers no answer while the agent's status is out of date", () => {
    renderApproval({ actionsAvailable: false });

    expect(screen.getByText("Needs your approval")).toBeTruthy();
    expect(screen.getByText("Status unavailable. Refresh to respond.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers no answer to an approval that has expired or whose details are hidden", () => {
    const view = renderApproval({ interaction: { ...approval, expiresAt: "2020-01-01T00:00:00.000Z" } as never });
    expect(screen.getByText("Expired")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();

    view.rerender(
      <PendingInteraction {...view.props} interaction={{ ...approval, payload: undefined } as never} />,
    );
    expect(screen.getByText("Only the designated person can respond.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("never offers Always allow", () => {
    renderApproval();

    expect(screen.queryByText("Always allow")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });
});
