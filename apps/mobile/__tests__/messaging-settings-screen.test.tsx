import { fireEvent, render, screen } from "@testing-library/react-native";
import { Linking } from "react-native";
const mockRefetch = jest.fn();
const mockPush = jest.fn();
let mockPlatformOrigin = "https://app.matrix-os.com";
jest.mock("@/lib/platform-origin", () => ({ get MOBILE_PLATFORM_ORIGIN() { return mockPlatformOrigin; } }));
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
  mockPlatformOrigin = "https://app.matrix-os.com";
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
it("uses the configured platform for browser entries and preserves local Chat navigation", () => {
  mockPlatformOrigin = "https://messaging-stage.example.com";
  const open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
  render(<Messaging />);
  fireEvent.press(screen.getByText("Manage connection"));
  expect(open).toHaveBeenCalledWith("https://messaging-stage.example.com/whatsapp/connect");
  fireEvent.press(screen.getByText("Add to Slack"));
  expect(open).toHaveBeenCalledWith("https://messaging-stage.example.com/slack/install");
  fireEvent.press(screen.getByText("Open Matrix Chat"));
  expect(mockPush).toHaveBeenCalledWith({ pathname: "/open", params: { chat: "chat_whatsapp" } });
  open.mockRestore();
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
