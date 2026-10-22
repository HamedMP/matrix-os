import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Platform, StyleSheet } from "react-native";

const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
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

const mockAppleIsAvailable = jest.fn(() => Promise.resolve(true));
const mockAppleSignInAsync = jest.fn();
jest.mock("expo-apple-authentication", () => {
  const { Pressable } = require("react-native");
  const mockReact = require("react");
  return {
    isAvailableAsync: () => mockAppleIsAvailable(),
    signInAsync: (options: unknown) => mockAppleSignInAsync(options),
    AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
    AppleAuthenticationButtonType: { SIGN_IN: 0, CONTINUE: 1, SIGN_UP: 2 },
    AppleAuthenticationButtonStyle: { WHITE: 0, WHITE_OUTLINE: 1, BLACK: 2 },
    AppleAuthenticationButton: (props: Record<string, unknown>) =>
      mockReact.createElement(Pressable, { accessibilityRole: "button", ...props }),
  };
});

const mockStartSSOFlow = jest.fn();
const mockSetActive = jest.fn(() => Promise.resolve());
const mockGetToken = jest.fn(() => Promise.resolve<string | null>("clerk-token"));
const mockSignInCreate = jest.fn();
const mockSignUpCreate = jest.fn();
const mockSignUpUpdate = jest.fn();

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ isSignedIn: false, getToken: mockGetToken }),
  useSSO: () => ({ startSSOFlow: mockStartSSOFlow }),
  useSignIn: () => ({
    isLoaded: true,
    setActive: mockSetActive,
    signIn: { create: mockSignInCreate },
  }),
  useSignUp: () => ({
    isLoaded: true,
    signUp: { create: mockSignUpCreate },
  }),
}));

const mockRegisterAppleAuthorizationCode = jest.fn((_token: string, _code: string) =>
  Promise.resolve(),
);
jest.mock("@/lib/requests/apple-authorization", () => ({
  registerAppleAuthorizationCode: (token: string, code: string) =>
    mockRegisterAppleAuthorizationCode(token, code),
}));

jest.mock("@/lib/storage", () => ({
  HOSTED_GATEWAY_URL: "https://app.matrix-os.com",
  getSelectedGatewayConnection: jest.fn(() =>
    Promise.resolve({ url: "https://app.matrix-os.com" }),
  ),
  isHostedGatewayUrl: (url: string) => url === "https://app.matrix-os.com",
  normalizeGatewayUrl: (url: string) => url,
  saveSelectedGatewayBasicAuth: jest.fn(),
  saveSelectedGatewayUrl: jest.fn(() => Promise.resolve()),
}));

jest.mock("../app/_layout", () => ({
  useGateway: () => ({ setGateway: jest.fn() }),
}));

import SignInScreen from "../app/sign-in";

const APPLE_BUTTON = "apple-sign-in-button";

const appleCredential = {
  user: "001234.abc",
  identityToken: "apple.identity.token",
  authorizationCode: "apple-auth-code",
  fullName: { givenName: "Thomas", familyName: "Anderson" },
  email: "thomas@matrix-os.com",
};

function pendingSignUp() {
  return {
    status: "missing_requirements",
    createdSessionId: null,
    missingFields: ["username", "legal_accepted"],
    unverifiedFields: [],
    emailAddress: "thomas@matrix-os.com",
    update: mockSignUpUpdate,
  };
}

