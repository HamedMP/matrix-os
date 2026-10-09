import { fireEvent, render, screen } from "@testing-library/react-native";
import { Linking } from "react-native";
const mockRefetch = jest.fn();
const mockPush = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ push: mockPush }) }));
let mockSnapshot: {
  data?: unknown;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  refetch: () => void;
};
jest.mock("@/lib/queries/use-whatsapp-settings", () => ({
  useWhatsAppSettings: () => mockSnapshot,
}));
import Messaging from "../app/settings-detail/messaging";
beforeEach(() => {
  jest.clearAllMocks();
  mockSnapshot = {
    data: {
      connected: true,
      maskedSender: "••••1234",
      admission: "pilot",
      startUrl: "https://wa.me/13073174314",
      chatId: "chat_whatsapp",
    },
    isPending: false,
    isFetching: false,
    isError: false,
    refetch: mockRefetch,
  };
});
it("shows connection and safe WhatsApp actions independently of AI readiness", () => {
  const open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
  render(<Messaging />);
  expect(screen.getByText("Connected")).toBeTruthy();
  expect(screen.getByText(/Agents & providers/)).toBeTruthy();
  fireEvent.press(screen.getByText("Open WhatsApp"));
  expect(open).toHaveBeenCalledWith("https://wa.me/13073174314");
  open.mockRestore();
});
it.each(["isFetching", "isError"] as const)(
  "hides stale actions during %s",
  (flag) => {
    mockSnapshot[flag] = true;
    render(<Messaging />);
    expect(screen.queryByText("Open WhatsApp")).toBeNull();
    expect(screen.queryByText("••••1234")).toBeNull();
    if (flag === "isError") {
      fireEvent.press(screen.getByText("Try again"));
      expect(mockRefetch).toHaveBeenCalled();
    }
  },
);

it("groups Slack installation and its connection guide under Messaging", () => {
  const open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
  render(<Messaging />);
  expect(screen.getByText("Slack")).toBeTruthy();
  fireEvent.press(screen.getByText("Add to Slack"));
  expect(open).toHaveBeenCalledWith("https://app.matrix-os.com/slack/install");
  fireEvent.press(screen.getByText("Slack connection guide"));
  expect(open).toHaveBeenCalledWith("https://matrix-os.com/docs/slack-company-brain");
  fireEvent.press(screen.getByText("Open Matrix Chat"));
  expect(mockPush).toHaveBeenCalledWith({ pathname: "/open", params: { chat: "chat_whatsapp" } });
  open.mockRestore();
});
