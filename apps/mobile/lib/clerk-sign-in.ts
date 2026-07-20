/**
 * Email-code (one-time passcode) sign-in against Clerk.
 *
 * The Matrix OS Clerk instance enables `email_code` as its only non-OAuth first
 * factor, which is what the web `<SignIn />` component renders alongside Google
 * and GitHub. These helpers drive the same flow from the native shell and are
 * kept free of React and of `@clerk/clerk-expo` imports so the branching stays
 * unit testable.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const CODE_LENGTH = 6;

export type FirstFactorLike = {
  strategy: string;
  emailAddressId?: string | null;
  safeIdentifier?: string | null;
};

export type EmailCodeFactor = {
  strategy: "email_code";
  emailAddressId: string;
  safeIdentifier?: string | null;
};

export type SignInAttemptLike = {
  status?: string | null;
  createdSessionId?: string | null;
  supportedFirstFactors?: FirstFactorLike[] | null;
  prepareFirstFactor: (params: {
    strategy: "email_code";
    emailAddressId: string;
  }) => Promise<unknown>;
  attemptFirstFactor: (params: {
    strategy: "email_code";
    code: string;
  }) => Promise<SignInAttemptLike>;
};

export type SignInResourceLike = {
  create: (params: { identifier: string }) => Promise<SignInAttemptLike>;
};

/** A message that is safe to render to the user. */
export class EmailCodeSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailCodeSignInError";
  }
}

export function normalizeSignInIdentifier(raw: string): string {
  const trimmed = raw.trim();
  // Usernames are case sensitive in Clerk; email addresses are not, and iOS
  // keyboards capitalise the first letter of a typed address.
  return trimmed.includes("@") ? trimmed.toLowerCase() : trimmed;
}

export function isLikelyEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

export function isValidVerificationCode(code: string): boolean {
  return new RegExp(`^\\d{${CODE_LENGTH}}$`).test(stripCodeSpacing(code));
}

export function findEmailCodeFactor(
  factors: FirstFactorLike[] | null | undefined,
): EmailCodeFactor | null {
  const factor = factors?.find(
    (candidate) => candidate.strategy === "email_code" && Boolean(candidate.emailAddressId),
  );
  if (!factor?.emailAddressId) return null;
  return {
    strategy: "email_code",
    emailAddressId: factor.emailAddressId,
    safeIdentifier: factor.safeIdentifier,
  };
}

/**
 * Clerk errors carry user-facing copy in `errors[].longMessage`. Anything else
 * (network failures, thrown strings, SDK internals) collapses to the caller's
 * fallback so raw internals never reach the screen.
 */
export function describeClerkError(error: unknown, fallback: string): string {
  if (typeof error !== "object" || error === null) return fallback;
  const errors = (error as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return fallback;
  const first = errors[0] as { longMessage?: unknown; message?: unknown };
  const message =
    typeof first?.longMessage === "string"
      ? first.longMessage
      : typeof first?.message === "string"
        ? first.message
        : null;
  return message && message.trim().length > 0 ? message : fallback;
}

export async function requestEmailCode(
  signIn: SignInResourceLike,
  identifier: string,
): Promise<{ attempt: SignInAttemptLike; maskedIdentifier: string }> {
  const normalized = normalizeSignInIdentifier(identifier);
  if (normalized.length === 0) {
    throw new EmailCodeSignInError("Enter the email address for your Matrix OS account.");
  }

  let attempt: SignInAttemptLike;
  try {
    attempt = await signIn.create({ identifier: normalized });
  } catch (error: unknown) {
    throw new EmailCodeSignInError(
      describeClerkError(error, "We could not start sign-in. Check the address and try again."),
    );
  }

  const factor = findEmailCodeFactor(attempt.supportedFirstFactors);
  if (!factor) {
    throw new EmailCodeSignInError(
      "This account cannot sign in with an email code. Continue with Google or GitHub instead.",
    );
  }

  try {
    await attempt.prepareFirstFactor({
      strategy: "email_code",
      emailAddressId: factor.emailAddressId,
    });
  } catch (error: unknown) {
    throw new EmailCodeSignInError(
      describeClerkError(error, "We could not send the code. Try again in a moment."),
    );
  }

  return { attempt, maskedIdentifier: factor.safeIdentifier || normalized };
}

export async function submitEmailCode(
  attempt: SignInAttemptLike,
  code: string,
): Promise<string> {
  if (!isValidVerificationCode(code)) {
    throw new EmailCodeSignInError(`Enter the ${CODE_LENGTH}-digit code from your email.`);
  }

  let result: SignInAttemptLike;
  try {
    result = await attempt.attemptFirstFactor({
      strategy: "email_code",
      code: stripCodeSpacing(code),
    });
  } catch (error: unknown) {
    throw new EmailCodeSignInError(
      describeClerkError(error, "That code did not work. Request a new one and try again."),
    );
  }

  if (result.status !== "complete" || !result.createdSessionId) {
    throw new EmailCodeSignInError(
      "Sign-in could not be completed on this device. Continue in the browser instead.",
    );
  }

  return result.createdSessionId;
}

function stripCodeSpacing(code: string): string {
  return code.replace(/\s/g, "");
}
