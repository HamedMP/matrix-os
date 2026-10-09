import { Button } from "@/components/ui";

import { InteractionCard } from "./InteractionCard";

export interface AccountChoiceCardProps {
  /** "Choose an account", from the copy every surface shares. */
  label: string;
  /** The service whose account is being chosen. */
  title: string;
  options: readonly { connectionId: string; label: string }[];
  /** The connection whose choice is on its way to the server, while one is. */
  sending?: string | null;
  error?: string | null;
  onChoose: (connectionId: string) => void;
  testID?: string;
}

/** Which of the person's accounts the agent should use for a service. */
export function AccountChoiceCard({ label, title, options, sending = null, error, onChoose, testID }: AccountChoiceCardProps) {
  return (
    <InteractionCard testID={testID} label={label} title={title} error={error}>
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
