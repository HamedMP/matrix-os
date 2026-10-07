import { useCallback, useRef, useState } from "react";
import { useAuth, useSignIn, useSignUp } from "@clerk/clerk-expo";
import * as AppleAuthentication from "expo-apple-authentication";
import { getRandomValues } from "expo-crypto";
import {
  describeAppleFailure,
  isAppleCancellation,
  signInWithApple,
  type AppleCredentialLike,
} from "./apple-sign-in";
import { EmailCodeSignInError, describeKnownSignInFailure } from "./clerk-sign-in";
import { registerAppleAuthorizationCode } from "./requests/apple-authorization";
import { SignInStepError } from "./use-email-code-sign-in";

type AppleSignInOptions = {
  /** Resolves the computer to sign in to, or throws with a message to show. */
  prepareGateway: () => Promise<void>;
  onError: (message: string) => void;
  onSuccess: () => void;
};

export type AppleSignIn = {
  signingIn: boolean;
  signIn: () => Promise<void>;
};

function randomNonce(): string {
  return Array.from(getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function requestAppleCredential(): Promise<AppleCredentialLike> {
  if (!(await AppleAuthentication.isAvailableAsync())) {
    throw new EmailCodeSignInError("Sign in with Apple is not available on this device.");
  }
  try {
    return await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: randomNonce(),
    });
  } catch (err: unknown) {
    // The screen only says the request did not complete; the native reason is
    // what tells a missing entitlement or signed-out device apart in the log.
    if (!isAppleCancellation(err)) {
      console.warn("[mobile] apple credential request failed:", describeAppleFailure(err));
    }
    throw err;
  }
}

/**
 * Best effort: the code only matters when the account is later deleted, where
 * the platform falls back to manual Apple revocation without it. A failure here
 * must never undo a sign-in that already succeeded.
 */
async function registerAppleAuthorization(
  getToken: () => Promise<string | null>,
  code: string,
): Promise<void> {
  try {
    const token = await getToken();
    if (!token) {
      console.warn("[mobile] apple authorization not registered:", "no session token");
      return;
    }
    await registerAppleAuthorizationCode(token, code);
  } catch (err: unknown) {
    console.warn(
      "[mobile] apple authorization not registered:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Owns the native Sign in with Apple exchange and its in-flight state, so the
 * sign-in screen only wires the button to a callback.
 */
export function useAppleSignIn({
  prepareGateway,
  onError,
  onSuccess,
}: AppleSignInOptions): AppleSignIn {
  const { signIn, setActive, isLoaded: isSignInLoaded } = useSignIn();
  const { signUp, isLoaded: isSignUpLoaded } = useSignUp();
  const { getToken } = useAuth();
  const [signingIn, setSigningIn] = useState(false);
  // State updates are async, so a disabled button is not enough to stop a second
  // tap from presenting Apple's sheet twice.
  const inFlightRef = useRef(false);

  const start = useCallback(async () => {
    if (!isSignInLoaded || !isSignUpLoaded || !signIn || !signUp || !setActive) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setSigningIn(true);
    try {
      await prepareGateway();
      const result = await signInWithApple({
        requestCredential: requestAppleCredential,
        signIn,
        signUp,
      });
      // The user dismissed Apple's sheet; there is nothing to report.
      if (!result) return;

      await setActive({ session: result.createdSessionId });
      if (result.authorizationCode) {
        // Apple's code expires within minutes, so it goes out as soon as there
        // is a session to authenticate it, without holding up navigation.
        void registerAppleAuthorization(getToken, result.authorizationCode);
      }
      onSuccess();
    } catch (err: unknown) {
      console.warn("[mobile] apple sign-in failed:", err);
      onError(
        err instanceof SignInStepError
          ? err.message
          : describeKnownSignInFailure(
              err,
              "We could not sign you in with Apple. Try again in a moment.",
            ),
      );
    } finally {
      inFlightRef.current = false;
      setSigningIn(false);
    }
  }, [
    getToken,
    isSignInLoaded,
    isSignUpLoaded,
    onError,
    onSuccess,
    prepareGateway,
    setActive,
    signIn,
    signUp,
  ]);

  return { signingIn, signIn: start };
}
