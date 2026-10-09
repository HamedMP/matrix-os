import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";

import { PendingInteraction, type PendingInteractionProps } from "../components/agents/interactions/PendingInteraction";
import { PendingInteractions } from "../components/agents/interactions/PendingInteractions";
import { TextField } from "../components/ui/TextField";

import { flat } from "./ui-test-utils";

const base = {
  interactionId: "in_abcdefgh",
  chatId: "chat_research",
  agentId: "bot_research1",
  taskId: "task_abcdefgh",
  blocking: true,
  status: "pending",
  expiresAt: "2099-01-01T00:00:00.000Z",
  revision: 1,
};

const question = {
  ...base,
  kind: "question",
  payload: { kind: "question", questions: [
    { questionId: "target", header: "Target", question: "Which company?", allowOther: true, secret: false },
    { questionId: "format", header: "Format", question: "Which format?", allowOther: false, secret: false,
      options: [{ label: "Brief", description: "One page" }, { label: "Deck", description: "Ten slides" }] },
  ] },
};

const accountChoice = {
  ...base,
  kind: "account_choice",
  payload: { kind: "account_choice", service: "google_calendar", options: [
    { connectionId: "conn_work", label: "Work" },
    { connectionId: "conn_home", label: "Home" },
  ] },
};

const connect = {
  ...base,
  kind: "connect_request",
  payload: { kind: "connect_request", service: "gmail", access: ["read", "send"], benefit: "Read your inbox",
    connectRequestId: "cr_abcdefgh" },
};

// Read and label only: the server's narrow mail-labelling authority.
const labelAccess = ["read", "label"];
const LABEL_ACCESS_SUMMARY = "Requested access: read Inbox, add Jev classification labels";
const LABEL_ACCESS_BOUNDARY = "Preserve existing labels; no archive, send, delete, or mark read.";

const resolved = { interaction: { interactionId: "in_abcdefgh", status: "resolved", revision: 2 } };

