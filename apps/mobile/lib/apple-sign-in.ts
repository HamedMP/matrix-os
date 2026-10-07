/**
 * Native Sign in with Apple against Clerk.
 *
 * Apple's sheet returns an identity token, which Clerk exchanges for a session,
 * and a one-use authorization code, which the platform needs to revoke Apple
 * access when the account is deleted (specs/547-account-deletion). Clerk's own
 * `useSignInWithApple` hook drops that code, so the same Clerk calls are made
 * here and the code is handed back to the caller. Dependencies are passed in to
 * keep the branching unit testable.
 */
import { EmailCodeSignInError, describeKnownClerkError } from "./clerk-sign-in";
import {
  ACCOUNT_SETUP_FAILED,
  AccountSetupError,
  completePendingSignUp,
  type PendingSignUpLike,
} from "./clerk-sign-up";

/** `expo-apple-authentication`'s code when the user dismisses the sheet. */
const APPLE_REQUEST_CANCELED = "ERR_REQUEST_CANCELED";
/** The native module's reason text for that same dismissal. */
const APPLE_CANCELED_REASON = "The user canceled the authorization attempt";

const APPLE_DID_NOT_COMPLETE = "Sign in with Apple did not complete. Try again.";
const APPLE_SIGN_IN_FAILED = "We could not sign you in with Apple. Try again in a moment.";

export type AppleCredentialLike = {
  identityToken?: string | null;
  authorizationCode?: string | null;
  /** Shared by Apple only the first time a user authorizes the app. */
  fullName?: { givenName?: string | null; familyName?: string | null } | null;
};

type AppleSignInAttemptLike = {
  status?: string | null;
  createdSessionId?: string | null;
  firstFactorVerification?: { status?: string | null } | null;
};

export type AppleSignInDependencies = {
  /** Presents Apple's sheet. Rejects as `isAppleCancellation` describes on dismissal. */
  requestCredential: () => Promise<AppleCredentialLike>;
  signIn: {
    create: (params: {
      strategy: "oauth_token_apple";
      token: string;
    }) => Promise<AppleSignInAttemptLike>;
  };
  signUp: {
    create: (params: { transfer: true }) => Promise<PendingSignUpLike>;
  };
  randomSuffix?: () => string;
};

export type AppleSignInResult = {
  createdSessionId: string;
  /** Apple's one-use code for the platform; null when Apple returned none. */
  authorizationCode: string | null;
};

function readString(error: unknown, key: "code" | "message"): string | null {
  if (typeof error !== "object" || error === null) return null;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * What the native module reported, for the log: its `ERR_REQUEST_*` code, or
 * its reason text when there is no code. The reasons are fixed strings in the
 * module, so they carry nothing about the user.
 */
export function describeAppleFailure(error: unknown): string {
  return readString(error, "code") ?? readString(error, "message") ?? "unknown";
}

/**
 * True when the user dismissed Apple's sheet. expo-modules-core 57.0.2 rejects
 * with a bare `Error` whose message is the native reason and which has no
 * `code` (seen on device), so the documented code alone would miss a dismissal
 * and report it as a failure.
 */
export function isAppleCancellation(error: unknown): boolean {
  return (
    readString(error, "code") === APPLE_REQUEST_CANCELED ||
    (readString(error, "message")?.includes(APPLE_CANCELED_REASON) ?? false)
  );
}

/**
 * Runs the whole exchange and returns the session to activate, or null when the
 * user dismissed Apple's sheet. Every thrown error carries copy safe to show.
 */
export async function signInWithApple({
  requestCredential,
  signIn,
  signUp,
  randomSuffix,
}: AppleSignInDependencies): Promise<AppleSignInResult | null> {
  let credential: AppleCredentialLike;
  try {
    credential = await requestCredential();
  } catch (error: unknown) {
    if (isAppleCancellation(error)) return null;
    if (error instanceof EmailCodeSignInError) throw error;
    throw new EmailCodeSignInError(APPLE_DID_NOT_COMPLETE);
  }

  const identityToken = credential.identityToken;
  if (!identityToken) throw new EmailCodeSignInError(APPLE_DID_NOT_COMPLETE);

  let attempt: AppleSignInAttemptLike;
  try {
    attempt = await signIn.create({ strategy: "oauth_token_apple", token: identityToken });
  } catch (error: unknown) {
    throw new EmailCodeSignInError(describeKnownClerkError(error, APPLE_SIGN_IN_FAILED));
  }

  const authorizationCode = credential.authorizationCode ?? null;

  // No Clerk account is linked to this Apple identity yet: the verified
  // identity moves into a sign-up, which then needs its requirements filled in.
  if (attempt.firstFactorVerification?.status === "transferable") {
    let pending: PendingSignUpLike;
    try {
      pending = await signUp.create({ transfer: true });
    } catch (error: unknown) {
      throw new AccountSetupError(describeKnownClerkError(error, ACCOUNT_SETUP_FAILED));
    }
    const createdSessionId = await completePendingSignUp(pending, {
      firstName: credential.fullName?.givenName,
      lastName: credential.fullName?.familyName,
      randomSuffix,
    });
    return { createdSessionId, authorizationCode };
  }

  if (attempt.status !== "complete" || !attempt.createdSessionId) {
    throw new EmailCodeSignInError(
      "Sign-in could not be completed on this device. Continue in the browser instead.",
    );
  }

  return { createdSessionId: attempt.createdSessionId, authorizationCode };
}
