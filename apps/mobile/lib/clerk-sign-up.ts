/**
 * Finishing a sign-up that a provider sign-in was transferred into.
 *
 * The Clerk instance requires a username and accepted legal terms at sign-up, so
 * a first-time Apple, Google or GitHub user comes back as `missing_requirements`
 * with no session. The sign-in screen states that continuing accepts the terms,
 * and the username is only a starting handle the user can change before a
 * computer is provisioned, so both are supplied here instead of asked for. Like
 * `clerk-sign-in`, this stays free of React and `@clerk/clerk-expo`.
 */
import { getRandomValues } from "expo-crypto";
import { EmailCodeSignInError, describeClerkError, hasClerkErrorCode } from "./clerk-sign-in";

/** Clerk's lower bound for a username on this instance. */
const USERNAME_MIN_LENGTH = 4;
/** Upper bound of a Matrix OS handle, which the username becomes. */
const USERNAME_MAX_LENGTH = 31;
const FALLBACK_USERNAME = "user";
const SUFFIX_LENGTH = 6;
const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const MAX_USERNAME_ATTEMPTS = 4;

/** Clerk's code when a unique identifier, here the username, is already in use. */
const IDENTIFIER_EXISTS = "form_identifier_exists";

/** The only requirements this module knows how to satisfy on the user's behalf. */
const FILLABLE_FIELDS = new Set(["username", "legal_accepted"]);

const FINISH_ON_WEB = "Finish creating your account at app.matrix-os.com, then sign in here.";
export const ACCOUNT_SETUP_FAILED =
  "We could not finish creating your account. Try again in a moment.";

type SignUpUpdateLike = {
  username?: string;
  legalAccepted?: boolean;
  firstName?: string;
  lastName?: string;
};

export type SignUpAttemptLike = {
  status?: string | null;
  createdSessionId?: string | null;
};

export type PendingSignUpLike = SignUpAttemptLike & {
  missingFields?: string[] | null;
  unverifiedFields?: string[] | null;
  emailAddress?: string | null;
  update: (params: SignUpUpdateLike) => Promise<SignUpAttemptLike>;
};

export type CompleteSignUpOptions = {
  /** Given name from the provider, when it shares one. */
  firstName?: string | null;
  lastName?: string | null;
  /** Injected by tests; defaults to six random lowercase alphanumerics. */
  randomSuffix?: () => string;
};

/** The account could not be set up from the app. The message is safe to show. */
export class AccountSetupError extends EmailCodeSignInError {
  constructor(message: string) {
    super(message);
    this.name = "AccountSetupError";
  }
}

function defaultRandomSuffix(): string {
  const bytes = getRandomValues(new Uint8Array(SUFFIX_LENGTH));
  return Array.from(bytes, (byte) => SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length]).join("");
}

function trimTo(value: string, maxLength: number): string {
  return value.slice(0, maxLength).replace(/-+$/, "");
}

/**
 * A username Clerk accepts that is also a valid Matrix OS handle: lowercase
 * letters, digits and single hyphens, starting with a letter. The first attempt
 * is the plain name from the address; later ones carry a random suffix.
 */
export function suggestUsername(
  email: string | null | undefined,
  attempt: number,
  randomSuffix: () => string,
): string {
  const local = (email ?? "").split("@")[0] ?? "";
  const cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // A Matrix OS handle starts with a letter; a relay address may not.
  const lettered = /^[a-z]/.test(cleaned) ? cleaned : `u-${cleaned}`;
  const named = cleaned.length === 0 ? FALLBACK_USERNAME : lettered;
  const plain = trimTo(named, USERNAME_MAX_LENGTH);

  if (attempt === 0 && cleaned.length > 0 && plain.length >= USERNAME_MIN_LENGTH) return plain;

  const suffix = randomSuffix();
  return `${trimTo(named, USERNAME_MAX_LENGTH - suffix.length - 1)}-${suffix}`;
}

function cleanName(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Sends the missing requirements, moving to the next username when Clerk
 * reports the suggested one as taken. `usernameFor` is null when the sign-up
 * already has a username.
 */
async function submitRequirements(
  signUp: PendingSignUpLike,
  fields: SignUpUpdateLike,
  usernameFor: ((attempt: number) => string) | null,
  attempt = 0,
): Promise<SignUpAttemptLike> {
  try {
    return await signUp.update(
      usernameFor ? { username: usernameFor(attempt), ...fields } : fields,
    );
  } catch (error: unknown) {
    const usernameTaken = usernameFor !== null && hasClerkErrorCode(error, IDENTIFIER_EXISTS);
    if (usernameTaken && attempt < MAX_USERNAME_ATTEMPTS - 1) {
      return submitRequirements(signUp, fields, usernameFor, attempt + 1);
    }
    // The user never chose the username, so Clerk's "that username is taken"
    // would describe a problem they cannot see or fix.
    throw new AccountSetupError(
      usernameTaken ? ACCOUNT_SETUP_FAILED : describeClerkError(error, ACCOUNT_SETUP_FAILED),
    );
  }
}

/**
 * Returns the session of a transferred sign-up, supplying the username and
 * legal acceptance when those are all Clerk is waiting for. Anything else it is
 * waiting for (an unverified address, a phone number) needs the web sign-up.
 */
export async function completePendingSignUp(
  signUp: PendingSignUpLike,
  options: CompleteSignUpOptions = {},
): Promise<string> {
  if (signUp.status === "complete" && signUp.createdSessionId) return signUp.createdSessionId;

  const missing = signUp.missingFields ?? [];
  const unverified = signUp.unverifiedFields ?? [];
  if (
    signUp.status !== "missing_requirements" ||
    missing.length === 0 ||
    unverified.length > 0 ||
    missing.some((field) => !FILLABLE_FIELDS.has(field))
  ) {
    throw new AccountSetupError(FINISH_ON_WEB);
  }

  const randomSuffix = options.randomSuffix ?? defaultRandomSuffix;
  const firstName = cleanName(options.firstName);
  const lastName = cleanName(options.lastName);

  const result = await submitRequirements(
    signUp,
    {
      ...(missing.includes("legal_accepted") ? { legalAccepted: true } : {}),
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
    },
    missing.includes("username")
      ? (attempt) => suggestUsername(signUp.emailAddress, attempt, randomSuffix)
      : null,
  );

  if (result.status !== "complete" || !result.createdSessionId) {
    throw new AccountSetupError(FINISH_ON_WEB);
  }
  return result.createdSessionId;
}
