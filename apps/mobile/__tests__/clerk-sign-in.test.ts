import {
  EmailCodeSignInError,
  MAX_VERIFICATION_CODE_INPUT_LENGTH,
  describeClerkError,
  describeSignInFailure,
  findEmailCodeFactor,
  isLikelyEmail,
  isValidVerificationCode,
  normalizeSignInIdentifier,
  requestEmailCode,
  submitEmailCode,
} from "../lib/clerk-sign-in";

describe("normalizeSignInIdentifier", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeSignInIdentifier("  neo@matrix-os.com  ")).toBe("neo@matrix-os.com");
  });

  it("lowercases email addresses so iOS autocapitalisation does not break lookup", () => {
    expect(normalizeSignInIdentifier("Neo@Matrix-OS.com")).toBe("neo@matrix-os.com");
  });

  it("preserves username casing because usernames are case sensitive", () => {
    expect(normalizeSignInIdentifier(" TheOne ")).toBe("TheOne");
  });
});

describe("isLikelyEmail", () => {
  it.each([
    ["neo@matrix-os.com", true],
    ["neo+beta@matrix-os.co.uk", true],
    ["neo", false],
    ["neo@", false],
    ["@matrix-os.com", false],
    ["neo@matrix", false],
    ["neo @matrix-os.com", false],
    ["", false],
  ])("classifies %s as %s", (value, expected) => {
    expect(isLikelyEmail(value)).toBe(expected);
  });
});

describe("isValidVerificationCode", () => {
  it("accepts the six digit code Clerk emails", () => {
    expect(isValidVerificationCode("123456")).toBe(true);
  });

  it("ignores spaces pasted from the email client", () => {
    expect(isValidVerificationCode("123 456")).toBe(true);
  });

  it.each(["12345", "1234567", "12345a", ""])("rejects %s", (code) => {
    expect(isValidVerificationCode(code)).toBe(false);
  });
});

describe("findEmailCodeFactor", () => {
  it("returns the email code factor with its address id", () => {
    expect(
      findEmailCodeFactor([
        { strategy: "oauth_google" },
        { strategy: "email_code", emailAddressId: "idn_1", safeIdentifier: "n***@matrix-os.com" },
      ]),
    ).toEqual({
      strategy: "email_code",
      emailAddressId: "idn_1",
      safeIdentifier: "n***@matrix-os.com",
    });
  });

  it("returns null when the instance does not offer email codes", () => {
    expect(findEmailCodeFactor([{ strategy: "password" }])).toBeNull();
  });

  it("returns null for a missing factor list", () => {
    expect(findEmailCodeFactor(null)).toBeNull();
    expect(findEmailCodeFactor(undefined)).toBeNull();
  });

  it("ignores an email code factor with no address id because prepare would fail", () => {
    expect(findEmailCodeFactor([{ strategy: "email_code" }])).toBeNull();
  });
});

describe("describeClerkError", () => {
  it("prefers the Clerk long message written for end users", () => {
    const error = {
      errors: [
        {
          code: "form_identifier_not_found",
          message: "Couldn't find your account.",
          longMessage: "Couldn't find your account. Try a different email address.",
        },
      ],
    };
    expect(describeClerkError(error, "fallback")).toBe(
      "Couldn't find your account. Try a different email address.",
    );
  });

  it("falls back to the short message when there is no long message", () => {
    expect(describeClerkError({ errors: [{ message: "Incorrect code." }] }, "fallback")).toBe(
      "Incorrect code.",
    );
  });

  it("uses the fallback for network and unknown errors so raw internals never surface", () => {
    expect(describeClerkError(new Error("Network request failed"), "fallback")).toBe("fallback");
    expect(describeClerkError(undefined, "fallback")).toBe("fallback");
    expect(describeClerkError({ errors: [] }, "fallback")).toBe("fallback");
  });
});

describe("describeSignInFailure", () => {
  it("passes through copy this module already made safe", () => {
    expect(
      describeSignInFailure(new EmailCodeSignInError("Enter the 6-digit code."), "fallback"),
    ).toBe("Enter the 6-digit code.");
  });

  it("normalises a Clerk error thrown outside this module, such as by setActive", () => {
    expect(
      describeSignInFailure({ errors: [{ longMessage: "Session is expired." }] }, "fallback"),
    ).toBe("Session is expired.");
  });

  it("hides raw internals from any other failure", () => {
    expect(describeSignInFailure(new Error("ECONNREFUSED 10.0.0.1:443"), "fallback")).toBe(
      "fallback",
    );
  });
});

describe("MAX_VERIFICATION_CODE_INPUT_LENGTH", () => {
  it("still admits a code pasted with its separating space", () => {
    expect("123 456".length).toBe(MAX_VERIFICATION_CODE_INPUT_LENGTH);
    expect(isValidVerificationCode("123 456")).toBe(true);
  });
});

