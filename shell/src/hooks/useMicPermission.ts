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
      } catch {
        // Firefox doesn't support microphone permission query — assume "prompt"
        setState("prompt");
      }
    }

    check();
    return () => {
      if (permStatus) permStatus.onchange = null;
    };
  }, []);

  const requestAccess = useCallback(async (): Promise<boolean> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Stop tracks immediately — we just needed the permission grant
      stream.getTracks().forEach((t) => t.stop());
      setState("granted");
      return true;
    } catch {
      setState("denied");
      return false;
    }
  }, []);

  return { state, requestAccess };
}
