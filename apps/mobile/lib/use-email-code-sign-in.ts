import { useCallback, useRef, useState } from "react";
import { useSignIn } from "@clerk/clerk-expo";
import {
  PasswordUnavailableError,
  describeSignInFailure,
  requestEmailCode,
  signInWithPassword,
  submitEmailCode,
  type SignInAttemptLike,
} from "./clerk-sign-in";

/**
 * Carries a message already resolved for the step that failed. `prepareGateway`
 * throws this to report its own copy instead of a generic sign-in failure.
 */
export class SignInStepError extends Error {}

type EmailCodeSignInOptions = {
  /** Resolves the computer to sign in to, or throws with a message to show. */
  prepareGateway: () => Promise<void>;
  onError: (message: string) => void;
  onSuccess: () => void;
};

export type EmailCodeSignIn = {
  email: string;
  setEmail: (value: string) => void;
  password: string;
  setPassword: (value: string) => void;
  code: string;
  setCode: (value: string) => void;
  /** Masked address the code went to; null while still collecting credentials. */
  codeSentTo: string | null;
  /** True once the account has been shown to have no password. */
  passwordUnavailable: boolean;
  signingIn: boolean;
  sending: boolean;
  verifying: boolean;
  signInWithPassword: () => Promise<void>;
  sendCode: () => Promise<void>;
  verifyCode: () => Promise<void>;
  reset: () => void;
};

/**
 * Owns the Clerk email-code sign-in exchange and the transient state behind it,
 * so the sign-in screen only wires inputs to callbacks.
 */
export function useEmailCodeSignIn({
  prepareGateway,
  onError,
  onSuccess,
}: EmailCodeSignInOptions): EmailCodeSignIn {
  const { signIn, setActive, isLoaded } = useSignIn();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [passwordUnavailable, setPasswordUnavailable] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  // Only read inside the submit handlers, so a ref keeps it out of the render path.
  const attemptRef = useRef<SignInAttemptLike | null>(null);

  const submitPassword = useCallback(async () => {
    if (!isLoaded || !signIn || !setActive) return;
    setSigningIn(true);
    try {
      await prepareGateway();
      const createdSessionId = await signInWithPassword(signIn, email, password);
      await setActive({ session: createdSessionId });
      onSuccess();
    } catch (err: unknown) {
      console.warn("[mobile] password sign-in failed:", err);
      if (err instanceof PasswordUnavailableError) {
        // OAuth-only account. The form renders its own inline hint pointing at
        // the code path, so an error banner would just repeat it.
        setPasswordUnavailable(true);
        return;
      }
      onError(
        err instanceof SignInStepError
          ? err.message
          : describeSignInFailure(err, "We could not sign you in. Try again in a moment."),
      );
    } finally {
      setSigningIn(false);
    }
  }, [email, isLoaded, onError, onSuccess, password, prepareGateway, setActive, signIn]);

  const sendCode = useCallback(async () => {
    if (!isLoaded || !signIn) return;
    setSending(true);
    try {
      await prepareGateway();
      const { attempt, maskedIdentifier } = await requestEmailCode(signIn, email);
      attemptRef.current = attempt;
      setCodeSentTo(maskedIdentifier);
      setCode("");
    } catch (err: unknown) {
      console.warn("[mobile] email code request failed:", err);
      onError(
        err instanceof SignInStepError
          ? err.message
          : describeSignInFailure(err, "We could not send the code. Try again in a moment."),
      );
    } finally {
      setSending(false);
    }
  }, [email, isLoaded, onError, prepareGateway, signIn]);

  const verifyCode = useCallback(async () => {
    const attempt = attemptRef.current;
    if (!attempt || !setActive) return;
    setVerifying(true);
    try {
      let createdSessionId: string;
      try {
        createdSessionId = await submitEmailCode(attempt, code);
      } catch (err: unknown) {
        throw new SignInStepError(
          describeSignInFailure(err, "That code did not work. Request a new one and try again."),
        );
      }

      // The attempt is spent once it verifies; drop it before activating so a
      // failing setActive cannot leave a completed attempt to be retried.
      attemptRef.current = null;
      try {
        await setActive({ session: createdSessionId });
      } catch (err: unknown) {
        // The code was correct, so telling the user to request a new one would
        // send them in circles. Name the step that actually failed.
        throw new SignInStepError(
          describeSignInFailure(err, "We verified the code but could not start your session."),
        );
      }

      onSuccess();
    } catch (err: unknown) {
      console.warn("[mobile] email code verification failed:", err);
      onError(
        err instanceof SignInStepError
          ? err.message
          : describeSignInFailure(err, "Sign-in did not complete. Try again in a moment."),
      );
    } finally {
      setVerifying(false);
    }
  }, [code, onError, onSuccess, setActive]);

  const reset = useCallback(() => {
    attemptRef.current = null;
    setCodeSentTo(null);
    setCode("");
    setPasswordUnavailable(false);
  }, []);

  return {
    email,
    setEmail,
    password,
    setPassword,
    code,
    setCode,
    codeSentTo,
    passwordUnavailable,
    signingIn,
    sending,
    verifying,
    signInWithPassword: submitPassword,
    sendCode,
    verifyCode,
    reset,
  };
}
