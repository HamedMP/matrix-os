import { EmailCodeSignInError, describeSignInFailure } from "../lib/clerk-sign-in";
import {
  AccountSetupError,
  completePendingSignUp,
  suggestUsername,
  type PendingSignUpLike,
} from "../lib/clerk-sign-up";

const usernameTaken = {
  errors: [
    {
      code: "form_identifier_exists",
      longMessage: "That username is taken. Please try another.",
      meta: { paramName: "username" },
    },
  ],
};

const suffix = () => "k3x9qa";

function pendingSignUp(overrides: Partial<PendingSignUpLike> = {}): PendingSignUpLike {
  return {
    status: "missing_requirements",
    createdSessionId: null,
    missingFields: ["username", "legal_accepted"],
    unverifiedFields: [],
    emailAddress: "thomas@matrix-os.com",
    update: jest.fn(() => Promise.resolve({ status: "complete", createdSessionId: "sess_new" })),
    ...overrides,
  } as PendingSignUpLike;
}

describe("suggestUsername", () => {
  it("starts with the part of the address before the @", () => {
    expect(suggestUsername("thomas@matrix-os.com", 0, suffix)).toBe("thomas");
  });

  it("turns characters a handle cannot carry into single hyphens", () => {
    expect(suggestUsername("Thomas.A_Anderson+work@metacortex.com", 0, suffix)).toBe(
      "thomas-a-anderson-work",
    );
  });

  it("keeps an Apple relay address usable as a handle", () => {
    expect(suggestUsername("dpdcnf87nu@privaterelay.appleid.com", 0, suffix)).toBe("dpdcnf87nu");
  });

  it("prefixes a leading digit, because a Matrix OS handle starts with a letter", () => {
    expect(suggestUsername("8f7k2m9qxz@privaterelay.appleid.com", 0, suffix)).toBe("u-8f7k2m9qxz");
  });

  it("adds a random suffix from the second attempt on", () => {
    expect(suggestUsername("thomas@matrix-os.com", 1, suffix)).toBe("thomas-k3x9qa");
  });

  it("adds the suffix straight away when the name is shorter than Clerk accepts", () => {
    expect(suggestUsername("neo@matrix-os.com", 0, suffix)).toBe("neo-k3x9qa");
  });

  it("stays within the 31 characters a handle may have, suffix included", () => {
    const long = `${"a".repeat(60)}@matrix-os.com`;

    expect(suggestUsername(long, 0, suffix)).toBe("a".repeat(31));
    expect(suggestUsername(long, 1, suffix)).toBe(`${"a".repeat(24)}-k3x9qa`);
  });

  it("does not leave a hyphen where the name was cut", () => {
    const awkward = `${"a".repeat(30)}.b@matrix-os.com`;

    expect(suggestUsername(awkward, 0, suffix)).toBe("a".repeat(30));
    expect(suggestUsername(`${"a".repeat(23)}.bcd@matrix-os.com`, 1, suffix)).toBe(
      `${"a".repeat(23)}-k3x9qa`,
    );
  });

  it.each([null, undefined, "", "@matrix-os.com", "...@matrix-os.com"])(
    "falls back to a neutral, always-suffixed name when %p carries nothing usable",
    (email) => {
      expect(suggestUsername(email, 0, suffix)).toBe("user-k3x9qa");
    },
  );
});

