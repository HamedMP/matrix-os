"use client";

import { useEffect, useRef, useState } from "react";

export function useTerminalSessionCreate({
  createSession,
  onCreated,
}: {
  createSession: () => Promise<string | null>;
  onCreated: (sessionName: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const create = async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    await createSession()
      .then((sessionName) => {
        if (sessionName) onCreated(sessionName);
      })
      .finally(() => {
        creatingRef.current = false;
        if (mountedRef.current) setCreating(false);
      });
  };

  return { create, creating };
}
