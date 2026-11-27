import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
interface ProjectSetupLaunch {
  requested: boolean;
  sequence: number;
  request: () => void;
  dismiss: () => void;
}
const Context = createContext<ProjectSetupLaunch | null>(null);
/** Ephemeral launch intent. Accepted answers are persisted by canonical Chat. */
export function ProjectSetupLaunchProvider({
  children,
  initiallyOffered = false,
}: {
  children: ReactNode;
  initiallyOffered?: boolean;
}) {
  const [requested, setRequested] = useState(initiallyOffered);
  const [sequence, setSequence] = useState(initiallyOffered ? 1 : 0);
  const value = useMemo(
    () => ({
      requested,
      sequence,
      request: () => {
        setRequested(true);
        setSequence((current) => current + 1);
      },
      dismiss: () => setRequested(false),
    }),
    [requested, sequence],
  );
  return <Context value={value}>{children}</Context>;
}
export function useProjectSetupLaunch() {
  return useContext(Context);
}
