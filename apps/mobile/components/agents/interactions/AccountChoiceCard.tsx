import { Button } from "@/components/ui";

import { InteractionCard, RequestedAccessNotes, type RequestedAccess } from "./InteractionCard";

export interface AccountChoiceCardProps {
  /** "Choose an account", from the copy every surface shares. */
  label: string;
  /** The service whose account is being chosen. */
  title: string;
  /** What the agent may do with the chosen account. Absent on requests stored before the server said. */
  access?: RequestedAccess | null;
  options: readonly { connectionId: string; label: string }[];
  /** The connection whose choice is on its way to the server, while one is. */
  sending?: string | null;
  error?: string | null;
  onChoose: (connectionId: string) => void;
  testID?: string;
}

/** Which of the person's accounts the agent should use for a service. */
export function AccountChoiceCard({
  label,
  title,
  access,
  options,
  sending = null,
  error,
  onChoose,
  testID,
}: AccountChoiceCardProps) {
  return (
    <InteractionCard testID={testID} label={label} title={title} error={error}>
      {access ? <RequestedAccessNotes access={access} /> : null}
      {options.map((option) => (
        <Button
          key={option.connectionId}
          variant="outline"
          fullWidth
          label={option.label}
          loading={sending === option.connectionId}
          disabled={sending !== null && sending !== option.connectionId}
          onPress={() => onChoose(option.connectionId)}
        />
      ))}
    </InteractionCard>
  );
}
