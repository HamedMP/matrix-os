/**
 * Password and email-code sign-in against Clerk.
 *
 * Which factors an account can use is decided per account, not per instance:
 * Clerk returns `password` in `supportedFirstFactors` only for accounts that
 * have one, and OAuth-only accounts get `email_code` instead. So the flow tries
 * the password the user typed and falls back to a code when the account has no
 * password. These helpers stay free of React and of `@clerk/clerk-expo` imports
 * so the branching stays unit testable.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const CODE_LENGTH = 6;
const CODE_PATTERN = new RegExp(`^\\d{${CODE_LENGTH}}$`);

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
  create: (params: {
    identifier: string;
    strategy?: "password";
    password?: string;
  }) => Promise<SignInAttemptLike>;
};

/** Clerk's code when the account cannot use the strategy that was attempted. */
const STRATEGY_NOT_AVAILABLE = "strategy_for_user_invalid";

/** A message that is safe to render to the user. */
export class EmailCodeSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailCodeSignInError";
  }
}

/**
 * The account exists but has no password — typically an OAuth-only signup. The
 * caller should offer the email-code path rather than reporting a failure.
 */
export class PasswordUnavailableError extends EmailCodeSignInError {
  constructor() {
    super("That account has no password. We can email you a sign-in code instead.");
    this.name = "PasswordUnavailableError";
  }
}

/**
 * Resolves any sign-in failure to user-safe copy. Errors raised by this module
 * already carry such copy; anything else (a Clerk error thrown by `setActive`,
 * a storage write failure) goes through the Clerk-aware normaliser.
 */
export function describeSignInFailure(error: unknown, fallback: string): string {
  if (error instanceof EmailCodeSignInError) return error.message;
  return describeClerkError(error, fallback);
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
  return CODE_PATTERN.test(stripCodeSpacing(code));
}

/** Longest raw input that can still contain a valid code, e.g. "123 456". */
export const MAX_VERIFICATION_CODE_INPUT_LENGTH = CODE_LENGTH + 1;

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

/** True when Clerk lists `password` among the account's usable first factors. */
export function supportsPassword(factors: FirstFactorLike[] | null | undefined): boolean {
  return Boolean(factors?.some((factor) => factor.strategy === "password"));
}

function hasClerkErrorCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const errors = (error as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((entry) => (entry as { code?: unknown })?.code === code);
}

/**
 * Signs in with a password in a single Clerk call. Throws
 * `PasswordUnavailableError` when the account has no password, so the caller can
 * offer the email-code path instead of showing a dead end.
 */
export async function signInWithPassword(
  signIn: SignInResourceLike,
  identifier: string,
  password: string,
): Promise<string> {
  const normalized = normalizeSignInIdentifier(identifier);
  if (normalized.length === 0) {
    throw new EmailCodeSignInError("Enter the email address for your Matrix OS account.");
  }
  if (password.length === 0) {
    throw new EmailCodeSignInError("Enter your password.");
  }

  let attempt: SignInAttemptLike;
  try {
    attempt = await signIn.create({ identifier: normalized, strategy: "password", password });
  } catch (error: unknown) {
    if (hasClerkErrorCode(error, STRATEGY_NOT_AVAILABLE)) {
      throw new PasswordUnavailableError();
    }
    throw new EmailCodeSignInError(
      describeClerkError(error, "We could not sign you in. Check your email and password."),
    );
  }

  if (attempt.status !== "complete" || !attempt.createdSessionId) {
    throw new EmailCodeSignInError(
      "Sign-in could not be completed on this device. Continue in the browser instead.",
    );
  }

  return attempt.createdSessionId;
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