function createSignIn(overrides: Record<string, unknown> = {}) {
  const attempt: Record<string, unknown> = {
    status: "needs_first_factor",
    supportedFirstFactors: [
      { strategy: "email_code", emailAddressId: "idn_1", safeIdentifier: "n***@matrix-os.com" },
    ],
    prepareFirstFactor: jest.fn(() => Promise.resolve({ status: "needs_first_factor" })),
    attemptFirstFactor: jest.fn(() =>
      Promise.resolve({ status: "complete", createdSessionId: "sess_1" }),
    ),
    ...overrides,
  };
  return {
    attempt,
    signIn: { create: jest.fn(() => Promise.resolve(attempt)) },
  };
}

describe("requestEmailCode", () => {
  it("creates the attempt and prepares the email code factor", async () => {
    const { signIn, attempt } = createSignIn();

    const result = await requestEmailCode(signIn as never, "neo@matrix-os.com");

    expect(signIn.create).toHaveBeenCalledWith({ identifier: "neo@matrix-os.com" });
    expect(attempt.prepareFirstFactor).toHaveBeenCalledWith({
      strategy: "email_code",
      emailAddressId: "idn_1",
    });
    expect(result.attempt).toBe(attempt);
    expect(result.maskedIdentifier).toBe("n***@matrix-os.com");
  });

  it("falls back to the typed identifier when Clerk returns no safe identifier", async () => {
    const { signIn } = createSignIn({
      supportedFirstFactors: [{ strategy: "email_code", emailAddressId: "idn_1" }],
    });

    const result = await requestEmailCode(signIn as never, "neo@matrix-os.com");

    expect(result.maskedIdentifier).toBe("neo@matrix-os.com");
  });

  it("rejects an empty identifier before calling Clerk", async () => {
    const { signIn } = createSignIn();

    await expect(requestEmailCode(signIn as never, "   ")).rejects.toBeInstanceOf(
      EmailCodeSignInError,
    );
    expect(signIn.create).not.toHaveBeenCalled();
  });

  it("explains that the account has no email code option instead of hanging", async () => {
    const { signIn } = createSignIn({ supportedFirstFactors: [{ strategy: "oauth_google" }] });

    await expect(requestEmailCode(signIn as never, "neo@matrix-os.com")).rejects.toThrow(
      /Google or GitHub/,
    );
  });

  it("surfaces the Clerk message when the account does not exist", async () => {
    const signIn = {
      create: jest.fn(() =>
        Promise.reject({
          errors: [{ code: "form_identifier_not_found", longMessage: "Couldn't find your account." }],
        }),
      ),
    };

    await expect(requestEmailCode(signIn as never, "ghost@matrix-os.com")).rejects.toThrow(
      "Couldn't find your account.",
    );
  });
});

describe("submitEmailCode", () => {
  it("returns the created session id when verification completes", async () => {
    const { attempt } = createSignIn();

    const sessionId = await submitEmailCode(attempt as never, "123 456");

    expect(attempt.attemptFirstFactor).toHaveBeenCalledWith({
      strategy: "email_code",
      code: "123456",
    });
    expect(sessionId).toBe("sess_1");
  });

  it("rejects a malformed code before calling Clerk", async () => {
    const { attempt } = createSignIn();

    await expect(submitEmailCode(attempt as never, "12")).rejects.toBeInstanceOf(
      EmailCodeSignInError,
    );
    expect(attempt.attemptFirstFactor).not.toHaveBeenCalled();
  });

  it("reports an incomplete sign-in instead of silently succeeding", async () => {
    const { attempt } = createSignIn({
      attemptFirstFactor: jest.fn(() => Promise.resolve({ status: "needs_second_factor" })),
    });

    await expect(submitEmailCode(attempt as never, "123456")).rejects.toThrow(
      /could not be completed/i,
    );
  });

  it("reports a completed status that carries no session id", async () => {
    const { attempt } = createSignIn({
      attemptFirstFactor: jest.fn(() => Promise.resolve({ status: "complete" })),
    });

    await expect(submitEmailCode(attempt as never, "123456")).rejects.toThrow(
      /could not be completed/i,
    );
  });

  it("surfaces the Clerk message for an incorrect code", async () => {
    const { attempt } = createSignIn({
      attemptFirstFactor: jest.fn(() =>
        Promise.reject({ errors: [{ longMessage: "Incorrect code. Try again." }] }),
      ),
    });

    await expect(submitEmailCode(attempt as never, "000000")).rejects.toThrow(
      "Incorrect code. Try again.",
    );
  });
});