describe("SignInScreen Sign in with Apple", () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    mockAppleIsAvailable.mockImplementation(() => Promise.resolve(true));
    mockAppleSignInAsync.mockImplementation(() => Promise.resolve(appleCredential));
    mockGetToken.mockImplementation(() => Promise.resolve("clerk-token"));
    mockRegisterAppleAuthorizationCode.mockImplementation(() => Promise.resolve());
    mockSignInCreate.mockImplementation(() =>
      Promise.resolve({
        status: "complete",
        createdSessionId: "sess_apple",
        firstFactorVerification: { status: "verified" },
      }),
    );
    mockSignUpCreate.mockImplementation(() => Promise.resolve(pendingSignUp()));
    mockSignUpUpdate.mockImplementation(() =>
      Promise.resolve({ status: "complete", createdSessionId: "sess_new" }),
    );
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("offers the system Sign in with Apple button next to the other providers", () => {
    render(<SignInScreen />);

    expect(screen.getByTestId(APPLE_BUTTON)).toBeTruthy();
    expect(screen.getByLabelText("Continue with Google")).toBeTruthy();
    expect(screen.getByLabelText("Continue with GitHub")).toBeTruthy();
  });

  it("uses the black system style on the light theme the app ships with", () => {
    render(<SignInScreen />);

    const button = screen.getByTestId(APPLE_BUTTON);
    expect(button.props.buttonType).toBe(0);
    expect(button.props.buttonStyle).toBe(2);
  });

  it("sizes the system button so its title is as large as the Sign in label", () => {
    // iOS draws the title at about 43% of the button's height and offers no
    // font size, so a 16pt title means a 38pt-high button.
    render(<SignInScreen />);

    const frame = StyleSheet.flatten(screen.getByTestId("apple-sign-in").props.style);
    expect(frame.height).toBe(38);
  });

  it("does not offer Apple on Android, where the native flow does not exist", () => {
    const platform = jest.replaceProperty(Platform, "OS", "android");
    try {
      render(<SignInScreen />);

      expect(screen.queryByTestId(APPLE_BUTTON)).toBeNull();
      expect(screen.getByLabelText("Continue with Google")).toBeTruthy();
    } finally {
      platform.restore();
    }
  });

  it("signs an existing account in and opens the app", async () => {
    render(<SignInScreen />);

    fireEvent.press(screen.getByTestId(APPLE_BUTTON));

    await waitFor(() => {
      expect(mockSetActive).toHaveBeenCalledWith({ session: "sess_apple" });
    });
    expect(mockAppleSignInAsync).toHaveBeenCalledWith({
      requestedScopes: [0, 1],
      nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(mockSignInCreate).toHaveBeenCalledWith({
      strategy: "oauth_token_apple",
      token: "apple.identity.token",
    });
    expect(mockSignUpCreate).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith("/(drawer)");
  });

  it("creates an account for a first-time Apple user without asking for anything else", async () => {
    mockSignInCreate.mockImplementationOnce(() =>
      Promise.resolve({
        status: "needs_identifier",
        createdSessionId: null,
        firstFactorVerification: { status: "transferable" },
      }),
    );
    render(<SignInScreen />);

    fireEvent.press(screen.getByTestId(APPLE_BUTTON));

    await waitFor(() => {
      expect(mockSetActive).toHaveBeenCalledWith({ session: "sess_new" });
    });
    expect(mockSignUpCreate).toHaveBeenCalledWith({ transfer: true });
    expect(mockSignUpUpdate).toHaveBeenCalledWith({
      username: "thomas",
      legalAccepted: true,
      firstName: "Thomas",
      lastName: "Anderson",
    });
    expect(mockReplace).toHaveBeenCalledWith("/(drawer)");
  });

  it("hands Apple's authorization code to the platform once the session is active", async () => {
    render(<SignInScreen />);

    fireEvent.press(screen.getByTestId(APPLE_BUTTON));

    await waitFor(() => {
      expect(mockRegisterAppleAuthorizationCode).toHaveBeenCalledWith(
        "clerk-token",
        "apple-auth-code",
      );
    });
    expect(mockSetActive.mock.invocationCallOrder[0]).toBeLessThan(
      mockRegisterAppleAuthorizationCode.mock.invocationCallOrder[0],
    );
  });

  it("opens the app even when the platform does not accept the authorization code", async () => {
    mockRegisterAppleAuthorizationCode.mockImplementationOnce(() =>
      Promise.reject(new Error("Apple authorization could not be registered.")),
    );
    render(<SignInScreen />);

    fireEvent.press(screen.getByTestId(APPLE_BUTTON));

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/(drawer)");
    });
    await waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        "[mobile] apple authorization not registered:",
        "Apple authorization could not be registered.",
      );
    });
    expect(screen.queryByText(/could not be registered/i)).toBeNull();
  });

  it("skips the platform call when there is no session token to send", async () => {
    mockGetToken.mockImplementationOnce(() => Promise.resolve(null));
    render(<SignInScreen />);

    fireEvent.press(screen.getByTestId(APPLE_BUTTON));

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/(drawer)");
    });
    expect(mockRegisterAppleAuthorizationCode).not.toHaveBeenCalled();
  });

  it("stays quiet when the user dismisses Apple's sheet", async () => {
    mockAppleSignInAsync.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("canceled"), { code: "ERR_REQUEST_CANCELED" })),
    );
    render(<SignInScreen />);

    fireEvent.press(screen.getByTestId(APPLE_BUTTON));

    await waitFor(() => {
      expect(mockAppleSignInAsync).toHaveBeenCalledTimes(1);
    });
    // The button is usable again, which only happens once the attempt settled.
    await waitFor(() => {
      expect(screen.getByTestId("apple-sign-in").props.pointerEvents).toBe("auto");
    });
    expect(screen.queryByText(/apple/i)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(mockSignInCreate).not.toHaveBeenCalled();
    expect(mockSetActive).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("logs what Apple reported, which the screen deliberately leaves out", async () => {
    mockAppleSignInAsync.mockImplementationOnce(() =>
      Promise.reject(new Error("The authorization attempt failed for an unknown reason")),
    );
    render(<SignInScreen />);

    fireEvent.press(screen.getByTestId(APPLE_BUTTON));

    expect(
      await screen.findByText("Sign in with Apple did not complete. Try again."),
    ).toBeTruthy();
    expect(warn).toHaveBeenCalledWith(
      "[mobile] apple credential request failed:",
      "The authorization attempt failed for an unknown reason",
    );
    expect(screen.queryByText(/unknown reason/)).toBeNull();
  });

  it("stays quiet for the code-less dismissal the native module really sends", async () => {
    mockAppleSignInAsync.mockImplementationOnce(() =>
      Promise.reject(new Error("The user canceled the authorization attempt")),
    );
    render(<SignInScreen />);

    fireEvent.press(screen.getByTestId(APPLE_BUTTON));

    await waitFor(() => {
      expect(mockAppleSignInAsync).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId("apple-sign-in").props.pointerEvents).toBe("auto");
    });
    expect(screen.queryByText(/apple/i)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(mockSignInCreate).not.toHaveBeenCalled();
  });

  it("explains a failed Apple sign-in on the screen in this app's own words", async () => {
    mockSignInCreate.mockImplementationOnce(() =>
      Promise.reject({
        errors: [{ code: "user_locked", longMessage: "Your account is locked for 30 minutes." }],
      }),
    );
    render(<SignInScreen />);

    fireEvent.press(screen.getByTestId(APPLE_BUTTON));

    expect(
      await screen.findByText("This account is locked. Try again later or contact support."),
    ).toBeTruthy();
    expect(screen.queryByText(/30 minutes/)).toBeNull();
    expect(mockSetActive).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("does not show a provider message when the session fails to activate", async () => {
    mockSetActive.mockImplementationOnce(() =>
      Promise.reject({
        errors: [{ code: "mystery_failure", longMessage: "pq: connection refused at 10.0.0.4" }],
      }),
    );
    render(<SignInScreen />);

    fireEvent.press(screen.getByTestId(APPLE_BUTTON));

    expect(
      await screen.findByText("We could not sign you in with Apple. Try again in a moment."),
    ).toBeTruthy();
    expect(screen.queryByText(/connection refused/)).toBeNull();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("says so when the device cannot use Sign in with Apple", async () => {
    mockAppleIsAvailable.mockImplementationOnce(() => Promise.resolve(false));
    render(<SignInScreen />);

    fireEvent.press(screen.getByTestId(APPLE_BUTTON));

    expect(
      await screen.findByText("Sign in with Apple is not available on this device."),
    ).toBeTruthy();
    expect(mockAppleSignInAsync).not.toHaveBeenCalled();
  });

  it("does not start a second attempt while one is in flight", async () => {
    let releaseCredential: (value: unknown) => void = () => {};
    mockAppleSignInAsync.mockImplementationOnce(
      () => new Promise((resolve) => { releaseCredential = resolve; }),
    );
    render(<SignInScreen />);

    fireEvent.press(screen.getByTestId(APPLE_BUTTON));
    fireEvent.press(screen.getByTestId(APPLE_BUTTON));
    fireEvent.press(screen.getByTestId(APPLE_BUTTON));

    await waitFor(() => {
      expect(mockAppleSignInAsync).toHaveBeenCalledTimes(1);
    });
    // While Apple's sheet is up the rest of the screen must not start a flow.
    expect(screen.getByLabelText("Continue with Google").props.accessibilityState?.disabled).toBe(
      true,
    );

    releaseCredential(appleCredential);
    await waitFor(() => {
      expect(mockSetActive).toHaveBeenCalledTimes(1);
    });
  });

  it("makes way for the code entry once an email code has been sent", async () => {
    const attempt = {
      status: "needs_first_factor",
      supportedFirstFactors: [
        { strategy: "email_code", emailAddressId: "idn_1", safeIdentifier: "n***@matrix-os.com" },
      ],
      prepareFirstFactor: jest.fn(() => Promise.resolve({})),
      attemptFirstFactor: jest.fn(),
    };
    mockSignInCreate.mockImplementationOnce(() => Promise.resolve(attempt));
    render(<SignInScreen />);

    fireEvent.changeText(screen.getByLabelText("Email address"), "neo@matrix-os.com");
    fireEvent.press(screen.getByLabelText("Email me a code instead"));
    await screen.findByLabelText("Verification code");

    expect(screen.queryByTestId(APPLE_BUTTON)).toBeNull();
  });
});

describe("SignInScreen first-time Google and GitHub accounts", () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    mockSignUpUpdate.mockImplementation(() =>
      Promise.resolve({ status: "complete", createdSessionId: "sess_new" }),
    );
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it.each([
    ["Continue with Google", "oauth_google"],
    ["Continue with GitHub", "oauth_github"],
  ])("finishes the sign-up that %s leaves pending", async (label, strategy) => {
    mockStartSSOFlow.mockImplementationOnce(() =>
      Promise.resolve({
        createdSessionId: null,
        setActive: mockSetActive,
        signUp: pendingSignUp(),
        authSessionResult: { type: "success", url: "matrixos://sso-callback" },
      }),
    );
    render(<SignInScreen />);

    fireEvent.press(screen.getByLabelText(label));

    await waitFor(() => {
      expect(mockSetActive).toHaveBeenCalledWith({ session: "sess_new" });
    });
    expect(mockStartSSOFlow).toHaveBeenCalledWith({
      strategy,
      redirectUrl: "matrixos://sso-callback",
    });
    expect(mockSignUpUpdate).toHaveBeenCalledWith({ username: "thomas", legalAccepted: true });
    expect(mockReplace).toHaveBeenCalledWith("/(drawer)");
  });

  it("still signs a returning account in with the session the provider flow created", async () => {
    mockStartSSOFlow.mockImplementationOnce(() =>
      Promise.resolve({
        createdSessionId: "sess_google",
        setActive: mockSetActive,
        signUp: { status: null },
        authSessionResult: { type: "success", url: "matrixos://sso-callback" },
      }),
    );
    render(<SignInScreen />);

    fireEvent.press(screen.getByLabelText("Continue with Google"));

    await waitFor(() => {
      expect(mockSetActive).toHaveBeenCalledWith({ session: "sess_google" });
    });
    expect(mockSignUpUpdate).not.toHaveBeenCalled();
  });

  it("does not finish an earlier pending sign-up when the browser round trip is cancelled", async () => {
    mockStartSSOFlow.mockImplementationOnce(() =>
      Promise.resolve({
        createdSessionId: null,
        setActive: mockSetActive,
        signUp: pendingSignUp(),
        authSessionResult: { type: "cancel" },
      }),
    );
    render(<SignInScreen />);

    fireEvent.press(screen.getByLabelText("Continue with Google"));

    await waitFor(() => {
      expect(mockStartSSOFlow).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Continue with Google").props.accessibilityState?.disabled).toBe(
        false,
      );
    });
    expect(mockSignUpUpdate).not.toHaveBeenCalled();
    expect(mockSetActive).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("tells a new user where to finish when the sign-up needs more than the app can supply", async () => {
    mockStartSSOFlow.mockImplementationOnce(() =>
      Promise.resolve({
        createdSessionId: null,
        setActive: mockSetActive,
        signUp: { ...pendingSignUp(), missingFields: ["username", "phone_number"] },
        authSessionResult: { type: "success", url: "matrixos://sso-callback" },
      }),
    );
    render(<SignInScreen />);

    fireEvent.press(screen.getByLabelText("Continue with Google"));

    expect(
      await screen.findByText(
        "Finish creating your account at app.matrix-os.com, then sign in here.",
      ),
    ).toBeTruthy();
    expect(mockSetActive).not.toHaveBeenCalled();
  });
});