function renderInteraction(interaction: unknown, overrides: Partial<PendingInteractionProps> = {}) {
  const props = {
    interaction,
    onResolve: jest.fn(async () => resolved),
    onRefresh: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as PendingInteractionProps;
  return { props, ...render(<PendingInteraction {...props} />) };
}

const card = () => screen.getByTestId("interaction-in_abcdefgh");

describe("an agent's other requests", () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    warn.mockRestore();
  });

  it.each([
    ["a question", question, "Question"],
    ["an account choice", accountChoice, "Choose an account"],
    ["a connect request", connect, "Connect a service"],
  ])("draws %s in the approval's card, labelled by the copy every surface shares", (_kind, interaction, label) => {
    renderInteraction(interaction);

    expect(flat(card())).toMatchObject({
      borderWidth: 1, borderColor: "#E0AA52", borderRadius: 16, padding: 16, gap: 12,
    });
    expect(flat(screen.getByText(label))).toMatchObject({ fontFamily: "Geist_500Medium", fontSize: 12, color: "#635F5F" });
    expect(screen.queryByText("Needs your approval")).toBeNull();
  });

  it("stacks everything the agent is waiting for, in the server's order, as far apart as messages", async () => {
    const onResolve = jest.fn(async () => resolved);
    render(
      <PendingInteractions
        interactions={[connect, { ...accountChoice, interactionId: "in_second01" }] as never}
        onResolve={onResolve as never}
        onRefresh={jest.fn()}
      />,
    );

    const stack = screen.getByTestId("pending-interactions");
    expect(flat(stack).gap).toBe(14);
    expect(within(stack).getAllByTestId(/^interaction-in_[a-z0-9]+$/).map((card) => card.props.testID))
      .toEqual(["interaction-in_abcdefgh", "interaction-in_second01"]);

    // Each card answers for itself.
    fireEvent.press(screen.getByRole("button", { name: "Home" }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("in_second01", {
      kind: "account_choice", baseRevision: 1, connectionId: "conn_home",
    }));
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  });

  describe("question", () => {
    it("shows an answer that is not secret as it is typed", () => {
      renderInteraction(question);

      expect(screen.getByLabelText("Answer Target").props.secureTextEntry).toBe(false);
    });

    it("sends each question's answer, typed or chosen, at the interaction's revision", async () => {
      const { props } = renderInteraction(question);
      expect(screen.getByText("Which company?")).toBeTruthy();
      expect(screen.getByText("One page")).toBeTruthy();

      fireEvent.changeText(screen.getByLabelText("Answer Target"), "Acme");
      fireEvent.press(screen.getByRole("radio", { name: "Brief" }));
      fireEvent.press(screen.getByRole("button", { name: "Answer" }));

      await waitFor(() => expect(props.onResolve).toHaveBeenCalledWith("in_abcdefgh", {
        kind: "question", baseRevision: 1, structuredAnswers: { target: ["Acme"], format: ["Brief"] },
      }));
    });

    it("cannot be answered until every question has an answer", () => {
      const { props } = renderInteraction(question);
      const answer = () => screen.getByRole("button", { name: "Answer" });
      expect(answer().props.accessibilityState).toMatchObject({ disabled: true });

      fireEvent.changeText(screen.getByLabelText("Answer Target"), "Acme");
      expect(answer().props.accessibilityState).toMatchObject({ disabled: true });
      fireEvent.press(answer());
      expect(props.onResolve).not.toHaveBeenCalled();

      fireEvent.press(screen.getByRole("radio", { name: "Deck" }));
      expect(answer().props.accessibilityState).toMatchObject({ disabled: false });
    });

    it("marks the chosen option, one at a time for a single choice", () => {
      renderInteraction(question);

      fireEvent.press(screen.getByRole("radio", { name: "Brief" }));
      expect(screen.getByRole("radio", { name: "Brief" }).props.accessibilityState).toMatchObject({ checked: true });
      expect(flat(screen.getByRole("radio", { name: "Brief" })).borderColor).toBe("#242323");

      fireEvent.press(screen.getByRole("radio", { name: "Deck" }));
      expect(screen.getByRole("radio", { name: "Brief" }).props.accessibilityState).toMatchObject({ checked: false });
      expect(screen.getByRole("radio", { name: "Deck" }).props.accessibilityState).toMatchObject({ checked: true });
    });

    it("gives every option a 44pt target", () => {
      renderInteraction(question);

      expect(flat(screen.getByRole("radio", { name: "Brief" })).minHeight).toBe(44);
    });

    it("keeps the selected option when an Other answer is typed then cleared", async () => {
      const single = { ...question, payload: { kind: "question", questions: [
        { questionId: "format", header: "Format", question: "Which format?", allowOther: true, secret: false,
          options: [{ label: "Brief", description: "One page" }] },
      ] } };
      const { props } = renderInteraction(single);

      fireEvent.press(screen.getByRole("radio", { name: "Brief" }));
      fireEvent.changeText(screen.getByLabelText("Answer Format"), "Detailed");
      fireEvent.changeText(screen.getByLabelText("Answer Format"), "");
      expect(screen.getByRole("button", { name: "Answer" }).props.accessibilityState.disabled).toBe(false);
      fireEvent.press(screen.getByRole("button", { name: "Answer" }));

      await waitFor(() => expect(props.onResolve).toHaveBeenCalledWith("in_abcdefgh", {
        kind: "question", baseRevision: 1, structuredAnswers: { format: ["Brief"] },
      }));
    });

    it("sends a typed Other answer in place of the single choice, and beside several", async () => {
      const several = { ...question, payload: { kind: "question", questions: [
        { questionId: "format", header: "Format", question: "Which format?", allowOther: true, secret: false,
          options: [{ label: "Brief", description: "One page" }] },
        { questionId: "share", header: "Share", question: "Share with whom?", allowOther: true, secret: false,
          multiSelect: true, options: [{ label: "Sales", description: "" }, { label: "Legal", description: "" }] },
      ] } };
      const { props } = renderInteraction(several);
      expect(screen.getByLabelText("Answer Format").props.placeholder).toBe("Other answer");

      fireEvent.press(screen.getByRole("radio", { name: "Brief" }));
      fireEvent.changeText(screen.getByLabelText("Answer Format"), "Detailed");
      fireEvent.press(screen.getByRole("checkbox", { name: "Sales" }));
      fireEvent.press(screen.getByRole("checkbox", { name: "Legal" }));
      fireEvent.press(screen.getByRole("checkbox", { name: "Sales" }));
      fireEvent.changeText(screen.getByLabelText("Answer Share"), " Finance ");
      fireEvent.press(screen.getByRole("button", { name: "Answer" }));

      await waitFor(() => expect(props.onResolve).toHaveBeenCalledWith("in_abcdefgh", {
        kind: "question", baseRevision: 1, structuredAnswers: { format: ["Detailed"], share: ["Legal", "Finance"] },
      }));
    });

    it("hides a secret answer as it is typed, and caps what can be typed", () => {
      const secret = { ...question, payload: { kind: "question", questions: [
        { questionId: "token", header: "Token", question: "What is the code?", allowOther: false, secret: true },
      ] } };
      renderInteraction(secret);

      const field = screen.getByLabelText("Answer Token");
      expect(field.props).toMatchObject({ secureTextEntry: true, maxLength: 400, placeholder: "Your answer" });
      // The app's own text field, not one of this card's.
      expect(screen.UNSAFE_getByType(TextField).props.accessibilityLabel).toBe("Answer Token");
    });

    it("locks the form while the answer is on its way, and keeps what was typed when it fails", async () => {
      let fail: (reason: Error) => void = () => {};
      const onResolve = jest.fn(() => new Promise<never>((_resolve, reject) => { fail = reject; }));
      const single = { ...question, payload: { kind: "question", questions: [question.payload.questions[0]] } };
      renderInteraction(single, { onResolve: onResolve as never });
      fireEvent.changeText(screen.getByLabelText("Answer Target"), "Acme");

      fireEvent.press(screen.getByRole("button", { name: "Answer" }));
      await waitFor(() => (
        expect(screen.getByRole("button", { name: "Answer" }).props.accessibilityState).toMatchObject({ busy: true })
      ));
      expect(screen.getByLabelText("Answer Target").props.editable).toBe(false);

      await act(async () => fail(new Error("upstream said no")));

      expect(screen.getByRole("alert").props.children).toBe("Could not save your response. Try again.");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("upstream said no");
      expect(screen.getByLabelText("Answer Target").props.value).toBe("Acme");
      expect(screen.getByLabelText("Answer Target").props.editable).toBe(true);
    });

    it("goes once the server has the answer", async () => {
      const single = { ...question, payload: { kind: "question", questions: [question.payload.questions[0]] } };
      const { props } = renderInteraction(single);
      fireEvent.changeText(screen.getByLabelText("Answer Target"), "Acme");

      await act(async () => {
        fireEvent.press(screen.getByRole("button", { name: "Answer" }));
      });

      expect(screen.queryByText("Which company?")).toBeNull();
      expect(props.onRefresh).toHaveBeenCalledTimes(1);
    });

    it("shows the questions read-only while the agent's status is out of date", () => {
      renderInteraction(question, { actionsAvailable: false });

      expect(screen.getByText("Which company?")).toBeTruthy();
      expect(screen.getByText("Status unavailable. Refresh to respond.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
      expect(screen.queryByLabelText("Answer Target")).toBeNull();
    });
  });

  describe("account choice", () => {
    it("titles the card with the service and offers each account as a button", () => {
      renderInteraction(accountChoice);

      expect(screen.getByRole("header", { name: "Google Calendar" })).toBeTruthy();
      expect(flat(screen.getByRole("button", { name: "Work" }))).toMatchObject({
        height: 44, alignSelf: "stretch", borderWidth: 1, borderColor: "#E5E5E5",
      });
      expect(screen.getByRole("button", { name: "Home" })).toBeTruthy();
    });

    it("sends the chosen connection, with the other accounts held back meanwhile", async () => {
      let confirm: (value: typeof resolved) => void = () => {};
      const onResolve = jest.fn(() => new Promise<typeof resolved>((resolve) => { confirm = resolve; }));
      renderInteraction(accountChoice, { onResolve: onResolve as never });

      fireEvent.press(screen.getByRole("button", { name: "Home" }));

      await waitFor(() => (
        expect(screen.getByRole("button", { name: "Home" }).props.accessibilityState).toMatchObject({ busy: true })
      ));
      expect(onResolve).toHaveBeenCalledWith("in_abcdefgh", {
        kind: "account_choice", baseRevision: 1, connectionId: "conn_home",
      });
      expect(screen.getByRole("button", { name: "Work" }).props.accessibilityState).toMatchObject({ disabled: true, busy: false });
      fireEvent.press(screen.getByRole("button", { name: "Work" }));
      expect(onResolve).toHaveBeenCalledTimes(1);

      await act(async () => confirm(resolved));
      expect(screen.queryByText("Choose an account")).toBeNull();
    });
  });

  describe("account choice access", () => {
    const labelChoice = {
      ...accountChoice,
      payload: { ...accountChoice.payload, service: "gmail", access: labelAccess },
    };

    it("says what the agent may do with the account, and what it may not, before one is chosen", () => {
      renderInteraction(labelChoice);

      expect(flat(screen.getByText(LABEL_ACCESS_SUMMARY))).toMatchObject({ fontSize: 13, lineHeight: 18, color: "#635F5F" });
      expect(screen.getByText(LABEL_ACCESS_BOUNDARY)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Work" })).toBeTruthy();
    });

    it("says nothing about access for a request stored before the server disclosed it", () => {
      renderInteraction(accountChoice);

      expect(screen.queryByText(/Requested access/)).toBeNull();
    });

    it("keeps the access in view while the agent's status is out of date", () => {
      renderInteraction(labelChoice, { actionsAvailable: false });

      expect(screen.getByText(LABEL_ACCESS_SUMMARY)).toBeTruthy();
      expect(screen.getByText(LABEL_ACCESS_BOUNDARY)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Work" })).toBeNull();
    });
  });

  describe("connect request", () => {
    it("words narrow access the way every surface does, with what stays untouched", () => {
      renderInteraction({ ...connect, payload: { ...connect.payload, access: labelAccess } });

      expect(screen.getByText(LABEL_ACCESS_SUMMARY)).toBeTruthy();
      expect(screen.getByText(LABEL_ACCESS_BOUNDARY)).toBeTruthy();
    });

    it("keeps the access in view on the way to the page where the service is connected", async () => {
      const onResolve = jest.fn(async () => ({ ...resolved, connectUrl: "https://example.com/consent" }));
      renderInteraction({ ...connect, payload: { ...connect.payload, access: labelAccess } }, { onResolve: onResolve as never });

      fireEvent.press(screen.getByRole("button", { name: "Connect" }));

      await screen.findByRole("button", { name: "Continue connecting" });
      expect(screen.getByText(LABEL_ACCESS_SUMMARY)).toBeTruthy();
      expect(screen.getByText(LABEL_ACCESS_BOUNDARY)).toBeTruthy();
    });

    it("says what the agent wants and why, with Connect over Decline", () => {
      renderInteraction(connect);

      expect(screen.getByRole("header", { name: "Gmail" })).toBeTruthy();
      expect(screen.getByText("Read your inbox")).toBeTruthy();
      expect(screen.getByText("Requested access: read, send")).toBeTruthy();
      expect(flat(screen.getByRole("button", { name: "Connect" }))).toMatchObject({ height: 48, backgroundColor: "#171717" });
      expect(flat(screen.getByRole("button", { name: "Decline" }))).toMatchObject({ height: 44, borderWidth: 1 });
    });

    it("declines, and goes once the server has that", async () => {
      const { props } = renderInteraction(connect);

      await act(async () => {
        fireEvent.press(screen.getByRole("button", { name: "Decline" }));
      });

      expect(props.onResolve).toHaveBeenCalledWith("in_abcdefgh", {
        kind: "connect_request", baseRevision: 1, action: "decline",
      });
      expect(screen.queryByText("Connect a service")).toBeNull();
    });

    it("starts connecting, then stays to open the page the server names", async () => {
      const onResolve = jest.fn(async () => ({ ...resolved, connectUrl: "https://example.com/consent" }));
      const onConnectUrl = jest.fn(async () => undefined);
      renderInteraction(connect, { onResolve: onResolve as never, onConnectUrl });

      fireEvent.press(screen.getByRole("button", { name: "Connect" }));

      const next = await screen.findByRole("button", { name: "Continue connecting" });
      expect(onResolve).toHaveBeenCalledWith("in_abcdefgh", { kind: "connect_request", baseRevision: 1, action: "start" });
      expect(screen.getByRole("header", { name: "Gmail" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
      expect(onConnectUrl).not.toHaveBeenCalled();

      fireEvent.press(next);
      await waitFor(() => expect(onConnectUrl).toHaveBeenCalledWith("https://example.com/consent"));
    });

    it("keeps a resolved connect request settled when opening consent fails", async () => {
      const onResolve = jest.fn(async () => ({ ...resolved, connectUrl: "https://example.com/consent" }));
      const onConnectUrl = jest.fn(async () => { throw new Error("Native browser unavailable"); });
      renderInteraction(connect, { onResolve: onResolve as never, onConnectUrl });

      fireEvent.press(screen.getByRole("button", { name: "Connect" }));
      fireEvent.press(await screen.findByRole("button", { name: "Continue connecting" }));

      await waitFor(() => expect(screen.getByText("Could not open the connection page. Try again.")).toBeTruthy());
      expect(screen.queryByText("Could not save your response. Try again.")).toBeNull();
      expect(JSON.stringify(warn.mock.calls)).not.toContain("Native browser unavailable");
      expect(onResolve).toHaveBeenCalledTimes(1);
    });
  });
});
