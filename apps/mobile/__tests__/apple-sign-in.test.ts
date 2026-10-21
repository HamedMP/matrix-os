import { EmailCodeSignInError } from "../lib/clerk-sign-in";
import {
  describeAppleFailure,
  isAppleCancellation,
  signInWithApple,
  type AppleCredentialLike,
  type AppleSignInDependencies,
} from "../lib/apple-sign-in";

const credential: AppleCredentialLike = {
  identityToken: "apple.identity.token",
  authorizationCode: "apple-auth-code",
  fullName: { givenName: "Thomas", familyName: "Anderson" },
};

function dependencies(overrides: Partial<AppleSignInDependencies> = {}): AppleSignInDependencies {
  return {
    requestCredential: jest.fn(() => Promise.resolve(credential)),
    signIn: {
      create: jest.fn(() =>
        Promise.resolve({
          status: "complete",
          createdSessionId: "sess_existing",
          firstFactorVerification: { status: "verified" },
        }),
      ),
    },
    signUp: {
      create: jest.fn(() =>
        Promise.resolve({
          status: "missing_requirements",
          createdSessionId: null,
          missingFields: ["username", "legal_accepted"],
          unverifiedFields: [],
          emailAddress: "thomas@matrix-os.com",
          update: jest.fn(() =>
            Promise.resolve({ status: "complete", createdSessionId: "sess_new" }),
          ),
        }),
      ),
    },
    randomSuffix: () => "k3x9qa",
    ...overrides,
  };
}

function transferableSignIn() {
  return {
    create: jest.fn(() =>
      Promise.resolve({
        status: "needs_identifier",
        createdSessionId: null,
        firstFactorVerification: { status: "transferable" },
      }),
    ),
  };
}

