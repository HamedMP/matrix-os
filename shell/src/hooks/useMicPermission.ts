"use client";

import { useCallback, useEffect, useState } from "react";

export type MicPermissionState = "checking" | "prompt" | "granted" | "denied";

export function useMicPermission() {
  const [state, setState] = useState<MicPermissionState>("checking");

  useEffect(() => {
    let permStatus: PermissionStatus | null = null;

    async function check() {
      try {
        permStatus = await navigator.permissions.query({ name: "microphone" as PermissionName });
        setState(permStatus.state as MicPermissionState);
        permStatus.onchange = () => {
          setState(permStatus!.state as MicPermissionState);
        };
      } catch (err) {
        console.warn("[mic] permission query failed:", err instanceof Error ? err.message : String(err));
        // Firefox doesn't support microphone permission query — assume "prompt"
        setState("prompt");
      }
    }

    // react-doctor-disable-next-line react-doctor/no-initialize-state -- cannot lazy-init this useState: the real value comes from the async navigator.permissions.query Promise (and Firefox falls back to "prompt" on rejection), so "checking" is a deliberate pending placeholder resolved here on mount, not derivable in render
    check();
    return () => {
      if (permStatus) permStatus.onchange = null;
    };
  }, []);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const requestAccess = useCallback(async (): Promise<boolean> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Stop tracks immediately — we just needed the permission grant
      stream.getTracks().forEach((t) => t.stop());
      setState("granted");
      return true;
    } catch (err) {
      console.warn("[mic] access request failed:", err instanceof Error ? err.message : String(err));
      setState("denied");
      return false;
    }
  }, []);

  return { state, requestAccess };
}
