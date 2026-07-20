import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock("expo-auth-session", () => ({
  makeRedirectUri: () => "matrixos://sso-callback",
}));

jest.mock("expo-web-browser", () => ({
  maybeCompleteAuthSession: jest.fn(),
}));

const mockStartSSOFlow = jest.fn();
const mockSetActive = jest.fn(() => Promise.resolve());
const mockCreate = jest.fn();
const mockPrepareFirstFactor = jest.fn(() => Promise.resolve({ status: "needs_first_factor" }));
const mockAttemptFirstFactor = jest.fn(() =>
  Promise.resolve({ status: "complete", createdSessionId: "sess_1" }),
);

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ isSignedIn: false }),
  useSSO: () => ({ startSSOFlow: mockStartSSOFlow }),
  useSignIn: () => ({
    isLoaded: true,
    setActive: mockSetActive,
    signIn: { create: mockCreate },
  }),
}));

const mockNormalizeGatewayUrl = jest.fn((url: string) => url);
jest.mock("@/lib/storage", () => ({
  HOSTED_GATEWAY_URL: "https://app.matrix-os.com",
  getSelectedGatewayConnection: jest.fn(() =>
    Promise.resolve({ url: "https://app.matrix-os.com" }),
  ),
  isHostedGatewayUrl: (url: string) => url === "https://app.matrix-os.com",
  normalizeGatewayUrl: (url: string) => mockNormalizeGatewayUrl(url),
  saveSelectedGatewayBasicAuth: jest.fn(),
  saveSelectedGatewayUrl: jest.fn(() => Promise.resolve()),
}));

jest.mock("../app/_layout", () => ({
  useGateway: () => ({ setGateway: jest.fn() }),
}));

import SignInScreen from "../app/sign-in";

function attemptWithEmailCodeFactor() {
  return {
    status: "needs_first_factor",
    supportedFirstFactors: [
      { strategy: "email_code", emailAddressId: "idn_1", safeIdentifier: "n***@matrix-os.com" },
    ],
    prepareFirstFactor: mockPrepareFirstFactor,
    attemptFirstFactor: mockAttemptFirstFactor,
  };
}

describe("SignInScreen email code flow", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNormalizeGatewayUrl.mockImplementation((url: string) => url);
    mockCreate.mockImplementation(() => Promise.resolve(attemptWithEmailCodeFactor()));
  });

  it("offers email sign-in next to the OAuth providers", () => {
    render(<SignInScreen />);

    expect(screen.getByText("Continue with Google")).toBeTruthy();
    expect(screen.getByText("Continue with GitHub")).toBeTruthy();
    expect(screen.getByText("Email me a code")).toBeTruthy();
  });

  it("sends a code, verifies it, and activates the session", async () => {
    render(<SignInScreen />);

    fireEvent.changeText(screen.getByLabelText("Email address"), "Neo@Matrix-OS.com");
    fireEvent.press(screen.getByText("Email me a code"));

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith({ identifier: "neo@matrix-os.com" });
    });
    expect(mockPrepareFirstFactor).toHaveBeenCalledWith({
      strategy: "email_code",
      emailAddressId: "idn_1",
    });
    expect(await screen.findByText(/n\*\*\*@matrix-os\.com/)).toBeTruthy();

    fireEvent.changeText(screen.getByLabelText("Verification code"), "123456");
    fireEvent.press(screen.getByText("Verify and sign in"));

    await waitFor(() => {
      expect(mockSetActive).toHaveBeenCalledWith({ session: "sess_1" });
    });
    expect(mockReplace).toHaveBeenCalledWith("/(tabs)/apps");
  });

  it("keeps the user on the code step and shows why an incorrect code failed", async () => {
    mockAttemptFirstFactor.mockImplementationOnce(() =>
      Promise.reject({ errors: [{ longMessage: "Incorrect code. Try again." }] }),
    );
    render(<SignInScreen />);

    fireEvent.changeText(screen.getByLabelText("Email address"), "neo@matrix-os.com");
    fireEvent.press(screen.getByText("Email me a code"));
    await screen.findByLabelText("Verification code");

    fireEvent.changeText(screen.getByLabelText("Verification code"), "000000");
    fireEvent.press(screen.getByText("Verify and sign in"));

    expect(await screen.findByText("Incorrect code. Try again.")).toBeTruthy();
    expect(mockSetActive).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Verification code")).toBeTruthy();
  });

  it("surfaces an unknown account without moving to the code step", async () => {
    mockCreate.mockImplementationOnce(() =>
      Promise.reject({
        errors: [{ code: "form_identifier_not_found", longMessage: "Couldn't find your account." }],
      }),
    );
    render(<SignInScreen />);

    fireEvent.changeText(screen.getByLabelText("Email address"), "ghost@matrix-os.com");
    fireEvent.press(screen.getByText("Email me a code"));

    expect(await screen.findByText("Couldn't find your account.")).toBeTruthy();
    expect(screen.queryByLabelText("Verification code")).toBeNull();
  });

  it("reports a bad computer URL as a URL problem, without starting a Clerk attempt", async () => {
    mockNormalizeGatewayUrl.mockImplementation(() => {
      throw new Error("Enter a valid Matrix OS URL.");
    });
    render(<SignInScreen />);

    fireEvent.changeText(screen.getByLabelText("Email address"), "neo@matrix-os.com");
    fireEvent.press(screen.getByText("Email me a code"));

    expect(await screen.findByText("Enter a valid Matrix OS URL.")).toBeTruthy();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns to the email step so a typo can be corrected", async () => {
    render(<SignInScreen />);

    fireEvent.changeText(screen.getByLabelText("Email address"), "neo@matrix-os.com");
    fireEvent.press(screen.getByText("Email me a code"));
    await screen.findByLabelText("Verification code");

    fireEvent.press(screen.getByText("Use a different email"));

    expect(screen.getByLabelText("Email address")).toBeTruthy();
    expect(screen.queryByLabelText("Verification code")).toBeNull();
  });
});