describe("signInWithApple", () => {
  it("signs an existing account in with Apple's identity token", async () => {
    const deps = dependencies();

    await expect(signInWithApple(deps)).resolves.toEqual({
      createdSessionId: "sess_existing",
      authorizationCode: "apple-auth-code",
    });
    expect(deps.signIn.create).toHaveBeenCalledWith({
      strategy: "oauth_token_apple",
      token: "apple.identity.token",
    });
    expect(deps.signUp.create).not.toHaveBeenCalled();
  });

  it("creates the account for a first-time Apple user and finishes its sign-up", async () => {
    const deps = dependencies({ signIn: transferableSignIn() });

    await expect(signInWithApple(deps)).resolves.toEqual({
      createdSessionId: "sess_new",
      authorizationCode: "apple-auth-code",
    });
    expect(deps.signUp.create).toHaveBeenCalledWith({ transfer: true });

    const pending = await (deps.signUp.create as jest.Mock).mock.results[0].value;
    expect(pending.update).toHaveBeenCalledWith({
      username: "thomas",
      legalAccepted: true,
      firstName: "Thomas",
      lastName: "Anderson",
    });
  });

  it("uses the session straight away when the transfer needs nothing more", async () => {
    const deps = dependencies({
      signIn: transferableSignIn(),
      signUp: {
        create: jest.fn(() =>
          Promise.resolve({
            status: "complete",
            createdSessionId: "sess_transfer",
            update: jest.fn(),
          }),
        ),
      },
    });

    await expect(signInWithApple(deps)).resolves.toMatchObject({
      createdSessionId: "sess_transfer",
    });
  });

  it("returns null without touching Clerk when the user dismisses Apple's sheet", async () => {
    const deps = dependencies({
      requestCredential: jest.fn(() =>
        Promise.reject(Object.assign(new Error("canceled"), { code: "ERR_REQUEST_CANCELED" })),
      ),
    });

    await expect(signInWithApple(deps)).resolves.toBeNull();
    expect(deps.signIn.create).not.toHaveBeenCalled();
  });

  it("also treats the code-less native error as a dismissal", async () => {
    // What expo-modules-core 57.0.2 actually rejects with: the native reason as
    // the message, and no `code` to compare against.
    const deps = dependencies({
      requestCredential: jest.fn(() =>
        Promise.reject(new Error("The user canceled the authorization attempt")),
      ),
    });

    await expect(signInWithApple(deps)).resolves.toBeNull();
    expect(deps.signIn.create).not.toHaveBeenCalled();
  });

  it("reports any other Apple failure without leaking the native message", async () => {
    const deps = dependencies({
      requestCredential: jest.fn(() =>
        Promise.reject(
          Object.assign(new Error("com.apple.AuthenticationServices.AuthorizationError 1000"), {
            code: "ERR_REQUEST_UNKNOWN",
          }),
        ),
      ),
    });

    const failure = await signInWithApple(deps).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EmailCodeSignInError);
    expect((failure as Error).message).toBe("Sign in with Apple did not complete. Try again.");
    expect(deps.signIn.create).not.toHaveBeenCalled();
  });

  it("keeps a message the credential request already made safe to show", async () => {
    const deps = dependencies({
      requestCredential: jest.fn(() =>
        Promise.reject(
          new EmailCodeSignInError("Sign in with Apple is not available on this device."),
        ),
      ),
    });

    await expect(signInWithApple(deps)).rejects.toThrow(
      "Sign in with Apple is not available on this device.",
    );
  });

  it("stops when Apple returns no identity token", async () => {
    const deps = dependencies({
      requestCredential: jest.fn(() => Promise.resolve({ ...credential, identityToken: null })),
    });

    await expect(signInWithApple(deps)).rejects.toThrow(
      "Sign in with Apple did not complete. Try again.",
    );
    expect(deps.signIn.create).not.toHaveBeenCalled();
  });

  it("uses this app's copy when Clerk rejects the token for a reason it knows", async () => {
    const deps = dependencies({
      signIn: {
        create: jest.fn(() =>
          Promise.reject({
            errors: [{ code: "user_locked", longMessage: "Your account is locked for 30 minutes." }],
          }),
        ),
      },
    });

    await expect(signInWithApple(deps)).rejects.toThrow(
      /^This account is locked\. Try again later or contact support\.$/,
    );
  });

  it("keeps a Clerk message it has no copy for off the screen", async () => {
    const deps = dependencies({
      signIn: {
        create: jest.fn(() =>
          Promise.reject({
            errors: [{ code: "oauth_token_invalid", longMessage: `aud mismatch ${"x".repeat(900)}` }],
          }),
        ),
      },
    });

    await expect(signInWithApple(deps)).rejects.toThrow(
      /^We could not sign you in with Apple\. Try again in a moment\.$/,
    );
  });

  it("uses this app's copy when the account transfer is refused for a known reason", async () => {
    const deps = dependencies({
      signIn: transferableSignIn(),
      signUp: {
        create: jest.fn(() =>
          Promise.reject({
            errors: [{ code: "sign_up_restricted_waitlist", longMessage: "Join the waitlist." }],
          }),
        ),
      },
    });

    await expect(signInWithApple(deps)).rejects.toThrow(
      /^New accounts cannot be created from the app right now\.$/,
    );
  });

  it("falls back to its own copy when the token exchange fails without a Clerk reason", async () => {
    const deps = dependencies({
      signIn: { create: jest.fn(() => Promise.reject(new TypeError("Network request failed"))) },
    });

    await expect(signInWithApple(deps)).rejects.toThrow(
      "We could not sign you in with Apple. Try again in a moment.",
    );
  });

  it("reports a failed account transfer", async () => {
    const deps = dependencies({
      signIn: transferableSignIn(),
      signUp: { create: jest.fn(() => Promise.reject(new TypeError("Network request failed"))) },
    });

    await expect(signInWithApple(deps)).rejects.toThrow(
      "We could not finish creating your account. Try again in a moment.",
    );
  });

  it("points at the browser when the account needs a step this screen cannot do", async () => {
    const deps = dependencies({
      signIn: {
        create: jest.fn(() =>
          Promise.resolve({
            status: "needs_second_factor",
            createdSessionId: null,
            firstFactorVerification: { status: "verified" },
          }),
        ),
      },
    });

    await expect(signInWithApple(deps)).rejects.toThrow(
      "Sign-in could not be completed on this device. Continue in the browser instead.",
    );
  });

  it("still signs in when Apple supplies no authorization code", async () => {
    const deps = dependencies({
      requestCredential: jest.fn(() =>
        Promise.resolve({ identityToken: "apple.identity.token", authorizationCode: null }),
      ),
    });

    await expect(signInWithApple(deps)).resolves.toEqual({
      createdSessionId: "sess_existing",
      authorizationCode: null,
    });
  });

  it("creates the account without a name when Apple does not share one", async () => {
    const deps = dependencies({
      signIn: transferableSignIn(),
      requestCredential: jest.fn(() =>
        Promise.resolve({ identityToken: "apple.identity.token", authorizationCode: "code" }),
      ),
    });

    await signInWithApple(deps);

    const pending = await (deps.signUp.create as jest.Mock).mock.results[0].value;
    expect(pending.update).toHaveBeenCalledWith({ username: "thomas", legalAccepted: true });
  });
});

describe("isAppleCancellation", () => {
  it.each([
    [Object.assign(new Error("canceled"), { code: "ERR_REQUEST_CANCELED" }), true],
    [new Error("The user canceled the authorization attempt"), true],
    [new Error("The authorization attempt failed for an unknown reason"), false],
    [Object.assign(new Error("failed"), { code: "ERR_REQUEST_FAILED" }), false],
    [new Error(""), false],
    ["ERR_REQUEST_CANCELED", false],
    [null, false],
  ])("classifies %p as %p", (error, expected) => {
    expect(isAppleCancellation(error)).toBe(expected);
  });
});

describe("describeAppleFailure", () => {
  it("prefers the module's error code", () => {
    expect(
      describeAppleFailure(Object.assign(new Error("failed"), { code: "ERR_REQUEST_FAILED" })),
    ).toBe("ERR_REQUEST_FAILED");
  });

  it("falls back to the native reason when there is no code", () => {
    expect(
      describeAppleFailure(new Error("The authorization attempt failed for an unknown reason")),
    ).toBe("The authorization attempt failed for an unknown reason");
  });

  it.each([null, undefined, "boom", {}, new Error("")])("has a label for %p", (error) => {
    expect(describeAppleFailure(error)).toBe("unknown");
  });
});