describe("completePendingSignUp", () => {
  it("returns the session of a sign-up that is already complete", async () => {
    const signUp = pendingSignUp({ status: "complete", createdSessionId: "sess_done" });

    await expect(completePendingSignUp(signUp)).resolves.toBe("sess_done");
    expect(signUp.update).not.toHaveBeenCalled();
  });

  it("fills in a handle and the accepted terms, then returns the new session", async () => {
    const signUp = pendingSignUp();

    await expect(completePendingSignUp(signUp, { randomSuffix: suffix })).resolves.toBe("sess_new");
    expect(signUp.update).toHaveBeenCalledTimes(1);
    expect(signUp.update).toHaveBeenCalledWith({ username: "thomas", legalAccepted: true });
  });

  it("sends only what Clerk reports as missing", async () => {
    const onlyTerms = pendingSignUp({ missingFields: ["legal_accepted"] });
    const onlyHandle = pendingSignUp({ missingFields: ["username"] });

    await completePendingSignUp(onlyTerms, { randomSuffix: suffix });
    await completePendingSignUp(onlyHandle, { randomSuffix: suffix });

    expect(onlyTerms.update).toHaveBeenCalledWith({ legalAccepted: true });
    expect(onlyHandle.update).toHaveBeenCalledWith({ username: "thomas" });
  });

  it("passes on the name Apple shared, which it only does the first time", async () => {
    const signUp = pendingSignUp();

    await completePendingSignUp(signUp, {
      randomSuffix: suffix,
      firstName: " Thomas ",
      lastName: "Anderson",
    });

    expect(signUp.update).toHaveBeenCalledWith({
      username: "thomas",
      legalAccepted: true,
      firstName: "Thomas",
      lastName: "Anderson",
    });
  });

  it("leaves out name parts Apple did not share", async () => {
    const signUp = pendingSignUp();

    await completePendingSignUp(signUp, { randomSuffix: suffix, firstName: null, lastName: "  " });

    expect(signUp.update).toHaveBeenCalledWith({ username: "thomas", legalAccepted: true });
  });

  it("tries another handle when the first one is taken", async () => {
    const update = jest
      .fn()
      .mockRejectedValueOnce(usernameTaken)
      .mockResolvedValueOnce({ status: "complete", createdSessionId: "sess_second" });
    const signUp = pendingSignUp({ update });

    await expect(completePendingSignUp(signUp, { randomSuffix: suffix })).resolves.toBe(
      "sess_second",
    );
    expect(update).toHaveBeenNthCalledWith(1, { username: "thomas", legalAccepted: true });
    expect(update).toHaveBeenNthCalledWith(2, { username: "thomas-k3x9qa", legalAccepted: true });
  });

  it("gives up after a few taken handles without blaming a name the user never chose", async () => {
    const update = jest.fn().mockRejectedValue(usernameTaken);
    const signUp = pendingSignUp({ update });

    const failure = await completePendingSignUp(signUp, { randomSuffix: suffix }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AccountSetupError);
    expect((failure as Error).message).toBe(
      "We could not finish creating your account. Try again in a moment.",
    );
    expect(update).toHaveBeenCalledTimes(4);
  });

  it("does not retry a failure that is not about the handle", async () => {
    const update = jest.fn().mockRejectedValue({
      errors: [{ code: "sign_up_mode_restricted", longMessage: "Sign-ups are paused." }],
    });
    const signUp = pendingSignUp({ update });

    await expect(completePendingSignUp(signUp, { randomSuffix: suffix })).rejects.toThrow(
      "New accounts cannot be created from the app right now.",
    );
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("keeps a Clerk message it has no copy for off the screen", async () => {
    const update = jest.fn().mockRejectedValue({
      errors: [
        {
          code: "form_param_format_invalid",
          longMessage: `username is invalid: ${"x".repeat(2000)}`,
        },
      ],
    });
    const signUp = pendingSignUp({ update });

    await expect(completePendingSignUp(signUp, { randomSuffix: suffix })).rejects.toThrow(
      /^We could not finish creating your account\. Try again in a moment\.$/,
    );
  });

  it("does not retry a taken identifier when no handle was being set", async () => {
    const update = jest.fn().mockRejectedValue(usernameTaken);
    const signUp = pendingSignUp({ missingFields: ["legal_accepted"], update });

    await expect(completePendingSignUp(signUp, { randomSuffix: suffix })).rejects.toBeInstanceOf(
      AccountSetupError,
    );
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("keeps network failures and SDK internals off the screen", async () => {
    const update = jest.fn().mockRejectedValue(new TypeError("Network request failed"));
    const signUp = pendingSignUp({ update });

    await expect(completePendingSignUp(signUp, { randomSuffix: suffix })).rejects.toThrow(
      "We could not finish creating your account. Try again in a moment.",
    );
  });

  it.each([
    ["a field it cannot fill in", { missingFields: ["username", "phone_number"] }],
    ["an address that still needs verifying", { unverifiedFields: ["email_address"] }],
    ["nothing it can act on", { missingFields: [] }],
    ["an abandoned attempt", { status: "abandoned" }],
    ["a complete attempt with no session", { status: "complete", createdSessionId: null }],
  ])("sends the user to the web when the sign-up has %s", async (_label, overrides) => {
    const signUp = pendingSignUp(overrides as Partial<PendingSignUpLike>);

    await expect(completePendingSignUp(signUp, { randomSuffix: suffix })).rejects.toThrow(
      "Finish creating your account at app.matrix-os.com, then sign in here.",
    );
    expect(signUp.update).not.toHaveBeenCalled();
  });

  it("sends the user to the web when Clerk still wants more after the update", async () => {
    const update = jest.fn(() =>
      Promise.resolve({ status: "missing_requirements", createdSessionId: null }),
    );
    const signUp = pendingSignUp({ update } as Partial<PendingSignUpLike>);

    await expect(completePendingSignUp(signUp, { randomSuffix: suffix })).rejects.toThrow(
      "Finish creating your account at app.matrix-os.com, then sign in here.",
    );
  });

  it("generates its own suffix when none is injected", async () => {
    const update = jest
      .fn()
      .mockRejectedValueOnce(usernameTaken)
      .mockResolvedValueOnce({ status: "complete", createdSessionId: "sess_second" });
    const signUp = pendingSignUp({ update });

    await completePendingSignUp(signUp);

    expect(update.mock.calls[1][0].username).toMatch(/^thomas-[a-z0-9]{6}$/);
  });

  it("raises errors the sign-in screen can show as they are", async () => {
    const signUp = pendingSignUp({ missingFields: ["phone_number"] });

    const failure = await completePendingSignUp(signUp).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EmailCodeSignInError);
    expect(describeSignInFailure(failure, "fallback")).toBe(
      "Finish creating your account at app.matrix-os.com, then sign in here.",
    );
  });
});
